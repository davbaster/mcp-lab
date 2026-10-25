"""POST /api/feedback (#24): access, storage, request validation, and course scoping."""

import json
from datetime import UTC, datetime

import pytest

from tests.auth_support import assert_error, new_client
from tests.content_support import VISITOR_KINDS, visitor_headers
from tests.feedback_support import (
    FEEDBACK_URL,
    REMOVE,
    body,
    feedback_count,
    feedback_rows,
    message,
    send,
)

CATEGORIES = ["bug", "content_error", "confusing_explanation", "suggestion"]


def assert_accepted(response):
    assert response.status_code == 202
    assert response.content == b""
    assert response.headers["cache-control"] == "private, no-store"


def assert_invalid(response, field=None):
    text = assert_error(response, 422, "validation_error")
    if field is not None:
        assert field in text
    return text


# --- access ---------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", VISITOR_KINDS)
def test_a_visitor_gets_401_for_a_valid_and_for_an_invalid_body(ana_fb, db, clock, kind):
    headers = visitor_headers(kind, ana_fb, clock)

    for payload in (body(), {}, [], {"category": "nope"}, body(message="short")):
        response = new_client().post(FEEDBACK_URL, json=payload, headers=headers)
        assert_error(response, 401, "not_authenticated")
    not_json = new_client().post(
        FEEDBACK_URL, content=b"{ nope", headers={**headers, "content-type": "application/json"}
    )
    assert_error(not_json, 401, "not_authenticated")
    assert feedback_count(db) == 0


def test_a_learner_gets_202_with_no_body_and_a_private_no_store_header(ana_fb, db):
    response = send(ana_fb)

    assert_accepted(response)
    assert list(response.headers).count("set-cookie") == 0
    assert feedback_count(db) == 1


def test_a_learner_with_a_body_that_is_not_json_gets_422(ana_fb, db):
    response = ana_fb.post(
        FEEDBACK_URL, content=b"{ nope", headers={"content-type": "application/json"}
    )

    assert_invalid(response)
    assert feedback_count(db) == 0


# --- storage --------------------------------------------------------------------------------


@pytest.mark.parametrize("category", CATEGORIES)
def test_each_category_is_stored_with_status_new_and_the_clock_time(ana_fb, db, clock, category):
    response = send(ana_fb, body(category=category))

    assert_accepted(response)
    (row,) = feedback_rows(db)
    assert row["category"] == category
    assert row["status"] == "new"
    assert row["course_id"] == "alpha-course"
    assert row["created_at"] == clock.now


def test_a_stored_row_holds_every_value_as_validated(ana_fb, db, clock):
    context = {
        "page_path": "/courses/alpha-course/chapters/01-first/quiz",
        "course_id": "alpha-course",
        "chapter_id": "01-first",
        "lesson_id": "first-b",
        "question_id": "01-first-3",
        "app_version": "1.2.3-abc",
        "user_agent": "Agent/1.0 é 日本語",
        "viewport": {"width": 360, "height": 20000},
        "client_time": "2031-02-03T04:05:06.789+02:00",
        "console_errors": ["TypeError: x is undefined", "<script>alert(1)</script>  ", ""],
    }

    send(
        ana_fb,
        body(
            ctx=context,
            category="content_error",
            about_quiz_question=True,
            message="   Option B is wrong, see the explanation.  \n",
        ),
    )

    (row,) = feedback_rows(db)
    assert dict(row) == {
        "course_id": "alpha-course",
        "chapter_id": "01-first",
        "lesson_id": "first-b",
        "question_id": "01-first-3",
        "category": "content_error",
        "message": "Option B is wrong, see the explanation.",
        "about_quiz_question": True,
        "page_path": "/courses/alpha-course/chapters/01-first/quiz",
        "app_version": "1.2.3-abc",
        "user_agent": "Agent/1.0 é 日本語",
        "viewport_width": 360,
        "viewport_height": 20000,
        "client_time": datetime(2031, 2, 3, 2, 5, 6, 789000, tzinfo=UTC),
        "console_errors": ["TypeError: x is undefined", "<script>alert(1)</script>  ", ""],
        "status": "new",
        "created_at": clock.now,
    }


