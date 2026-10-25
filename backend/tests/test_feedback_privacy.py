"""What feedback never reveals (#24): no response, header, or log line holds the learner's text or
identity. The sentinels are unique strings planted in every field the browser sends."""

import dataclasses
import logging

import pytest
from sqlalchemy import text

from tests.auth_support import assert_error, new_client, register
from tests.content_support import account_id
from tests.feedback_support import body, feedback_count, feedback_rows, message, send

USERNAME = "Zq7xK3mV"  # 4 to 8 characters, the registration rule
MESSAGE = "MESSAGE-SENTINEL-4b7e please fix this page"
PATH = "/PATH-SENTINEL-6c2d/lesson"
AGENT = "AGENT-SENTINEL-1f8a/1.0"
CONSOLE = "CONSOLE-SENTINEL-9d3b TypeError"
VERSION = "VERSION-SENTINEL-5e0c"
SENTINELS = [
    MESSAGE.split(" ")[0],
    PATH.split("/")[1],
    AGENT.split("/")[0],
    CONSOLE.split(" ")[0],
    VERSION,
]


def sentinel_body(**top):
    ctx = {
        "page_path": PATH,
        "user_agent": AGENT,
        "console_errors": [CONSOLE],
        "app_version": VERSION,
        "chapter_id": "chapter-sentinel-77",
        "lesson_id": "lesson-sentinel-88",
        "question_id": "question-sentinel-99",
    }
    return body(ctx=ctx, **{"message": MESSAGE, **top})


@pytest.fixture
def sentinel_learner(fb_api):
    assert register(fb_api, USERNAME).status_code == 201
    return fb_api


def everything_seen(caplog, *responses) -> str:
    """The captured log, every field of every log record, and every response in full."""
    logged = caplog.text + "\n".join(str(r.__dict__) for r in caplog.records)
    seen = "\n".join(f"{r.status_code} {dict(r.headers)} {r.text}" for r in responses)
    return logged + "\n" + seen


def assert_nothing_leaks(db, caplog, *responses):
    seen = everything_seen(caplog, *responses)
    needles = [*SENTINELS, "chapter-sentinel-77", "lesson-sentinel-88", "question-sentinel-99"]
    needles += [USERNAME, str(account_id(db, USERNAME)), "session="]
    for needle in needles:
        assert needle.lower() not in seen.lower(), needle


def feedback_log_lines(caplog):
    return [r for r in caplog.records if r.name == "uvicorn.error" and "Feedback" in r.getMessage()]


def test_a_stored_item_writes_one_log_line_with_the_course_and_category_only(
    sentinel_learner, db, caplog
):
    caplog.clear()

    response = send(sentinel_learner, sentinel_body(category="content_error"))

    assert response.status_code == 202 and response.content == b""
    lines = feedback_log_lines(caplog)
    assert [(r.levelno, r.getMessage()) for r in lines] == [
        (logging.INFO, "Feedback stored: course_id=alpha-course category=content_error")
    ]
    assert_nothing_leaks(db, caplog, response)


def test_an_item_outside_a_course_logs_course_id_none(ana_fb, caplog):
    caplog.clear()
    ctx = {"course_id": None, "chapter_id": None, "lesson_id": None}

    send(ana_fb, body(ctx=ctx, category="suggestion"))

    assert [r.getMessage() for r in feedback_log_lines(caplog)] == [
        "Feedback stored: course_id=none category=suggestion"
    ]


def test_nothing_else_is_logged_by_the_app_for_a_stored_item(ana_fb, caplog):
    caplog.clear()

    send(ana_fb, body())

    app_records = [r for r in caplog.records if r.name.startswith(("app", "uvicorn"))]
    assert [r.getMessage() for r in app_records] == [
        "Feedback stored: course_id=alpha-course category=bug"
    ]


def test_a_duplicate_logs_nothing_and_leaks_nothing(sentinel_learner, db, caplog):
    first = send(sentinel_learner, sentinel_body())
    caplog.clear()

    duplicate = send(sentinel_learner, sentinel_body())

    assert duplicate.status_code == 202 and duplicate.content == b""
    assert feedback_log_lines(caplog) == []
    assert_nothing_leaks(db, caplog, first, duplicate)


def test_a_422_leaks_nothing(sentinel_learner, db, caplog):
    caplog.clear()

    response = send(sentinel_learner, sentinel_body(category="not-a-category"))

    assert_error(response, 422, "validation_error")
    assert feedback_log_lines(caplog) == []
    assert_nothing_leaks(db, caplog, response)


