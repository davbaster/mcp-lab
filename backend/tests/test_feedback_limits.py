"""The feedback limits (#24): 10 per learner per rolling 24 hours, and a repeated message within
a minute ignored. All counted from `app.feedback` with the fake clock; no test sleeps."""

from datetime import timedelta

from tests.auth_support import assert_error, register
from tests.feedback_support import (
    body,
    feedback_count,
    feedback_rows,
    message,
    send,
    sign_in_again,
)
from tests.helpers import without_request_id

LIMIT_CODE = "feedback_limit_reached"


def fill_the_day(client, clock, spacing=timedelta(minutes=1), start=1):
    """Send 10 different messages, `spacing` apart; the clock ends `spacing` after the last."""
    for n in range(start, start + 10):
        assert send(client, body(message=message(n))).status_code == 202
        clock.advance(seconds=spacing.total_seconds())


def test_the_eleventh_item_in_a_day_is_429_and_is_not_stored(ana_fb, db, clock):
    fill_the_day(ana_fb, clock)

    response = send(ana_fb, body(message=message(99)))

    assert_error(response, 429, LIMIT_CODE)
    assert feedback_count(db) == 10


def test_the_429_says_when_the_learner_can_send_again(ana_fb, db, clock):
    first_at = clock.now
    fill_the_day(ana_fb, clock)

    message_text = assert_error(send(ana_fb, body(message=message(99))), 429, LIMIT_CODE)

    assert (first_at + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ") == "2030-01-16T12:00:00Z"
    assert "2030-01-16T12:00:00Z" in message_text


def test_the_limit_frees_up_exactly_24_hours_after_the_oldest_item(ana_fb, db, clock):
    start = clock.now
    fill_the_day(ana_fb, clock)  # items at start + 0, 1, ... 9 minutes; the clock is at +10 min
    retry_at = start + timedelta(hours=24)

    clock.now = retry_at - timedelta(seconds=1)
    sign_in_again(ana_fb, clock)
    one_second_early = send(ana_fb, body(message=message(99)))
    clock.now = retry_at
    sign_in_again(ana_fb, clock)
    on_time = send(ana_fb, body(message=message(99)))

    assert "2030-01-16T12:00:00Z" in assert_error(one_second_early, 429, LIMIT_CODE)
    assert on_time.status_code == 202
    assert feedback_count(db) == 11


def test_after_the_oldest_item_expires_the_next_one_sets_the_new_retry_time(ana_fb, db, clock):
    start = clock.now
    fill_the_day(ana_fb, clock)
    clock.now = start + timedelta(hours=24)
    sign_in_again(ana_fb, clock)
    assert send(ana_fb, body(message=message(50))).status_code == 202

    clock.advance(seconds=1)
    response = send(ana_fb, body(message=message(51)))

    # Now 10 items count again; the oldest of them was sent one minute after the first.
    assert "2030-01-16T12:01:00Z" in assert_error(response, 429, LIMIT_CODE)


def test_a_denied_request_does_not_count_toward_the_limit(ana_fb, db, clock):
    start = clock.now
    fill_the_day(ana_fb, clock)
    for n in range(60, 65):
        clock.advance(seconds=61)
        assert_error(send(ana_fb, body(message=message(n))), 429, LIMIT_CODE)

    clock.now = start + timedelta(hours=24)
    sign_in_again(ana_fb, clock)

    assert send(ana_fb, body(message=message(70))).status_code == 202
    assert feedback_count(db) == 11


def test_the_retry_time_is_utc_with_seconds_and_rounded_up_to_the_next_second(ana_fb, clock):
    clock.now = clock.now.replace(microsecond=250_000)
    fill_the_day(ana_fb, clock)

    text = assert_error(send(ana_fb, body(message=message(99))), 429, LIMIT_CODE)

    # 2030-01-15T12:00:00.25Z + 24 hours is 12:00:00.25 on the 16th: a time shown as :00 would
    # still be a 429, so it shows :01.
    assert "2030-01-16T12:00:01Z" in text


def test_the_limit_counts_all_courses_and_items_with_no_course(ana_fb, db, clock):
    courses = ["alpha-course", "beta-course", None]
    for n in range(1, 11):
        course = courses[n % 3]
        ctx = {"course_id": course, "chapter_id": None, "lesson_id": None}
        assert send(ana_fb, body(ctx=ctx, message=message(n))).status_code == 202
        clock.advance(seconds=61)

    for course in courses:
        ctx = {"course_id": course, "chapter_id": None, "lesson_id": None}
        assert_error(send(ana_fb, body(ctx=ctx, message=message(99))), 429, LIMIT_CODE)
    assert feedback_count(db) == 10


def test_another_learner_is_not_affected_by_the_first_learners_count(fb_api, db, clock):
    assert register(fb_api, "ana1").status_code == 201
    fill_the_day(fb_api, clock)
    assert_error(send(fb_api, body(message=message(99))), 429, LIMIT_CODE)

    fb_api.cookies.clear()
    assert register(fb_api, "ben1").status_code == 201

    assert send(fb_api, body(message=message(99))).status_code == 202
    assert len(feedback_rows(db, "ana1")) == 10
    assert len(feedback_rows(db, "ben1")) == 1


def test_a_learner_who_signs_in_again_keeps_the_count(ana_fb, db, clock):
    fill_the_day(ana_fb, clock)

    sign_in_again(ana_fb, clock)

    assert_error(send(ana_fb, body(message=message(99))), 429, LIMIT_CODE)


def test_the_client_time_does_not_change_the_limits(ana_fb, db, clock):
    for n in range(1, 11):
        ctx = {"client_time": f"2000-01-01T00:00:{n:02d}Z"}
        assert send(ana_fb, body(ctx=ctx, message=message(n))).status_code == 202
        clock.advance(seconds=61)

    far_future = {"client_time": "2999-01-01T00:00:00Z"}
    assert_error(send(ana_fb, body(ctx=far_future, message=message(99))), 429, LIMIT_CODE)


# --- duplicates -----------------------------------------------------------------------------


def test_the_same_message_within_a_minute_gets_202_and_is_not_stored_again(ana_fb, db, clock):
    first = send(ana_fb)
    clock.advance(seconds=59, milliseconds=999)

    second = send(ana_fb)

    assert (second.status_code, without_request_id(second), second.content) == (
        first.status_code,
        without_request_id(first),
        first.content,
    )
    assert second.content == b""
    assert feedback_count(db) == 1


def test_at_exactly_60_seconds_the_same_message_is_stored_again(ana_fb, db, clock):
    send(ana_fb)
    clock.advance(seconds=60)

    response = send(ana_fb)

    assert response.status_code == 202
    assert feedback_count(db) == 2


def test_the_window_is_counted_from_the_last_stored_copy_not_from_the_ignored_one(
    ana_fb, db, clock
):
    send(ana_fb)
    clock.advance(seconds=40)
    send(ana_fb)  # ignored
    clock.advance(seconds=25)  # 65 s after the stored copy, 25 s after the ignored one

    send(ana_fb)

    assert feedback_count(db) == 2


def test_the_duplicate_ignores_category_context_and_the_quiz_flag(ana_fb, db):
    send(ana_fb, body(category="bug"))

    other_ctx = {
        "page_path": "/elsewhere",
        "course_id": None,
        "chapter_id": None,
        "lesson_id": None,
    }
    response = send(ana_fb, body(category="suggestion", ctx=other_ctx))

    assert response.status_code == 202
    assert feedback_count(db) == 1
    assert feedback_rows(db)[0]["category"] == "bug"


def test_the_duplicate_check_compares_the_trimmed_message(ana_fb, db):
    send(ana_fb, body(message="Same words here"))

    send(ana_fb, body(message="   Same words here\n"))

    assert feedback_count(db) == 1


def test_the_duplicate_check_is_exact_and_case_sensitive(ana_fb, db):
    send(ana_fb, body(message="Same words here"))

    send(ana_fb, body(message="same words here"))
    send(ana_fb, body(message="Same words here."))
    send(ana_fb, body(message="Same  words here"))

    assert feedback_count(db) == 4


def test_an_ignored_duplicate_does_not_count_toward_the_daily_limit(ana_fb, db, clock):
    for _ in range(30):
        assert send(ana_fb, body(message=message(1))).status_code == 202
    assert feedback_count(db) == 1

    for n in range(2, 11):  # nine more fit
        assert send(ana_fb, body(message=message(n))).status_code == 202

    assert feedback_count(db) == 10
    assert_error(send(ana_fb, body(message=message(99))), 429, LIMIT_CODE)


def test_the_duplicate_check_runs_before_the_limit(ana_fb, db, clock):
    fill_the_day(ana_fb, clock, spacing=timedelta(seconds=1))  # the last was sent 1 s ago

    resent = send(ana_fb, body(message=message(10)))
    different = send(ana_fb, body(message=message(99)))

    assert resent.status_code == 202 and resent.content == b""
    assert_error(different, 429, LIMIT_CODE)
    assert feedback_count(db) == 10


def test_a_message_sent_again_after_a_minute_at_the_limit_is_429_like_any_other(ana_fb, db, clock):
    fill_the_day(ana_fb, clock, spacing=timedelta(seconds=1))
    clock.advance(seconds=70)  # a minute after message 10, so it is no longer a duplicate

    assert_error(send(ana_fb, body(message=message(10))), 429, LIMIT_CODE)


def test_a_message_sent_within_a_minute_is_a_duplicate_even_if_it_was_not_the_last_one(
    ana_fb, db, clock
):
    fill_the_day(ana_fb, clock, spacing=timedelta(seconds=1))

    # Message 1 was sent 10 s ago: still within the minute, so it is ignored too.
    assert send(ana_fb, body(message=message(1))).status_code == 202
    clock.advance(seconds=51)
    assert_error(send(ana_fb, body(message=message(1))), 429, LIMIT_CODE)


def test_the_same_message_from_two_learners_is_stored_twice(fb_api, db):
    assert register(fb_api, "ana1").status_code == 201
    assert send(fb_api).status_code == 202
    fb_api.cookies.clear()
    assert register(fb_api, "ben1").status_code == 201

    assert send(fb_api).status_code == 202

    assert len(feedback_rows(db, "ana1")) == 1
    assert len(feedback_rows(db, "ben1")) == 1


def test_a_rejected_request_is_not_a_duplicate_of_anything(ana_fb, db):
    assert send(ana_fb, body(category="nope")).status_code == 422

    assert send(ana_fb).status_code == 202
    assert feedback_count(db) == 1


def test_deleting_the_account_deletes_its_feedback_and_only_its_feedback(fb_api, db):
    from sqlalchemy import text

    assert register(fb_api, "ana1").status_code == 201
    send(fb_api)
    fb_api.cookies.clear()
    assert register(fb_api, "ben1").status_code == 201
    send(fb_api)

    with db.begin() as conn:
        conn.execute(text("DELETE FROM app.accounts WHERE username = 'ana1'"))

    assert len(feedback_rows(db)) == 1
    assert len(feedback_rows(db, "ben1")) == 1


def test_the_truncate_helper_empties_the_feedback_table(ana_fb, db):
    from tests.dbtools import truncate_app_tables

    send(ana_fb)
    assert feedback_count(db) == 1

    truncate_app_tables(db)

    assert feedback_count(db) == 0
