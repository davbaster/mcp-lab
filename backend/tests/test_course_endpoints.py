"""The public course list and chapter list (#13)."""

import json
import re
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.courses import (
    MANIFEST_SCHEMA_VERSION,
    _Manifest,
    _ManifestChapter,
    _ManifestLesson,
)
from app.main import app
from tests.auth_support import BASE_URL, register
from tests.course_support import GOLDEN_BUILD, SENTINEL_MARKER

ALPHA_CHAPTERS = {
    "course_id": "alpha-course",
    "chapters": [
        {
            "id": "01-basics",
            "title": "Basics",
            "free_preview": True,
            "lessons": [{"id": "hello", "title": "Hello"}, {"id": "01-setup", "title": "Setup"}],
            "status": None,
        },
        {
            "id": "02-more",
            "title": "More",
            "free_preview": False,
            "lessons": [{"id": "next-steps", "title": "Next steps"}],
            "status": None,
        },
    ],
}
BETA_CHAPTERS = {
    "course_id": "beta-course",
    "chapters": [
        {
            "id": "01-only",
            "title": "The only chapter",
            "free_preview": True,
            "lessons": [{"id": "only-lesson", "title": "The only lesson"}],
            "status": None,
        }
    ],
}
ALPHA_SUMMARY = {
    "id": "alpha-course",
    "title": "Alpha course",
    "description": "The first fixture course, with two chapters.",
    "chapter_count": 2,
}
BETA_SUMMARY = {
    "id": "beta-course",
    "title": "Beta course",
    "description": "The second fixture course, with one chapter.",
    "chapter_count": 1,
}


def assert_course_not_found(response):
    assert response.status_code == 404
    body = response.json()
    assert list(body) == ["error"]
    assert body["error"]["code"] == "course_not_found"
    assert body["error"]["message"]


def without_status(body):
    return {
        **body,
        "chapters": [{k: v for k, v in c.items() if k != "status"} for c in body["chapters"]],
    }


# --- GET /api/courses ---


def test_courses_follow_the_order_of_courses(serve):
    assert serve("alpha-course,beta-course").get("/api/courses").json() == {
        "courses": [ALPHA_SUMMARY, BETA_SUMMARY]
    }


def test_courses_follow_the_reverse_order_of_courses(serve):
    assert serve("beta-course,alpha-course").get("/api/courses").json() == {
        "courses": [BETA_SUMMARY, ALPHA_SUMMARY]
    }


def test_each_course_has_exactly_four_keys_and_chapter_count_is_the_chapter_total(serve):
    courses = serve().get("/api/courses").json()["courses"]

    for course in courses:
        assert sorted(course) == ["chapter_count", "description", "id", "title"]
    assert [c["chapter_count"] for c in courses] == [2, 1]


def test_only_the_configured_courses_are_listed_and_a_broken_unlisted_one_is_ignored(serve):
    response = serve("alpha-course").get("/api/courses")

    assert response.status_code == 200
    assert response.json() == {"courses": [ALPHA_SUMMARY]}


# --- GET /api/courses/{course_id}/chapters ---


def test_chapters_and_lessons_are_in_manifest_order(serve):
    response = serve().get("/api/courses/alpha-course/chapters")

    assert response.status_code == 200
    assert response.json() == ALPHA_CHAPTERS


def test_the_second_course_answers_with_its_own_data(serve):
    assert serve().get("/api/courses/beta-course/chapters").json() == BETA_CHAPTERS


def test_chapters_and_lessons_have_exactly_the_documented_keys(serve):
    body = serve().get("/api/courses/alpha-course/chapters").json()

    assert sorted(body) == ["chapters", "course_id"]
    for chapter in body["chapters"]:
        assert sorted(chapter) == ["free_preview", "id", "lessons", "status", "title"]
        assert isinstance(chapter["free_preview"], bool)
        for lesson in chapter["lessons"]:
            assert sorted(lesson) == ["id", "title"]


