"""The Prometheus metrics (#36): settings, exposure, labels, and every series."""

import random
import re
import socket
import threading
import urllib.error
import urllib.request

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from app import metrics, rate_limit
from app.db import create_db_engine, get_database_url, get_engine
from app.deployment import DeploymentError, parse_deployment
from app.errors import ApiError, ErrorResponse
from app.main import app
from app.metrics import BUCKETS, Metrics
from app.metrics_server import MetricsPortError, parse_metrics_port
from tests.auth_support import PASSWORD, URL, assert_error, login, new_client, register
from tests.content_support import committed_spec
from tests.course_support import FIXTURE_BUILD
from tests.dbtools import BACKEND_DIR
from tests.limit_support import run_together
from tests.obs_support import (
    Page,
    fetch,
    metrics_port,
    page,
    rose,
    throwaway_app,
)
from tests.quiz_support import EPSILON, answers, attempt_url, submit

ALPHA = "/api/courses/alpha-course/lessons"
GAMMA = "/api/courses/gamma-course/lessons"
SERIES_NAMES = {
    "http_requests_total",
    "http_request_duration_seconds_bucket",
    "http_request_duration_seconds_count",
    "http_request_duration_seconds_sum",
    "lesson_loads_total",
    "quiz_submissions_total",
    "quiz_submission_errors_total",
    "auth_attempts_total",
    "db_connection_errors_total",
    "db_pool_in_use",
    "db_pool_waiting",
    "db_pool_size",
}


def _worst_case(courses: int = 1) -> int:
    """The README's number: the most samples the page can hold for the default setup."""
    routes = {(r.path_format, m) for r in app.routes for m in r.methods if m != "HEAD"}
    statuses = {
        code
        for p in committed_spec()["paths"].values()
        for op in p.values()
        for code in op["responses"]
    }
    return metrics.worst_case_samples(routes, len(statuses), courses)


WORST_CASE = _worst_case()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


COURSE_IDS = {"alpha-course", "gamma-course", "epsilon-course"}  # `attempt_api` serves these


@pytest.fixture
def api(attempt_api):
    """The app serving alpha, gamma, and epsilon, with a client that keeps its cookies."""
    return attempt_api


@pytest.fixture
def learner(ana):
    """The client, signed in as `ana1`."""
    return ana


@pytest.fixture
def unreachable_database(monkeypatch):
    """The app's engine points at a port where nothing listens."""
    url = get_database_url().set(port=free_port())
    monkeypatch.setenv("DATABASE_URL", url.render_as_string(hide_password=False))
    get_engine.cache_clear()
    yield url
    get_engine.cache_clear()


# --- settings ---


@pytest.mark.parametrize(
    "value", [None, "", "Local", "my_env", "a b", "x.y", "-é", "UPPER", "a/b", "host"]
)
def test_a_missing_or_invalid_deployment_is_an_error_naming_the_variable(value):
    with pytest.raises(DeploymentError, match="DEPLOYMENT"):
        parse_deployment(value)


@pytest.mark.parametrize("value", ["local", "staging", "prod-1", "0", "a-b-c", "hostile", "host1"])
def test_a_valid_deployment_is_accepted(value):
    assert parse_deployment(value) == value


@pytest.mark.parametrize("value", [None, "", "host", "Bad_Name"])
def test_the_app_does_not_start_without_a_valid_deployment(value, monkeypatch):
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", str(FIXTURE_BUILD))
    if value is None:
        monkeypatch.delenv("DEPLOYMENT")
    else:
        monkeypatch.setenv("DEPLOYMENT", value)

    with pytest.raises(DeploymentError, match="DEPLOYMENT"), TestClient(app):
        pass


def test_the_default_metrics_port_is_9000():
    assert parse_metrics_port(None) == 9000
    assert parse_metrics_port("9100") == 9100


