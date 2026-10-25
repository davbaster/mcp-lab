"""The JSON log format, the request line, and the request ID (#36)."""

import asyncio
import json
import logging
import math
import re
import uuid

import pytest
from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app import metrics
from app.deployment import UNKNOWN
from app.errors import ErrorResponse
from app.log_format import JsonFormatter
from app.request_middleware import CLIENT_CLOSED_REQUEST, RequestObservabilityMiddleware
from tests.auth_support import URL, assert_error, login, new_client, register
from tests.feedback_support import body as feedback_body
from tests.feedback_support import send as send_feedback
from tests.limit_support import USERNAME_LIMIT, WRONG
from tests.obs_support import capture_logs, lines_of, page, request_lines, throwaway_app
from tests.quiz_support import EPSILON, submit

TIMESTAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
FIVE = {"timestamp", "level", "message", "deployment", "logger"}
REQUEST_KEYS = {"request_id", "method", "route", "status", "latency_ms"}
logger = logging.getLogger("format.test")


def one(**kwargs) -> dict:
    with capture_logs() as stream:
        logger.log(kwargs.pop("level", logging.INFO), kwargs.pop("message", "hello"), **kwargs)
    (line,) = lines_of(stream)
    return line


@pytest.fixture
def api(attempt_api):
    return attempt_api


@pytest.fixture
def learner(ana):
    return ana


# --- the format ---


def test_every_line_has_the_five_fields_and_nothing_else_outside_a_request():
    line = one()

    assert set(line) == FIVE
    assert line["message"] == "hello"
    assert line["deployment"] == "test"
    assert line["logger"] == "format.test"
    assert line["level"] == "INFO"


def test_the_timestamp_is_utc_iso_8601_with_milliseconds_and_a_z():
    with capture_logs() as stream:
        logger.info("a")
    record = logging.LogRecord("n", logging.INFO, "p", 1, "m", None, None)
    record.created = 1761393600.123456  # 2025-10-25T12:00:00.123456Z

    (line,) = lines_of(stream)
    assert TIMESTAMP.fullmatch(line["timestamp"])
    assert json.loads(JsonFormatter().format(record))["timestamp"] == "2025-10-25T12:00:00.123Z"


@pytest.mark.parametrize(
    ("level", "name"),
    [
        (logging.DEBUG, "DEBUG"),
        (logging.INFO, "INFO"),
        (logging.WARNING, "WARNING"),
        (logging.ERROR, "ERROR"),
        (logging.CRITICAL, "CRITICAL"),
    ],
)
def test_the_level_is_one_of_the_five_names(level, name):
    assert one(level=level)["level"] == name


def test_fields_passed_with_extra_are_top_level_keys():
    line = one(extra={"course_id": "alpha-course", "score": 4, "nested": {"a": [1, 2]}})

    assert line["course_id"] == "alpha-course"
    assert line["score"] == 4
    assert line["nested"] == {"a": [1, 2]}


def test_extra_fields_cannot_replace_the_five():
    line = one(
        extra={"timestamp": "x", "level": "x", "deployment": "x", "logger": "x", "request_id": "r"}
    )

    assert line["timestamp"] != "x" and TIMESTAMP.fullmatch(line["timestamp"])
    assert line["level"] == "INFO"
    assert line["deployment"] == "test"
    assert line["logger"] == "format.test"
    assert line["message"] == "hello"


def test_a_message_with_a_newline_a_quote_and_non_ascii_text_stays_one_line():
    text = 'line one\nline "two"\r\n\tüñí 漢字 🙂 \\ \u2028'

    with capture_logs() as stream:
        logger.info(text)
        logger.info("%s", text)

    raw = stream.getvalue()
    assert len(raw.splitlines()) == 2
    assert [line["message"] for line in lines_of(stream)] == [text, text]


def test_a_field_that_is_not_json_is_written_as_its_str():
    class Thing:
        def __str__(self):
            return "a thing"

    class Broken:
        def __str__(self):
            raise RuntimeError("no")

    cyclic: dict = {}
    cyclic["self"] = cyclic

    with capture_logs() as stream:
        logger.info(
            "fields",
            extra={
                "thing": Thing(),
                "broken": Broken(),
                "cyclic": cyclic,
                "nan": math.nan,
                "inf": math.inf,
                "raw": b"ab",
                "members": {1},
                "pair": (1, "a"),
            },
        )
    (line,) = lines_of(stream)

    assert line["thing"] == "a thing"
    assert line["broken"] == "<unprintable>"
    assert isinstance(line["cyclic"], dict)
    assert line["nan"] == "nan" and line["inf"] == "inf"
    assert line["raw"] == "ab"
    assert line["members"] == [1]
    assert line["pair"] == [1, "a"]