def test_a_row_outside_a_course_has_null_ids(ana_fb, db):
    context = {"page_path": "/", "course_id": None, "chapter_id": None, "lesson_id": None}

    assert_accepted(send(ana_fb, body(ctx=context, category="suggestion")))

    (row,) = feedback_rows(db)
    assert (row["course_id"], row["chapter_id"], row["lesson_id"], row["question_id"]) == (
        None,
        None,
        None,
        None,
    )
    assert row["about_quiz_question"] is False


def test_the_optional_fields_may_be_left_out(ana_fb, db):
    payload = body(ctx={"chapter_id": REMOVE, "lesson_id": REMOVE, "question_id": REMOVE})
    del payload["about_quiz_question"]

    assert_accepted(send(ana_fb, payload))

    (row,) = feedback_rows(db)
    assert (row["chapter_id"], row["lesson_id"], row["question_id"]) == (None, None, None)
    assert row["about_quiz_question"] is False


def test_the_ids_are_stored_as_sent_and_not_checked_against_the_content(ana_fb, db):
    context = {"chapter_id": "99-gone", "lesson_id": "removed-lesson", "question_id": "q-0"}

    assert_accepted(send(ana_fb, body(ctx=context)))

    (row,) = feedback_rows(db)
    assert (row["chapter_id"], row["lesson_id"], row["question_id"]) == (
        "99-gone",
        "removed-lesson",
        "q-0",
    )


def test_the_console_errors_are_not_rewritten_or_truncated(ana_fb, db):
    errors = ["x" * 500, "Bearer abc.def.ghi", "password=hunter2 at /x?token=abc", "é" * 500]

    assert_accepted(send(ana_fb, body(ctx={"console_errors": errors})))

    assert feedback_rows(db)[0]["console_errors"] == errors


def test_the_client_time_is_stored_as_sent_and_the_row_time_is_the_server_clock(ana_fb, db, clock):
    far_away = "2001-01-01T00:00:00Z"

    send(ana_fb, body(ctx={"client_time": far_away}))

    (row,) = feedback_rows(db)
    assert row["client_time"] == datetime(2001, 1, 1, tzinfo=UTC)
    assert row["created_at"] == clock.now


def test_two_items_get_two_different_ids_and_nothing_is_returned_about_them(ana_fb, db):
    first = send(ana_fb, body(message=message(1)))
    second = send(ana_fb, body(message=message(2)))

    assert first.content == second.content == b""
    assert dict(first.headers) == dict(second.headers)
    assert feedback_count(db) == 2


# --- message --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "a" * 10,
        "a" * 2000,
        "é" * 10,
        "日" * 2000,
        "  " + "a" * 10 + "\t\n ",
        "😀" * 10,
        "a" * 5 + " " * 5 + "a" * 5,
    ],
)
def test_a_message_of_10_to_2000_characters_after_trimming_is_accepted(ana_fb, db, text):
    assert_accepted(send(ana_fb, body(message=text)))

    assert feedback_rows(db)[0]["message"] == text.strip()


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "\n\t   ",
        "a" * 9,
        "é" * 9,
        "a" * 2001,
        "日" * 2001,
        "  " + "a" * 9 + "  ",
        " " + "a" * 2001 + " ",
    ],
)
def test_a_message_outside_10_to_2000_characters_after_trimming_is_422(ana_fb, db, text):
    assert_invalid(send(ana_fb, body(message=text)), "body.message")

    assert feedback_count(db) == 0


def test_a_message_is_counted_in_characters_not_bytes(ana_fb, db):
    # 9 characters, 27 bytes; and 2000 characters, 6000 bytes.
    assert_invalid(send(ana_fb, body(message="日" * 9)), "body.message")
    assert_accepted(send(ana_fb, body(message="日" * 2000)))


def test_a_missing_message_is_422(ana_fb, db):
    payload = body()
    del payload["message"]

    assert_invalid(send(ana_fb, payload), "body.message")


