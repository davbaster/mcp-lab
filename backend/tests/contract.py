"""Contract check: every test-client response is validated against the OpenAPI document.

`tests/conftest.py` installs the check around every test (autouse fixture). `check_response`
raises `ContractViolation` from the line that made the request, naming the route, method, status,
and field. Messages hold field paths and rules, never the response body's values.

Which document a response is checked against:

- `app.main.app` is checked against the committed `openapi.yaml`, read once per session. A route
  missing from that file fails with the command that re-exports it.
- Any other FastAPI app (a throwaway app in a test) is checked against its own `app.openapi()`,
  built when its first response is checked and kept for the rest of the run. `app.openapi()` is
  cached by FastAPI, so define every route before the app's first request.

Rules, in order, for one response (see the issue for #56 for the full list):

- A path in the skip list (`app.main.app` only) is not checked, for any method.
- Routes are matched by path template (the query string is ignored; `/things/me` beats
  `/things/{thing_id}`). The matching is `openapi-core`'s.
- A path no operation matches: a 404 passes if its body is a valid `ErrorResponse`. Any other
  status fails. A known path with a method the spec does not define: a 405 passes if its body is
  a valid `ErrorResponse` and `Allow` names exactly the methods the spec defines for the path.
- On a described operation the status, the content type (parameters such as `charset` ignored),
  and the body must match the spec. A status listed without `content` must have an empty body.
  Only JSON bodies are parsed and schema-checked; other listed media types get a content type
  check. A `HEAD` response has its status and content type checked and its body ignored.
- Any status of 400 or more must also be a valid `ErrorResponse`, whatever schema the spec lists.
- `@pytest.mark.undocumented_status(<statuses>, reason="...")` accepts, in that test only, a 3xx,
  4xx, or 5xx status that the spec does not list. A 3xx body must be empty, a 4xx/5xx body must
  still be a valid `ErrorResponse`.

The only exemptions are the skip list and that marker. Nothing in the environment, the command
line, or a config file turns the check off. Today's tests use `fastapi.testclient.TestClient`;
a later client type must go through `Contract.check` too.
"""

import json
import weakref
from collections.abc import Iterable, Mapping
from functools import cache
from pathlib import Path
from typing import Any

import httpx
import yaml
from fastapi import FastAPI
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from openapi_core import OpenAPI
from openapi_core.datatypes import RequestParameters
from openapi_core.exceptions import OpenAPIError
from openapi_core.templating.media_types.exceptions import MediaTypeNotFound
from openapi_core.templating.media_types.finders import MediaTypeFinder
from openapi_core.templating.paths.iterators import TemplatePathsIterator
from openapi_core.templating.responses.exceptions import ResponseNotFound
from openapi_core.templating.responses.finders import ResponseFinder
from openapi_core.validation.response.exceptions import (
    DataValidationError,
    HeaderValidationError,
    MissingData,
)
from starlette.routing import compile_path

from app.errors import ErrorResponse
from app.main import app as main_app
from tests.dbtools import BACKEND_DIR

COMMITTED_SPEC = BACKEND_DIR.parent / "openapi.yaml"
EXPORT_COMMAND = "uv run python scripts/export_openapi.py"

# Routes `app.main.app` serves that are not in the spec. Each entry is a path template and the
# reason it is not checked. Matching is exact: `/api/docs/x` is not skipped.
SKIPPED_ROUTES: dict[str, str] = {
    "/api/openapi.json": "serves the spec itself; it is not an API operation",
    "/api/docs": "Swagger UI page; it is not an API operation",
}

_HTTP_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
_JSON_MIME_TYPES = ("application/json", "application/vnd.api+json")
_MAX_LISTED_ERRORS = 5


class ContractViolation(AssertionError):
    """A response does not match the OpenAPI document. Holds the request and response."""

    def __init__(
        self,
        message: str,
        request: httpx.Request | None = None,
        response: httpx.Response | None = None,
    ) -> None:
        super().__init__(message)
        self.request = request
        self.response = response


class SpecFileError(Exception):
    """The committed openapi.yaml is missing or unusable. The message names the file."""


class MarkerError(Exception):
    """The `undocumented_status` marker is used wrongly."""


# --- the committed spec ---