@pytest.mark.parametrize("value", ["", "abc", "-1", "65536", "90 00", "9000.5", "0x10", "٣"])
def test_a_metrics_port_that_is_not_a_port_number_stops_the_app_naming_the_variable(
    value, monkeypatch
):
    with pytest.raises(MetricsPortError, match="METRICS_PORT"):
        parse_metrics_port(value)
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", str(FIXTURE_BUILD))
    monkeypatch.setenv("METRICS_PORT", value)

    with pytest.raises(MetricsPortError, match="METRICS_PORT"), TestClient(app):
        pass


def test_a_metrics_port_in_use_stops_the_app_naming_the_variable(monkeypatch):
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", str(FIXTURE_BUILD))
    with socket.socket() as taken:
        taken.bind(("0.0.0.0", 0))
        taken.listen()
        monkeypatch.setenv("METRICS_PORT", str(taken.getsockname()[1]))

        with pytest.raises(MetricsPortError, match="METRICS_PORT"), TestClient(app):
            pass

    assert metrics.current() is None  # nothing is left reporting


def test_the_port_is_free_after_shutdown_and_a_second_start_in_the_same_process_works(
    monkeypatch,
):
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", str(FIXTURE_BUILD))
    port = free_port()
    monkeypatch.setenv("METRICS_PORT", str(port))

    for _ in range(2):
        with TestClient(app):
            assert fetch(port=port)[0] == 200
        with pytest.raises(urllib.error.URLError):
            fetch(port=port)  # closed
        with socket.socket() as probe:
            # Free for anyone else too. (A server sets SO_REUSEADDR, so the closed connection of
            # the scrape, which sits in TIME_WAIT, does not block it.)
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("0.0.0.0", port))
            probe.listen()


# --- exposure and access ---


def test_the_metrics_port_serves_the_prometheus_text_format_and_nothing_else(api):
    status, content_type, body = fetch()

    assert status == 200
    assert content_type.startswith("text/plain; version=")
    assert "# TYPE http_requests_total counter" in body
    assert fetch("/")[0] == 404
    assert fetch("/api/health")[0] == 404
    assert fetch("/metrics/x")[0] == 404
    assert fetch("/metrics?x=1")[0] == 200


def test_the_metrics_port_answers_other_methods_with_405(api):
    request = urllib.request.Request(f"http://127.0.0.1:{metrics_port()}/metrics", method="POST")

    with pytest.raises(urllib.error.HTTPError) as raised:
        urllib.request.urlopen(request, timeout=10)

    assert raised.value.code == 405


def test_a_scrape_returns_200_with_the_database_down_and_opens_no_connection(
    unreachable_database, serve
):
    serve("alpha-course")

    first = fetch()
    second = fetch()

    assert first[0] == 200 and second[0] == 200
    after = Page(second[2])
    assert after.total("db_connection_errors_total") == 0
    assert after.get("db_pool_in_use") == 0
    assert after.get("db_pool_waiting") == 0
    assert after.get("db_pool_size") == 0  # no engine created yet


@pytest.mark.parametrize("path", ["/metrics", "/api/metrics", "/metrics/", "/api/metrics/x"])
def test_the_main_app_does_not_serve_metrics(api, path):
    response = api.get(path)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert "http_requests_total" not in response.text


def test_metrics_are_not_in_the_openapi_document():
    assert not [path for path in committed_spec()["paths"] if "metrics" in path]
    assert not [path for path in app.openapi()["paths"] if "metrics" in path]


def test_every_sample_has_the_deployment_and_only_the_apps_own_series_are_exposed(learner):
    learner.get("/api/health")
    learner.get(f"{ALPHA}/hello")
    learner.get("/nope")

    samples = page().samples

    assert samples
    assert {s.labels.get("deployment") for s in samples} == {"test"}
    assert {s.name for s in samples} <= SERIES_NAMES
    assert not [s for s in samples if s.name.startswith(("process_", "python_"))]


# --- the HTTP series ---