# --- top level ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "category", ["", "Bug", "BUG", "bugs", "other", "bug ", None, 1, True, ["bug"]]
)
def test_a_category_outside_the_four_values_is_422(ana_fb, db, category):
    assert_invalid(send(ana_fb, body(category=category)), "body.category")

    assert feedback_count(db) == 0


def test_a_missing_category_is_422(ana_fb):
    payload = body()
    del payload["category"]

    assert_invalid(send(ana_fb, payload), "body.category")


def test_a_missing_context_is_422(ana_fb):
    payload = body()
    del payload["context"]

    assert_invalid(send(ana_fb, payload), "body.context")


@pytest.mark.parametrize("value", ["true", "false", 1, 0, "yes", None, []])
def test_about_quiz_question_must_be_a_boolean(ana_fb, db, value):
    assert_invalid(send(ana_fb, body(about_quiz_question=value)), "body.about_quiz_question")

    assert feedback_count(db) == 0


def test_about_quiz_question_true_with_a_question_id_is_accepted(ana_fb, db):
    assert_accepted(send(ana_fb, body(ctx={"question_id": "01-first-1"}, about_quiz_question=True)))

    assert feedback_rows(db)[0]["about_quiz_question"] is True


def test_about_quiz_question_true_without_a_question_id_is_422(ana_fb, db):
    for context in ({"question_id": None}, {"question_id": REMOVE}):
        assert_invalid(send(ana_fb, body(ctx=context, about_quiz_question=True)), "question_id")

    assert feedback_count(db) == 0


def test_about_quiz_question_false_with_a_question_id_is_accepted(ana_fb, db):
    assert_accepted(send(ana_fb, body(ctx={"question_id": "01-first-1"})))


# --- context: page_path ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/a",
        "/courses/alpha-course/lessons/first-a",
        "/a/b/",
        "/with space",
        "/é/日本",
        "/" + "a" * 1999,
        "/a%3Fb",
        "/a:b",
        "/a/b/../c",
    ],
)
def test_a_path_that_starts_with_one_slash_is_accepted(ana_fb, db, path):
    assert_accepted(send(ana_fb, body(ctx={"page_path": path})))

    assert feedback_rows(db)[0]["page_path"] == path


@pytest.mark.parametrize(
    "path",
    [
        "",
        "a",
        "courses/x",
        "//evil.example/x",
        "//",
        "https://evil.example/x",
        "http://x/",
        "javascript:alert(1)",
        "/a?token=SECRET",
        "/a?",
        "/a#frag",
        "/a#",
        "/a\nb",
        "/a\rb",
        "/a\tb",
        "/a\x00b",
        "/a\x1fb",
        "/a\x7fb",
        "/a\x85b",
        "/" + "a" * 2000,
        None,
        1,
        ["/a"],
    ],
)
def test_a_page_path_that_is_not_a_plain_path_is_422(ana_fb, db, path):
    assert_invalid(send(ana_fb, body(ctx={"page_path": path})), "body.context.page_path")

    assert feedback_count(db) == 0


def test_a_missing_page_path_is_422(ana_fb):
    assert_invalid(send(ana_fb, body(ctx={"page_path": REMOVE})), "body.context.page_path")


# --- context: course and IDs ----------------------------------------------------------------


def test_course_id_may_be_null_but_not_missing(ana_fb, db):
    ctx = {"course_id": None, "chapter_id": None, "lesson_id": None}
    assert_accepted(send(ana_fb, body(ctx=ctx)))

    assert_invalid(send(ana_fb, body(ctx={**ctx, "course_id": REMOVE})), "body.context.course_id")
    assert feedback_count(db) == 1


@pytest.mark.parametrize("course", ["alpha-course", "beta-course"])
def test_each_configured_course_is_accepted_and_stored_under_its_own_id(ana_fb, db, course):
    ctx = {"course_id": course, "chapter_id": None, "lesson_id": None}

    assert_accepted(send(ana_fb, body(ctx=ctx)))

    assert feedback_rows(db)[0]["course_id"] == course


