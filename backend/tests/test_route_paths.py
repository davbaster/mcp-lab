"""A path that ends in a newline is not the path without it (#111)."""

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.responses import PlainTextResponse
from starlette.routing import Match, Route

from app.main import app
from app.route_paths import install_strict_paths
from tests.auth_support import PASSWORD, URL, assert_error, cookie_headers, count, login, register
from tests.obs_support import capture_logs, page, request_lines, rose, throwaway_app

# The routes whose last part is a parameter. A newline there becomes part of the ID, which is a
# miss with the route's own error code (see the controls below), so these are not aliases.
ENDS_IN_PARAMETER = {
    "/api/courses/{course_id}/lessons/{lesson_id}",
    "/api/courses/{course_id}/assets/{file_name}",
}
STRICT_ROUTES = [r for r in app.routes if r.path_format not in ENDS_IN_PARAMETER]
SAMPLE_VALUES = {
    "course_id": "alpha-course",
    "chapter_id": "01-basics",
    "lesson_id": "hello",
    "file_name": "x.png",
}
ALPHA = "/api/courses/alpha-course"


def method_of(route) -> str:
    return min(m for m in route.methods if m != "HEAD")


def concrete_path(route) -> str:
    """The route's template filled in with sample values, checked to match the route itself."""
    template = route.path_format
    try:
        path = template.format(**{name: SAMPLE_VALUES[name] for name in route.param_convertors})
    except KeyError as missing:
        pytest.fail(f"{template}: no sample value for the path parameter {missing}", pytrace=False)
    scope = {"type": "http", "method": method_of(route), "path": path, "root_path": ""}
    if route.matches(scope)[0] is not Match.FULL:
        pytest.fail(f"{template}: the sample path {path} does not match it", pytrace=False)
    return path


# --- every route, now and later ---


@pytest.mark.parametrize("route", STRICT_ROUTES, ids=lambda route: route.path_format)
def test_a_path_with_a_trailing_newline_is_404_not_found_on_every_route(route, serve):
    path = concrete_path(route)

    response = serve().request(method_of(route), path + "%0a", json={})

    assert_error(response, 404, "not_found")
    assert response.json()["error"]["message"]


def test_the_routes_that_end_in_a_parameter_are_the_two_known_ones():
    # A new route that ends in a parameter must be looked at, not skipped by accident.
    ends_in_parameter = {r.path_format for r in app.routes if r.path_format.endswith("}")}

    assert ends_in_parameter == ENDS_IN_PARAMETER
    assert {r.path_format for r in STRICT_ROUTES} | ENDS_IN_PARAMETER == {
        r.path_format for r in app.routes
    }


# --- the fix on its own, for both route classes ---


def throwaway(strict: bool) -> FastAPI:
    """A plain route, a route with a parameter, and a Starlette `Route` (the class of `/api/docs`)."""
    small = throwaway_app()

    @small.get("/plain")
    def plain() -> dict:
        return {"ok": True}

    @small.get("/things/{thing_id}/info")
    def info(thing_id: str) -> dict:
        return {"thing": thing_id}

    async def page_endpoint(request: Request):
        return PlainTextResponse("page")

    small.router.routes.append(Route("/page", page_endpoint))
    if strict:
        install_strict_paths(small)
    return small


THROWAWAY_PATHS = ["/plain", "/things/x/info", "/page"]


def serves(small: FastAPI, path: str) -> bool:
    """Whether a GET on `path` fully matches a route (the router's answer, as uvicorn gives it)."""
    scope = {"type": "http", "method": "GET", "path": path, "root_path": ""}
    return any(route.matches(scope)[0] is Match.FULL for route in small.router.routes)


@pytest.mark.parametrize("path", THROWAWAY_PATHS)
def test_without_the_fix_the_newline_alias_matches_a_route(path):
    small = throwaway(strict=False)

    assert serves(small, path)
    assert serves(small, path + "\n")


@pytest.mark.parametrize("path", THROWAWAY_PATHS)
def test_install_strict_paths_on_a_throwaway_app_rejects_the_alias_only(path):
    small = throwaway(strict=True)

    assert serves(small, path)
    assert not serves(small, path + "\n")
    with TestClient(small) as client:
        assert_error(client.get(path + "%0a"), 404, "not_found")


# --- a rejected request does nothing ---


def test_register_with_a_trailing_newline_creates_no_account(client, db):
    response = client.post(f"{URL}/register%0a", json={"username": "ana1", "password": PASSWORD})

    assert_error(response, 404, "not_found")
    assert count(db, "accounts") == 0
    assert cookie_headers(response) == []


def test_login_with_a_trailing_newline_sets_no_cookie_and_adds_no_session(client, db):
    assert register(client).status_code == 201
    sessions = count(db, "sessions")
    client.cookies.clear()

    response = client.post(f"{URL}/login%0a", json={"username": "ana1", "password": PASSWORD})

    assert_error(response, 404, "not_found")
    assert cookie_headers(response) == []
    assert count(db, "sessions") == sessions
    assert login(client).status_code == 200  # the same request without the newline works


# --- the other forms of the alias ---


def test_a_wrong_method_on_the_alias_is_404_not_found_not_405(serve):
    assert_error(serve().post("/api/health%0a"), 404, "not_found")


def test_the_slash_redirect_does_not_follow_the_alias(serve):
    response = serve().get("/api/health%0a/", follow_redirects=False)

    assert_error(response, 404, "not_found")
    assert "location" not in response.headers


def test_a_query_string_does_not_change_the_answer(serve):
    assert_error(serve().get("/api/courses%0a?x=1"), 404, "not_found")


def test_a_rejected_alias_is_logged_and_counted_as_unmatched(serve):
    client = serve()
    before = page()

    with capture_logs() as stream:
        client.get("/api/health%0a")
    after = page()

    (line,) = request_lines(stream)
    assert (line["method"], line["route"], line["status"]) == ("GET", "unmatched", 404)
    assert rose(before, after, "http_requests_total") == {
        (("method", "GET"), ("route", "unmatched"), ("status", "404")): 1
    }


# --- nothing else changes ---


@pytest.mark.parametrize(
    ("path", "code"),
    [
        (f"{ALPHA}/lessons/hello%0a", "lesson_not_found"),
        (f"{ALPHA}/assets/x.png%0a", "asset_not_found"),
        (f"{ALPHA}/chapters/01-basics%0a/code", "chapter_not_found"),
        (f"{ALPHA}/chapters/01-basics%0a/code.zip", "chapter_not_found"),
        ("/api/courses/alpha-course%0a/chapters", "course_not_found"),
        ("/api/health%0a%0a", "not_found"),
        ("/api/health%0d", "not_found"),
        ("/api/health%0d%0a", "not_found"),
        ("/api/health%0a%0d", "not_found"),
    ],
)
def test_these_paths_keep_their_own_answers(path, code, serve):
    assert_error(serve().get(path), 404, code)


@pytest.mark.parametrize(
    "path",
    [
        "/api/health",
        "/api/courses",
        f"{ALPHA}/chapters",
        "/api/openapi.json",
        "/api/docs",
    ],
)
def test_the_plain_path_still_answers(path, serve):
    assert serve().get(path).status_code == 200


@pytest.mark.undocumented_status(307, reason="the slash redirect of a path the spec does not list")
def test_the_slash_redirect_of_a_normal_path_is_unchanged(serve):
    response = serve().get("/api/health/", follow_redirects=False)

    assert response.status_code == 307
    assert response.headers["location"].endswith("/api/health")
