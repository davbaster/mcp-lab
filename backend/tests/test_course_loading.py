"""Loading the courses at startup (#13): every way it can fail, and what a good load logs."""

import copy
import json
import logging
import os
import queue
import socket
import subprocess
import sys
import threading

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine

from app.courses import CourseLoadError, load_catalog, load_catalog_from_environment
from app.main import app
from tests.course_support import (
    FIXTURE_BUILD,
    GOLDEN_BUILD,
    SENTINEL_MARKER,
    manifest_path,
    read_manifest,
    write_manifest,
)
from tests.dbtools import BACKEND_DIR

BUILD = str(FIXTURE_BUILD)
ALPHA_FILE = "private/courses/alpha-course.json"


def load_error(courses, build=BUILD) -> str:
    with pytest.raises(CourseLoadError) as raised:
        load_catalog(courses, str(build) if build is not None else None)
    return str(raised.value)


def field_name(path) -> str:
    """`("chapters", 0, "title")` as `chapters[0].title`, the way the messages write it."""
    name = ""
    for part in path:
        name += f"[{part}]" if isinstance(part, int) else (f".{part}" if name else part)
    return name


def break_manifest(build_copy, change) -> str:
    """Apply `change(document)` to the alpha manifest, then return the load error message."""
    document = read_manifest(build_copy, "alpha-course")
    change(document)
    write_manifest(build_copy, "alpha-course", document)
    return load_error("alpha-course", build_copy)


# --- the good path ---


def test_two_courses_load_in_the_order_of_courses():
    catalog = load_catalog("beta-course,alpha-course", BUILD)

    assert [course.id for course in catalog.courses] == ["beta-course", "alpha-course"]
    alpha = catalog.get("alpha-course")
    assert [(c.id, c.title, c.free_preview, c.has_code) for c in alpha.chapters] == [
        ("01-basics", "Basics", True, True),
        ("02-more", "More", False, False),
    ]
    assert [lesson.id for lesson in alpha.chapters[0].lessons] == ["hello", "01-setup"]


def test_entries_are_trimmed():
    catalog = load_catalog(" alpha-course , beta-course ", BUILD)

    assert [course.id for course in catalog.courses] == ["alpha-course", "beta-course"]


def test_load_logs_one_info_line_per_course_with_counts(caplog):
    caplog.clear()

    load_catalog("alpha-course,beta-course", BUILD)

    lines = [r.getMessage() for r in caplog.records if r.levelno == logging.INFO]
    assert lines == [
        "loaded course alpha-course: 2 chapters, 3 lessons",
        "loaded course beta-course: 1 chapters, 1 lessons",
    ]


def test_logs_and_messages_hold_no_lesson_quiz_or_code_text(caplog, build_copy):
    caplog.clear()
    load_catalog("alpha-course,beta-course", BUILD)
    (build_copy / "private" / "quizzes" / "alpha-course" / "01-basics.json").unlink()
    message = load_error("alpha-course", build_copy)

    assert SENTINEL_MARKER not in caplog.text
    assert SENTINEL_MARKER not in message


def test_the_lifespan_loads_the_catalog_and_removes_it_at_shutdown(monkeypatch):
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", BUILD)

    with TestClient(app):
        assert "alpha-course" in app.state.catalog

    assert not hasattr(app.state, "catalog")


def test_the_content_build_golden_output_loads(monkeypatch):
    catalog = load_catalog("sample-course", str(GOLDEN_BUILD))

    assert [chapter.id for chapter in catalog.get("sample-course").chapters] == [
        "01-first-steps",
        "02-going-further",
    ]


# --- COURSES ---


@pytest.mark.parametrize("value", [None, "", "   ", "\t\n"])
def test_courses_unset_empty_or_blank_fails_naming_courses(value):
    assert "COURSES" in load_error(value)