def test_the_formatter_never_raises():
    record = logging.LogRecord("n", logging.INFO, "p", 1, "bad %d format", ("text",), None)

    out = JsonFormatter().format(record)

    assert json.loads(out)["message"] == "bad %d format"
    record.levelname = object()  # type: ignore[assignment]
    record.name = object()  # type: ignore[assignment]
    assert json.loads(JsonFormatter().format(record))["level"]


def test_a_missing_or_invalid_deployment_is_unknown_on_the_line(monkeypatch):
    for value in (None, "", "Bad Name", "host"):
        if value is None:
            monkeypatch.delenv("DEPLOYMENT")
        else:
            monkeypatch.setenv("DEPLOYMENT", value)

        assert one()["deployment"] == UNKNOWN


def test_a_record_outside_a_request_has_no_request_keys():
    line = one(extra={"course_id": "alpha-course"})

    assert not REQUEST_KEYS & set(line)


# --- the lines the app already wrote ---


def test_the_quiz_attempt_line_keeps_its_text_and_gains_fields(learner):
    with capture_logs() as stream:
        response = submit(learner, right=(1, 2, 3, 4))

    (line,) = [x for x in lines_of(stream) if x["message"].startswith("Quiz attempt graded")]
    assert line["message"] == (
        f"Quiz attempt graded: course_id={EPSILON} chapter_id=01-first score=4 total=5 outcome=passed"
    )
    assert line["logger"] == "uvicorn.error"
    assert (line["course_id"], line["chapter_id"], line["score"], line["total"], line["outcome"]) == (
        EPSILON, "01-first", 4, 5, "passed",
    )  # fmt: skip
    assert line["request_id"] == response.headers["x-request-id"]


def test_the_feedback_line_keeps_its_text_and_gains_fields(api, db):
    from tests.feedback_support import FEEDBACK_COURSES  # noqa: F401  (documents the courses)

    assert register(api).status_code == 201
    with capture_logs() as stream:
        response = send_feedback(api, feedback_body())
        none_response = send_feedback(
            api,
            feedback_body(
                ctx={"course_id": None, "chapter_id": None, "lesson_id": None},
                message="Another note",
            ),
        )

    assert response.status_code == 202 and none_response.status_code == 202
    lines = [x for x in lines_of(stream) if x["message"].startswith("Feedback stored")]
    assert [x["message"] for x in lines] == [
        "Feedback stored: course_id=alpha-course category=bug",
        "Feedback stored: course_id=none category=bug",
    ]
    assert [(x["course_id"], x["category"]) for x in lines] == [
        ("alpha-course", "bug"),
        (None, "bug"),
    ]
    assert lines[0]["request_id"] == response.headers["x-request-id"]
    assert lines[0]["logger"] == "uvicorn.error"


def test_the_login_limit_line_keeps_its_text_and_gains_the_scope(api):
    client = new_client()
    with capture_logs() as stream:
        for _ in range(USERNAME_LIMIT):
            login(client, "ana1", WRONG)

    lines = [x for x in lines_of(stream) if x["message"].startswith("Login limit reached")]
    assert lines
    assert lines[0]["message"] == "Login limit reached: scope=username"
    assert lines[0]["scope"] == "username"
    assert lines[0]["logger"] == "uvicorn.error"


def test_the_course_loading_lines_gain_the_course_id(serve):
    with capture_logs() as stream:
        serve("alpha-course,beta-course")

    lines = [x for x in lines_of(stream) if x["message"].startswith("loaded course")]
    assert [(x["message"], x["course_id"]) for x in lines] == [
        ("loaded course alpha-course: 2 chapters, 3 lessons", "alpha-course"),
        ("loaded course beta-course: 1 chapters, 1 lessons", "beta-course"),
    ]
    assert not [x for x in lines if "request_id" in x]


# --- the request line ---


