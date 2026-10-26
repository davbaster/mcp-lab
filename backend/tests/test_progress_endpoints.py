"""Chapter status on the chapter list and the progress route (#14)."""

import json
from datetime import UTC, datetime

import pytest
from sqlalchemy import text

from tests.auth_support import (
    BASE_URL,
    assert_error,
    count,
    new_client,
    register,
    rows,
    with_cookie,
)
from tests.course_support import SENTINEL_MARKER, read_manifest, write_manifest

COURSES = "alpha-course,beta-course,gamma-course"
GAMMA = ["01-intro", "02-middle", "03-end"]
L, I, P = "locked", "in_progress", "passed"
CHAPTERS_URL = "/api/courses/gamma-course/chapters"
PROGRESS_URL = "/api/courses/gamma-course/progress"
UNKNOWN_COURSES = ["nope", "ALPHA-COURSE", "unlisted-course", "%2e%2e", "a" * 5000, "alpha_course"]
PASSED_AT = datetime(2030, 1, 1, tzinfo=UTC)


@pytest.fixture
def api(serve, db, clock):
    """The app serving all three fixture courses, with a client for the first learner."""
    client = serve(COURSES)
    client.base_url = BASE_URL  # https, so the cookie jar sends the Secure session cookie
    return client


@pytest.fixture
def learner(api):
    """The client, signed in as `ana1`."""
    assert register(api).status_code == 201
    return api


def account_id(db, username="ana1"):
    return rows(db, "SELECT id FROM app.accounts WHERE username = :u", u=username)[0][0]


def put(db, username, chapter, *, course="gamma-course", score=None, passed=False, last=None):
    """Insert a progress row with SQL (the routes that write them come with #15 and #16)."""
    if passed and score is None:
        score = 4
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app.chapter_progress"
                " (account_id, course_id, chapter_id, best_score, passed_at, last_lesson_id)"
                " VALUES (:a, :c, :ch, :s, :p, :l)"
            ),
            {
                "a": account_id(db, username),
                "c": course,
                "ch": chapter,
                "s": score,
                "p": PASSED_AT if passed else None,
                "l": last,
            },
        )


def list_statuses(client, url=CHAPTERS_URL):
    response = client.get(url)
    assert response.status_code == 200
    return [c["status"] for c in response.json()["chapters"]]


def progress_statuses(client, url=PROGRESS_URL):
    response = client.get(url)
    assert response.status_code == 200
    return [c["status"] for c in response.json()["chapters"]]


def expired_session(learner, clock):
    token = learner.cookies.get("session")
    clock.advance(days=1)
    return token


# --- the chapter list: visitors ---


def test_a_visitor_gets_every_chapter_with_status_null(api):
    response = api.get(CHAPTERS_URL)

    assert response.status_code == 200
    body = response.json()
    assert body["course_id"] == "gamma-course"
    assert [c["id"] for c in body["chapters"]] == GAMMA
    assert [c["status"] for c in body["chapters"]] == [None, None, None]
    assert all("status" in c for c in body["chapters"])


def test_the_other_chapter_fields_are_the_same_as_before_status_was_added(api):
    chapters = api.get(CHAPTERS_URL).json()["chapters"]

    assert chapters == [
        {
            "id": "01-intro",
            "title": "Intro",
            "free_preview": True,
            "lessons": [{"id": "intro-lesson", "title": "Intro lesson"}],
            "status": None,
        },
        {
            "id": "02-middle",
            "title": "Middle",
            "free_preview": False,
            "lessons": [{"id": "middle-lesson", "title": "Middle lesson"}],
            "status": None,
        },
        {
            "id": "03-end",
            "title": "End",
            "free_preview": True,
            "lessons": [{"id": "end-lesson", "title": "End lesson"}],
            "status": None,
        },
    ]


@pytest.mark.parametrize("value", ["garbage", "x" * 43, "", "A" * 44, "a b", "a;b"])
def test_a_cookie_that_is_not_a_known_token_is_a_visitor_not_a_401(api, value):
    response = api.get(CHAPTERS_URL, headers={"Cookie": f"session={value}"})

    assert response.status_code == 200
    assert [c["status"] for c in response.json()["chapters"]] == [None, None, None]