@pytest.mark.parametrize(
    "value", ["alpha-course,", "alpha-course,,beta-course", ",alpha-course", "a, ,b"]
)
def test_an_empty_entry_fails_and_says_so(value):
    message = load_error(value)

    assert "COURSES" in message
    assert "empty entry" in message


@pytest.mark.parametrize(
    "entry", ["../x", "A", "a/b", "Alpha-Course", "alpha_course", "a b", "..", "alpha\\beta", "é"]
)
def test_an_entry_that_is_not_a_course_id_fails_naming_the_entry(entry):
    message = load_error(f"alpha-course,{entry}")

    assert repr(entry) in message
    assert "not a valid course ID" in message


def test_the_id_check_comes_before_any_path_is_built():
    # The build folder is unset too: the entry is reported first, and no folder is looked at.
    message = load_error("../x", build=None)

    assert "'../x'" in message
    assert "COURSE_BUILD_DIR" not in message


def test_a_duplicate_entry_fails_naming_the_id():
    message = load_error("alpha-course,beta-course,alpha-course")

    assert "alpha-course" in message
    assert "more than once" in message


@pytest.mark.parametrize("length", [101, 251, 255, 256, 5000])
def test_an_entry_over_100_characters_fails_as_too_long_not_as_an_oserror(length):
    message = load_error(f"alpha-course,{'a' * length}")

    assert "COURSES" in message
    assert "too long" in message
    assert "'" + "a" * 76 + "... (entry 2" in message  # shortened to 80 characters, like the others
    assert "a" * 77 not in message
    assert "entry 2" in message
    assert f"{length} characters" in message
    assert "at most 100 characters" in message
    assert len(message) < 300


def test_an_entry_of_exactly_100_characters_gets_past_the_parse_and_has_no_manifest():
    message = load_error("a" * 100)

    assert "No manifest for the course " + "a" * 100 in message


def test_the_length_of_an_entry_is_counted_after_trimming():
    assert "No manifest" in load_error(f"  {'a' * 100}  ")


def test_an_entry_that_is_both_invalid_and_too_long_gets_the_not_a_valid_id_message():
    message = load_error("A" * 300)

    assert "not a valid course ID" in message
    assert "too long" not in message


def test_the_first_problem_in_courses_order_is_reported_empty_entry_before_long_one():
    message = load_error(f",{'a' * 300}")

    assert "empty entry (entry 1)" in message
    assert "too long" not in message


def test_the_length_check_comes_before_the_build_folder_is_looked_at():
    message = load_error("a" * 300, build=None)

    assert "too long" in message
    assert "COURSE_BUILD_DIR" not in message


# --- COURSE_BUILD_DIR ---


@pytest.mark.parametrize("kind", ["unset", "empty", "missing", "file"])
def test_a_bad_build_dir_fails_naming_course_build_dir(kind, tmp_path):
    build = {
        "unset": None,
        "empty": "",
        "missing": tmp_path / "nowhere",
        "file": FIXTURE_BUILD / "private" / "courses" / "alpha-course.json",
    }[kind]

    assert "COURSE_BUILD_DIR" in load_error("alpha-course", build)


def test_a_build_folder_with_a_300_character_part_fails_naming_course_build_dir(tmp_path):
    message = load_error("alpha-course", tmp_path / ("d" * 300))

    assert "COURSE_BUILD_DIR is not an existing folder" in message
    assert len(message) < 300


# --- the manifest ---


def test_a_course_without_a_manifest_fails_naming_the_course_and_the_file():
    message = load_error("alpha-course,omega-course")

    assert "omega-course" in message
    assert "private/courses/omega-course.json" in message


def test_a_manifest_that_is_a_folder_fails_like_a_missing_one(build_copy):
    path = manifest_path(build_copy, "alpha-course")
    path.unlink()
    path.mkdir()

    message = load_error("alpha-course", build_copy)

    assert ALPHA_FILE in message


def test_empty_build_folder_fails_naming_the_course(tmp_path):
    message = load_error("alpha-course", tmp_path)

    assert "alpha-course" in message
    assert ALPHA_FILE in message