def test_a_request_writes_one_info_line_with_the_documented_fields(api):
    with capture_logs() as stream:
        response = api.get("/api/health")

    (line,) = request_lines(stream)
    assert lines_of(stream) == [line]
    assert set(line) == FIVE | REQUEST_KEYS
    assert line["level"] == "INFO"
    assert line["message"] == "request completed"
    assert line["request_id"] == response.headers["x-request-id"]
    assert (line["method"], line["route"], line["status"]) == ("GET", "/api/health", 200)
    assert isinstance(line["status"], int)
    assert isinstance(line["latency_ms"], int | float) and line["latency_ms"] >= 0


def test_the_route_is_the_metric_label(api):
    with capture_logs() as stream:
        api.get("/nope")
        api.get("/api/courses/alpha-course/lessons/no-such-lesson")

    unknown, lesson = request_lines(stream)
    assert unknown["route"] == "unmatched" and unknown["status"] == 404
    assert lesson["route"] == "/api/courses/{course_id}/lessons/{lesson_id}"
    assert lesson["status"] == 404


def test_a_request_under_a_configured_course_has_its_course_id_and_an_unknown_course_has_none(api):
    with capture_logs() as stream:
        api.get("/api/courses/alpha-course/lessons/hello")
        api.get("/api/courses/SENTINEL-NOPE/lessons/hello")
        api.get("/api/health")

    configured, unknown, health = request_lines(stream)
    assert configured["course_id"] == "alpha-course"
    assert "course_id" not in unknown
    assert "course_id" not in health
    assert "SENTINEL" not in stream.getvalue()


@pytest.mark.parametrize(
    ("path", "status"),
    [("/api/health", 200), ("/nope", 404), ("/api/auth/me", 401)],
)
def test_the_request_line_is_info_whatever_the_status(api, path, status):
    with capture_logs() as stream:
        api.get(path)

    (line,) = request_lines(stream)
    assert (line["level"], line["status"]) == ("INFO", status)


def test_a_rate_limited_and_a_validation_failed_request_are_info_lines(api):
    client = new_client()
    for _ in range(USERNAME_LIMIT):
        login(client, "ana1", WRONG)
    with capture_logs() as stream:
        assert login(client, "ana1", WRONG).status_code == 429
        assert client.post(f"{URL}/login", json={}).status_code == 422

    assert [(x["level"], x["status"]) for x in request_lines(stream)] == [
        ("INFO", 429),
        ("INFO", 422),
    ]


def test_the_request_line_holds_no_path_query_header_body_address_or_identity(api):
    client = new_client()
    with capture_logs() as stream:
        register(client, "Zq7xK3mV", "PW-SENTINEL-77aa")
        client.get(
            "/api/courses/alpha-course/lessons/hello?token=QS-SENTINEL-1",
            headers={"X-Forwarded-For": "198.51.100.9", "Authorization": "Bearer AUTHZ-SENTINEL-1"},
        )

    raw = stream.getvalue()
    for needle in ("Zq7xK3mV", "PW-SENTINEL", "QS-SENTINEL", "198.51.100.9", "AUTHZ", "testclient",
                   "lessons/hello", "session"):  # fmt: skip
        assert needle not in raw
    assert {frozenset(x) for x in request_lines(stream)} == {
        frozenset(FIVE | REQUEST_KEYS),
        frozenset(FIVE | REQUEST_KEYS | {"course_id"}),
    }


def test_a_query_string_never_appears_in_a_line_the_metrics_or_the_response(api):
    with capture_logs() as stream:
        first = api.get("/api/health?token=QS-SENTINEL-1")
        second = api.get("/api/courses?session=QS-SENTINEL-2")
        third = api.get("/nope?x=QS-SENTINEL-3")

    seen = (
        stream.getvalue()
        + page().text
        + "".join(f"{r.headers}{r.text}" for r in (first, second, third))
    )
    assert "QS-SENTINEL" not in seen


def test_the_unhandled_exception_record_has_no_query_string():
    app_ = throwaway_app()

    @app_.get("/boom")
    def boom():
        raise RuntimeError("boom")

    with capture_logs() as stream, TestClient(app_, raise_server_exceptions=False) as client:
        client.get("/boom?token=QS-SENTINEL-9")

    assert "QS-SENTINEL" not in stream.getvalue()


