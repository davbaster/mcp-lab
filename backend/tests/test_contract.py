"""The contract check itself: what it accepts, what it rejects, and what the message says.

Most tests build a throwaway app and make the request with a `TestClient` built in the test body,
so the autouse check in `conftest.py` is what raises. A few feed the checker a response directly
(`ContractViolation.response` or a hand-built `httpx.Response`) to check it against the committed
`openapi.yaml` or against a small skip list.
"""

import inspect
import re
from pathlib import Path
from typing import Literal

import httpx
import pytest
import yaml
from fastapi import FastAPI
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict

import tests.conftest as conftest_module
from app.errors import ApiError, ErrorResponse, install_error_handling
from app.main import app as main_app
from tests import contract
from tests.contract import (
    COMMITTED_SPEC,
    SKIPPED_ROUTES,
    Contract,
    ContractViolation,
    MarkerError,
    SpecFileError,
    committed_openapi,
    contract_for,
    exempt_statuses,
    read_spec_file,
    route_problems,
)

pytest_plugins = ["pytester"]

SENTINEL = "CONTRACT-SENTINEL-6b1f"
RUN_EXPORT = "run: uv run python scripts/export_openapi.py"


class Thing(BaseModel):
    id: int
    name: str


class StrictThing(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int


class Level(BaseModel):
    level: Literal["low", "high"]


class Flag(BaseModel):
    flag: Literal["on"]


def make_app_with(add_routes) -> FastAPI:
    """A throwaway app with the shared error handling and the routes `add_routes` defines."""
    app = FastAPI()
    install_error_handling(app)
    add_routes(app)
    return app


def empty() -> dict[str, str]:
    return {}


def violation_message(call) -> str:
    with pytest.raises(ContractViolation) as info:
        call()
    return str(info.value)


def check_against_committed(response: httpx.Response) -> None:
    """Check a response (from any app) against the real `openapi.yaml`."""
    contract_for(main_app).check(response.request, response)


def request_and_response(
    method: str, path: str, status: int, **kwargs
) -> tuple[httpx.Request, httpx.Response]:
    request = httpx.Request(method, f"http://testserver{path}")
    return request, httpx.Response(status, request=request, **kwargs)


def small_contract(paths: dict, skipped=None) -> Contract:
    document = {
        "openapi": "3.1.0",
        "info": {"title": "t", "version": "1"},
        "paths": paths,
    }
    return Contract(
        contract.OpenAPI.from_dict(document),
        source="the test spec",
        missing_route_hint=RUN_EXPORT,
        skipped_routes=skipped,
    )


JSON_200 = {"200": {"description": "ok", "content": {"application/json": {"schema": {}}}}}


# --- the check runs by itself ---


def test_a_client_built_in_the_test_body_is_checked():
    app = make_app_with(lambda a: a.get("/undeclared")(lambda: JSONResponse({}, status_code=202)))
    client = TestClient(app)

    message = violation_message(lambda: client.get("/undeclared"))

    assert "GET /undeclared 202" in message


def test_the_violation_is_raised_at_the_line_that_made_the_request():
    app = make_app_with(lambda a: a.get("/undeclared")(lambda: JSONResponse({}, status_code=202)))
    client = TestClient(app)

    with pytest.raises(ContractViolation) as info:
        client.get("/undeclared")

    assert isinstance(info.value, AssertionError)
    assert info.traceback[-1].path.name == "contract.py"
    assert info.traceback[0].path.name == "test_contract.py"


@pytest.mark.undocumented_status(307, reason="the test follows a redirect on purpose")
def test_every_hop_of_a_followed_redirect_is_checked():
    def add(app):
        @app.get("/start")
        def start():
            return RedirectResponse("/end")

        @app.get("/end", response_model=Thing)
        def end():
            return JSONResponse({"id": "not a number", "name": "x"})

    client = TestClient(make_app_with(add))

    message = violation_message(lambda: client.get("/start"))

    assert "GET /end 200" in message
    assert 'field "id"' in message


def test_the_first_hop_of_a_followed_redirect_is_checked():
    def add(app):
        @app.get("/start")
        def start():
            return RedirectResponse("/end")

        @app.get("/end")
        def end():
            return {}

    client = TestClient(make_app_with(add))

    message = violation_message(lambda: client.get("/start"))

    assert "GET /start 307" in message


def test_a_response_from_a_client_that_does_not_follow_redirects_is_checked():
    app = make_app_with(lambda a: a.get("/start")(lambda: RedirectResponse("/end")))
    client = TestClient(app)

    message = violation_message(lambda: client.get("/start", follow_redirects=False))

    assert "GET /start 307" in message


def test_no_switch_in_the_environment_or_the_command_line_turns_the_check_off():
    sources = [
        Path(contract.__file__).read_text(),
        inspect.getsource(conftest_module.contract_check),
    ]
    for source in sources:
        assert not re.search(r"os\.environ|getenv|addoption|getoption|getini", source)


# --- which spec a response is checked against ---


def test_main_app_is_checked_against_the_committed_file():
    assert contract_for(main_app).openapi is committed_openapi()
    assert committed_openapi().spec.read_value() == yaml.safe_load(COMMITTED_SPEC.read_bytes())


def test_main_app_is_not_checked_against_its_own_app_openapi(monkeypatch):
    spec = yaml.safe_load(COMMITTED_SPEC.read_bytes())
    del spec["paths"]["/api/health"]["get"]["responses"]["200"]
    stale = contract.OpenAPI.from_dict(spec)
    monkeypatch.setattr(contract, "committed_openapi", lambda: stale)

    message = violation_message(lambda: TestClient(main_app).get("/api/health"))

    assert "GET /api/health 200" in message
    assert "(it lists 500)" in message
    assert "200" in main_app.openapi()["paths"]["/api/health"]["get"]["responses"]


def test_the_committed_file_is_read_once_per_session():
    assert committed_openapi() is committed_openapi()
    assert contract_for(main_app).openapi is contract_for(main_app).openapi


def test_a_missing_spec_file_stops_the_run_with_an_error_naming_the_file(tmp_path):
    missing = tmp_path / "openapi.yaml"

    with pytest.raises(SpecFileError) as info:
        read_spec_file(missing)

    assert str(missing) in str(info.value)
    assert "does not exist" in str(info.value)


@pytest.mark.parametrize(
    "text", ["{unclosed: [", "- a\n- b\n", "openapi: 3.1.0\n", "openapi: 9.9\ninfo: {}\n"]
)
def test_a_spec_file_that_does_not_parse_or_validate_is_an_error_naming_the_file(tmp_path, text):
    broken = tmp_path / "openapi.yaml"
    broken.write_text(text)

    with pytest.raises(SpecFileError) as info:
        read_spec_file(broken)

    assert str(broken) in str(info.value)


def test_a_spec_file_error_in_pytest_configure_is_a_usage_error_naming_the_file(monkeypatch):
    def broken():
        raise SpecFileError("/somewhere/openapi.yaml does not exist")

    monkeypatch.setattr(conftest_module, "committed_openapi", broken)

    with pytest.raises(pytest.UsageError, match="/somewhere/openapi.yaml"):
        conftest_module.pytest_configure(None)


def test_a_throwaway_app_is_checked_against_its_own_spec_not_openapi_yaml():
    app = make_app_with(lambda a: a.get("/only-here")(lambda: {"ok": True}))

    response = TestClient(app).get("/only-here")

    assert response.status_code == 200
    assert "/only-here" not in committed_openapi().spec.read_value()["paths"]


def test_a_throwaway_apps_spec_is_built_on_its_first_response_and_only_once():
    app = make_app_with(lambda a: a.get("/ping")(empty))
    calls = []
    original = app.openapi

    def counting():
        calls.append(1)
        return original()

    app.openapi = counting
    client = TestClient(app)

    assert calls == []
    for _ in range(3):
        client.get("/ping")

    assert calls == [1]


def test_a_route_added_after_the_first_request_is_not_in_the_cached_spec():
    app = make_app_with(lambda a: a.get("/first")(empty))
    client = TestClient(app)
    client.get("/first")
    app.get("/late")(empty)

    message = violation_message(lambda: client.get("/late"))

    assert "GET /late 200" in message
    assert "define every route before the app's first request" in message


def test_a_response_from_a_route_the_committed_spec_lacks_fails_with_the_export_command():
    app = make_app_with(lambda a: a.get("/api/brand-new")(empty))
    response = TestClient(app).get("/api/brand-new")

    message = violation_message(lambda: check_against_committed(response))

    assert message.startswith("GET /api/brand-new 200:")
    assert message.endswith(RUN_EXPORT)


# --- route, status, and content type ---


def test_a_route_is_found_by_template_and_the_query_string_is_ignored():
    app = make_app_with(lambda a: a.get("/things/{thing_id}")(lambda thing_id: {}))

    response = TestClient(app).get("/things/42?x=1")

    assert response.status_code == 200


def test_a_failure_names_the_route_template_not_the_concrete_path():
    app = make_app_with(
        lambda a: a.get("/things/{thing_id}")(lambda thing_id: JSONResponse({}, status_code=202))
    )

    message = violation_message(lambda: TestClient(app).get("/things/42?x=1"))

    assert message.startswith("GET /things/{thing_id} 202:")
    assert "/things/42" not in message


def test_a_literal_path_wins_over_a_template_that_matches_it():
    paths = {
        "/things/{thing_id}": {
            "get": {
                "parameters": [
                    {
                        "name": "thing_id",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "string"},
                    }
                ],
                "responses": {**JSON_200, "201": JSON_200["200"]},
            }
        },
        "/things/me": {"get": {"responses": JSON_200}},
    }
    checker = small_contract(paths)
    request, response = request_and_response("GET", "/things/me", 201, json={})

    with pytest.raises(ContractViolation) as info:
        checker.check(request, response)
    request, response = request_and_response("GET", "/things/7", 201, json={})
    checker.check(request, response)

    assert str(info.value).startswith("GET /things/me 201:")