def test_a_422_for_each_other_field_leaks_nothing(sentinel_learner, db, caplog):
    cases = [
        sentinel_body(message=MESSAGE[:5]),
        sentinel_body(ctx_extra=1),
        body(ctx={"page_path": PATH + "?q=" + CONSOLE}, message=MESSAGE),
        body(
            ctx={"course_id": VERSION.lower(), "chapter_id": None, "lesson_id": None},
            message=MESSAGE,
        ),
        body(ctx={"console_errors": [CONSOLE * 100], "user_agent": AGENT}, message=MESSAGE),
    ]
    responses = [send(sentinel_learner, case) for case in cases]

    assert [r.status_code for r in responses] == [422] * 5
    assert_nothing_leaks(db, caplog, *responses)


def test_a_429_leaks_nothing(sentinel_learner, db, caplog):
    for n in range(1, 11):
        assert send(sentinel_learner, body(message=message(n))).status_code == 202
    caplog.clear()

    response = send(sentinel_learner, sentinel_body())

    assert_error(response, 429, "feedback_limit_reached")
    assert feedback_log_lines(caplog) == []
    assert_nothing_leaks(db, caplog, response)


def test_a_401_leaks_nothing(sentinel_learner, db, caplog):
    caplog.clear()

    response = new_client().post("/api/feedback", json=sentinel_body())

    assert_error(response, 401, "not_authenticated")
    assert_nothing_leaks(db, caplog, response)


def test_a_database_failure_is_a_500_that_stores_and_leaks_nothing(
    fb_errors, db, monkeypatch, caplog
):
    import app.feedback_routes as routes

    real = routes.store_feedback

    def store_with_a_category_the_table_refuses(db_session, *, item, **kwargs):
        return real(db_session, item=dataclasses.replace(item, category="BAD"), **kwargs)

    monkeypatch.setattr(routes, "store_feedback", store_with_a_category_the_table_refuses)
    # `fb_errors` is signed in as ana1, so the sentinel username is not in play for this test.
    caplog.clear()

    response = send(fb_errors, sentinel_body())

    assert_error(response, 500, "internal_error")
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error."}
    }
    assert feedback_count(db) == 0
    logged = caplog.text + "\n".join(str(r.__dict__) for r in caplog.records)
    assert "Database error (SQLSTATE" in logged  # the failure was logged, without its detail
    for needle in [*SENTINELS, "chapter-sentinel-77", "Failing row", "BAD"]:
        assert needle not in logged
        assert needle not in response.text
    assert str(account_id(db, "ana1")) not in logged
    assert feedback_log_lines(caplog) == []


def test_the_real_database_error_does_carry_the_row_so_the_wrapper_is_what_hides_it(db):
    """The control for the test above: without the wrapper the error text holds the message."""
    import uuid

    from sqlalchemy.exc import DBAPIError

    from tests.test_accounts_db import add_account
    from tests.test_feedback_db import add_feedback

    with pytest.raises(DBAPIError) as excinfo, db.begin() as conn:
        add_feedback(conn, add_account(conn, "Ana1"), message=MESSAGE, category="BAD")

    assert "MESSAGE-SENTINEL-4b7e" in str(excinfo.value.orig)
    _ = uuid


def test_a_failed_save_leaves_the_learner_able_to_send_again(fb_errors, db, monkeypatch):
    import app.feedback_routes as routes

    real = routes.store_feedback
    calls = []

    def fail_once(db_session, *, item, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            item = dataclasses.replace(item, category="BAD")
        return real(db_session, item=item, **kwargs)

    monkeypatch.setattr(routes, "store_feedback", fail_once)

    assert_error(send(fb_errors), 500, "internal_error")
    assert send(fb_errors).status_code == 202
    assert feedback_count(db) == 1


def test_the_stored_row_is_not_returned_by_any_route(ana_fb, db):
    send(ana_fb)
    stored = feedback_rows(db)[0]
    with db.connect() as conn:
        row_id = str(conn.execute(text("SELECT id FROM app.feedback")).scalar_one())
    me = ana_fb.get("/api/auth/me")

    for response in (me, ana_fb.get("/api/courses"), ana_fb.get("/api/feedback")):
        assert row_id not in response.text
        assert stored["message"] not in response.text
    assert ana_fb.get("/api/feedback").status_code == 405


def test_no_route_reads_feedback(ana_fb):
    from app.main import app

    feedback_routes = [r for r in app.routes if "feedback" in getattr(r, "path", "")]

    assert [(r.path, sorted(r.methods)) for r in feedback_routes] == [("/api/feedback", ["POST"])]