def test_the_line_is_written_before_the_client_has_the_whole_response(api):
    # Every response is counted and logged before its last bytes go out, so a client that has
    # read a response can scrape and find it. (The metrics tests rely on this too.)
    with capture_logs() as stream:
        for _ in range(3):
            api.get("/api/health")
            assert len(request_lines(stream)) >= 1
    assert len(request_lines(stream)) == 3


# --- the request ID ---


VALID = [
    "abc-123",
    "A",
    "0123456789-abcdefABCDEF",
    "x" * 64,
    "-",
]
INVALID = {
    "65 characters": "x" * 65,
    "a space": "abc 123",
    "an underscore": "abc_123",
    "a dot": "abc.123",
    "a slash": "a/b",
    "non-ASCII": "abc-é".encode("latin-1"),
    "empty": "",
}


@pytest.mark.parametrize("sent", VALID)
def test_a_valid_request_id_is_kept_in_the_header_and_the_line(api, sent):
    with capture_logs() as stream:
        response = api.get("/api/health", headers={"X-Request-ID": sent})

    assert response.headers["x-request-id"] == sent
    assert request_lines(stream)[0]["request_id"] == sent


@pytest.mark.parametrize("sent", INVALID.values(), ids=INVALID.keys())
def test_an_invalid_request_id_is_replaced_by_a_uuid(api, sent):
    with capture_logs() as stream:
        response = api.get("/api/health", headers={"X-Request-ID": sent})

    returned = response.headers["x-request-id"]
    assert returned.encode() != (sent if isinstance(sent, bytes) else sent.encode())
    assert str(uuid.UUID(returned)) == returned
    assert request_lines(stream)[0]["request_id"] == returned


def test_a_repeated_request_id_header_is_replaced_by_a_uuid(api):
    response = api.get(
        "/api/health", headers=[("X-Request-ID", "abc-1"), ("X-Request-ID", "abc-2")]
    )

    assert str(uuid.UUID(response.headers["x-request-id"])) == response.headers["x-request-id"]


def test_each_request_without_an_id_gets_its_own(api):
    ids = {api.get("/api/health").headers["x-request-id"] for _ in range(5)}

    assert len(ids) == 5


def test_every_kind_of_response_carries_the_request_id(api):
    client = new_client()
    for _ in range(USERNAME_LIMIT):
        login(client, "ana1", WRONG)
    cases = {
        200: lambda: client.get("/api/health"),
        401: lambda: client.get("/api/auth/me"),
        404: lambda: client.get("/nope"),
        422: lambda: client.post(f"{URL}/login", json={}),
        429: lambda: login(client, "ana1", WRONG),
    }

    for status, send in cases.items():
        response = send()

        assert response.status_code == status
        assert str(uuid.UUID(response.headers["x-request-id"]))


def test_the_500_after_an_unhandled_exception_carries_the_request_id_of_its_line():
    app_ = throwaway_app()

    @app_.get("/boom")
    def boom():
        raise RuntimeError("boom")

    with capture_logs() as stream, TestClient(app_, raise_server_exceptions=False) as client:
        response = client.get("/boom", headers={"X-Request-ID": "keep-me-1"})

    assert response.status_code == 500
    assert response.headers["x-request-id"] == "keep-me-1"
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error."}
    }
    assert {x["request_id"] for x in lines_of(stream) if "request_id" in x} == {"keep-me-1"}


def test_the_request_id_is_not_in_the_json_error_body(api):
    response = api.get("/nope", headers={"X-Request-ID": "abc-123"})

    assert response.json()["error"].keys() == {"code", "message"}
    assert "abc-123" not in response.text


def test_every_record_written_while_a_request_is_handled_carries_its_id_in_a_sync_route():
    app_ = throwaway_app()

    @app_.get("/sync")
    def sync_route():  # runs in a thread
        logging.getLogger("inside.test").info("inside the sync route")
        return {}

    @app_.get("/async")
    async def async_route():
        logging.getLogger("inside.test").info("inside the async route")
        return {}

    with capture_logs() as stream, TestClient(app_) as client:
        first = client.get("/sync", headers={"X-Request-ID": "sync-1"})
        second = client.get("/async", headers={"X-Request-ID": "async-1"})

    by_message = {x["message"]: x for x in lines_of(stream) if x["logger"] == "inside.test"}
    assert first.status_code == second.status_code == 200
    assert by_message["inside the sync route"]["request_id"] == "sync-1"
    assert by_message["inside the async route"]["request_id"] == "async-1"