def test_a_status_the_spec_does_not_list_fails_naming_method_route_status_and_listed_ones():
    def add(app):
        @app.post("/things/{thing_id}")
        def post(thing_id: int):
            return JSONResponse({}, status_code=201)

    message = violation_message(lambda: TestClient(make_app_with(add)).post("/things/1"))

    assert "POST /things/{thing_id} 201" in message
    assert "status 201 is not listed" in message
    assert "it lists 200, 422, 500" in message


def test_a_range_or_default_response_in_the_spec_counts_as_listing_the_status():
    checker = small_contract(
        {"/a": {"get": {"responses": {"2XX": {"description": "ok"}, "default": JSON_200["200"]}}}}
    )

    checker.check(*request_and_response("GET", "/a", 202))
    checker.check(
        *request_and_response("GET", "/a", 418, json={"error": {"code": "c", "message": "m"}})
    )


def test_a_wrong_content_type_fails():
    app = make_app_with(
        lambda a: a.get("/page")(lambda: Response("<p>hi</p>", media_type="text/html"))
    )

    message = violation_message(lambda: TestClient(app).get("/page"))

    assert "GET /page 200" in message
    assert "content type text/html is not listed" in message
    assert "application/json" in message


def test_content_type_parameters_are_ignored():
    app = make_app_with(
        lambda a: a.get("/ok")(lambda: Response("{}", media_type="application/json; charset=utf-8"))
    )

    assert TestClient(app).get("/ok").status_code == 200


