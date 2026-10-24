"""Error behavior: every error uses the shared shape, with the right status and code."""

import logging

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.errors import ApiError, install_error_handling
from app.main import app

SENTINEL = "ERR-SENTINEL-4d2b"


def assert_error(response, status, code, message=None):
    assert response.status_code == status
    assert response.headers["content-type"] == "application/json"
    body = response.json()
    assert list(body) == ["error"]
    assert sorted(body["error"]) == ["code", "message"]
    assert body["error"]["code"] == code
    assert isinstance(body["error"]["message"], str)
    if message is not None:
        assert body["error"]["message"] == message
    return body["error"]["message"]


class Item(BaseModel):
    name: str
    qty: int = 1


class Payload(BaseModel):
    items: list[Item]


class Secret(BaseModel):
    count: int


def make_app() -> FastAPI:
    throwaway = FastAPI()
    install_error_handling(throwaway)

    @throwaway.post("/payload")
    def payload(body: Payload) -> dict[str, str]:
        return {}

    @throwaway.post("/secret")
    def secret(body: Secret) -> dict[str, str]:
        return {}

    @throwaway.get("/query")
    def query(limit: int) -> dict[str, str]:
        return {}

    @throwaway.get("/things/{thing_id}")
    def thing(thing_id: int) -> dict[str, str]:
        return {}

    @throwaway.get("/boom")
    def boom() -> dict[str, str]:
        raise RuntimeError(f"boom {SENTINEL}")

    @throwaway.get("/bad-response", response_model=Secret)
    def bad_response() -> dict[str, str]:
        return {"count": "not a number"}

    @throwaway.get("/api-error")
    def api_error() -> dict[str, str]:
        raise ApiError(409, "username_taken", "That username is taken.")

    @throwaway.get("/http/{status}")
    def http(status: int) -> dict[str, str]:
        raise StarletteHTTPException(status, "Custom detail", headers={"X-Extra": "kept"})

    @throwaway.get("/fastapi-http")
    def fastapi_http() -> dict[str, str]:
        raise HTTPException(401, detail={"nested": True}, headers={"WWW-Authenticate": "Bearer"})

    def guard() -> None:
        raise HTTPException(403, "Nope", headers={"WWW-Authenticate": "Basic"})

    @throwaway.get("/guarded", dependencies=[Depends(guard)])
    def guarded() -> dict[str, str]:
        return {}

    return throwaway


@pytest.fixture
def client():
    return TestClient(make_app(), raise_server_exceptions=False)


@pytest.fixture
def real():
    return TestClient(app)


# --- unknown route, wrong method (real app) ---


@pytest.mark.parametrize("path", ["/api/nope", "/api", "/api/health/nope", "/nope"])
def test_unknown_route_is_404_not_found(real, path):
    assert_error(real.get(path), 404, "not_found")


@pytest.mark.parametrize("method", ["post", "put", "delete", "patch"])
def test_wrong_method_is_405_and_keeps_allow(real, method):
    response = getattr(real, method)("/api/health")

    assert_error(response, 405, "method_not_allowed")
    assert response.headers["allow"] == "GET"


def test_head_is_405_with_allow(real):
    response = real.head("/api/health")

    assert response.status_code == 405
    assert response.headers["allow"] == "GET"


def test_options_is_405_with_allow(real):
    response = real.options("/api/health")

    assert response.status_code == 405
    assert response.headers["allow"] == "GET"


def test_no_cors_headers_are_added(real):
    response = real.get("/api/health", headers={"Origin": "http://example.com"})

    assert "access-control-allow-origin" not in response.headers


def test_unknown_query_parameters_are_ignored(real):
    response = real.get("/api/health?x=1")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_trailing_slash_redirects_to_the_route(real):
    response = real.get("/api/health/", follow_redirects=False)

    assert response.status_code == 307
    assert response.headers["location"].endswith("/api/health")


# --- other HTTPException ---


def test_http_exception_becomes_http_error_with_its_status_and_headers(client):
    response = client.get("/http/418")

    assert_error(response, 418, "http_error", "Custom detail")
    assert response.headers["x-extra"] == "kept"


def test_fastapi_http_exception_with_non_string_detail_uses_the_reason_phrase(client):
    response = client.get("/fastapi-http")

    assert_error(response, 401, "http_error", "Unauthorized")
    assert response.headers["www-authenticate"] == "Bearer"


def test_http_exception_raised_in_a_dependency_keeps_its_headers(client):
    response = client.get("/guarded")

    assert_error(response, 403, "http_error", "Nope")
    assert response.headers["www-authenticate"] == "Basic"