def read_spec_file(path: Path) -> OpenAPI:
    """Parse and validate an OpenAPI document from `path`; every error names the file."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        raise SpecFileError(
            f"{path} does not exist. Contract tests need it; run: {EXPORT_COMMAND}"
        ) from None
    except OSError as exc:
        raise SpecFileError(f"{path} cannot be read: {exc.strerror or exc}") from None
    try:
        document = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise SpecFileError(f"{path} is not valid YAML: {exc}") from None
    if not isinstance(document, dict) or not isinstance(document.get("openapi"), str):
        raise SpecFileError(
            f"{path} is not an OpenAPI document (expected a YAML mapping with an openapi version)"
        )
    try:
        return OpenAPI.from_dict(document)
    except (OpenAPIError, ValidationError) as exc:
        raise SpecFileError(
            f"{path} is not a valid OpenAPI document ({type(exc).__name__}); run: {EXPORT_COMMAND}"
        ) from None


@cache
def committed_openapi() -> OpenAPI:
    """`openapi.yaml` at the repo root, read and validated once per session."""
    return read_spec_file(COMMITTED_SPEC)


# --- messages ---


def _field(path: Iterable[Any]) -> str:
    text = ""
    for part in path:
        if isinstance(part, int):
            text += f"[{part}]"
        else:
            text += f".{part}" if text else str(part)
    return text or "(body root)"


def _describe_schema_error(err: Any) -> list[str]:
    """Field path and rule for one JSON Schema error. Never the submitted values."""
    here = list(err.absolute_path)
    rule = err.validator
    instance = err.instance
    if rule == "required" and isinstance(instance, dict):
        return [
            f'field "{_field([*here, name])}" is required but missing'
            for name in err.validator_value
            if name not in instance
        ]
    if rule == "additionalProperties" and isinstance(instance, dict):
        known = set(err.schema.get("properties", {}))
        return [
            f'field "{_field([*here, key])}" is not allowed (additionalProperties is false)'
            for key in instance
            if key not in known
        ]
    where = f'field "{_field(here)}"'
    if rule == "type":
        expected = err.validator_value
        expected = ", ".join(expected) if isinstance(expected, list) else expected
        return [f"{where} has the wrong type (expected {expected})"]
    if rule == "const":
        return [f"{where} breaks const (must be {json.dumps(err.validator_value)})"]
    if rule == "enum":
        return [f"{where} breaks enum (must be one of {json.dumps(err.validator_value)})"]
    return [f'{where} breaks the "{rule}" rule']


def _describe_schema_errors(errors: Iterable[Any]) -> str:
    lines: list[str] = []
    for err in errors:
        lines.extend(_describe_schema_error(err))
    extra = len(lines) - _MAX_LISTED_ERRORS
    shown = lines[:_MAX_LISTED_ERRORS]
    if extra > 0:
        shown.append(f"and {extra} more")
    return "; ".join(shown)


def _describe_library_error(err: Exception) -> str:
    """One `openapi-core` error as text. `str(err)` holds the body value, so it is never used."""
    schema_errors = getattr(err.__cause__, "schema_errors", None)
    if schema_errors is not None:
        return "body: " + _describe_schema_errors(schema_errors)
    if isinstance(err, MissingData):
        return "body is empty but the spec lists a body for this status"
    if isinstance(err, DataValidationError):
        return "body is not valid JSON"
    if isinstance(err, HeaderValidationError):
        return f'header "{err.name}" is missing or invalid'
    return f"{type(err).__name__}"


# --- ErrorResponse, from #4 ---


@cache
def _error_validator() -> Draft202012Validator:
    return Draft202012Validator(ErrorResponse.model_json_schema())


# --- adapters between httpx and openapi-core ---


class _LibRequest:
    """The parts of `httpx.Request` that `openapi-core` reads."""

    def __init__(self, request: httpx.Request, path: str) -> None:
        self.host_url = f"{request.url.scheme}://{request.url.netloc.decode('ascii')}"
        self.path = path
        self.method = request.method.lower()
        self.parameters = RequestParameters()
        self.body = None
        self.content_type = ""


class _LibResponse:
    """The parts of `httpx.Response` that `openapi-core` reads."""

    def __init__(self, response: httpx.Response) -> None:
        self.status_code = response.status_code
        self.headers = response.headers
        self.content_type = response.headers.get("content-type", "").lower()
        self.data = response.content


def _mime(content_type: str) -> str:
    return content_type.split(";")[0].strip().lower()


def _request_path(request: httpx.Request) -> str:
    return request.url.raw_path.split(b"?")[0].decode("ascii")


# --- the checker ---


class Contract:
    """Checks responses against one OpenAPI document.

    `skipped_routes` maps path templates to reasons; matching is exact. `source` and
    `missing_route_hint` are only used in messages.
    """

    def __init__(
        self,
        openapi: OpenAPI,
        *,
        source: str,
        missing_route_hint: str,
        skipped_routes: Mapping[str, str] | None = None,
    ) -> None:
        self.openapi = openapi
        self.source = source
        self.missing_route_hint = missing_route_hint
        self._skipped = [compile_path(template)[0] for template in (skipped_routes or {})]

    def is_skipped(self, path: str) -> bool:
        return any(pattern.fullmatch(path) for pattern in self._skipped)

    def check(
        self,
        request: httpx.Request,
        response: httpx.Response,
        exempt_statuses: Iterable[int] = (),
    ) -> None:
        """Raise `ContractViolation` unless `response` matches the document."""
        path = _request_path(request)
        if self.is_skipped(path):
            return
        response.read()
        exempt = frozenset(exempt_statuses)
        try:
            self._check(request, response, path, exempt)
        except _Problem as problem:
            label = f"{request.method} {problem.route or path} {response.status_code}"
            raise ContractViolation(f"{label}: {problem}", request, response) from None

    # -- internals --

    def _matching_paths(self, path: str) -> list[Any]:
        iterator = TemplatePathsIterator("paths")
        matches = []
        for item, result in iterator(path, self.openapi.spec):
            # The library's matching looks for the template anywhere in the string; the whole
            # path must be it.
            if result.resolved == path:
                matches.append((item, result.pattern))
        return matches

    def _check(self, request: httpx.Request, response: httpx.Response, path: str, exempt) -> None:
        method = request.method.lower()
        matches = self._matching_paths(path)
        if not matches:
            self._check_unknown_route(request, response, path, exempt)
            return
        route = matches[0][1]
        operation = next((item / method for item, _ in matches if method in item), None)
        if operation is None:
            self._check_unknown_method(request, response, matches, exempt, route)
            return
        self._check_operation(request, response, path, operation, route, exempt)

    def _check_unknown_route(self, request, response, path, exempt) -> None:
        status = response.status_code
        if status == 404 or status in exempt:
            self._check_not_described(request, response)
            return
        raise _Problem(f"this route is not in {self.source}; {self.missing_route_hint}")

    def _check_unknown_method(self, request, response, matches, exempt, route) -> None:
        status = response.status_code
        defined = sorted({m.upper() for item, _ in matches for m in _HTTP_METHODS if m in item})
        if status == 405:
            self._check_not_described(request, response)
            allow = {m.strip().upper() for m in response.headers.get("allow", "").split(",") if m}
            if allow != set(defined):
                raise _Problem(
                    f"Allow header lists {sorted(allow) or 'nothing'} but the spec defines "
                    f"{defined} for this path",
                    route,
                )
            return
        if status in exempt:
            self._check_not_described(request, response)
            return
        raise _Problem(
            f"the spec does not define {request.method} for this route (it defines "
            f"{', '.join(defined)}); only a 405 is accepted here",
            route,
        )

    def _check_not_described(self, request, response) -> None:
        """A 4xx/5xx from outside the spec must be an ErrorResponse; a 3xx must be empty."""
        if response.status_code < 400:
            if request.method != "HEAD" and response.content:
                raise _Problem("a redirect or other 3xx response must have an empty body")
            return
        self._check_error_shape(request, response)

    def _check_error_shape(self, request, response, route: str | None = None) -> None:
        mime = _mime(response.headers.get("content-type", ""))
        if mime != "application/json":
            raise _Problem(
                f"error responses must be application/json, got {mime or 'no content type'}",
                route,
            )
        if request.method == "HEAD":
            return
        try:
            body = json.loads(response.content)
        except ValueError:
            raise _Problem("error body is not valid JSON", route) from None
        errors = list(_error_validator().iter_errors(body))
        if errors:
            raise _Problem(
                "error body is not the shared error shape: " + _describe_schema_errors(errors),
                route,
            )

    def _check_operation(self, request, response, path, operation, route, exempt) -> None:
        status = response.status_code
        responses = operation / "responses"
        try:
            described = ResponseFinder(responses).find(str(status))
        except ResponseNotFound as exc:
            if status in exempt:
                self._check_not_described(request, response)
                return
            listed = ", ".join(exc.availableresponses) or "none"
            raise _Problem(
                f"status {status} is not listed in the spec (it lists {listed})", route
            ) from None
        if "content" not in described:
            if response.content and request.method != "HEAD":
                hint = (
                    "; every status of 400 or more has the shared error body, so list "
                    "it with ErrorResponse as its content"
                    if status >= 400
                    else ""
                )
                raise _Problem(
                    f"status {status} has no content in the spec, but the response has a body"
                    + hint,
                    route,
                )
            return
        content = described / "content"
        content_type = response.headers.get("content-type", "")
        try:
            MediaTypeFinder(content).find(content_type or None)
        except MediaTypeNotFound:
            listed = ", ".join(content.str_keys())
            raise _Problem(
                f"content type {_mime(content_type) or 'none'} is not listed for status "
                f"{status} (the spec lists {listed})",
                route,
            ) from None
        if status >= 400:
            self._check_error_shape(request, response, route)
            return
        if request.method == "HEAD" or _mime(content_type) not in _JSON_MIME_TYPES:
            return
        validator = self.openapi.response_validator
        for err in validator.iter_errors(_LibRequest(request, path), _LibResponse(response)):
            raise _Problem(_describe_library_error(err), route)


class _Problem(Exception):
    """Internal: a rule was broken. `route` is the template to name, if known."""

    def __init__(self, message: str, route: str | None = None) -> None:
        super().__init__(message)
        self.route = route


# --- which document and skip list apply to which app ---

_app_contracts: "weakref.WeakKeyDictionary[FastAPI, Contract]" = weakref.WeakKeyDictionary()


def contract_for(app: Any, skipped_routes: Mapping[str, str] | None = None) -> Contract:
    """The checker for `app`. `skipped_routes` defaults to `SKIPPED_ROUTES` and applies only to
    `app.main.app`."""
    if app is main_app:
        skipped = SKIPPED_ROUTES if skipped_routes is None else skipped_routes
        return Contract(
            committed_openapi(),
            source=COMMITTED_SPEC.name,
            missing_route_hint=f"run: {EXPORT_COMMAND}",
            skipped_routes=skipped,
        )
    if not isinstance(app, FastAPI):
        raise TypeError(
            f"the contract check needs a FastAPI app, got {type(app).__name__}; "
            "TestClient must wrap the FastAPI app itself"
        )
    contract = _app_contracts.get(app)
    if contract is None:
        contract = Contract(
            OpenAPI.from_dict(app.openapi()),
            source="the app's own app.openapi()",
            missing_route_hint=(
                "define every route before the app's first request, because app.openapi() "
                "is cached; run: " + EXPORT_COMMAND
            ),
        )
        _app_contracts[app] = contract
    return contract


# --- the undocumented_status marker ---


def exempt_statuses(marker: Any) -> frozenset[int]:
    """The statuses a test's `undocumented_status` marker exempts (empty without a marker)."""
    if marker is None:
        return frozenset()
    reason = marker.kwargs.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise MarkerError(
            "undocumented_status needs a non-empty reason, "
            'for example @pytest.mark.undocumented_status(307, reason="trailing-slash redirect")'
        )
    unknown = set(marker.kwargs) - {"reason"}
    if unknown:
        raise MarkerError(f"undocumented_status got unexpected keyword {min(unknown)!r}")
    statuses: list[Any] = []
    for arg in marker.args:
        statuses.extend(arg if isinstance(arg, (list, tuple, set, frozenset)) else [arg])
    if not statuses:
        raise MarkerError("undocumented_status needs at least one status to accept")
    for status in statuses:
        if isinstance(status, bool) or not isinstance(status, int):
            raise MarkerError(f"undocumented_status takes integer statuses, got {status!r}")
        if not 300 <= status <= 599:
            raise MarkerError(
                f"undocumented_status accepts only 3xx, 4xx, and 5xx statuses, got {status}; "
                "a success response can never be exempted"
            )
    return frozenset(statuses)