@pytest.mark.parametrize(
    "content", [b"", b"{", b"not json", b"\xff\xfe\x00{}", b"\xef\xbb\xbf{}", b"[" * 100000]
)
def test_a_manifest_that_is_not_utf8_json_fails_naming_the_file(content, build_copy):
    manifest_path(build_copy, "alpha-course").write_bytes(content)

    message = load_error("alpha-course", build_copy)

    assert ALPHA_FILE in message
    assert "UTF-8 JSON" in message


@pytest.mark.parametrize("document", [[], "text", 5, None])
def test_a_manifest_that_is_not_an_object_fails(document, build_copy):
    write_manifest(build_copy, "alpha-course", document)

    message = load_error("alpha-course", build_copy)

    assert ALPHA_FILE in message
    assert "JSON object" in message


@pytest.mark.parametrize(
    "field", ["schema_version", "course_id", "title", "description", "chapters"]
)
def test_a_missing_top_level_field_fails_naming_file_and_field(field, build_copy):
    message = break_manifest(build_copy, lambda doc: doc.pop(field))

    assert ALPHA_FILE in message
    assert f"field {field}" in message


@pytest.mark.parametrize("field", ["id", "title", "free_preview", "has_code", "lessons"])
def test_a_missing_chapter_field_fails_naming_file_and_field(field, build_copy):
    message = break_manifest(build_copy, lambda doc: doc["chapters"][1].pop(field))

    assert ALPHA_FILE in message
    assert f"chapters[1].{field}" in message


@pytest.mark.parametrize("field", ["id", "title", "order"])
def test_a_missing_lesson_field_fails_naming_file_and_field(field, build_copy):
    message = break_manifest(build_copy, lambda doc: doc["chapters"][0]["lessons"][1].pop(field))

    assert ALPHA_FILE in message
    assert f"chapters[0].lessons[1].{field}" in message


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("course_id",), 5),
        (("title",), 5),
        (("description",), ["x"]),
        (("chapters",), {"a": 1}),
        (("chapters", 0, "title"), 7),
        (("chapters", 0, "free_preview"), "yes"),
        (("chapters", 0, "free_preview"), 1),
        (("chapters", 0, "has_code"), None),
        (("chapters", 0, "lessons"), "none"),
        (("chapters", 0, "lessons", 0, "title"), False),
        (("chapters", 0, "lessons", 0, "order"), "1"),
        (("chapters", 0, "lessons", 0, "order"), True),
        (("chapters", 0, "lessons", 0, "order"), 1.5),
    ],
)
def test_a_field_of_the_wrong_type_fails_naming_file_and_field(path, value, build_copy):
    def change(doc):
        target = doc
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value

    message = break_manifest(build_copy, change)

    assert ALPHA_FILE in message
    assert f"field {field_name(path)}" in message


@pytest.mark.parametrize(
    "path",
    [
        ("title",),
        ("description",),
        ("chapters", 0, "title"),
        ("chapters", 0, "lessons", 0, "title"),
    ],
)
def test_an_empty_title_or_description_fails(path, build_copy):
    def change(doc):
        target = doc
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = ""

    message = break_manifest(build_copy, change)

    assert ALPHA_FILE in message
    assert f"field {field_name(path)}" in message


@pytest.mark.parametrize(
    ("where", "name"),
    [
        (lambda doc: doc, "extra"),
        (lambda doc: doc["chapters"][0], "chapters[0].extra"),
        (lambda doc: doc["chapters"][0]["lessons"][0], "chapters[0].lessons[0].extra"),
    ],
)
def test_an_unknown_field_fails_naming_file_and_field(where, name, build_copy):
    message = break_manifest(build_copy, lambda doc: where(doc).update(extra="x"))

    assert ALPHA_FILE in message
    assert f"field {name}" in message