def test_a_request_is_counted_once_with_its_method_route_and_status(api):
    before = page()

    api.get("/api/health")

    after = page()
    key = (("method", "GET"), ("route", "/api/health"), ("status", "200"))
    assert rose(before, after, "http_requests_total") == {key: 1}
    assert rose(before, after, "http_request_duration_seconds_count") == {key: 1}


def test_the_histogram_buckets_are_the_documented_bounds(api):
    api.get("/api/health")

    bounds = {s.labels["le"] for s in page().select("http_request_duration_seconds_bucket")}

    assert bounds == {
        "0.005",
        "0.01",
        "0.025",
        "0.05",
        "0.1",
        "0.25",
        "0.5",
        "1.0",
        "2.5",
        "5.0",
        "10.0",
        "+Inf",
    }
    assert BUCKETS == (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)


def test_a_500_and_a_503_land_in_the_5xx_series():
    app_ = throwaway_app()

    @app_.get("/boom")
    def boom():
        raise RuntimeError("boom")

    @app_.get("/busy", responses={503: {"model": ErrorResponse}})
    def busy():
        raise ApiError(503, "unavailable", "Try later.")

    with TestClient(app_, raise_server_exceptions=False) as client:
        client.get("/boom")
        client.get("/busy")
        client.get("/busy")
        result = page()

    series = {
        s.labels["status"]: s.value
        for s in result.select("http_requests_total")
        if s.labels["status"].startswith("5")
    }
    assert series == {"500": 1, "503": 2}
    assert result.total("http_requests_total", status="500", route="/boom") == 1
    assert result.total("http_request_duration_seconds_count", status="500") == 1


def test_an_unhandled_exception_is_one_request_with_status_500():
    app_ = throwaway_app()

    @app_.get("/boom")
    def boom():
        raise RuntimeError("boom")

    with TestClient(app_, raise_server_exceptions=False) as client:
        response = client.get("/boom")
        result = page()

    assert response.status_code == 500
    assert result.total("http_requests_total") == 1
    assert result.get("http_requests_total", method="GET", route="/boom", status="500") == 1


@pytest.mark.parametrize(
    ("method", "label"),
    [("GET", "GET"), ("POST", "POST"), ("PUT", "PUT"), ("PATCH", "PATCH"), ("DELETE", "DELETE"),
     ("HEAD", "HEAD"), ("OPTIONS", "OPTIONS"), ("FOO", "other"), ("TRACE", "other"), ("PROPFIND", "other")],
)  # fmt: skip
def test_the_method_label_is_one_of_eight_values(api, method, label):
    before = page()

    api.request(method, "/nope")

    assert rose(before, page(), "http_requests_total") == {
        (("method", label), ("route", "unmatched"), ("status", "404")): 1
    }


def test_status_is_the_numeric_code_as_a_string(api):
    api.get("/nope")

    assert page().get("http_requests_total", method="GET", route="unmatched", status="404") == 1


def concrete(template: str) -> str:
    return re.sub(
        r"\{(\w+)\}", lambda m: "alpha-course" if m.group(1) == "course_id" else "x", template
    )


def test_every_route_is_labelled_with_its_template(api):
    checked = []
    for route in app.routes:
        template = route.path_format
        method = min(m for m in route.methods if m != "HEAD")
        before = page()

        response = api.request(method, concrete(template), json={} if method != "GET" else None)

        rises = rose(before, page(), "http_requests_total")
        assert rises == {
            (("method", method), ("route", template), ("status", str(response.status_code))): 1
        }, template
        checked.append(template)
    assert "/api/courses/{course_id}/assets/{file_name}" in checked
    assert len(checked) == len(set(checked)) > 10
    assert len(page().samples) <= WORST_CASE


def test_every_api_route_label_is_a_path_of_the_openapi_document():
    spec_paths = set(committed_spec()["paths"])
    templates = {r.path_format for r in app.routes if getattr(r, "include_in_schema", False)}

    assert templates == spec_paths
    assert not [t for t in templates if ":" in t]
    assert {r.path_format for r in app.routes} - templates == {"/api/openapi.json", "/api/docs"}