def test_a_lesson_listed_in_the_manifest_after_its_file_name_order_keeps_the_manifest_position(
    serve,
):
    lessons = serve().get("/api/courses/alpha-course/chapters").json()["chapters"][0]["lessons"]

    assert [lesson["id"] for lesson in lessons] == ["hello", "01-setup"]


# --- unknown courses ---


def test_a_course_in_the_build_folder_but_not_in_courses_is_404(serve):
    client = serve("alpha-course")

    assert_course_not_found(client.get("/api/courses/beta-course/chapters"))
    assert_course_not_found(client.get("/api/courses/unlisted-course/chapters"))


@pytest.mark.parametrize(
    "course_id",
    [
        "nope",
        "ALPHA-COURSE",
        "Alpha-Course",
        "alpha-course ",
        "%2e%2e",
        "%2E%2E",
        "a" * 5000,
        "alpha_course",
        "é",
        "%00",
        "alpha-course%0a",
    ],
)
def test_an_id_that_is_not_a_configured_course_is_404_course_not_found(course_id, serve):
    assert_course_not_found(serve().get(f"/api/courses/{course_id}/chapters"))


@pytest.mark.parametrize(
    "course_id", ["alpha-course%2Fx", "..%2F..%2Fetc", "a%5Cb", "..", ".", "%2e%2e%2f"]
)
def test_a_dot_segment_or_an_encoded_slash_in_the_id_is_a_404_with_the_shared_shape(
    course_id, serve
):
    # The client resolves `..` and `.` before the request is sent, and the path then matches no
    # route, so these get the generic not_found. Either way: 404, never 422 or 500.
    response = serve().get(f"/api/courses/{course_id}/chapters")

    assert response.status_code == 404
    assert response.json()["error"]["code"] in ("course_not_found", "not_found")


def test_an_unknown_course_reads_nothing_from_disk(serve, build_copy, monkeypatch):
    client = serve("alpha-course", build_copy)
    refused = AssertionError("an unknown course must be answered from memory")

    def refuse(*args, **kwargs):
        raise refused

    for name in ("read_bytes", "read_text", "is_file", "is_dir", "exists", "open"):
        monkeypatch.setattr(Path, name, refuse)

    assert_course_not_found(client.get("/api/courses/beta-course/chapters"))
    assert_course_not_found(client.get("/api/courses/nope/chapters"))


# --- public, and the same for everyone ---


def test_the_responses_are_the_same_with_and_without_a_session_cookie_except_the_status(serve, db):
    client = serve()
    client.base_url = BASE_URL  # https, so the cookie jar sends the Secure session cookie
    anon_courses = client.get("/api/courses")
    anon_chapters = client.get("/api/courses/alpha-course/chapters")

    assert register(client).status_code == 201
    assert client.cookies.get("session")
    learner_courses = client.get("/api/courses")
    learner_chapters = client.get("/api/courses/alpha-course/chapters")

    assert learner_courses.status_code == anon_courses.status_code == 200
    assert learner_courses.content == anon_courses.content
    assert learner_chapters.status_code == anon_chapters.status_code == 200
    assert [c["status"] for c in anon_chapters.json()["chapters"]] == [None, None]
    assert [c["status"] for c in learner_chapters.json()["chapters"]] == ["in_progress", "locked"]
    assert without_status(learner_chapters.json()) == without_status(anon_chapters.json())


def test_a_bogus_session_cookie_does_not_change_the_responses(serve):
    client = serve()
    before = client.get("/api/courses")

    client.cookies.set("session", "x" * 43)
    after = client.get("/api/courses")

    assert after.status_code == 200
    assert after.content == before.content


# --- nothing private ---


def test_no_response_holds_lesson_quiz_or_code_text_or_the_answer_keys(serve):
    client = serve()
    bodies = [client.get("/api/courses").text]
    for course_id in ("alpha-course", "beta-course"):
        bodies.append(client.get(f"/api/courses/{course_id}/chapters").text)

    for text in bodies:
        assert SENTINEL_MARKER not in text
        for sentinel in (
            "LESSON-SENTINEL",
            "CORRECT-SENTINEL",
            "EXPLANATION-SENTINEL",
            "CODE-SENTINEL",
        ):
            assert sentinel not in text
        for key in ("correct", "explanation", "options", "questions", "tree", "steps", "zip"):
            assert f'"{key}"' not in text
        assert "private/" not in text
        assert ".json" not in text