def test_an_unknown_but_well_formed_token_is_a_visitor(api):
    assert list_statuses(api) == [None, None, None]
    response = api.get(CHAPTERS_URL, headers=with_cookie("a" * 43))

    assert response.status_code == 200
    assert [c["status"] for c in response.json()["chapters"]] == [None, None, None]


def test_an_expired_session_is_a_visitor_at_exactly_expires_at_and_a_learner_a_second_before(
    learner, clock
):
    token = learner.cookies.get("session")
    fresh = new_client()
    clock.advance(days=1, seconds=-1)

    one_second_before = fresh.get(CHAPTERS_URL, headers=with_cookie(token))
    clock.advance(seconds=1)
    at_expiry = fresh.get(CHAPTERS_URL, headers=with_cookie(token))

    assert [c["status"] for c in one_second_before.json()["chapters"]] == [I, L, L]
    assert at_expiry.status_code == 200
    assert [c["status"] for c in at_expiry.json()["chapters"]] == [None, None, None]


def test_the_chapter_list_of_a_visitor_opens_no_database_connection(serve, monkeypatch):
    from sqlalchemy.engine import Engine

    def refuse(*args, **kwargs):
        raise AssertionError("a visitor's chapter list must not open a database connection")

    monkeypatch.setattr(Engine, "connect", refuse)
    monkeypatch.setattr(Engine, "begin", refuse)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    client = serve(COURSES)

    assert client.get(CHAPTERS_URL).status_code == 200
    for cookie in ("garbage", "x" * 42, "x" * 44, ""):
        response = client.get(CHAPTERS_URL, headers={"Cookie": f"session={cookie}"})
        assert response.status_code == 200
        assert response.json()["chapters"][0]["status"] is None


# --- the chapter list: learners ---


def test_a_new_learner_has_the_first_chapter_in_progress_and_the_rest_locked(learner):
    assert list_statuses(learner) == [I, L, L]


def test_after_the_first_pass_the_second_chapter_is_in_progress(learner, db):
    put(db, "ana1", "01-intro", passed=True)

    assert list_statuses(learner) == [P, I, L]


def test_after_two_passes_the_third_chapter_is_in_progress(learner, db):
    put(db, "ana1", "01-intro", passed=True)
    put(db, "ana1", "02-middle", passed=True)

    assert list_statuses(learner) == [P, P, I]


def test_with_all_passes_every_chapter_is_passed(learner, db):
    for chapter in GAMMA:
        put(db, "ana1", chapter, passed=True)

    assert list_statuses(learner) == [P, P, P]


def test_out_of_order_data_is_shown_as_is_and_does_not_fail(learner, db):
    put(db, "ana1", "02-middle", passed=True)

    assert list_statuses(learner) == [I, P, L]


def test_a_free_preview_chapter_is_still_locked_for_a_learner(learner):
    chapters = learner.get(CHAPTERS_URL).json()["chapters"]

    assert chapters[2]["free_preview"] is True
    assert chapters[2]["status"] == L


def test_flipping_every_free_preview_flag_changes_no_status(serve, db, clock, build_copy):
    manifest = read_manifest(build_copy, "gamma-course")
    for chapter in manifest["chapters"]:
        chapter["free_preview"] = not chapter["free_preview"]
    write_manifest(build_copy, "gamma-course", manifest)
    client = serve("gamma-course", build_copy)
    client.base_url = BASE_URL
    assert register(client).status_code == 201
    put(db, "ana1", "01-intro", passed=True)

    chapters = client.get(CHAPTERS_URL).json()["chapters"]

    assert [c["free_preview"] for c in chapters] == [False, True, False]
    assert [c["status"] for c in chapters] == [P, I, L]  # as with the flags unflipped


def test_a_score_without_a_pass_does_not_unlock_the_next_chapter(learner, db):
    put(db, "ana1", "01-intro", score=5)

    assert list_statuses(learner) == [I, L, L]


def test_a_pass_in_another_course_does_not_change_this_course(learner, db):
    put(db, "ana1", "01-basics", course="alpha-course", passed=True)
    put(db, "ana1", "02-more", course="alpha-course", passed=True)

    assert list_statuses(learner) == [I, L, L]
    assert list_statuses(learner, "/api/courses/alpha-course/chapters") == [P, P]