# --- every route of app.main.app is in the spec or the skip list ---


def route_problems(
    app: FastAPI, spec: Mapping[str, Any], skipped_routes: Mapping[str, str]
) -> list[str]:
    """Routes of `app` that are neither in `spec` nor in `skipped_routes`, and stale skip entries."""
    spec_paths: Mapping[str, Any] = spec.get("paths", {})
    problems: list[str] = []
    route_paths: set[str] = set()
    for route in app.routes:
        path = getattr(route, "path_format", None)
        if path is None:
            problems.append(
                f"{type(route).__name__} {getattr(route, 'path', '?')} is not a plain route; "
                "extend route_problems to cover it"
            )
            continue
        route_paths.add(path)
        methods = {m.lower() for m in getattr(route, "methods", None) or ()} - {"head", "options"}
        if path in skipped_routes:
            if path in spec_paths:
                problems.append(
                    f"{path} is in the skip list but also in openapi.yaml; remove it from the skip list"
                )
        elif path not in spec_paths:
            problems.append(
                f"route {path} is not in openapi.yaml or the skip list; run: {EXPORT_COMMAND}"
            )
        else:
            missing = sorted(m.upper() for m in methods if m not in spec_paths[path])
            if missing:
                problems.append(
                    f"route {path} {', '.join(missing)} is not in openapi.yaml; "
                    f"run: {EXPORT_COMMAND}"
                )
    for path in skipped_routes:
        if path not in route_paths:
            problems.append(f"skip list entry {path} is not a route of the app; remove it")
    return problems
