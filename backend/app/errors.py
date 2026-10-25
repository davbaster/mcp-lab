"""The shared error shape, the handlers that produce it, and its declaration in the spec.

Every error the backend sends is `{"error": {"code": ..., "message": ...}}`. Routes raise
`ApiError` for their own codes. Call `install_error_handling` once on an app: it registers the
handlers and declares the shape in the OpenAPI document, so tests can apply it to a throwaway
`FastAPI` app instead of touching `app.main.app`.
"""

import copy
import logging
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.log_format import mark_logged
from app.request_middleware import REQUEST_ID_HEADER, request_id_from

logger = logging.getLogger(__name__)

MAX_VALIDATION_ERRORS = 5
INTERNAL_ERROR_MESSAGE = "Internal server error."
_HTTP_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
_ERROR_REF = {"$ref": "#/components/schemas/ErrorResponse"}


class ErrorDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: ErrorDetail


class ApiError(Exception):
    """Raise from a route to send `status_code` with exactly this `code` and `message`.

    `headers`, when given, are added to the error response (for example `Retry-After`).
    """

    def __init__(
        self, status_code: int, code: str, message: str, headers: dict[str, str] | None = None
    ) -> None:
        super().__init__(f"{status_code} {code}: {message}")
        self.status_code = status_code
        self.code = code
        self.message = message
        self.headers = headers


def error_response(
    status_code: int, code: str, message: str, headers: dict[str, str] | None = None
) -> JSONResponse:
    body = {"error": {"code": code, "message": message}}
    return JSONResponse(body, status_code=status_code, headers=headers)


def _reason_phrase(status_code: int) -> str:
    try:
        return HTTPStatus(status_code).phrase
    except ValueError:
        return "Error"


async def _api_error_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, ApiError)
    return error_response(exc.status_code, exc.code, exc.message, exc.headers)


async def _http_exception_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, StarletteHTTPException)
    headers = dict(exc.headers) if exc.headers else None
    if exc.status_code in (204, 304):  # these statuses cannot have a body
        return Response(status_code=exc.status_code, headers=headers)
    if exc.status_code == 404:
        code = "not_found"
    elif exc.status_code == 405:
        code = "method_not_allowed"
    else:
        code = "http_error"
    message = exc.detail if isinstance(exc.detail, str) else _reason_phrase(exc.status_code)
    return error_response(exc.status_code, code, message, headers)


def _location(loc: tuple[Any, ...]) -> str:
    text = str(loc[0]) if loc else "body"
    for part in loc[1:]:
        text += f"[{part}]" if isinstance(part, int) else f".{part}"
    return text


def validation_message(errors: list[Any]) -> str:
    """`<location>: <message>` per error, joined by `; `, from Pydantic's `loc` and `msg` only.

    Never reads `input` or `ctx`, because those hold what the client submitted. For the same
    reason an unknown key is reported against the object that holds it, not by name.
    """
    parts = []
    for err in errors[:MAX_VALIDATION_ERRORS]:
        loc = tuple(err.get("loc", ()))
        if err.get("type") == "json_invalid":
            loc = loc[:1]  # the second item is a character offset in the raw body
        elif err.get("type") == "extra_forbidden":
            loc = loc[:-1]  # the last item is a key the client invented
        parts.append(f"{_location(loc)}: {err.get('msg', 'Invalid value')}")
    extra = len(errors) - MAX_VALIDATION_ERRORS
    if extra > 0:
        parts.append(f"and {extra} more")
    return "; ".join(parts)


async def _validation_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, RequestValidationError)
    return error_response(422, "validation_error", validation_message(list(exc.errors())))


async def _unexpected_handler(request: Request, exc: Exception) -> Response:
    # Only the method and path are logged: never the query string, headers, cookies, or body.
    # The JSON handler writes the trace as one `stack_trace` field.
    logger.error("Unhandled exception on %s %s", request.method, request.url.path, exc_info=exc)
    # Starlette re-raises after this handler and uvicorn would log the exception again; this
    # mark makes the log handler skip that second record.
    mark_logged(exc)
    # This response is sent by Starlette's outermost middleware, outside the request middleware,
    # so the request ID header is added here.
    headers = {REQUEST_ID_HEADER: request_id_from(request.scope)}
    return error_response(500, "internal_error", INTERNAL_ERROR_MESSAGE, headers)


def _error_content(description: str) -> dict[str, Any]:
    return {"description": description, "content": {"application/json": {"schema": _ERROR_REF}}}


def declare_error_responses(spec: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of an OpenAPI document with the shared error shape declared.

    Every operation gets a 500. Operations with any parameter or body also get a 422. The
    default `HTTPValidationError` schemas are replaced by `ErrorResponse`.
    """
    spec = copy.deepcopy(spec)
    schemas = spec.setdefault("components", {}).setdefault("schemas", {})
    schemas.pop("HTTPValidationError", None)
    schemas.pop("ValidationError", None)
    error_schema = ErrorResponse.model_json_schema(ref_template="#/components/schemas/{model}")
    schemas.update(error_schema.pop("$defs"))
    schemas["ErrorResponse"] = error_schema
    for path_item in spec.get("paths", {}).values():
        for method in _HTTP_METHODS:
            operation = path_item.get(method)
            if operation is None:
                continue
            responses = operation.setdefault("responses", {})
            if operation.get("parameters") or "requestBody" in operation:
                responses["422"] = _error_content("Validation error")
            responses.setdefault("500", _error_content("Internal server error"))
    return spec


def install_error_handling(app: FastAPI) -> None:
    """Register the error handlers and declare the error shape in `app.openapi()`."""
    app.add_exception_handler(ApiError, _api_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(Exception, _unexpected_handler)

    default_openapi = app.openapi
    cached: dict[str, Any] | None = None

    def openapi() -> dict[str, Any]:
        nonlocal cached
        if cached is None:
            cached = declare_error_responses(default_openapi())
            app.openapi_schema = cached
        return cached

    app.openapi = openapi  # type: ignore[method-assign]