@pytest.mark.parametrize("version", [1, 3, "2", 2.5, None, True])
def test_another_schema_version_fails_naming_the_version(version, build_copy):
    message = break_manifest(build_copy, lambda doc: doc.update(schema_version=version))

    assert ALPHA_FILE in message
    assert "schema_version" in message
    assert repr(version) in message


def test_a_manifest_with_no_chapter_fails(build_copy):
    message = break_manifest(build_copy, lambda doc: doc.update(chapters=[]))

    assert ALPHA_FILE in message
    assert "field chapters" in message


def test_a_chapter_with_no_lesson_fails(build_copy):
    message = break_manifest(build_copy, lambda doc: doc["chapters"][1].update(lessons=[]))

    assert ALPHA_FILE in message
    assert "chapters[1].lessons" in message


def test_a_repeated_chapter_id_fails(build_copy):
    def change(doc):
        doc["chapters"].append(copy.deepcopy(doc["chapters"][0]))
        doc["chapters"][2]["lessons"] = [{"id": "other", "title": "Other", "order": 1}]

    message = break_manifest(build_copy, change)

    assert ALPHA_FILE in message
    assert "chapters[2].id" in message
    assert "01-basics" in message


def test_a_repeated_lesson_id_in_one_chapter_fails(build_copy):
    def change(doc):
        doc["chapters"][0]["lessons"][1]["id"] = "hello"

    message = break_manifest(build_copy, change)

    assert ALPHA_FILE in message
    assert "chapters[0].lessons[1].id" in message
    assert "hello" in message


def test_a_repeated_lesson_id_in_two_chapters_fails(build_copy):
    def change(doc):
        doc["chapters"][1]["lessons"][0]["id"] = "hello"

    message = break_manifest(build_copy, change)

    assert ALPHA_FILE in message
    assert "chapters[1].lessons[0].id" in message


def test_a_manifest_for_another_course_fails_naming_both(build_copy):
    message = break_manifest(build_copy, lambda doc: doc.update(course_id="beta-course"))

    assert ALPHA_FILE in message
    assert "beta-course" in message
    assert "alpha-course" in message


@pytest.mark.parametrize("bad", ["Bad", "../x", "a/b", "a b", "", "x_y", "..", "a\n"])
def test_a_chapter_id_that_is_not_lowercase_letters_digits_and_hyphens_fails(bad, build_copy):
    message = break_manifest(build_copy, lambda doc: doc["chapters"][0].update(id=bad))

    assert ALPHA_FILE in message
    assert "chapters[0].id" in message


@pytest.mark.parametrize("bad", ["Bad", "../x", "a/b", "a b", "", "x_y", "..", "a\n"])
def test_a_lesson_id_that_is_not_lowercase_letters_digits_and_hyphens_fails(bad, build_copy):
    message = break_manifest(
        build_copy, lambda doc: doc["chapters"][0]["lessons"][0].update(id=bad)
    )

    assert ALPHA_FILE in message
    assert "chapters[0].lessons[0].id" in message


@pytest.mark.parametrize("length", [101, 251])
def test_a_chapter_id_over_100_characters_fails_naming_file_and_field(length, build_copy):
    message = break_manifest(build_copy, lambda doc: doc["chapters"][0].update(id="a" * length))

    assert (
        message == f"{ALPHA_FILE}: field chapters[0].id: String should have at most 100 characters."
    )


@pytest.mark.parametrize("length", [101, 251])
def test_a_lesson_id_over_100_characters_fails_naming_file_and_field(length, build_copy):
    message = break_manifest(
        build_copy, lambda doc: doc["chapters"][0]["lessons"][0].update(id="a" * length)
    )

    assert message == (
        f"{ALPHA_FILE}: field chapters[0].lessons[0].id: String should have at most 100 characters."
    )