def test_a_204_with_a_body_fails():
    def add(app):
        @app.get("/gone", status_code=204, response_class=Response)
        def gone():
            return Response(b"surprise", status_code=204)

    message = violation_message(lambda: TestClient(make_app_with(add)).get("/gone"))

    assert "GET /gone 204" in message
    assert "has no content in the spec, but the response has a body" in message


def test_a_204_with_no_body_passes():
    def add(app):
        @app.get("/gone", status_code=204, response_class=Response)
        def gone():
            return Response(status_code=204)

    assert TestClient(make_app_with(add)).get("/gone").status_code == 204


def _zip_app(media_type: str, body: bytes = b"PK\x03\x04 not json {") -> FastAPI:
    def add(app):
        @app.get(
            "/file.zip",
            response_class=Response,
            responses={200: {"description": "zip", "content": {"application/zip": {}}}},
        )
        def file():
            return Response(body, media_type=media_type)

    return make_app_with(add)


def test_a_listed_non_json_media_type_is_checked_by_content_type_only():
    response = TestClient(_zip_app("application/zip")).get("/file.zip")

    assert response.status_code == 200


def test_a_listed_non_json_media_type_with_the_wrong_content_type_fails():
    message = violation_message(lambda: TestClient(_zip_app("application/pdf")).get("/file.zip"))

    assert "GET /file.zip 200" in message
    assert "content type application/pdf is not listed" in message
    assert "application/zip" in message


