"""#36 under the real server: `uvicorn` started the documented way, its output read as it is.

`caplog` and the test client cannot see uvicorn's own records, its startup and shutdown lines, its
access log, or a second log record of one exception. These tests start the process, send real
requests, and search every line it wrote.
"""

import json
import re
import signal
import socket
import subprocess
import sys

import pytest

from tests.auth_support import rows
from tests.dbtools import BACKEND_DIR
from tests.obs_support import Page
from tests.quiz_support import answers, attempt_url
from tests.server_support import START_COMMAND, Server, free_port, server_env

FIVE = {"timestamp", "level", "message", "deployment", "logger"}
ACCESS_LINE = re.compile(r"INFO:\s+127\.0\.0\.1:\d+ - \"")
TIMESTAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")


@pytest.fixture(scope="module")
def plain():
    """The documented command, `app.main:app`."""
    server = Server()
    try:
        server.wait_until_started()
        yield server
    finally:
        server.stop()


@pytest.fixture(scope="module")
def broken():
    """The app plus failing routes, with the quiz attempt write broken (a CHECK violation)."""
    server = Server("tests.obs_server_app:app", server_env(OBS_BREAK_ATTEMPTS="1"))
    try:
        server.wait_until_started()
        yield server
    finally:
        server.stop()


def count_of(server: Server, message: str, since: int = 0) -> int:
    return sum(r["message"] == message for r in server.records(since))


# --- startup, shutdown, and the shape of every line ---


def test_every_line_the_process_writes_is_one_json_object_with_the_five_fields(db):
    server = Server()
    try:
        server.wait_until_started()
        server.request("GET", "/api/health")
        server.wait_for_requests(1)
    finally:
        assert server.stop() in (0, -signal.SIGTERM)  # uvicorn re-raises the signal it was sent

    records = server.records()
    assert records
    for record in records:
        assert FIVE <= record.keys(), record
        assert TIMESTAMP.fullmatch(record["timestamp"])
        assert record["deployment"] == "e2e-test"
        assert record["level"] in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
    messages = [r["message"] for r in records]
    assert any(m.startswith("Started server process") for m in messages)
    assert "Application startup complete." in messages
    assert any(m.startswith("Uvicorn running on") for m in messages)
    assert any(m.startswith("loaded course alpha-course") for m in messages)
    assert "Waiting for application shutdown." in messages
    assert "Application shutdown complete." in messages
    assert {"uvicorn.error", "mcp_lab.requests"} <= {r["logger"] for r in records}


def test_the_app_does_not_start_without_deployment_and_says_so():
    env = {k: v for k, v in server_env().items() if k != "DEPLOYMENT"}
    process = subprocess.run(  # noqa: PLW1510 (the exit code is asserted below)
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--port",
            str(free_port()),
            *START_COMMAND,
        ],
        cwd=BACKEND_DIR,
        env={**env, "METRICS_PORT": str(free_port())},
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert process.returncode != 0
    assert "DEPLOYMENT" in process.stderr
    reporting = [json.loads(line) for line in process.stderr.splitlines() if "DEPLOYMENT" in line]
    assert reporting
    assert {r["deployment"] for r in reporting} == {"unknown"}
    # every other line is valid JSON too
    assert all(json.loads(line) for line in process.stderr.splitlines())


@pytest.mark.parametrize("value", ["host", "Bad_Name", ""])
def test_an_invalid_deployment_stops_the_real_server(value):
    process = subprocess.run(  # noqa: PLW1510 (the exit code is asserted below)
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--port",
            str(free_port()),
            *START_COMMAND,
        ],
        cwd=BACKEND_DIR,
        env={**server_env(DEPLOYMENT=value), "METRICS_PORT": str(free_port())},
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert process.returncode != 0
    assert "DEPLOYMENT" in process.stderr


def test_a_metrics_port_that_is_in_use_stops_the_real_server_naming_the_variable():
    with socket.socket() as taken:
        taken.bind(("0.0.0.0", 0))
        taken.listen()
        env = server_env(METRICS_PORT=str(taken.getsockname()[1]))
        process = subprocess.run(  # noqa: PLW1510 (the exit code is asserted below)
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--port",
                str(free_port()),
                *START_COMMAND,
            ],
            cwd=BACKEND_DIR,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )

    assert process.returncode != 0
    assert "METRICS_PORT" in process.stderr