def test_a_chapter_id_and_a_lesson_id_of_100_characters_load(build_copy):
    long_id = "a" * 100
    document = read_manifest(build_copy, "alpha-course")
    document["chapters"][1]["id"] = long_id
    document["chapters"][1]["lessons"][0]["id"] = long_id
    write_manifest(build_copy, "alpha-course", document)
    (build_copy / "private" / "quizzes" / "alpha-course" / "02-more.json").rename(
        build_copy / "private" / "quizzes" / "alpha-course" / f"{long_id}.json"
    )
    (build_copy / "private" / "lessons" / "alpha-course" / "next-steps.json").rename(
        build_copy / "private" / "lessons" / "alpha-course" / f"{long_id}.json"
    )

    chapter = load_catalog("alpha-course", str(build_copy)).get("alpha-course").chapters[1]

    assert chapter.id == long_id
    assert chapter.lessons[0].id == long_id


# --- the files the manifest points to ---


@pytest.mark.parametrize(
    "relative",
    [
        "private/lessons/alpha-course/hello.json",
        "private/lessons/alpha-course/next-steps.json",
        "private/quizzes/alpha-course/01-basics.json",
        "private/quizzes/alpha-course/02-more.json",
        "private/code/alpha-course/01-basics.json",
    ],
)
def test_a_missing_file_fails_naming_its_path_in_the_build_folder(relative, build_copy):
    (build_copy / relative).unlink()

    message = load_error("alpha-course", build_copy)

    assert relative in message
    assert str(build_copy) not in message


def test_a_file_that_is_a_folder_fails(build_copy):
    path = build_copy / "private" / "quizzes" / "alpha-course" / "02-more.json"
    path.unlink()
    path.mkdir()

    assert "private/quizzes/alpha-course/02-more.json" in load_error("alpha-course", build_copy)


def test_another_courses_file_does_not_stand_in(build_copy):
    (build_copy / "private" / "lessons" / "alpha-course" / "hello.json").rename(
        build_copy / "private" / "lessons" / "beta-course" / "hello.json"
    )

    assert "private/lessons/alpha-course/hello.json" in load_error("alpha-course", build_copy)


def test_a_chapter_without_code_needs_no_code_file(build_copy):
    assert not (build_copy / "private" / "code" / "alpha-course" / "02-more.json").exists()

    assert load_catalog("alpha-course", str(build_copy)).get("alpha-course") is not None


def test_has_code_true_without_a_code_file_fails(build_copy):
    def change(doc):
        doc["chapters"][1]["has_code"] = True

    message = break_manifest(build_copy, change)

    assert "private/code/alpha-course/02-more.json" in message


def test_the_files_are_only_checked_to_exist(build_copy):
    (build_copy / "private" / "lessons" / "alpha-course" / "hello.json").write_bytes(
        b"\xff not json"
    )
    (build_copy / "private" / "quizzes" / "alpha-course" / "01-basics.json").write_text("")

    assert load_catalog("alpha-course", str(build_copy)).get("alpha-course") is not None


# --- which courses are read ---


def test_a_course_outside_courses_is_not_read_even_when_broken():
    assert "{ this manifest" in (FIXTURE_BUILD / "private/courses/unlisted-course.json").read_text()

    catalog = load_catalog("alpha-course,beta-course", BUILD)

    assert "unlisted-course" not in catalog
    assert load_error("unlisted-course")  # naming it does read it, and it fails


def test_a_course_outside_courses_with_an_empty_manifest_does_not_stop_startup(build_copy):
    manifest_path(build_copy, "unlisted-course").write_bytes(b"")

    assert load_catalog("beta-course", str(build_copy)).get("beta-course") is not None


# --- no database ---