def test_a_head_response_has_status_and_content_type_checked_and_body_ignored():
    def add(app):
        @app.head("/thing", response_model=Thing)
        def head():
            return Response(media_type="application/json")

    client = TestClient(make_app_with(add))

    assert client.head("/thing").status_code == 200


def test_a_head_response_with_the_wrong_content_type_fails():
    def add(app):
        @app.head("/thing", response_model=Thing)
        def head():
            return Response(media_type="text/plain")

    message = violation_message(lambda: TestClient(make_app_with(add)).head("/thing"))

    assert "HEAD /thing 200" in message
    assert "content type text/plain is not listed" in message


# --- bodies ---


def _body_app(model, body) -> FastAPI:
    def add(app):
        @app.get("/body", response_model=model)
        def get_body():
            return JSONResponse(body)

    return make_app_with(add)


@pytest.mark.parametrize(
    ("model", "body", "expected"),
    [
        (Thing, {"id": 1}, 'field "name" is required but missing'),
        (Thing, {"id": "one", "name": "x"}, 'field "id" has the wrong type (expected integer)'),
        (Flag, {"flag": "off"}, 'field "flag" breaks const (must be "on")'),
        (Level, {"level": "mid"}, 'field "level" breaks enum (must be one of ["low", "high"])'),
        (
            StrictThing,
            {"id": 1, "extra": 2},
            'field "extra" is not allowed (additionalProperties is false)',
        ),
    ],
    ids=["missing", "wrong-type", "const", "enum", "extra-forbidden"],
)
def test_a_body_that_breaks_the_schema_fails_naming_route_status_and_field(model, body, expected):
    message = violation_message(lambda: TestClient(_body_app(model, body)).get("/body"))

    assert message.startswith("GET /body 200:")
    assert expected in message


def test_a_failure_does_not_print_the_values_in_the_body():
    body = {"id": SENTINEL, "name": SENTINEL, "extra": SENTINEL}

    message = violation_message(lambda: TestClient(_body_app(Thing, body)).get("/body"))

    assert SENTINEL not in message
    assert 'field "id"' in message


def test_an_extra_field_passes_where_the_schema_does_not_forbid_extras():
    body = {"id": 1, "name": "x", "extra": SENTINEL}

    assert TestClient(_body_app(Thing, body)).get("/body").status_code == 200


def test_a_nested_field_path_is_dotted_and_lists_are_indexed():
    def add(app):
        @app.get("/nested", response_model=dict[str, list[Thing]])
        def nested():
            return JSONResponse({"things": [{"id": 1, "name": "a"}, {"id": 2}]})

    message = violation_message(lambda: TestClient(make_app_with(add)).get("/nested"))

    assert 'field "things[1].name" is required but missing' in message