# --- requests ---


def test_five_requests_give_five_request_lines_and_no_access_log_line(plain):
    start = len(plain.lines)
    before = plain.requests_logged()

    for _ in range(5):
        status, headers, _ = plain.request("GET", "/api/health")
        assert status == 200
        assert headers["x-request-id"]
    plain.wait_for_requests(before + 5)

    new = plain.lines[start:]
    assert count_of(plain, "request completed", start) == 5
    assert not [line for line in new if ACCESS_LINE.search(line)]
    assert not [line for line in new if "GET /api/health" in line]
    assert len([r for r in plain.records(start) if r["logger"] == "mcp_lab.requests"]) == 5


def test_a_query_string_reaches_no_output_line_no_metric_and_no_response(plain):
    start = len(plain.lines)
    before = plain.requests_logged()

    first = plain.request("GET", "/api/health?token=QS-SENTINEL-1")
    second = plain.request("GET", "/api/courses?session=QS-SENTINEL-2")
    plain.wait_for_requests(before + 2)

    seen = "\n".join(plain.lines[start:]) + plain.scrape()[1] + str(first) + str(second)
    assert "QS-SENTINEL" not in seen


def test_metrics_are_on_the_metrics_port_and_not_on_the_main_port(plain):
    plain.request("GET", "/api/health")

    main = plain.request("GET", "/metrics")
    api = plain.request("GET", "/api/metrics")
    status, body = plain.scrape()

    assert main[0] == 404 and api[0] == 404
    assert "http_requests_total" not in main[2] + api[2]
    assert json.loads(main[2])["error"]["code"] == "not_found"
    assert status == 200
    page = Page(body)
    assert page.total("http_requests_total", route="/api/health", status="200") >= 1
    assert {s.labels["deployment"] for s in page.samples} == {"e2e-test"}
    assert plain.scrape("/")[0] == 404


def test_the_scrape_needs_no_database_and_the_page_is_ready_at_startup(plain):
    page = Page(plain.scrape()[1])

    assert page.get("lesson_loads_total", course="alpha-course") is not None
    assert page.get("lesson_loads_total", course="epsilon-course") is not None
    assert page.get("quiz_submission_errors_total", course="epsilon-course") is not None


# --- one record for one exception ---


def test_an_unhandled_exception_writes_exactly_one_record_with_a_stack_trace(broken):
    start = len(broken.lines)
    before = broken.requests_logged()

    status, headers, body = broken.request("GET", "/api/test/boom", {"X-Request-ID": "boom-1"})
    for _ in range(3):  # later lines show that a second record of the exception is not coming
        broken.request("GET", "/api/health")
    broken.wait_for_requests(before + 4)

    assert status == 500
    assert headers["x-request-id"] == "boom-1"
    assert json.loads(body) == {
        "error": {"code": "internal_error", "message": "Internal server error."}
    }
    traced = [r for r in broken.records(start) if "stack_trace" in r]
    assert len(traced) == 1
    (record,) = traced
    assert record["level"] == "ERROR"
    assert record["request_id"] == "boom-1"
    assert "RuntimeError" in record["stack_trace"] and "Traceback" in record["stack_trace"]
    assert "PW-SENTINEL-boom" not in broken.everything()
    assert not [r for r in broken.records(start) if "Exception in ASGI application" in r["message"]]
    lines = [r for r in broken.records(start) if r["message"] == "request completed"]
    assert (lines[0]["status"], lines[0]["level"], lines[0]["request_id"]) == (
        500,
        "INFO",
        "boom-1",
    )
    page = Page(broken.scrape()[1])
    assert page.get("http_requests_total", method="GET", route="/api/test/boom", status="500") == 1


