"""The lesson read endpoint (#15): GET /api/courses/{course_id}/lessons/{lesson_id}."""

import json

import pytest
from sqlalchemy.engine import Engine

from tests.auth_support import assert_error, new_client, register, with_cookie
from tests.content_support import (
    COURSES,
    VISITOR_KINDS,
    committed_spec,
    put_progress,
    snapshot,
    visitor_headers,
)
from tests.course_support import FIXTURE_BUILD, GOLDEN_BUILD, read_manifest, write_manifest

KEYS = {
    "course_id",
    "chapter_id",
    "lesson_id",
    "title",
    "prev_lesson_id",
    "next_lesson_id",
    "tree",
}
GAMMA = "/api/courses/gamma-course/lessons"
DELTA = "/api/courses/delta-course/lessons"
ALPHA = "/api/courses/alpha-course/lessons"
NO_STORE = "private, no-store"
ODD_IDS = ["UPPER", "%2e%2e", "a" * 5000, "has space", "with_underscore", "x" * 101, "%00"]


def file_tree(course, lesson, build=FIXTURE_BUILD):
    path = build / "private" / "lessons" / course / f"{lesson}.json"
    return json.loads(path.read_text(encoding="utf-8"))["tree"]


# --- the response ---


def test_a_lesson_has_exactly_the_documented_keys_and_the_catalog_ids_and_title(content_api):
    response = content_api.get(f"{ALPHA}/hello")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == KEYS
    assert body["course_id"] == "alpha-course"
    assert body["chapter_id"] == "01-basics"
    assert body["lesson_id"] == "hello"
    assert body["title"] == "Hello"


def test_the_tree_is_the_trees_of_the_file_unchanged(content_api):
    response = content_api.get(f"{ALPHA}/hello")

    assert response.json()["tree"] == file_tree("alpha-course", "hello")


def test_the_golden_tree_of_the_content_build_comes_back_equal_as_json(serve, db, clock):
    client = serve("sample-course", build=GOLDEN_BUILD)
    client.base_url = "https://testserver"
    assert register(client).status_code == 201
    put_progress(db, "ana1", "01-first-steps", course="sample-course", passed=True)

    for lesson in ("01-welcome", "setup", "01-next"):
        response = client.get(f"/api/courses/sample-course/lessons/{lesson}")

        assert response.status_code == 200
        assert response.json()["tree"] == file_tree("sample-course", lesson, GOLDEN_BUILD)
        assert response.json()["course_id"] == "sample-course"


def test_the_title_comes_from_the_catalog_and_not_from_the_file(serve, build_copy):
    manifest = read_manifest(build_copy, "alpha-course")
    manifest["chapters"][0]["lessons"][0]["title"] = "A new title"
    write_manifest(build_copy, "alpha-course", manifest)
    client = serve("alpha-course", build=build_copy)

    assert client.get(f"{ALPHA}/hello").json()["title"] == "A new title"


@pytest.mark.parametrize(
    ("lesson", "before", "after"),
    [
        ("first-lesson", None, "second-lesson"),
        ("second-lesson", "first-lesson", "third-lesson"),
        ("third-lesson", "second-lesson", None),
        ("quiz-link-7f3a", None, None),  # the only lesson of its chapter
    ],
)
def test_the_neighbours_are_in_the_same_chapter_and_null_at_the_ends(
    content_api, learner, db, lesson, before, after
):
    put_progress(db, "ana1", "01-open", course="delta-course", passed=True)  # unlocks chapter 2

    response = learner.get(f"{DELTA}/{lesson}")

    assert response.status_code == 200
    body = response.json()
    assert body["prev_lesson_id"] == before
    assert body["next_lesson_id"] == after
    assert "prev_lesson_id" in body
    assert "next_lesson_id" in body


def test_the_last_lesson_of_a_chapter_never_points_into_the_next_chapter(content_api):
    # delta chapter 1 ends with `third-lesson`, and chapter 2 starts with `quiz-link-7f3a`.
    body = content_api.get(f"{DELTA}/third-lesson").json()

    assert body["next_lesson_id"] is None
    assert content_api.get(f"{ALPHA}/01-setup").json()["next_lesson_id"] is None