@pytest.mark.parametrize("content", [b"", b"not json {"], ids=["empty", "not-json"])
def test_a_json_response_with_an_empty_or_invalid_body_fails(content):
    def add(app):
        @app.get("/body", response_model=Thing)
        def get_body():
            return Response(content, media_type="application/json")

    message = violation_message(lambda: TestClient(make_app_with(add)).get("/body"))

    assert message.startswith("GET /body 200:")


def test_the_committed_spec_rejects_a_health_body_that_breaks_const():
    app = make_app_with(lambda a: a.get("/api/health")(lambda: {"status": "nope"}))
    response = TestClient(app).get("/api/health")

    message = violation_message(lambda: check_against_committed(response))

    assert message.startswith("GET /api/health 200:")
    assert 'field "status" breaks const (must be "ok")' in message
    assert "nope" not in message.replace("must be", "")


def test_the_real_health_route_passes():
    assert TestClient(main_app).get("/api/health").json() == {"status": "ok"}


def test_a_throwaway_route_whose_response_matches_its_own_spec_passes():
    assert TestClient(_body_app(Thing, {"id": 1, "name": "x"})).get("/body").status_code == 200


# --- errors use the shared shape ---


def _error_app(status: int, body, **route_kwargs) -> FastAPI:
    def add(app):
        @app.get("/err", **route_kwargs)
        def err():
            return JSONResponse(body, status_code=status)

    return make_app_with(add)


DECLARED_400 = {400: {"model": ErrorResponse}}


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"detail": "Not found"}, 'field "error" is required but missing'),
        (
            {"error": {"code": "c", "message": "m", "extra": 1}},
            'field "error.extra" is not allowed',
        ),
        ({"error": "a string"}, 'field "error" has the wrong type (expected object)'),
        ({"error": {"code": 5, "message": "m"}}, 'field "error.code" has the wrong type'),
        ({"error": {"code": "c"}}, 'field "error.message" is required but missing'),
    ],
    ids=["detail", "extra-key", "string", "wrong-type", "missing-message"],
)
def test_an_error_body_not_in_the_shared_shape_fails(body, expected):
    app = _error_app(400, body, responses=DECLARED_400)

    message = violation_message(lambda: TestClient(app).get("/err"))

    assert message.startswith("GET /err 400:")
    assert "not the shared error shape" in message
    assert expected in message


def test_a_declared_error_with_the_shared_shape_passes():
    app = _error_app(400, {"error": {"code": "c", "message": "m"}}, responses=DECLARED_400)

    assert TestClient(app).get("/err").status_code == 400


def test_a_route_that_declares_its_own_409_schema_and_returns_it_is_still_rejected():
    class Conflict(BaseModel):
        detail: str

    app = _error_app(409, {"detail": "taken"}, responses={409: {"model": Conflict}})

    message = violation_message(lambda: TestClient(app).get("/err"))

    assert message.startswith("GET /err 409:")
    assert 'field "error" is required but missing' in message


@pytest.mark.parametrize(
    "body", [b"", b'{"error": {"code": "c", "message": "m"}}'], ids=["empty", "valid"]
)
def test_a_4xx_listed_without_content_fails_whatever_the_body(body):
    def add(app):
        @app.get("/err", responses={400: {"description": "bad"}})
        def err():
            return Response(body, status_code=400, media_type="application/json" if body else None)

    message = violation_message(lambda: TestClient(make_app_with(add)).get("/err"))

    assert message.startswith("GET /err 400:")
    assert "list it with ErrorResponse as its content" in message


def test_a_declared_error_that_is_not_json_fails():
    def add(app):
        @app.get("/err", responses=DECLARED_400)
        def err():
            return Response("bad", status_code=400, media_type="text/plain")

    message = violation_message(lambda: TestClient(make_app_with(add)).get("/err"))

    assert "GET /err 400" in message


def test_a_404_for_a_path_no_operation_matches_passes_with_a_valid_error_body():
    response = TestClient(main_app).get("/api/nothing-here")

    assert response.status_code == 404