@pytest.mark.undocumented_status(307, reason="the slash redirect of a path the spec does not list")
def test_routes_that_did_not_fully_match_are_unmatched(api):
    cases = [
        ("GET", "/nope"),
        ("POST", "/api/health"),  # wrong method: 405
        ("GET", "/api/courses/"),  # slash redirect: 307
        ("GET", "/api/health/"),
        ("DELETE", "/api/auth/login"),
    ]
    for method, path in cases:
        before = page()

        response = api.request(method, path, follow_redirects=False)

        rises = rose(before, page(), "http_requests_total")
        assert list(rises.values()) == [1], path
        assert dict(next(iter(rises)))["route"] == "unmatched", (path, response.status_code)
    assert api.request("GET", "/api/courses/", follow_redirects=False).status_code == 307


def test_a_matched_route_that_answers_404_itself_keeps_its_template(api):
    before = page()

    response = api.get(f"{ALPHA}/no-such-lesson")

    assert response.status_code == 404
    assert rose(before, page(), "http_requests_total") == {
        (
            ("method", "GET"),
            ("route", "/api/courses/{course_id}/lessons/{lesson_id}"),
            ("status", "404"),
        ): 1
    }


def test_no_raw_path_query_or_input_reaches_the_page(api):
    api.get("/api/courses/SENTINEL-ZZ/lessons/SENTINEL-YY")
    api.get("/nope?token=SENTINEL-TT")
    api.get("/api/courses/SENTINEL-ZZ/chapters/SENTINEL-XX/quiz")
    api.request("SENTINEL-MM", "/api/health")

    body = fetch()[2]

    assert "SENTINEL" not in body
    assert "token" not in body


def test_the_course_label_comes_from_the_catalog_never_from_the_url(learner):
    learner.get(f"{ALPHA}/hello")
    learner.get("/api/courses/SENTINEL-ZZ/lessons/hello")

    result = page()

    assert {s.labels["course"] for s in result.select("lesson_loads_total")} == COURSE_IDS
    assert result.get("lesson_loads_total", course="alpha-course") == 1
    assert "SENTINEL" not in result.text


def test_random_course_ids_add_no_series(learner):
    rng = random.Random(36)

    def ids(count):
        return [
            "".join(rng.choice("abcdefghijklmnop-0123456789") for _ in range(12))
            for _ in range(count)
        ]

    def send(course):
        learner.get(f"/api/courses/{course}/lessons/hello")
        learner.get(f"/api/courses/{course}/chapters/01-first/quiz")
        learner.post(attempt_url("01-first", course=course), json={"answers": answers()})

    send("unknown-warmup")
    before = page()

    for course in ids(50):
        send(course)

    after = page()
    assert len(after.samples) == len(before.samples)
    assert rose(before, after, "lesson_loads_total") == {}
    assert rose(before, after, "quiz_submissions_total") == {}
    assert rose(before, after, "quiz_submission_errors_total") == {}
    # the requests themselves were counted, under the route templates
    assert after.total("http_requests_total") - before.total("http_requests_total") == 150


def test_series_exist_at_zero_right_after_startup(serve):
    serve("alpha-course,epsilon-course")

    result = page()

    for course in ("alpha-course", "epsilon-course"):
        assert result.get("lesson_loads_total", course=course) == 0
        assert result.get("quiz_submission_errors_total", course=course) == 0
        assert result.get("quiz_submissions_total", course=course, outcome="passed") == 0
        assert result.get("quiz_submissions_total", course=course, outcome="failed") == 0
    assert {
        (s.labels["action"], s.labels["outcome"]): s.value
        for s in result.select("auth_attempts_total")
    } == {key: 0 for key in metrics.AUTH_OUTCOMES}
    assert {s.labels["reason"]: s.value for s in result.select("db_connection_errors_total")} == {
        reason: 0 for reason in ("auth", "timeout", "refused", "pool_exhausted", "other")
    }
    assert result.get("db_pool_in_use") == result.get("db_pool_waiting") == 0