def test_the_neighbours_follow_the_manifest_order_and_not_the_name_order(content_api):
    # alpha chapter 1 is `hello` then `01-setup`: the names sort the other way.
    assert content_api.get(f"{ALPHA}/hello").json()["next_lesson_id"] == "01-setup"
    assert content_api.get(f"{ALPHA}/01-setup").json()["prev_lesson_id"] == "hello"


def test_the_lesson_response_has_cache_control_private_no_store_for_visitors_and_learners(
    content_api,
):
    visitor = new_client().get(f"{ALPHA}/hello")
    assert register(content_api).status_code == 201
    learner = content_api.get(f"{ALPHA}/hello")

    assert visitor.headers["cache-control"] == NO_STORE
    assert learner.headers["cache-control"] == NO_STORE


# --- visitors ---


@pytest.mark.parametrize("kind", VISITOR_KINDS)
def test_a_visitor_reads_any_lesson_of_a_free_preview_chapter(content_api, clock, kind):
    assert register(content_api).status_code == 201
    headers = visitor_headers(kind, content_api, clock)

    response = new_client().get(f"{GAMMA}/intro-lesson", headers=headers)

    assert response.status_code == 200
    assert response.json()["lesson_id"] == "intro-lesson"


@pytest.mark.parametrize("kind", VISITOR_KINDS)
def test_a_visitor_gets_401_for_a_lesson_of_a_chapter_that_is_not_free_preview(
    content_api, clock, kind
):
    assert register(content_api).status_code == 201
    headers = visitor_headers(kind, content_api, clock)

    for url in (f"{GAMMA}/middle-lesson", f"{ALPHA}/next-steps", f"{DELTA}/quiz-link-7f3a"):
        response = new_client().get(url, headers=headers)

        assert_error(response, 401, "not_authenticated")


def test_a_session_one_second_before_it_expires_still_reads_a_locked_free_lesson_as_a_learner(
    content_api, clock
):
    assert register(content_api).status_code == 201
    token = content_api.cookies.get("session")
    clock.advance(days=1, seconds=-1)

    response = new_client().get(f"{GAMMA}/middle-lesson", headers=with_cookie(token))

    assert_error(response, 403, "chapter_locked")  # a learner, not a visitor: 403 and not 401


def test_a_session_that_expires_while_reading_still_gives_a_free_lesson_but_not_a_closed_one(
    content_api, clock
):
    assert register(content_api).status_code == 201
    assert content_api.get(f"{GAMMA}/intro-lesson").status_code == 200
    clock.advance(days=1)

    assert content_api.get(f"{GAMMA}/end-lesson").status_code == 200
    assert_error(content_api.get(f"{GAMMA}/middle-lesson"), 401, "not_authenticated")


def test_with_no_free_preview_chapter_a_visitor_gets_401_for_every_lesson(serve, build_copy):
    manifest = read_manifest(build_copy, "alpha-course")
    for chapter in manifest["chapters"]:
        chapter["free_preview"] = False
    write_manifest(build_copy, "alpha-course", manifest)
    client = serve("alpha-course", build=build_copy)

    for lesson in ("hello", "01-setup", "next-steps"):
        assert_error(client.get(f"{ALPHA}/{lesson}"), 401, "not_authenticated")


# --- learners: the access matrix ---

L, I, P = "locked", "in_progress", "passed"
# gamma: intro-lesson (free), middle-lesson (not free), end-lesson (free, third chapter)
PASSES = {
    "a new learner": [],
    "after chapter 1": ["01-intro"],
    "after chapters 1 and 2": ["01-intro", "02-middle"],
    "all chapters": ["01-intro", "02-middle", "03-end"],
    "chapter 2 only (out of order)": ["02-middle"],
}
EXPECTED = {
    "a new learner": (200, 403, 200),
    "after chapter 1": (200, 200, 200),
    "after chapters 1 and 2": (200, 200, 200),
    "all chapters": (200, 200, 200),
    "chapter 2 only (out of order)": (200, 200, 200),
}