def test_a_record_after_a_request_has_no_request_id(api):
    api.get("/api/health")

    with capture_logs() as stream:
        logger.info("later, outside any request")

    (line,) = lines_of(stream)
    assert not REQUEST_KEYS & set(line)


# --- stack traces ---


def test_an_unhandled_exception_writes_one_error_record_with_the_whole_trace_in_one_field():
    app_ = throwaway_app()

    @app_.get("/boom")
    def boom():
        raise RuntimeError("the failure")

    with capture_logs() as stream, TestClient(app_, raise_server_exceptions=False) as client:
        client.get("/boom")

    raw = stream.getvalue()
    lines = lines_of(stream)
    traced = [x for x in lines if "stack_trace" in x]
    assert len(traced) == 1
    (record,) = traced
    assert record["level"] == "ERROR"
    assert record["message"] == "Unhandled exception on GET /boom"
    assert "Traceback (most recent call last)" in record["stack_trace"]
    assert "RuntimeError: the failure" in record["stack_trace"]
    assert (
        record["stack_trace"].count("\n") > 3
    )  # newlines are inside the string, escaped on the line
    assert len(raw.splitlines()) == len(lines)
    assert [x["status"] for x in request_lines(stream)] == [500]
    assert [x["level"] for x in request_lines(stream)] == ["INFO"]


def test_a_second_record_of_the_same_exception_is_not_written():
    # What uvicorn does after the error handler: it logs the same exception again.
    error = RuntimeError("once")
    with capture_logs() as stream:
        try:
            raise error
        except RuntimeError:
            logging.getLogger("app.errors").error("Unhandled exception on GET /x", exc_info=error)
            from app.log_format import mark_logged

            mark_logged(error)
            logging.getLogger("uvicorn.error").error(
                "Exception in ASGI application\n", exc_info=error
            )

    assert [x["message"] for x in lines_of(stream)] == ["Unhandled exception on GET /x"]


class Item(BaseModel):
    n: int


# Module constants, so that no source line of a traceback holds the text itself.
BAD_RESPONSE = "RESPONSE-SENTINEL-1"
BAD_MODEL = "MODEL-SENTINEL-2"
BAD_REQUEST = "REQUEST-SENTINEL-3"


def test_a_response_validation_failure_logs_only_locations_and_types():
    app_ = throwaway_app()

    @app_.get("/invalid", response_model=Item)
    def invalid():
        return {"n": BAD_RESPONSE}

    @app_.get("/model")
    def model():
        return Item(n=BAD_MODEL)  # type: ignore[arg-type]

    with capture_logs() as stream, TestClient(app_, raise_server_exceptions=False) as client:
        first = client.get("/invalid")
        second = client.get("/model")

    raw = stream.getvalue() + first.text + second.text
    assert first.status_code == second.status_code == 500
    assert "SENTINEL" not in raw
    traces = [x["stack_trace"] for x in lines_of(stream) if "stack_trace" in x]
    assert len(traces) == 2
    assert "ResponseValidationError" in traces[0] and "int_parsing" in traces[0]
    assert "ValidationError" in traces[1] and "int_parsing" in traces[1]


def test_a_validation_error_in_a_message_argument_holds_only_location_and_type():
    error = RequestValidationError(
        [{"type": "int_parsing", "loc": ("body", "n"), "msg": "bad", "input": BAD_REQUEST}]
    )
    with capture_logs() as stream:
        try:
            raise error
        except RequestValidationError:
            logger.error("bad request: %s", error, exc_info=error)
        logger.error(error)
        try:
            Item(n=BAD_MODEL)  # type: ignore[arg-type]
        except Exception as caught:
            logger.error("rejected %s", caught, exc_info=caught)

    raw = stream.getvalue()
    assert "SENTINEL" not in raw
    assert "body.n (int_parsing)" in raw
    assert len(raw.splitlines()) == 3


def test_a_database_error_text_after_detail_is_cut_from_the_trace():
    import psycopg

    class Failing(psycopg.errors.CheckViolation):
        def __str__(self):
            return (
                "new row violates check constraint\nDETAIL:  Failing row contains (ROW-SENTINEL-5)."
            )

    with capture_logs() as stream:
        try:
            raise Failing()
        except Failing:
            logger.exception("db failed")

    assert "ROW-SENTINEL" not in stream.getvalue()
    assert "new row violates check constraint" in stream.getvalue()