def test_a_row_of_another_course_with_a_chapter_id_this_course_also_uses_is_ignored(learner, db):
    put(db, "ana1", "01-intro", course="beta-course", passed=True)

    assert list_statuses(learner) == [I, L, L]


def test_another_learners_pass_does_not_show(learner, db):
    other = new_client()
    assert register(other, username="bob2").status_code == 201
    put(db, "bob2", "01-intro", passed=True)

    assert list_statuses(learner) == [I, L, L]
    assert list_statuses(other) == [P, I, L]


def test_the_chapter_list_has_private_no_store_for_visitors_and_learners(api):
    visitor = api.get(CHAPTERS_URL)
    assert register(api).status_code == 201
    signed_in = api.get(CHAPTERS_URL)

    assert visitor.headers["cache-control"] == "private, no-store"
    assert signed_in.headers["cache-control"] == "private, no-store"


def test_the_course_list_is_unchanged_and_sets_no_cache_header(api):
    response = api.get("/api/courses")

    assert response.status_code == 200
    assert "cache-control" not in response.headers


@pytest.mark.parametrize("course_id", UNKNOWN_COURSES)
def test_an_unknown_course_is_404_on_the_chapter_list_with_and_without_a_session(api, course_id):
    visitor = api.get(f"/api/courses/{course_id}/chapters")
    assert register(api).status_code == 201
    signed_in = api.get(f"/api/courses/{course_id}/chapters")

    for response in (visitor, signed_in):
        assert_error(response, 404, "course_not_found")


# --- the progress route ---


@pytest.mark.parametrize("cookie", [None, "garbage", "x" * 43, "x" * 44])
def test_progress_without_a_valid_session_is_401(api, cookie):
    headers = {} if cookie is None else {"Cookie": f"session={cookie}"}

    assert_error(api.get(PROGRESS_URL, headers=headers), 401, "not_authenticated")


def test_progress_with_an_expired_session_is_401(learner, clock):
    token = expired_session(learner, clock)

    assert_error(
        new_client().get(PROGRESS_URL, headers=with_cookie(token)), 401, "not_authenticated"
    )


@pytest.mark.parametrize("course_id", UNKNOWN_COURSES)
def test_a_visitor_asking_for_an_unknown_course_gets_401_not_404(api, course_id):
    assert_error(api.get(f"/api/courses/{course_id}/progress"), 401, "not_authenticated")


@pytest.mark.parametrize("course_id", UNKNOWN_COURSES)
def test_a_learner_asking_for_an_unknown_course_gets_404(learner, course_id):
    assert_error(learner.get(f"/api/courses/{course_id}/progress"), 404, "course_not_found")


# The client resolves `..` before the request is sent, so it becomes `/api/progress`, and an
# encoded slash adds a path part: neither matches a route.
@pytest.mark.parametrize("course_id", ["..", "a%2Fb", "%2e%2e%2f"])
def test_a_dot_segment_or_encoded_slash_is_a_404_not_found_with_the_shared_shape(
    learner, course_id
):
    assert_error(learner.get(f"/api/courses/{course_id}/progress"), 404, "not_found")


def test_a_new_learner_gets_the_initial_state(learner):
    response = learner.get(PROGRESS_URL)

    assert response.status_code == 200
    assert response.json() == {
        "course_id": "gamma-course",
        "course_complete": False,
        "chapters": [
            {"id": chapter, "status": status, "best_score": None, "last_lesson_id": None}
            for chapter, status in zip(GAMMA, [I, L, L], strict=True)
        ],
    }


def test_the_body_and_each_chapter_have_exactly_the_documented_keys(learner, db):
    put(db, "ana1", "01-intro", passed=True, last="intro-lesson")

    body = learner.get(PROGRESS_URL).json()

    assert sorted(body) == ["chapters", "course_complete", "course_id"]
    for chapter in body["chapters"]:
        assert sorted(chapter) == ["best_score", "id", "last_lesson_id", "status"]