def test_feedback_is_stored_per_course_and_for_no_course(ana_fb, db, clock):
    for n, course in enumerate(["alpha-course", "beta-course", None, "alpha-course"], start=1):
        ctx = {"course_id": course, "chapter_id": None, "lesson_id": None}
        assert_accepted(send(ana_fb, body(ctx=ctx, message=message(n))))
        clock.advance(seconds=61)

    assert [row["course_id"] for row in feedback_rows(db)] == [
        "alpha-course",
        "beta-course",
        None,
        "alpha-course",
    ]


@pytest.mark.parametrize(
    "course",
    [
        "unlisted-course",
        "nope",
        "Alpha-Course",
        "ALPHA-COURSE",
        "alpha_course",
        "alpha course",
        "alpha-course ",
        " alpha-course",
        "alpha-course\n",
        "../alpha-course",
        "alpha/course",
        "",
        "a" * 101,
        "é",
        "alpha-course\x00",
    ],
)
def test_a_course_that_is_not_configured_or_not_well_formed_is_422_not_404(ana_fb, db, course):
    ctx = {"course_id": course, "chapter_id": None, "lesson_id": None}

    assert_invalid(send(ana_fb, body(ctx=ctx)), "body.context.course_id")

    assert feedback_count(db) == 0


def test_the_unknown_course_message_does_not_repeat_the_course(ana_fb):
    ctx = {"course_id": "sentinel-course-8f2a", "chapter_id": None, "lesson_id": None}

    response = send(ana_fb, body(ctx=ctx))

    assert_invalid(response, "body.context.course_id")
    assert "sentinel-course-8f2a" not in response.text


@pytest.mark.parametrize("column", ["chapter_id", "lesson_id", "question_id"])
@pytest.mark.parametrize("value", ["a", "a-b-1", "0", "-", "a" * 100, "01-first"])
def test_an_id_of_lowercase_letters_digits_and_hyphens_is_accepted(ana_fb, db, column, value):
    assert_accepted(send(ana_fb, body(ctx={column: value})))

    assert feedback_rows(db)[0][column] == value


@pytest.mark.parametrize("column", ["chapter_id", "lesson_id", "question_id"])
@pytest.mark.parametrize(
    "value",
    [
        "",
        "Upper",
        "aB",
        "a/b",
        "a b",
        "a_b",
        "a.b",
        "é",
        "a\n",
        "\na",
        "a" * 101,
        "../x",
        "a%2fb",
        "a\x00",
        1,
        ["a"],
        {},
    ],
)
def test_an_id_with_other_characters_or_the_wrong_length_is_422(ana_fb, db, column, value):
    assert_invalid(send(ana_fb, body(ctx={column: value})), f"body.context.{column}")

    assert feedback_count(db) == 0


@pytest.mark.parametrize("column", ["chapter_id", "lesson_id", "question_id"])
def test_an_id_with_a_null_course_is_422(ana_fb, db, column):
    ctx = {"course_id": None, "chapter_id": None, "lesson_id": None, "question_id": None}
    ctx[column] = "some-id"

    assert_invalid(send(ana_fb, body(ctx=ctx)), "chapter_id, lesson_id and question_id")

    assert feedback_count(db) == 0


# --- context: the rest ----------------------------------------------------------------------


@pytest.mark.parametrize("value", ["dev", "a", "1.2.3+build.5", "a" * 100, " "])
def test_an_app_version_of_1_to_100_characters_is_accepted(ana_fb, db, value):
    assert_accepted(send(ana_fb, body(ctx={"app_version": value})))

    assert feedback_rows(db)[0]["app_version"] == value


@pytest.mark.parametrize("value", ["", "a" * 101, None, 1, REMOVE])
def test_an_app_version_outside_1_to_100_characters_is_422(ana_fb, db, value):
    assert_invalid(send(ana_fb, body(ctx={"app_version": value})), "body.context.app_version")


@pytest.mark.parametrize("value", ["", "a" * 1000, "é" * 1000])
def test_a_user_agent_of_0_to_1000_characters_is_accepted(ana_fb, db, value):
    assert_accepted(send(ana_fb, body(ctx={"user_agent": value})))

    assert feedback_rows(db)[0]["user_agent"] == value


@pytest.mark.parametrize("value", ["a" * 1001, None, 1, REMOVE])
def test_a_user_agent_over_1000_characters_or_not_a_string_is_422(ana_fb, db, value):
    assert_invalid(send(ana_fb, body(ctx={"user_agent": value})), "body.context.user_agent")