def test_startup_opens_no_database_connection_and_needs_no_database_url(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("loading the courses must not open a database connection")

    monkeypatch.setattr(Engine, "connect", refuse)
    monkeypatch.setattr(Engine, "begin", refuse)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", BUILD)

    with TestClient(app) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_the_lifespan_raises_the_load_error(monkeypatch):
    monkeypatch.delenv("COURSES", raising=False)
    monkeypatch.setenv("COURSE_BUILD_DIR", BUILD)

    with pytest.raises(CourseLoadError, match="COURSES"), TestClient(app):
        pass


def listed(client) -> list[str]:
    response = client.get("/api/courses")
    assert response.status_code == 200
    return [course["id"] for course in response.json()["courses"]]


def test_nested_lifespans_with_the_same_courses_leave_the_outer_one_serving(monkeypatch):
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", BUILD)

    with TestClient(app) as outer:
        assert listed(outer) == ["alpha-course"]
        with TestClient(app) as inner:
            assert listed(inner) == ["alpha-course"]
        assert listed(outer) == ["alpha-course"]

    assert not hasattr(app.state, "catalog")


def test_a_nested_lifespan_with_other_courses_gives_the_catalog_back_on_exit(monkeypatch):
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", BUILD)

    with TestClient(app) as outer:
        monkeypatch.setenv("COURSES", "beta-course")
        with TestClient(app) as inner:
            assert listed(inner) == ["beta-course"]
        assert listed(outer) == ["alpha-course"]

    assert not hasattr(app.state, "catalog")


def test_a_nested_lifespan_that_fails_to_start_leaves_the_outer_one_serving(monkeypatch):
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", BUILD)

    with TestClient(app) as outer:
        monkeypatch.delenv("COURSES")
        with pytest.raises(CourseLoadError, match="COURSES"), TestClient(app):
            pass
        assert listed(outer) == ["alpha-course"]

    assert not hasattr(app.state, "catalog")


def test_the_lifespan_exit_does_not_fail_when_the_catalog_is_already_gone(monkeypatch):
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", BUILD)

    with TestClient(app):
        del app.state.catalog

    assert not hasattr(app.state, "catalog")


def test_environment_variables_are_read_when_called(monkeypatch):
    monkeypatch.setenv("COURSES", "beta-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", BUILD)

    assert [c.id for c in load_catalog_from_environment().courses] == ["beta-course"]


# --- the real process ---


def _env(**extra):
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in ("DATABASE_URL", "COURSES", "COURSE_BUILD_DIR")
    }
    env.update(extra)
    return env


def _uvicorn(port, env):
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--no-proxy-headers",
            "--no-access-log",
            "--log-config",
            "app/log_config.json",
        ],
        cwd=BACKEND_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_uvicorn_exits_non_zero_and_names_courses_when_it_is_unset():
    process = _uvicorn(_free_port(), _env(COURSE_BUILD_DIR=BUILD))

    _, stderr = process.communicate(timeout=60)

    assert process.returncode != 0
    assert "COURSES" in stderr


def test_uvicorn_exits_non_zero_and_names_course_build_dir_when_it_is_unset():
    process = _uvicorn(_free_port(), _env(COURSES="alpha-course"))

    _, stderr = process.communicate(timeout=60)

    assert process.returncode != 0
    assert "COURSE_BUILD_DIR" in stderr


def test_uvicorn_logs_one_line_per_course_and_starts_without_a_database():
    process = _uvicorn(
        _free_port(), _env(COURSES="beta-course,alpha-course", COURSE_BUILD_DIR=BUILD)
    )
    lines: queue.Queue[str] = queue.Queue()

    def pump():
        for line in process.stderr:
            lines.put(line)

    threading.Thread(target=pump, daemon=True).start()
    seen = []
    try:
        while not any("startup complete" in line for line in seen):
            seen.append(lines.get(timeout=60))
    finally:
        process.terminate()
        process.wait(timeout=30)
        process.stderr.close()

    loaded = [json.loads(line)["message"] for line in seen if "loaded course" in line]
    assert loaded == [
        "loaded course beta-course: 1 chapters, 1 lessons",
        "loaded course alpha-course: 2 chapters, 3 lessons",
    ]
    assert SENTINEL_MARKER not in "".join(seen)