def test_the_fixture_files_do_hold_the_sentinels():
    # Guards the absence test above: it proves nothing if the sentinels are not in the files.
    private = Path(__file__).parent / "fixtures" / "course-build" / "private"
    text = "".join(
        path.read_text() for path in private.rglob("*.json") if "unlisted" not in path.name
    )

    for sentinel in (
        "LESSON-SENTINEL",
        "CORRECT-SENTINEL",
        "EXPLANATION-SENTINEL",
        "CODE-SENTINEL",
    ):
        assert sentinel in text


def test_a_field_added_to_the_manifest_does_not_reach_the_client(serve, build_copy, monkeypatch):
    # The loader rejects unknown fields, so a new field is a startup failure and never a leak;
    # the response models list their fields on their own as the second line of defence.
    from app.course_routes import ChapterSummary, CourseSummary, LessonSummary

    for model in (CourseSummary, ChapterSummary, LessonSummary):
        assert model.model_config["extra"] == "forbid"


# --- read once ---


def test_the_data_is_read_once_at_startup(serve, build_copy):
    client = serve("alpha-course,beta-course", build_copy)
    before = (
        client.get("/api/courses").content,
        client.get("/api/courses/alpha-course/chapters").content,
    )

    shutil.rmtree(build_copy)

    assert client.get("/api/courses").content == before[0]
    assert client.get("/api/courses/alpha-course/chapters").content == before[1]


def test_changing_a_manifest_after_startup_changes_nothing(serve, build_copy):
    client = serve("alpha-course", build_copy)
    before = client.get("/api/courses/alpha-course/chapters").content

    (build_copy / "private" / "courses" / "alpha-course.json").write_text("{")

    assert client.get("/api/courses/alpha-course/chapters").content == before


# --- no database ---


def test_the_endpoints_open_no_database_connection(serve, monkeypatch):
    from sqlalchemy.engine import Engine

    def refuse(*args, **kwargs):
        raise AssertionError("the course routes must not open a database connection")

    monkeypatch.setattr(Engine, "connect", refuse)
    monkeypatch.setattr(Engine, "begin", refuse)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    client = serve()

    assert client.get("/api/courses").status_code == 200
    assert client.get("/api/courses/alpha-course/chapters").status_code == 200
    assert client.get("/api/health").json() == {"status": "ok"}


def test_the_routes_fail_clearly_when_the_lifespan_did_not_run(monkeypatch):
    # TestClient used without `with` does not load the courses.
    client = TestClient(app, raise_server_exceptions=False)

    response = client.get("/api/courses")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"


# --- producer and consumer agree ---


def test_the_loader_accepts_the_keys_and_version_of_the_content_builds_golden_manifest():
    golden = json.loads(
        (GOLDEN_BUILD / "private" / "courses" / "sample-course.json").read_text(encoding="utf-8")
    )

    assert golden["schema_version"] == MANIFEST_SCHEMA_VERSION
    assert set(golden) == set(_Manifest.model_fields)
    for chapter in golden["chapters"]:
        assert set(chapter) == set(_ManifestChapter.model_fields)
        for lesson in chapter["lessons"]:
            assert set(lesson) == set(_ManifestLesson.model_fields)


def test_the_course_id_pattern_matches_the_ids_the_content_build_writes():
    golden = json.loads(
        (GOLDEN_BUILD / "private" / "courses" / "sample-course.json").read_text(encoding="utf-8")
    )
    ids = [golden["course_id"]]
    for chapter in golden["chapters"]:
        ids.append(chapter["id"])
        ids.extend(lesson["id"] for lesson in chapter["lessons"])

    assert all(re.fullmatch(r"[a-z0-9-]+", value) for value in ids)