def test_the_chapters_are_in_manifest_order_with_one_entry_per_chapter(learner, db):
    put(db, "ana1", "03-end", passed=True)

    chapters = learner.get(PROGRESS_URL).json()["chapters"]

    assert [c["id"] for c in chapters] == GAMMA


def test_a_failed_attempt_is_in_progress_with_its_best_score(learner, db):
    put(db, "ana1", "01-intro", score=3)

    chapters = learner.get(PROGRESS_URL).json()["chapters"]

    assert chapters[0] == {
        "id": "01-intro",
        "status": I,
        "best_score": 3,
        "last_lesson_id": None,
    }
    assert [c["status"] for c in chapters] == [I, L, L]


def test_a_score_is_reported_whatever_the_status(learner, db):
    put(db, "ana1", "01-intro", score=5, passed=True)
    put(db, "ana1", "03-end", score=0)

    chapters = learner.get(PROGRESS_URL).json()["chapters"]

    assert [(c["status"], c["best_score"]) for c in chapters] == [(P, 5), (I, None), (L, 0)]


def test_a_row_with_only_a_last_lesson_has_no_score_and_no_pass(learner, db):
    put(db, "ana1", "01-intro", last="intro-lesson")

    chapters = learner.get(PROGRESS_URL).json()["chapters"]

    assert chapters[0] == {
        "id": "01-intro",
        "status": I,
        "best_score": None,
        "last_lesson_id": "intro-lesson",
    }


def test_a_last_lesson_that_is_no_longer_in_the_course_is_returned_as_stored(learner, db):
    put(db, "ana1", "01-intro", last="a-lesson-that-was-removed")

    assert learner.get(PROGRESS_URL).json()["chapters"][0]["last_lesson_id"] == (
        "a-lesson-that-was-removed"
    )


def test_a_row_for_a_removed_chapter_is_ignored_and_stays_in_the_table(learner, db):
    put(db, "ana1", "99-removed", passed=True, last="gone")
    put(db, "ana1", "01-intro", score=2)

    body = learner.get(PROGRESS_URL).json()

    assert [c["id"] for c in body["chapters"]] == GAMMA
    assert [c["status"] for c in body["chapters"]] == [I, L, L]
    assert "99-removed" not in json.dumps(body)
    assert count(db, "chapter_progress") == 2
    assert rows(db, "SELECT chapter_id FROM app.chapter_progress WHERE passed_at IS NOT NULL") == [
        ("99-removed",)
    ]


def test_the_course_is_complete_only_when_every_chapter_is_passed(learner, db):
    put(db, "ana1", "01-intro", passed=True)
    put(db, "ana1", "02-middle", passed=True)
    assert learner.get(PROGRESS_URL).json()["course_complete"] is False

    put(db, "ana1", "03-end", passed=True)

    assert learner.get(PROGRESS_URL).json()["course_complete"] is True


def test_a_pass_for_a_removed_chapter_does_not_complete_an_incomplete_course(learner, db):
    put(db, "ana1", "01-intro", passed=True)
    put(db, "ana1", "02-middle", passed=True)
    put(db, "ana1", "99-removed", passed=True)

    assert learner.get(PROGRESS_URL).json()["course_complete"] is False


def test_a_pass_for_the_last_chapter_only_leaves_the_course_incomplete(learner, db):
    put(db, "ana1", "03-end", passed=True)

    body = learner.get(PROGRESS_URL).json()

    assert [c["status"] for c in body["chapters"]] == [I, L, P]
    assert body["course_complete"] is False


def test_each_learner_sees_only_their_own_data(learner, db):
    other = new_client()
    assert register(other, username="bob2").status_code == 201
    put(db, "ana1", "01-intro", passed=True, score=5, last="intro-lesson")
    put(db, "bob2", "01-intro", score=2, last="middle-lesson")

    mine = learner.get(PROGRESS_URL)
    theirs = other.get(PROGRESS_URL)

    assert mine.json()["chapters"][0] == {
        "id": "01-intro",
        "status": P,
        "best_score": 5,
        "last_lesson_id": "intro-lesson",
    }
    assert theirs.json()["chapters"][0] == {
        "id": "01-intro",
        "status": I,
        "best_score": 2,
        "last_lesson_id": "middle-lesson",
    }
    for response, own, foreign in ((mine, "ana1", "bob2"), (theirs, "bob2", "ana1")):
        assert str(account_id(db, own)) not in response.text
        assert str(account_id(db, foreign)) not in response.text
        assert own not in response.text
        assert foreign not in response.text