@pytest.mark.parametrize("size", [(1, 1), (20000, 20000), (360, 640), (1, 20000)])
def test_a_viewport_from_1_to_20000_is_accepted(ana_fb, db, size):
    width, height = size

    assert_accepted(send(ana_fb, body(ctx={"viewport": {"width": width, "height": height}})))

    row = feedback_rows(db)[0]
    assert (row["viewport_width"], row["viewport_height"]) == size


@pytest.mark.parametrize("bad", [0, -1, 20001, 1.5, 100.0, "100", None, True, [100]])
@pytest.mark.parametrize("side", ["width", "height"])
def test_a_viewport_side_outside_1_to_20000_or_not_an_integer_is_422(ana_fb, db, side, bad):
    viewport = {"width": 100, "height": 100, side: bad}

    assert_invalid(send(ana_fb, body(ctx={"viewport": viewport})), f"body.context.viewport.{side}")

    assert feedback_count(db) == 0


@pytest.mark.parametrize("viewport", [{}, {"width": 1}, {"height": 1}, None, [], "1x1", REMOVE])
def test_a_viewport_with_a_missing_side_or_the_wrong_type_is_422(ana_fb, viewport):
    assert_invalid(send(ana_fb, body(ctx={"viewport": viewport})), "body.context.viewport")


@pytest.mark.parametrize(
    "stamp,expected",
    [
        ("2026-10-25T14:03:07.123Z", datetime(2026, 10, 25, 14, 3, 7, 123000, tzinfo=UTC)),
        ("2026-10-25T14:03:07Z", datetime(2026, 10, 25, 14, 3, 7, tzinfo=UTC)),
        ("2026-10-25T14:03:07+00:00", datetime(2026, 10, 25, 14, 3, 7, tzinfo=UTC)),
        ("2026-10-25T14:03:07-05:30", datetime(2026, 10, 25, 19, 33, 7, tzinfo=UTC)),
        ("2026-10-25T14:03:07.5+14:00", datetime(2026, 10, 25, 0, 3, 7, 500000, tzinfo=UTC)),
        ("0001-01-01T00:00:00Z", datetime(1, 1, 1, tzinfo=UTC)),
        ("0001-01-01T14:00:00+14:00", datetime(1, 1, 1, tzinfo=UTC)),
        ("9999-12-31T23:59:59Z", datetime(9999, 12, 31, 23, 59, 59, tzinfo=UTC)),
        ("9999-12-31T11:59:59-12:00", datetime(9999, 12, 31, 23, 59, 59, tzinfo=UTC)),
    ],
)
def test_a_client_time_with_a_time_zone_is_accepted(ana_fb, db, stamp, expected):
    assert_accepted(send(ana_fb, body(ctx={"client_time": stamp})))

    assert feedback_rows(db)[0]["client_time"] == expected


@pytest.mark.parametrize(
    "stamp",
    [
        "2026-10-25T14:03:07",
        "2026-10-25T14:03:07.123",
        "2026-10-25",
        "2026-10-25 14:03:07Z",
        "2026-10-25T14:03Z",
        "14:03:07Z",
        "2026-10-25T14:03:07+0200",
        "2026-13-25T14:03:07Z",
        "2026-10-25T25:03:07Z",
        "2026-02-30T00:00:00Z",
        "yesterday",
        "",
        "1761400987",
        1761400987,
        1761400987.5,
        None,
        True,
        "2026-10-25T14:03:07Z\n",
        "0001-01-01T00:00:00+14:00",
        "9999-12-31T23:59:59-12:00",
        "0000-01-01T00:00:00Z",
        "10000-01-01T00:00:00Z",
        REMOVE,
    ],
)
def test_a_client_time_without_a_zone_or_not_in_iso_form_is_422(ana_fb, db, stamp):
    assert_invalid(send(ana_fb, body(ctx={"client_time": stamp})), "body.context.client_time")

    assert feedback_count(db) == 0


