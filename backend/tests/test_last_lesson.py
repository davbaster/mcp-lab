"""Saving the last lesson a learner visited (#15): PUT /api/courses/{course_id}/progress/last-lesson."""

import pytest

from tests.auth_support import assert_error, new_client, register, rows, with_cookie
from tests.content_support import (
    VISITOR_KINDS,
    committed_spec,
    progress_rows,
    put_progress,
    snapshot,
    visitor_headers,
)

URL = "/api/courses/gamma-course/progress/last-lesson"
ALPHA_URL = "/api/courses/alpha-course/progress/last-lesson"
DELTA_URL = "/api/courses/delta-course/progress/last-lesson"
PROGRESS = "/api/courses/gamma-course/progress"
NO_STORE = "private, no-store"


def save(client, lesson_id, url=URL, **kwargs):
    return client.put(url, json={"lesson_id": lesson_id}, **kwargs)


def progress_of(client, url=PROGRESS):
    return {c["id"]: c for c in client.get(url).json()["chapters"]}


# --- the write ---


def test_it_creates_the_row_of_the_lessons_chapter_and_returns_204_with_no_body(learner, db):
    response = save(learner, "intro-lesson")

    assert response.status_code == 204
    assert response.content == b""
    assert progress_rows(db) == [("01-intro", None, False, "intro-lesson")]


def test_it_has_cache_control_private_no_store(learner):
    assert save(learner, "intro-lesson").headers["cache-control"] == NO_STORE


def test_the_progress_route_shows_the_saved_lesson_and_nothing_else_changed(learner, db):
    before = progress_of(learner)

    save(learner, "intro-lesson")
    after = progress_of(learner)

    assert after["01-intro"]["last_lesson_id"] == "intro-lesson"
    after["01-intro"]["last_lesson_id"] = None
    assert after == before  # statuses and scores are unchanged
    assert [c["status"] for c in after.values()] == ["in_progress", "locked", "locked"]


def test_a_stored_score_and_a_pass_are_kept(learner, db):
    put_progress(db, "ana1", "01-intro", score=3, passed=True, last="old-lesson")
    before = rows(db, "SELECT best_score, passed_at FROM app.chapter_progress")

    assert save(learner, "intro-lesson").status_code == 204

    assert rows(db, "SELECT best_score, passed_at FROM app.chapter_progress") == before
    assert progress_rows(db) == [("01-intro", 3, True, "intro-lesson")]
    chapter = progress_of(learner)["01-intro"]
    assert (chapter["status"], chapter["best_score"]) == ("passed", 3)


def test_it_updates_an_existing_row(learner, db):
    put_progress(db, "ana1", "01-intro", last="old-lesson")

    save(learner, "intro-lesson")

    assert progress_rows(db) == [("01-intro", None, False, "intro-lesson")]


def test_the_same_request_twice_leaves_the_database_as_after_the_first(learner, db):
    save(learner, "intro-lesson")
    first = snapshot(db)

    assert save(learner, "intro-lesson").status_code == 204

    assert snapshot(db) == first


def test_lesson_a_and_then_lesson_b_of_one_chapter_leaves_one_row_with_b(learner, db):
    assert save(learner, "first-lesson", DELTA_URL).status_code == 204
    assert save(learner, "second-lesson", DELTA_URL).status_code == 204

    assert progress_rows(db, "delta-course") == [("01-open", None, False, "second-lesson")]


def test_each_chapter_keeps_its_own_lesson(learner, db):
    put_progress(db, "ana1", "01-open", course="delta-course", passed=True)
    save(learner, "first-lesson", DELTA_URL)

    save(learner, "quiz-link-7f3a", DELTA_URL)

    assert progress_rows(db, "delta-course") == [
        ("01-open", 4, True, "first-lesson"),
        ("02-closed", None, False, "quiz-link-7f3a"),
    ]


def test_the_chapter_comes_from_the_catalog_and_not_from_the_client(learner, db):
    # A client cannot name a chapter: an extra key is a 422, and the lesson decides the chapter.
    response = learner.put(URL, json={"lesson_id": "intro-lesson", "chapter_id": "03-end"})

    assert_error(response, 422, "validation_error")
    assert progress_rows(db) == []


def test_other_learners_and_other_courses_are_untouched(learner, db):
    assert register(new_client(), username="bob2").status_code == 201
    put_progress(db, "bob2", "01-intro", score=2, last="bobs-lesson")
    put_progress(db, "ana1", "01-basics", course="alpha-course", last="hello")  # same-shaped row
    put_progress(db, "ana1", "01-intro", course="alpha-course", last="elsewhere")
    others = snapshot(db)["chapter_progress"]

    save(learner, "intro-lesson")

    after = snapshot(db)["chapter_progress"]
    assert [row for row in after if row in others] == others
    assert len(after) == len(others) + 1
    assert progress_rows(db, "alpha-course") == [
        ("01-basics", None, False, "hello"),
        ("01-intro", None, False, "elsewhere"),
    ]
    assert progress_rows(db, username="bob2") == [("01-intro", 2, False, "bobs-lesson")]


def test_it_writes_no_other_table(learner, db):
    before = snapshot(db)

    save(learner, "intro-lesson")

    after = snapshot(db)
    assert after["sessions"] == before["sessions"]
    assert after["accounts"] == before["accounts"]


# --- access ---


def test_a_learner_may_save_a_lesson_of_a_locked_free_preview_chapter(learner, db):
    # gamma chapter 3 is `free_preview` and `locked` for a new learner.
    assert save(learner, "end-lesson").status_code == 204

    assert progress_rows(db) == [("03-end", None, False, "end-lesson")]
    assert progress_of(learner)["03-end"]["status"] == "locked"  # the row changes no status