def test_a_404_for_an_unknown_path_with_another_body_fails():
    bare = FastAPI()  # no error handling: Starlette answers with {"detail": "Not Found"}

    message = violation_message(lambda: TestClient(bare).get("/nothing"))

    assert message.startswith("GET /nothing 404:")
    assert 'field "error" is required but missing' in message


def test_a_405_for_a_path_the_spec_defines_passes_with_error_body_and_matching_allow():
    response = TestClient(main_app).post("/api/health")

    assert response.status_code == 405
    assert response.headers["allow"] == "GET"


@pytest.mark.parametrize("allow", ["GET, POST", "POST", ""], ids=["extra", "other", "missing"])
def test_a_405_whose_allow_header_differs_from_the_spec_fails(allow):
    headers = {"content-type": "application/json", **({"allow": allow} if allow else {})}
    request, response = request_and_response(
        "POST",
        "/api/health",
        405,
        json={"error": {"code": "method_not_allowed", "message": "m"}},
        headers=headers,
    )

    message = violation_message(lambda: contract_for(main_app).check(request, response))

    assert message.startswith("POST /api/health 405:")
    assert "Allow header" in message
    assert "['GET']" in message


def test_a_405_with_a_body_not_in_the_shared_shape_fails():
    request, response = request_and_response(
        "POST", "/api/health", 405, json={"detail": "no"}, headers={"allow": "GET"}
    )

    message = violation_message(lambda: contract_for(main_app).check(request, response))

    assert message.startswith("POST /api/health 405:")
    assert "not the shared error shape" in message


def test_a_known_path_with_an_undefined_method_fails_for_a_status_other_than_405():
    request, response = request_and_response("POST", "/api/health", 200, json={})

    message = violation_message(lambda: contract_for(main_app).check(request, response))

    assert message.startswith("POST /api/health 200:")
    assert "does not define POST" in message
    assert "GET" in message


def test_a_404_from_a_route_the_spec_defines_must_be_listed_on_the_operation():
    def add(app):
        @app.get("/things/{thing_id}")
        def thing(thing_id: int):
            raise ApiError(404, "not_found", "No such thing.")

    message = violation_message(lambda: TestClient(make_app_with(add)).get("/things/1"))

    assert "GET /things/{thing_id} 404" in message
    assert "status 404 is not listed" in message


def test_a_404_listed_on_the_operation_passes():
    def add(app):
        @app.get("/things/{thing_id}", responses={404: {"model": ErrorResponse}})
        def thing(thing_id: int):
            raise ApiError(404, "not_found", "No such thing.")

    assert TestClient(make_app_with(add)).get("/things/1").status_code == 404


@pytest.mark.parametrize("status", [200, 201])
def test_a_non_error_status_from_a_route_the_spec_does_not_describe_fails(status):
    request, response = request_and_response("GET", "/api/other", status, json={})

    message = violation_message(lambda: contract_for(main_app).check(request, response))

    assert message.startswith(f"GET /api/other {status}:")
    assert message.endswith(RUN_EXPORT)


# --- the undocumented_status marker ---


@pytest.mark.undocumented_status(409, reason="the route raises a conflict on purpose")
def test_the_marker_accepts_a_listed_error_status_with_a_valid_error_body():
    def add(app):
        @app.get("/conflict")
        def conflict():
            raise ApiError(409, "taken", "Taken.")

    assert TestClient(make_app_with(add)).get("/conflict").status_code == 409


@pytest.mark.undocumented_status(409, reason="the route raises a conflict on purpose")
def test_the_marker_still_requires_the_shared_error_body():
    app = _error_app(409, {"detail": "taken"})

    message = violation_message(lambda: TestClient(app).get("/err"))

    assert 'field "error" is required but missing' in message


@pytest.mark.undocumented_status(409, reason="the route raises a conflict on purpose")
def test_the_marker_does_not_accept_other_statuses():
    app = _error_app(418, {"error": {"code": "c", "message": "m"}})

    message = violation_message(lambda: TestClient(app).get("/err"))

    assert "status 418 is not listed" in message