@pytest.mark.parametrize("errors", [[], ["a"], ["a"] * 10, ["x" * 500] * 10, ["é" * 500]])
def test_up_to_10_console_errors_of_up_to_500_characters_are_accepted(ana_fb, db, errors):
    assert_accepted(send(ana_fb, body(ctx={"console_errors": errors})))

    assert feedback_rows(db)[0]["console_errors"] == errors


@pytest.mark.parametrize(
    "errors",
    [
        ["a"] * 11,
        ["x" * 501],
        ["ok"] * 9 + ["x" * 501],
        [1],
        [None],
        [["a"]],
        "a",
        {"0": "a"},
        None,
        REMOVE,
    ],
)
def test_more_than_10_console_errors_or_one_over_500_characters_or_the_wrong_type_is_422(
    ana_fb, db, errors
):
    assert_invalid(
        send(ana_fb, body(ctx={"console_errors": errors})), "body.context.console_errors"
    )

    assert feedback_count(db) == 0


# --- NUL and lone surrogates ----------------------------------------------------------------

UNSTORABLE = ["\u0000", "\ud800", "\udfff", "ab\u0000cd", "ab\udc00cd"]


def post_raw(client, payload):
    """Send JSON text with the escapes intact (the test client would refuse a lone surrogate)."""
    return client.post(
        FEEDBACK_URL,
        content=json.dumps(payload, ensure_ascii=True).encode("ascii"),
        headers={"content-type": "application/json"},
    )


@pytest.mark.parametrize("bad", UNSTORABLE)
def test_a_message_with_a_nul_or_a_lone_surrogate_is_422_not_500(ana_fb, db, bad):
    assert_invalid(post_raw(ana_fb, body(message="valid message " + bad)), "body.message")

    assert feedback_count(db) == 0


@pytest.mark.parametrize("bad", UNSTORABLE)
def test_a_user_agent_with_a_nul_or_a_lone_surrogate_is_422_not_500(ana_fb, db, bad):
    assert_invalid(post_raw(ana_fb, body(ctx={"user_agent": "UA " + bad})), "user_agent")

    assert feedback_count(db) == 0


@pytest.mark.parametrize("bad", UNSTORABLE)
def test_a_console_error_with_a_nul_or_a_lone_surrogate_is_422_not_500(ana_fb, db, bad):
    payload = body(ctx={"console_errors": ["fine", "bad " + bad]})

    assert_invalid(post_raw(ana_fb, payload), "body.context.console_errors[1]")

    assert feedback_count(db) == 0


@pytest.mark.parametrize("column", ["app_version", "page_path"])
def test_the_other_strings_refuse_a_nul_too(ana_fb, db, column):
    value = "/a\u0000b" if column == "page_path" else "v\u0000"

    assert_invalid(post_raw(ana_fb, body(ctx={column: value})), column)

    assert feedback_count(db) == 0


@pytest.mark.parametrize("column", ["chapter_id", "lesson_id", "question_id", "course_id"])
def test_an_id_with_a_nul_is_422(ana_fb, db, column):
    assert_invalid(post_raw(ana_fb, body(ctx={column: "a\u0000"})), column)


def test_a_category_with_a_lone_surrogate_is_422(ana_fb):
    assert_invalid(post_raw(ana_fb, body(category="bug\ud800")), "body.category")


def test_a_valid_astral_character_written_as_a_surrogate_pair_is_accepted(ana_fb, db):
    assert_accepted(post_raw(ana_fb, body(message="Smile \U0001f600 please fix this")))

    assert feedback_rows(db)[0]["message"] == "Smile \U0001f600 please fix this"


# --- unknown fields and types ---------------------------------------------------------------


def test_an_unknown_field_at_the_top_level_is_422(ana_fb, db):
    assert_invalid(send(ana_fb, body(extra="x")))

    assert feedback_count(db) == 0


def test_an_unknown_field_in_the_context_is_422(ana_fb, db):
    assert_invalid(send(ana_fb, body(ctx={"extra": "x"})), "body.context")

    assert feedback_count(db) == 0