def test_a_learner_gets_403_for_a_locked_chapter_that_is_not_free_preview_and_nothing_is_written(
    learner, db
):
    before = snapshot(db)

    assert_error(save(learner, "middle-lesson"), 403, "chapter_locked")
    assert_error(save(learner, "next-steps", ALPHA_URL), 403, "chapter_locked")

    assert snapshot(db) == before


def test_a_learner_may_save_a_lesson_of_an_unlocked_chapter(learner, db):
    put_progress(db, "ana1", "01-intro", passed=True)

    assert save(learner, "middle-lesson").status_code == 204

    assert ("02-middle", None, False, "middle-lesson") in progress_rows(db)


@pytest.mark.parametrize("kind", VISITOR_KINDS)
def test_a_visitor_gets_401_even_for_a_free_preview_lesson_and_even_with_an_invalid_body(
    content_api, db, clock, kind
):
    assert register(content_api).status_code == 201
    headers = visitor_headers(kind, content_api, clock)
    before = snapshot(db)

    for kwargs in (
        {"json": {"lesson_id": "intro-lesson"}},
        {"json": {"lesson_id": "middle-lesson"}},
        {"json": {"lesson_id": 5}},
        {"json": {}},
        {"json": []},
        {"json": {"lesson_id": "intro-lesson", "extra": 1}},
        {"content": b"{not json", "headers": {"content-type": "application/json"}},
        {"content": b"\xff\xfe", "headers": {"content-type": "application/json"}},
        {"content": b"", "headers": {"content-type": "application/json"}},
        {"content": b"intro-lesson", "headers": {"content-type": "text/plain"}},
    ):
        extra = kwargs.pop("headers", {})
        response = new_client().put(URL, headers={**headers, **extra}, **kwargs)

        assert_error(response, 401, "not_authenticated")
    assert snapshot(db) == before


def test_a_visitor_gets_401_for_an_unknown_course_and_an_unknown_lesson(content_api, db):
    client = new_client()

    assert_error(
        client.put("/api/courses/nope/progress/last-lesson", json={"lesson_id": "x"}),
        401,
        "not_authenticated",
    )
    assert_error(save(client, "no-such-lesson"), 401, "not_authenticated")


def test_an_unknown_course_is_404_course_not_found(learner, db):
    response = learner.put("/api/courses/nope/progress/last-lesson", json={"lesson_id": "x"})

    assert_error(response, 404, "course_not_found")
    assert progress_rows(db) == []


def test_an_unknown_lesson_is_404_before_the_access_rule_and_a_lesson_of_another_course_too(
    learner, db
):
    before = snapshot(db)

    assert_error(save(learner, "no-such-lesson"), 404, "lesson_not_found")
    assert_error(save(learner, "hello"), 404, "lesson_not_found")  # alpha's lesson, gamma's URL
    for odd in ("UPPER", "../x", "a" * 100, "with space"):
        assert_error(save(learner, odd), 404, "lesson_not_found")

    assert snapshot(db) == before


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"lesson_id": None},
        {"lesson_id": 5},
        {"lesson_id": ""},
        {"lesson_id": "a" * 101},
        {"lesson_id": ["intro-lesson"]},
        {"lesson_id": "intro-lesson", "extra": True},
        [],
        "intro-lesson",
        None,
    ],
)
def test_a_body_that_is_not_an_object_with_a_lesson_id_of_1_to_100_characters_is_422(
    learner, db, body
):
    response = learner.put(URL, json=body)

    assert_error(response, 422, "validation_error")
    assert progress_rows(db) == []


def test_a_body_that_is_not_json_is_422_for_a_learner(learner, db):
    for content in (b"{not json", b"\xff\xfe", b""):
        response = learner.put(URL, content=content, headers={"content-type": "application/json"})

        assert_error(response, 422, "validation_error")
    assert progress_rows(db) == []


def test_a_lesson_id_of_exactly_100_characters_is_a_404_and_not_a_422(learner):
    assert_error(save(learner, "a" * 100), 404, "lesson_not_found")


def test_the_422_message_does_not_echo_the_body(learner):
    response = save(learner, "SECRET-" + "x" * 200)

    assert_error(response, 422, "validation_error")
    assert "SECRET" not in response.text


def test_a_stored_lesson_that_was_removed_later_stays_as_stored(learner, db):
    put_progress(db, "ana1", "01-intro", last="removed-lesson")

    assert progress_of(learner)["01-intro"]["last_lesson_id"] == "removed-lesson"


def test_a_session_one_second_before_expiry_still_saves_and_at_expiry_gets_401(
    content_api, db, clock
):
    assert register(content_api).status_code == 201
    token = content_api.cookies.get("session")
    clock.advance(days=1, seconds=-1)
    assert save(new_client(), "intro-lesson", headers=with_cookie(token)).status_code == 204
    clock.advance(seconds=1)

    assert_error(
        save(new_client(), "intro-lesson", headers=with_cookie(token)), 401, "not_authenticated"
    )


# --- contract ---


def test_the_operation_needs_the_cookie_and_declares_the_204_header():
    operation = committed_spec()["paths"]["/api/courses/{course_id}/progress/last-lesson"]["put"]

    assert operation["operationId"] == "saveLastLesson"
    assert operation["security"] == [{"SessionCookie": []}]
    assert operation["responses"]["204"]["headers"]["Cache-Control"]
    assert "content" not in operation["responses"]["204"]