@pytest.mark.undocumented_status(409, reason="the route raises a conflict on purpose")
def test_the_marker_still_checks_the_content_type_of_an_exempt_status():
    def add(app):
        @app.get("/err")
        def err():
            return Response('{"error": {"code": "c", "message": "m"}}', 409, media_type="text/html")

    message = violation_message(lambda: TestClient(make_app_with(add)).get("/err"))

    assert "error responses must be application/json" in message


@pytest.mark.undocumented_status(307, reason="the route redirects on purpose")
def test_the_marker_accepts_a_3xx_with_an_empty_body():
    app = make_app_with(lambda a: a.get("/go")(lambda: RedirectResponse("/")))

    assert TestClient(app).get("/go", follow_redirects=False).status_code == 307


@pytest.mark.undocumented_status(307, reason="the route redirects on purpose")
def test_the_marker_rejects_a_3xx_with_a_body():
    app = make_app_with(
        lambda a: a.get("/go")(lambda: Response("moved", 307, headers={"location": "/"}))
    )

    message = violation_message(lambda: TestClient(app).get("/go", follow_redirects=False))

    assert "3xx response must have an empty body" in message


def test_the_marker_is_for_one_test_only():
    app = _error_app(409, {"error": {"code": "c", "message": "m"}})

    assert "status 409 is not listed" in violation_message(lambda: TestClient(app).get("/err"))


class FakeMarker:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs


def test_the_marker_takes_several_statuses_or_a_list():
    assert exempt_statuses(FakeMarker(401, 403, reason="r")) == {401, 403}
    assert exempt_statuses(FakeMarker([307, 500], reason="r")) == {307, 500}
    assert exempt_statuses(None) == frozenset()


@pytest.mark.parametrize("status", [100, 200, 201, 204, 299, 600])
def test_the_marker_rejects_a_status_that_is_not_3xx_4xx_or_5xx(status):
    with pytest.raises(MarkerError, match="only 3xx, 4xx, and 5xx"):
        exempt_statuses(FakeMarker(status, reason="r"))


@pytest.mark.parametrize("kwargs", [{}, {"reason": ""}, {"reason": "  "}, {"reason": 5}])
def test_the_marker_rejects_a_missing_or_empty_reason(kwargs):
    with pytest.raises(MarkerError, match="non-empty reason"):
        exempt_statuses(FakeMarker(409, **kwargs))


@pytest.mark.parametrize(
    ("args", "kwargs", "match"),
    [
        ((), {"reason": "r"}, "at least one status"),
        (("409",), {"reason": "r"}, "integer statuses"),
        ((True,), {"reason": "r"}, "integer statuses"),
        ((409,), {"reason": "r", "why": "x"}, "unexpected keyword"),
    ],
)
def test_the_marker_rejects_other_misuse(args, kwargs, match):
    with pytest.raises(MarkerError, match=match):
        exempt_statuses(FakeMarker(*args, **kwargs))


def test_a_bad_marker_fails_the_test_with_a_clear_message(pytester):
    pytester.makeconftest("from tests.conftest import contract_check  # noqa: F401\n")
    pytester.makepyfile(
        """
        import pytest

        @pytest.mark.undocumented_status(200, reason="success can not be exempted")
        def test_two_hundred():
            pass

        @pytest.mark.undocumented_status(409)
        def test_no_reason():
            pass

        @pytest.mark.undocumented_status(409, reason="fine")
        def test_fine():
            pass
        """
    )
    pytester.makeini("[pytest]\nmarkers =\n    undocumented_status\n")

    result = pytester.runpytest_inprocess()

    result.assert_outcomes(passed=1, errors=2)
    result.stdout.fnmatch_lines(
        ["*only 3xx, 4xx, and 5xx statuses, got 200*", "*non-empty reason*"]
    )


# --- the skip list ---


def test_the_skip_list_starts_with_the_two_routes_the_spec_lacks():
    assert list(SKIPPED_ROUTES) == ["/api/openapi.json", "/api/docs"]
    assert all(reason for reason in SKIPPED_ROUTES.values())