def test_http_exception_with_no_body_status_sends_no_body(client):
    response = client.get("/http/204")

    assert response.status_code == 204
    assert response.content == b""


# --- ApiError ---


def test_api_error_returns_its_status_code_and_message(client):
    response = client.get("/api-error")

    assert_error(response, 409, "username_taken", "That username is taken.")


# --- validation ---


def test_invalid_query_is_422_validation_error(client):
    message = assert_error(client.get("/query?limit=abc"), 422, "validation_error")

    assert message.startswith("query.limit: ")


def test_missing_query_parameter_is_422(client):
    message = assert_error(client.get("/query"), 422, "validation_error")

    assert message.startswith("query.limit: ")


def test_invalid_path_parameter_is_422(client):
    message = assert_error(client.get("/things/abc"), 422, "validation_error")

    assert message.startswith("path.thing_id: ")


def test_nested_body_error_names_the_field_path_with_list_index(client):
    body = {"items": [{"name": "a"}, {"name": "b"}, {"qty": 2}]}

    message = assert_error(client.post("/payload", json=body), 422, "validation_error")

    assert "body.items[2].name" in message
    assert message.startswith("body.items[2].name: ")


def test_several_errors_are_joined_with_semicolons(client):
    body = {"items": [{}, {"name": "x", "qty": "many"}]}

    message = assert_error(client.post("/payload", json=body), 422, "validation_error")

    assert message.count("; ") == 1
    assert "body.items[0].name" in message and "body.items[1].qty" in message


def test_body_that_is_not_json_is_422_without_the_raw_body(client):
    raw = f"{{not json {SENTINEL}"

    response = client.post("/payload", content=raw, headers={"content-type": "application/json"})

    message = assert_error(response, 422, "validation_error")
    assert message.startswith("body")
    assert SENTINEL not in response.text


def test_missing_required_body_is_422(client):
    message = assert_error(client.post("/payload"), 422, "validation_error")

    assert message.startswith("body")


def test_submitted_values_are_in_neither_the_response_nor_the_logs(client, caplog):
    caplog.set_level(logging.DEBUG)

    response = client.post("/secret", json={"count": SENTINEL})

    assert_error(response, 422, "validation_error")
    assert SENTINEL not in response.text
    assert SENTINEL not in caplog.text


def test_a_422_lists_at_most_5_errors_and_counts_the_rest(client):
    body = {"items": [{} for _ in range(20)]}

    message = assert_error(client.post("/payload", json=body), 422, "validation_error")

    assert message.endswith("and 15 more")
    assert message.count("body.items[") == 5
    assert "body.items[4].name" in message
    assert "body.items[5].name" not in message


def test_exactly_5_errors_have_no_and_more(client):
    body = {"items": [{} for _ in range(5)]}

    message = assert_error(client.post("/payload", json=body), 422, "validation_error")

    assert "more" not in message


# --- unexpected exceptions ---


def test_unexpected_exception_is_500_internal_error_without_details(client):
    response = client.get("/boom")

    assert_error(response, 500, "internal_error", "Internal server error.")
    for leaked in (SENTINEL, "RuntimeError", "Traceback", ".py"):
        assert leaked not in response.text


def test_failing_response_model_is_500_not_422(client):
    response = client.get("/bad-response")

    assert_error(response, 500, "internal_error", "Internal server error.")


def test_unexpected_exception_is_logged_once_with_trace_method_and_path(client, caplog):
    caplog.set_level(logging.DEBUG)

    client.get("/boom?token=QUERY-SENTINEL-77", headers={"Cookie": "sid=COOKIE-SENTINEL-77"})

    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(errors) == 1
    record = errors[0]
    assert record.exc_info is not None
    assert isinstance(record.exc_info[1], RuntimeError)
    assert "GET" in record.getMessage() and "/boom" in record.getMessage()
    # The test client's own httpx logger prints the URL; only the app's records matter here.
    app_text = "\n".join(r.getMessage() for r in caplog.records if r.name != "httpx")
    assert "QUERY-SENTINEL-77" not in app_text
    assert "COOKIE-SENTINEL-77" not in app_text


def test_unexpected_exception_log_does_not_hold_the_request_body(client, caplog):
    caplog.set_level(logging.DEBUG)

    client.post("/boom", json={"secret": "BODY-SENTINEL-77"})

    assert "BODY-SENTINEL-77" not in "\n".join(r.getMessage() for r in caplog.records)