# --- the middleware on its own ---


async def call(app, *, scope=None, messages=()):
    """Run the middleware around `app` once; return (sent messages, the raised error or None)."""
    sent: list[dict] = []
    incoming = list(messages)

    async def receive():
        if incoming:
            return incoming.pop(0)
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    base = {"type": "http", "method": "GET", "path": "/x", "headers": [], "query_string": b""}
    middleware = RequestObservabilityMiddleware(app)
    error = None
    try:
        await middleware({**base, **(scope or {})}, receive, send)
    except BaseException as exc:  # noqa: BLE001  (returned for the test to inspect)
        error = exc
    return sent, error


def run(coro):
    return asyncio.run(coro)


def test_a_client_that_leaves_before_any_response_is_logged_as_499_and_nothing_is_raised():
    async def app(scope, receive, send):
        while (await receive())["type"] != "http.disconnect":
            pass

    with capture_logs() as stream:
        sent, error = run(call(app))

    (line,) = request_lines(stream)
    assert error is None and sent == []
    assert line["status"] == CLIENT_CLOSED_REQUEST == 499
    assert line["route"] == "unmatched" and line["method"] == "GET"


def test_a_client_that_leaves_during_the_response_is_logged_with_the_status_that_was_sent():
    async def app(scope, receive, send):
        await receive()  # the disconnect
        await send({"type": "http.response.start", "status": 200, "headers": []})
        raise OSError("connection lost")

    with capture_logs() as stream:
        sent, error = run(call(app))

    (line,) = request_lines(stream)
    assert error is None
    assert line["status"] == 200
    assert sent[0]["headers"] == [(b"x-request-id", line["request_id"].encode())]


def test_an_error_that_is_not_a_disconnect_is_raised_again_and_logged_once_as_500():
    async def app(scope, receive, send):
        raise ValueError("a bug")

    with capture_logs() as stream:
        _, error = run(call(app))

    assert isinstance(error, ValueError)
    assert [x["status"] for x in request_lines(stream)] == [500]


def test_cancellation_is_raised_again_and_logged_as_499():
    async def app(scope, receive, send):
        raise asyncio.CancelledError

    with capture_logs() as stream:
        _, error = run(call(app))

    assert isinstance(error, asyncio.CancelledError)
    assert [x["status"] for x in request_lines(stream)] == [499]


def test_a_request_is_recorded_once_even_if_the_app_sends_after_its_last_body():
    async def app(scope, receive, send):
        await receive()  # the disconnect
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})
        raise OSError("closed after the end")

    with capture_logs() as stream:
        _, error = run(call(app, messages=[{"type": "http.disconnect"}]))

    assert error is None
    assert [x["status"] for x in request_lines(stream)] == [204]


def test_a_lifespan_scope_is_ignored():
    reached = []

    async def app(scope, receive, send):
        reached.append(scope["type"])

    with capture_logs() as stream:
        run(call(app, scope={"type": "lifespan"}))

    assert reached == ["lifespan"]
    assert stream.getvalue() == ""
    assert metrics.current() is None


def test_a_failure_while_counting_does_not_reach_the_request(monkeypatch):
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    def broken(*args, **kwargs):
        raise RuntimeError("the registry failed")

    monkeypatch.setattr(RequestObservabilityMiddleware, "_record", broken)

    sent, error = run(call(app))

    assert error is None
    assert [m["type"] for m in sent] == ["http.response.start", "http.response.body"]


def test_a_response_header_the_app_set_for_the_request_id_is_replaced():
    async def app(scope, receive, send):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"X-Request-ID", b"theirs")],
            }
        )
        await send({"type": "http.response.body", "body": b""})

    sent, _ = run(call(app))

    ids = [value for name, value in sent[0]["headers"] if name.lower() == b"x-request-id"]
    assert len(ids) == 1 and ids[0] != b"theirs"


def test_an_http_exception_from_a_route_is_a_normal_request_line():
    app_ = throwaway_app()

    @app_.get("/gone", responses={410: {"model": ErrorResponse}})
    def gone():
        raise HTTPException(410, "Gone.")

    with capture_logs() as stream, TestClient(app_) as client:
        response = client.get("/gone")

    assert_error(response, 410, "http_error")
    assert [x["status"] for x in request_lines(stream)] == [410]