def test_a_response_validation_failure_writes_no_response_data_under_the_real_server(broken):
    start = len(broken.lines)
    before = broken.requests_logged()

    status, _, body = broken.request("GET", "/api/test/invalid-response")
    for _ in range(3):
        broken.request("GET", "/api/health")
    broken.wait_for_requests(before + 4)

    assert status == 500
    seen = "\n".join(broken.lines[start:]) + body
    assert "RESPONSE-SENTINEL" not in seen
    traced = [r for r in broken.records(start) if "stack_trace" in r]
    assert len(traced) == 1
    assert "int_parsing" in traced[0]["stack_trace"]


# --- nothing secret reaches the output ---


def test_no_secret_reaches_any_output_line_or_the_metrics(broken, db):
    start = len(broken.lines)
    before = broken.requests_logged()
    password = "Pw9x" + "Kd4vQ2"  # unique, 10 characters
    wrong = "PW-SENTINEL-" + "e2e-wrong-pass"
    long_password = "PW-SENTINEL-" + "e2e-too-long-to-register"
    username = "Uq7zK3mV"
    ghost = "UNAME-SENTINEL-" + "e2e"
    forwarded = "203.0.113." + "231"
    cookie = "SESSION-SENTINEL-" + "e2e-cookie"
    bearer = "AUTHZ-SENTINEL-" + "e2e-bearer"
    option = "OPTION-SENTINEL-" + "e2e"
    query = "QS-SENTINEL-" + "e2e"
    secrets = [
        password,
        wrong,
        long_password,
        username,
        ghost,
        forwarded,
        cookie,
        bearer,
        option,
        query,
    ]

    registered = broken.request(
        "POST", "/api/auth/register", body={"username": username, "password": password}
    )
    assert registered[0] == 201
    session = registered[1]["set-cookie"].split(";")[0]
    token = session.split("=", 1)[1]
    secrets.append(token)
    assert (
        broken.request(
            "POST", "/api/auth/register", body={"username": username, "password": long_password}
        )[0]
        == 422
    )
    assert (
        broken.request(
            "POST",
            "/api/auth/login",
            {"X-Forwarded-For": forwarded},
            {"username": username, "password": wrong},
        )[0]
        == 401
    )
    assert (
        broken.request(
            "POST",
            "/api/auth/login",
            {"X-Forwarded-For": forwarded},
            {"username": ghost, "password": wrong},
        )[0]
        == 401
    )
    assert broken.request("POST", "/api/auth/login", None, {"username": username})[0] == 422
    assert (
        broken.request(
            "GET",
            f"/api/auth/me?session={query}",
            {"Cookie": f"session={cookie}", "Authorization": f"Bearer {bearer}"},
        )[0]
        == 401
    )
    assert broken.request("GET", "/api/auth/me", {"Cookie": session})[0] == 200
    # a quiz attempt whose option IDs are made up: 422
    made_up = [{"question_id": a["question_id"], "option_id": option} for a in answers(1)]
    assert (
        broken.request("POST", attempt_url(), {"Cookie": session}, {"answers": made_up})[0] == 422
    )
    # a valid one, whose write Postgres refuses: 500, and the row it prints holds the answers
    real = [a["option_id"] for a in answers(1, right=(1, 3), which={2: "y", 4: "y"})]
    status, _, response_text = broken.request(
        "POST",
        attempt_url(),
        {"Cookie": session},
        {"answers": answers(1, right=(1, 3), which={2: "y", 4: "y"})},
    )
    assert status == 500
    assert broken.request("GET", "/api/health")[0] == 200
    broken.wait_for_requests(before + 10)  # the ten requests above

    output = "\n".join(broken.lines[start:])
    scraped = broken.scrape()[1]
    for secret in [*secrets, *real, "k3q7", "w9d2", "Failing row", "BAD CHAPTER ID", "SENTINEL"]:
        assert secret not in output, secret
        assert secret not in scraped, secret
        assert secret not in response_text, secret
    for line in broken.lines[start:]:
        json.loads(line)
    errors = [r for r in broken.records(start) if r["level"] == "ERROR"]
    assert len(errors) == 1 and "stack_trace" in errors[0]
    assert "Database error (SQLSTATE" in errors[0]["stack_trace"]
    assert rows(db, "SELECT count(*) FROM app.quiz_attempts")[0][0] == 0