def test_progress_has_private_no_store(learner):
    assert learner.get(PROGRESS_URL).headers["cache-control"] == "private, no-store"


def test_the_progress_request_writes_nothing(learner, db):
    put(db, "ana1", "01-intro", score=2, last="intro-lesson")
    tables = ("chapter_progress", "sessions", "accounts")
    before = [count(db, t) for t in tables]
    stored = rows(db, "SELECT * FROM app.chapter_progress")

    assert learner.get(PROGRESS_URL).status_code == 200
    assert learner.get(CHAPTERS_URL).status_code == 200

    assert [count(db, t) for t in tables] == before
    assert rows(db, "SELECT * FROM app.chapter_progress") == stored


def test_the_response_models_forbid_extra_fields():
    from app.course_routes import ChapterProgressSummary, ChapterSummary, CourseProgressResponse

    for model in (ChapterProgressSummary, ChapterSummary, CourseProgressResponse):
        assert model.model_config["extra"] == "forbid"


# --- status is computed, not stored ---


def test_reordering_the_chapters_reorders_the_statuses_with_the_same_rows(
    serve, db, clock, build_copy
):
    # With the manifest order 01, 02, 03 this one row gives [passed, in_progress, locked].
    manifest = read_manifest(build_copy, "gamma-course")
    first, second, third = manifest["chapters"]
    manifest["chapters"] = [second, first, third]
    write_manifest(build_copy, "gamma-course", manifest)
    client = serve("gamma-course", build_copy)
    client.base_url = BASE_URL
    assert register(client).status_code == 201
    put(db, "ana1", "01-intro", passed=True)

    body = client.get(PROGRESS_URL).json()

    assert [(c["id"], c["status"]) for c in body["chapters"]] == [
        ("02-middle", I),
        ("01-intro", P),
        ("03-end", L),
    ]
    assert list_statuses(client) == [I, P, L]
    assert "status" not in [
        r[0]
        for r in rows(
            db,
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_schema = 'app' AND table_name = 'chapter_progress'",
        )
    ]


# --- the two routes cannot drift ---


@pytest.mark.parametrize(
    "passes",
    [
        [],
        ["01-intro"],
        ["01-intro", "02-middle"],
        ["02-middle"],
        ["03-end"],
        ["01-intro", "03-end"],
        ["01-intro", "02-middle", "03-end"],
        ["01-intro", "99-removed"],
    ],
)
def test_the_chapter_list_and_the_progress_route_return_the_same_status(learner, db, passes):
    for chapter in passes:
        put(db, "ana1", chapter, passed=True)

    assert list_statuses(learner) == progress_statuses(learner)


# --- nothing private, nothing logged ---


def test_no_response_holds_lesson_quiz_or_code_text(learner, db):
    put(db, "ana1", "01-intro", passed=True)
    bodies = [
        learner.get(CHAPTERS_URL).text,
        learner.get(PROGRESS_URL).text,
        new_client().get(CHAPTERS_URL).text,
    ]

    for text_ in bodies:
        assert SENTINEL_MARKER not in text_
        for key in ("correct", "explanation", "options", "questions", "tree"):
            assert f'"{key}"' not in text_


def test_the_requests_log_no_token_cookie_account_id_or_username(api, db, caplog):
    username = "Qx9zLm2"
    assert register(api, username=username).status_code == 201
    token = api.cookies.get("session")
    put(db, username, "01-intro", passed=True)
    caplog.clear()

    assert api.get(CHAPTERS_URL).status_code == 200
    assert api.get(PROGRESS_URL).status_code == 200
    assert new_client().get(PROGRESS_URL).status_code == 401
    logged = caplog.text + "\n".join(str(r.__dict__) for r in caplog.records)

    assert token not in logged
    assert str(account_id(db, username)) not in logged
    assert username not in logged
    assert "session=" not in logged