# --- exact counting ---


def test_ten_requests_raise_the_counter_and_the_histogram_count_by_ten(api):
    before = page()

    for _ in range(10):
        api.get("/api/health")

    after = page()
    key = (("method", "GET"), ("route", "/api/health"), ("status", "200"))
    assert rose(before, after, "http_requests_total") == {key: 10}
    assert rose(before, after, "http_request_duration_seconds_count") == {key: 10}


def test_requests_from_five_threads_are_all_counted(api):
    before = page()

    def work():
        client = new_client()
        return [client.get("/api/health").status_code for _ in range(2)]

    run_together([work] * 5)

    after = page()
    key = (("method", "GET"), ("route", "/api/health"), ("status", "200"))
    assert rose(before, after, "http_requests_total") == {key: 10}
    assert rose(before, after, "http_request_duration_seconds_count") == {key: 10}


# --- lessons and quizzes ---


def test_lesson_loads_count_only_200s(learner, api):
    before = page()

    assert learner.get(f"{GAMMA}/middle-lesson").status_code == 403  # locked
    assert learner.get(f"{GAMMA}/nope").status_code == 404
    assert new_client().get(f"{GAMMA}/middle-lesson").status_code == 401
    assert rose(before, page(), "lesson_loads_total") == {}
    assert learner.get(f"{GAMMA}/intro-lesson").status_code == 200

    assert rose(before, page(), "lesson_loads_total") == {(("course", "gamma-course"),): 1}


def test_a_visitor_in_a_free_preview_counts_as_a_lesson_load(api):
    before = page()

    assert new_client().get(f"{GAMMA}/intro-lesson").status_code == 200

    assert rose(before, page(), "lesson_loads_total") == {(("course", "gamma-course"),): 1}


@pytest.mark.parametrize("right", [(1, 2, 3, 4, 5), (1, 2, 3, 4), (1, 3)])
def test_a_saved_attempt_counts_with_the_outcome_of_the_response(learner, right):
    before = page()

    response = submit(learner, right=right)

    passed = response.json()["passed"]
    assert passed is (len(right) >= 4)
    assert rose(before, page(), "quiz_submissions_total") == {
        (("course", EPSILON), ("outcome", "passed" if passed else "failed")): 1
    }


def test_an_attempt_that_is_not_saved_counts_nothing(learner, api):
    before = page()
    body = {"answers": answers()}
    wrong_shape = {"answers": [{"question_id": "nope", "option_id": "x"}]}

    assert new_client().post(attempt_url(), json=body).status_code == 401
    assert learner.post(attempt_url("02-second"), json=body).status_code == 403  # locked
    assert learner.post(attempt_url("99-none"), json=body).status_code == 404
    assert learner.post(attempt_url(course="nope"), json=body).status_code == 404
    assert learner.post(attempt_url(), json=wrong_shape).status_code == 422
    assert learner.post(attempt_url(), json={"answers": "x"}).status_code == 422

    after = page()
    assert rose(before, after, "quiz_submissions_total") == {}
    assert rose(before, after, "quiz_submission_errors_total") == {}


def test_a_5xx_on_the_attempt_route_counts_an_error_and_no_submission(server_errors, monkeypatch):
    import app.quiz_attempts as attempts

    def fail(*args, **kwargs):
        raise RuntimeError("the progress upsert failed")

    monkeypatch.setattr(attempts, "upsert_progress", fail)
    before = page()

    response = submit(server_errors)

    assert_error(response, 500, "internal_error")
    after = page()
    assert rose(before, after, "quiz_submission_errors_total") == {(("course", EPSILON),): 1}
    assert rose(before, after, "quiz_submissions_total") == {}