@pytest.mark.parametrize("who", list(PASSES))
def test_the_lesson_access_matrix_of_a_learner_on_gamma_course(learner, db, who):
    for chapter in PASSES[who]:
        put_progress(db, "ana1", chapter, passed=True)

    got = tuple(
        learner.get(f"{GAMMA}/{lesson}").status_code
        for lesson in ("intro-lesson", "middle-lesson", "end-lesson")
    )

    assert got == EXPECTED[who]


def test_a_locked_free_preview_chapter_is_readable_by_a_learner_as_by_a_visitor(learner):
    # gamma chapter 3 is `locked` for a new learner and `free_preview`.
    statuses = [
        c["status"] for c in learner.get("/api/courses/gamma-course/chapters").json()["chapters"]
    ]
    assert statuses == [I, L, L]

    assert learner.get(f"{GAMMA}/end-lesson").status_code == 200
    assert_error(learner.get(f"{GAMMA}/middle-lesson"), 403, "chapter_locked")


def test_a_learner_gets_403_for_a_locked_chapter_that_is_not_free_preview(learner):
    assert_error(learner.get(f"{ALPHA}/next-steps"), 403, "chapter_locked")
    assert learner.get(f"{ALPHA}/hello").status_code == 200


def test_out_of_order_data_gives_200_for_chapter_2_and_403_for_a_closed_chapter_3(
    serve, db, clock, build_copy
):
    manifest = read_manifest(build_copy, "gamma-course")
    manifest["chapters"][2]["free_preview"] = False  # gamma's third chapter is free; close it
    write_manifest(build_copy, "gamma-course", manifest)
    client = serve("gamma-course", build=build_copy)
    client.base_url = "https://testserver"
    assert register(client).status_code == 201
    put_progress(
        db, "ana1", "02-middle", passed=True
    )  # only chapter 2: in_progress, passed, locked

    assert client.get(f"{GAMMA}/intro-lesson").status_code == 200
    assert client.get(f"{GAMMA}/middle-lesson").status_code == 200
    assert_error(client.get(f"{GAMMA}/end-lesson"), 403, "chapter_locked")


def test_a_passed_chapter_stays_readable(learner, db):
    put_progress(db, "ana1", "01-intro", passed=True)
    put_progress(db, "ana1", "02-middle", passed=True)

    assert learner.get(f"{GAMMA}/middle-lesson").status_code == 200


# --- not found ---


def test_an_unknown_course_is_404_course_not_found_for_a_visitor_and_a_learner(learner):
    for client in (new_client(), learner):
        response = client.get("/api/courses/nope/lessons/hello")

        assert_error(response, 404, "course_not_found")


def test_a_course_that_is_not_configured_is_404(serve):
    client = serve("alpha-course")

    assert_error(
        client.get("/api/courses/gamma-course/lessons/intro-lesson"), 404, "course_not_found"
    )
    assert_error(client.get("/api/courses/unlisted-course/lessons/x"), 404, "course_not_found")


def test_an_unknown_lesson_is_404_lesson_not_found_for_a_visitor_and_a_learner_never_401(learner):
    for client in (new_client(), learner):
        response = client.get(f"{ALPHA}/no-such-lesson")

        assert_error(response, 404, "lesson_not_found")


def test_a_lesson_of_another_course_is_404_lesson_not_found(content_api):
    # `hello` is in alpha-course only.
    assert_error(content_api.get(f"{GAMMA}/hello"), 404, "lesson_not_found")
    assert_error(
        content_api.get("/api/courses/beta-course/lessons/hello"), 404, "lesson_not_found"
    )


@pytest.mark.parametrize("lesson", ODD_IDS)
def test_odd_lesson_ids_are_404_for_a_visitor_and_a_learner(learner, lesson):
    for client in (new_client(), learner):
        response = client.get(f"{ALPHA}/{lesson}")

        assert_error(response, 404, "lesson_not_found")