def test_an_unknown_field_in_the_viewport_is_422(ana_fb, db):
    viewport = {"width": 1, "height": 1, "dpr": 2}

    assert_invalid(send(ana_fb, body(ctx={"viewport": viewport})), "body.context.viewport")

    assert feedback_count(db) == 0


@pytest.mark.parametrize("where", ["top", "context", "viewport"])
def test_an_unknown_field_is_not_named_in_the_error(ana_fb, where):
    payload = body()
    target = {
        "top": payload,
        "context": payload["context"],
        "viewport": payload["context"]["viewport"],
    }[where]
    target["sentinel_key_5e1d"] = 1

    response = send(ana_fb, payload)

    assert_invalid(response)
    assert "sentinel_key_5e1d" not in response.text


def test_an_account_id_in_the_body_is_422_not_trusted(ana_fb, db):
    assert_invalid(send(ana_fb, body(account_id="00000000-0000-0000-0000-000000000000")))

    assert feedback_count(db) == 0


@pytest.mark.parametrize("payload", [[], "text", 1, None, [body()], {}])
def test_a_body_that_is_not_an_object_or_is_empty_is_422(ana_fb, payload):
    assert_invalid(send(ana_fb, payload))


def test_strict_types_a_number_is_not_converted_to_a_string_or_back(ana_fb, db):
    cases = [
        body(message=1234567890),
        body(ctx={"app_version": 1}),
        body(ctx={"viewport": {"width": "100", "height": 100}}),
        body(ctx={"console_errors": [5]}),
        body(about_quiz_question="false"),
    ]

    for payload in cases:
        assert_invalid(send(ana_fb, payload))
    assert feedback_count(db) == 0


def test_every_422_is_in_the_shared_shape_and_does_not_repeat_the_message(ana_fb, db):
    secret = "MESSAGE-SENTINEL-77aa"
    payload = body(message=secret + " ".join(["x"] * 1000), category="not-a-category")

    response = send(ana_fb, payload)

    assert_invalid(response, "body.category")
    assert secret not in response.text
    assert response.json()["error"].keys() == {"code", "message"}


def test_a_too_long_message_is_not_repeated_in_the_422(ana_fb):
    secret = "LONG-MESSAGE-SENTINEL-1c3d"

    response = send(ana_fb, body(message=secret + "x" * 3000))

    assert_invalid(response, "body.message")
    assert secret not in response.text


def test_the_first_error_and_a_cross_field_error_both_name_a_field(ana_fb):
    response = send(ana_fb, body(ctx={"viewport": {"width": 0, "height": 0}}, category="x"))

    text = assert_invalid(response)
    assert "body.category" in text and "body.context.viewport.width" in text


# --- the spec -------------------------------------------------------------------------------


def test_the_spec_describes_the_route_and_forbids_extra_fields():
    from tests.content_support import committed_spec

    spec = committed_spec()
    operation = spec["paths"]["/api/feedback"]["post"]
    schemas = spec["components"]["schemas"]

    assert operation["operationId"] == "submitFeedback"
    assert operation["tags"] == ["feedback"]
    assert operation["security"] == [{"SessionCookie": []}]
    assert sorted(operation["responses"]) == ["202", "401", "422", "429", "500"]
    assert "content" not in operation["responses"]["202"]
    assert "Cache-Control" in operation["responses"]["202"]["headers"]
    for status in ("401", "422", "429", "500"):
        schema = operation["responses"][status]["content"]["application/json"]["schema"]
        assert schema == {"$ref": "#/components/schemas/ErrorResponse"}
    for name in ("FeedbackRequest", "FeedbackContext", "Viewport"):
        assert schemas[name]["additionalProperties"] is False
    assert set(schemas["FeedbackRequest"]["properties"]) == {
        "category",
        "message",
        "about_quiz_question",
        "context",
    }
    assert set(schemas["FeedbackContext"]["properties"]) == {
        "page_path",
        "course_id",
        "chapter_id",
        "lesson_id",
        "question_id",
        "app_version",
        "user_agent",
        "viewport",
        "client_time",
        "console_errors",
    }
    assert sorted(schemas["FeedbackRequest"]["required"]) == ["category", "context", "message"]
    assert "account_id" not in json.dumps(schemas["FeedbackRequest"])