def test_the_real_skipped_routes_answer_without_a_failure():
    client = TestClient(main_app)

    assert client.get("/api/openapi.json").status_code == 200
    assert client.get("/api/docs").status_code == 200
    assert client.post("/api/docs").status_code == 405  # any method, never checked


def test_a_path_that_only_starts_like_a_skipped_one_gets_the_normal_404_rule():
    response = TestClient(main_app).get("/api/docs/x")

    assert response.status_code == 404
    request, ok = request_and_response("GET", "/api/docs/x", 200, json={})
    message = violation_message(lambda: contract_for(main_app).check(request, ok))
    assert message.endswith(RUN_EXPORT)


def test_a_skipped_path_is_not_checked_and_the_same_path_unskipped_is():
    app = make_app_with(lambda a: a.get("/skipme")(lambda: JSONResponse({}, status_code=202)))
    with pytest.raises(ContractViolation) as info:
        TestClient(app).get("/skipme")
    request, response = info.value.request, info.value.response

    contract_for(main_app, {"/skipme": "a test of the skip list"}).check(request, response)
    unskipped = violation_message(lambda: contract_for(main_app, {}).check(request, response))

    assert "202" in unskipped


def test_skip_matching_is_exact_and_for_any_method():
    checker = small_contract({}, skipped={"/files/{name}": "served by hand", "/plain": "r"})
    for method in ("GET", "POST", "DELETE"):
        checker.check(*request_and_response(method, "/files/a", 200, json={}))
        checker.check(*request_and_response(method, "/plain", 200, json={}))

    for path in ("/files/a/b", "/files", "/plain/x", "/plainer", "/x/plain"):
        request, response = request_and_response("GET", path, 200, json={})
        with pytest.raises(ContractViolation):
            checker.check(request, response)


def test_the_skip_list_applies_only_to_the_main_app():
    app = make_app_with(lambda a: a.get("/skipme")(lambda: JSONResponse({}, status_code=202)))
    client = TestClient(app)

    message = violation_message(lambda: client.get("/skipme"))

    assert "GET /skipme 202" in message
    assert contract_for(app, {"/skipme": "ignored for a throwaway app"}) is contract_for(app)


def test_every_route_of_the_main_app_is_in_the_spec_or_the_skip_list():
    document = yaml.safe_load(COMMITTED_SPEC.read_bytes())

    assert route_problems(main_app, document, SKIPPED_ROUTES) == []


def test_a_route_in_neither_the_spec_nor_the_skip_list_is_a_problem():
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
    app.get("/api/forgotten")(empty)
    document = yaml.safe_load(COMMITTED_SPEC.read_bytes())

    problems = route_problems(app, document, {})

    assert problems == [
        f"route /api/forgotten is not in openapi.yaml or the skip list; {RUN_EXPORT}"
    ]


def test_a_route_method_missing_from_the_spec_is_a_problem():
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
    app.post("/api/health")(empty)
    document = yaml.safe_load(COMMITTED_SPEC.read_bytes())

    problems = route_problems(app, document, {})

    assert problems == [f"route /api/health POST is not in openapi.yaml; {RUN_EXPORT}"]


def test_a_skip_entry_for_a_route_that_does_not_exist_is_a_problem():
    document = yaml.safe_load(COMMITTED_SPEC.read_bytes())

    problems = route_problems(main_app, document, {**SKIPPED_ROUTES, "/api/gone": "stale"})

    assert problems == ["skip list entry /api/gone is not a route of the app; remove it"]


def test_a_skip_entry_for_a_route_already_in_the_spec_is_a_problem():
    document = yaml.safe_load(COMMITTED_SPEC.read_bytes())

    problems = route_problems(main_app, document, {**SKIPPED_ROUTES, "/api/health": "stale"})

    assert len(problems) == 1
    assert problems[0].startswith("/api/health is in the skip list but also in openapi.yaml")