def test_a_4xx_on_the_attempt_route_is_not_an_error(learner):
    before = page()

    assert learner.post(attempt_url("02-second"), json={"answers": answers()}).status_code == 403

    assert rose(before, page(), "quiz_submission_errors_total") == {}


# --- sign-in and sign-up ---


def auth_rises(before: Page) -> dict:
    return rose(before, page(), "auth_attempts_total")


@pytest.fixture
def auth_client(api):
    return new_client()


def test_a_login_that_succeeds_counts_login_success(auth_client):
    assert register(auth_client, "ana1").status_code == 201
    before = page()

    assert login(auth_client).status_code == 200

    assert auth_rises(before) == {(("action", "login"), ("outcome", "success")): 1}


def test_a_wrong_password_counts_invalid_credentials(auth_client):
    before = page()

    assert_error(login(auth_client, "ghost1", "x" * 9), 401, "invalid_credentials")

    assert auth_rises(before) == {(("action", "login"), ("outcome", "invalid_credentials")): 1}


def test_a_login_body_that_is_not_valid_counts_validation_error(auth_client):
    before = page()

    assert auth_client.post(f"{URL}/login", json={"username": "ana1"}).status_code == 422

    assert auth_rises(before) == {(("action", "login"), ("outcome", "validation_error")): 1}


def test_a_login_that_is_rate_limited_counts_rate_limited(auth_client):
    for _ in range(rate_limit.LOGIN_USERNAME_MAX_FAILURES):
        assert login(auth_client, "ana1", "wrong-pass").status_code == 401
    before = page()

    assert_error(login(auth_client, "ana1", "wrong-pass"), 429, "too_many_attempts")

    assert auth_rises(before) == {(("action", "login"), ("outcome", "rate_limited")): 1}


def test_a_registration_counts_register_success(auth_client):
    before = page()

    assert register(auth_client).status_code == 201

    assert auth_rises(before) == {(("action", "register"), ("outcome", "success")): 1}


def test_a_taken_username_counts_username_taken(auth_client):
    assert register(auth_client).status_code == 201
    before = page()

    assert_error(register(auth_client), 409, "username_taken")

    assert auth_rises(before) == {(("action", "register"), ("outcome", "username_taken")): 1}


def test_a_registration_body_that_is_not_valid_counts_validation_error(auth_client):
    before = page()

    assert register(auth_client, "x", "short").status_code == 422

    assert auth_rises(before) == {(("action", "register"), ("outcome", "validation_error")): 1}