def test_a_dot_dot_lesson_segment_is_a_404(learner):
    # The HTTP client folds `..` out of the path before it is sent, so the router may answer.
    for client in (new_client(), learner):
        assert client.get(f"{ALPHA}/..").status_code == 404


def test_an_empty_lesson_segment_is_a_404_and_not_a_422_or_500(content_api):
    for url in ("/api/courses/alpha-course/lessons/", "/api/courses/alpha-course/lessons"):
        response = content_api.get(url)

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"


@pytest.mark.parametrize("lesson", ODD_IDS)
def test_an_odd_lesson_id_reads_nothing_from_disk(content_api, monkeypatch, lesson):
    from pathlib import Path

    reads = []
    original = Path.read_bytes

    def spy(self):
        reads.append(str(self))
        return original(self)

    monkeypatch.setattr(Path, "read_bytes", spy)
    for url in (f"{ALPHA}/{lesson}", f"/api/courses/{lesson}/lessons/hello"):
        assert content_api.get(url).status_code == 404

    assert reads == []


def test_the_path_is_built_from_catalog_ids_so_a_traversal_id_cannot_reach_another_file(
    content_api,
):
    # `private/lessons/alpha-course/../../courses/alpha-course` would be the manifest.
    for lesson in ("../../courses/alpha-course", "..%2F..%2Fcourses%2Falpha-course"):
        response = content_api.get(f"{ALPHA}/{lesson}")

        assert response.status_code == 404
        assert "schema_version" not in response.text


# --- no writes, no connection ---


def test_a_lesson_read_writes_nothing(learner, db):
    put_progress(db, "ana1", "01-intro", score=3, passed=True, last="intro-lesson")
    before = snapshot(db)

    assert learner.get(f"{GAMMA}/intro-lesson").status_code == 200
    assert learner.get(f"{GAMMA}/middle-lesson").status_code == 200
    assert learner.get(f"{GAMMA}/end-lesson").status_code == 200

    assert snapshot(db) == before


def test_a_new_learner_reading_creates_no_progress_row(learner, db):
    assert learner.get(f"{GAMMA}/intro-lesson").status_code == 200

    assert snapshot(db)["chapter_progress"] == []


def test_cookie_less_and_malformed_cookie_requests_open_no_database_connection(serve, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("a visitor's lesson read must not open a database connection")

    monkeypatch.setattr(Engine, "connect", refuse)
    monkeypatch.setattr(Engine, "begin", refuse)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    client = serve(COURSES)

    for cookie in (None, "garbage", "x" * 42, "x" * 44, ""):
        headers = {} if cookie is None else {"Cookie": f"session={cookie}"}
        free = client.get(f"{GAMMA}/intro-lesson", headers=headers)
        closed = client.get(f"{GAMMA}/middle-lesson", headers=headers)

        assert free.status_code == 200
        assert_error(closed, 401, "not_authenticated")


def test_a_learner_reading_a_free_preview_lesson_needs_no_progress_query(learner, monkeypatch):
    import app.access

    calls = []
    original = app.access.load_progress

    def counting(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(app.access, "load_progress", counting)

    assert learner.get(f"{GAMMA}/end-lesson").status_code == 200  # free, and locked for ana1
    assert calls == []
    assert learner.get(f"{GAMMA}/intro-lesson").status_code == 200
    assert calls == []
    assert_error(learner.get(f"{GAMMA}/middle-lesson"), 403, "chapter_locked")
    assert len(calls) == 1  # one query for the learner's rows of the course


# --- the contract ---


def test_the_lesson_operation_marks_the_cookie_as_optional():
    spec = committed_spec()
    operation = spec["paths"]["/api/courses/{course_id}/lessons/{lesson_id}"]["get"]

    assert operation["operationId"] == "getLesson"
    assert operation["security"] == [{"SessionCookie": []}, {}]
    assert operation["responses"]["200"]["headers"]["Cache-Control"]