def test_a_status_outside_the_table_is_not_counted_as_an_auth_attempt(api, monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("the limit store failed")

    monkeypatch.setattr(rate_limit, "reserve", fail)
    client = new_client(raise_server_exceptions=False)
    before = page()

    assert login(client).status_code == 500

    after = page()
    assert rose(before, after, "auth_attempts_total") == {}
    assert (
        after.get("http_requests_total", method="POST", route="/api/auth/login", status="500") == 1
    )


def test_the_auth_pairs_on_the_page_are_the_table_and_no_identity_reaches_it(api):
    client = new_client()
    headers = {"X-Forwarded-For": "198.51.100.77", "X-Real-IP": "SENTINEL-IP-1"}
    assert register(client, "SNTLa1").status_code == 201
    assert login(client, "SNTLa1", "SENTINEL-PW-1").status_code == 401
    assert (
        client.post(
            f"{URL}/login",
            json={"username": "SENTINEL-UN-2", "password": PASSWORD},
            headers=headers,
        ).status_code
        == 401
    )
    assert register(client, "SNTLa1").status_code == 409
    assert login(client, "SNTLa1").status_code == 200
    assert client.post(f"{URL}/login", json={}, headers=headers).status_code == 422

    body = fetch()[2]
    result = Page(body)

    assert {
        (s.labels["action"], s.labels["outcome"]) for s in result.select("auth_attempts_total")
    } == set(metrics.AUTH_OUTCOMES)
    for sentinel in ("SNTLa1", "SENTINEL", "198.51.100.77", "SNTL"):
        assert sentinel not in body


# --- database connections ---


@pytest.fixture
def counting():
    """A `Metrics` that the pool reports to, for engines the test builds."""
    state = {}

    def start(engine_provider=None):
        state["metrics"] = Metrics("test", ["alpha-course"], engine=engine_provider)
        metrics.activate(state["metrics"])
        return state["metrics"]

    yield start
    if "metrics" in state:
        metrics.deactivate(state["metrics"])


def reasons(active: Metrics) -> dict[str, float]:
    from prometheus_client import generate_latest

    result = Page(generate_latest(active.registry).decode())
    return {s.labels["reason"]: s.value for s in result.select("db_connection_errors_total")}


def only(reason: str) -> dict[str, float]:
    return {
        r: (1.0 if r == reason else 0.0)
        for r in ("auth", "timeout", "refused", "pool_exhausted", "other")
    }


def test_a_closed_port_is_counted_as_refused_once(counting):
    active = counting()
    engine = create_db_engine(get_database_url().set(port=free_port()))

    with pytest.raises(OperationalError), engine.connect():
        pass

    assert reasons(active) == only("refused")
    engine.dispose()


def test_a_wrong_password_is_counted_as_auth(counting):
    active = counting()
    engine = create_db_engine(get_database_url().set(password="not-the-password"))

    with pytest.raises(OperationalError), engine.connect():
        pass

    assert reasons(active) == only("auth")
    engine.dispose()


def test_a_simulated_connect_timeout_is_counted_as_timeout(counting):
    import psycopg

    def creator():
        raise psycopg.errors.ConnectionTimeout("connection timeout expired")

    active = counting()
    engine = create_db_engine(get_database_url(), creator=creator)

    with pytest.raises(OperationalError), engine.connect():
        pass

    assert reasons(active) == only("timeout")


@pytest.mark.parametrize("error", [RuntimeError("x"), ValueError("y")])
def test_an_unclassified_driver_error_is_counted_as_other(counting, error):
    def creator():
        raise error

    active = counting()
    engine = create_db_engine(get_database_url(), creator=creator)

    with pytest.raises(type(error)), engine.connect():
        pass

    assert reasons(active) == only("other")


def test_a_driver_error_with_another_sqlstate_is_counted_as_other(counting):
    import psycopg

    def creator():
        raise psycopg.errors.TooManyConnections("too many")

    active = counting()
    engine = create_db_engine(get_database_url(), creator=creator)

    with pytest.raises(OperationalError), engine.connect():
        pass

    assert reasons(active) == only("other")


def test_a_full_pool_with_no_overflow_is_counted_as_pool_exhausted(counting):
    active = counting()
    engine = create_db_engine(get_database_url(), pool_size=1, max_overflow=0, pool_timeout=0.05)

    with engine.connect(), pytest.raises(PoolTimeoutError), engine.connect():
        pass

    assert reasons(active) == only("pool_exhausted")
    engine.dispose()


def test_a_request_that_fails_to_get_a_connection_counts_one_error_and_one_500(
    unreachable_database, serve
):
    serve("alpha-course")
    client = new_client(raise_server_exceptions=False)
    before = page()

    response = client.get("/api/auth/me", headers={"Cookie": "session=" + "a" * 43})

    assert response.status_code == 500
    after = page()
    assert rose(before, after, "db_connection_errors_total") == {(("reason", "refused"),): 1}
    assert after.get("http_requests_total", method="GET", route="/api/auth/me", status="500") == 1


# --- the pool gauges ---


def gauges(active: Metrics) -> tuple[float, float, float]:
    from prometheus_client import generate_latest

    result = Page(generate_latest(active.registry).decode())
    return tuple(result.get(name) for name in ("db_pool_in_use", "db_pool_waiting", "db_pool_size"))  # type: ignore[return-value]


def wait_until(condition, seconds: float = 10.0) -> None:
    done = threading.Event()
    for _ in range(int(seconds / 0.005)):
        if condition():
            return
        done.wait(0.005)
    raise AssertionError("the condition did not become true")


def test_the_gauges_read_in_use_waiting_and_size_of_a_pool_of_one(counting):
    engine = create_db_engine(get_database_url(), pool_size=1, max_overflow=0, pool_timeout=30)
    active = counting(lambda: engine)
    held = engine.connect()
    errors: list[BaseException] = []

    def second_checkout():
        try:
            with engine.connect():
                pass
        except BaseException as error:  # noqa: BLE001  (reported by the assertion below)
            errors.append(error)

    thread = threading.Thread(target=second_checkout)
    thread.start()
    try:
        wait_until(lambda: engine.pool.waiting == 1)
        assert gauges(active) == (1, 1, 1)
    finally:
        held.close()
        thread.join(timeout=30)
    assert not errors
    assert gauges(active) == (0, 0, 1)
    engine.dispose()


def test_waiting_is_back_to_zero_after_the_wait_times_out(counting):
    engine = create_db_engine(get_database_url(), pool_size=1, max_overflow=0, pool_timeout=0.2)
    active = counting(lambda: engine)
    errors: list[BaseException] = []

    def second_checkout():
        try:
            engine.connect()
        except BaseException as error:  # noqa: BLE001  (reported by the assertion below)
            errors.append(error)

    with engine.connect():
        thread = threading.Thread(target=second_checkout)
        thread.start()
        wait_until(lambda: engine.pool.waiting == 1 or errors)
        thread.join(timeout=30)
        assert len(errors) == 1
        assert gauges(active) == (1, 0, 1)
    engine.dispose()


def test_the_size_is_the_pool_size_plus_the_overflow(counting):
    engine = create_db_engine(get_database_url(), pool_size=3, max_overflow=4)
    active = counting(lambda: engine)

    assert gauges(active) == (0, 0, 7)
    default = create_db_engine(get_database_url())
    assert default.pool.capacity == 15  # SQLAlchemy's defaults: 5 and 10
    engine.dispose()
    default.dispose()


def test_reading_the_gauges_opens_no_connection(counting):
    engine = create_db_engine(get_database_url().set(port=free_port()))
    active = counting(lambda: engine)

    assert gauges(active) == (0, 0, 15)
    assert reasons(active) == {
        "auth": 0,
        "timeout": 0,
        "refused": 0,
        "pool_exhausted": 0,
        "other": 0,
    }
    engine.dispose()


def test_the_gauges_are_read_when_the_page_is_built(learner, db):
    first = page()
    with get_engine().connect():
        held = page()

    assert first.get("db_pool_size") == 15
    assert held.get("db_pool_in_use") >= 1
    assert page().get("db_pool_in_use") == 0


# --- the size of the page ---


def test_the_number_of_samples_does_not_grow_with_random_paths_methods_or_courses(learner):
    rng = random.Random(7)
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_"

    def word(n=10):
        return "".join(rng.choice(alphabet) for _ in range(n))

    def lesson_of_a_random_course():
        return learner.get(f"/api/courses/{word()}/lessons/{word()}")

    # one of each kind first, so that their series exist
    learner.get("/nope")
    learner.request("FOO", "/nope")
    lesson_of_a_random_course()
    before = len(page().samples)

    for _ in range(50):
        learner.get(f"/{word()}/{word()}?{word()}={word()}")
    for _ in range(50):
        learner.request(word(6).upper(), "/nope")
    for _ in range(50):
        lesson_of_a_random_course()

    assert len(page().samples) == before
    assert before <= WORST_CASE


def test_the_worst_case_number_of_samples_is_what_the_readme_states():
    readme = (BACKEND_DIR.parent / "README.md").read_text(encoding="utf-8")

    assert f"**{WORST_CASE} samples**" in readme
