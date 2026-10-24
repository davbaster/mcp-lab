"""Bad build files at request time, the log checks, and the build folder boundary (#15)."""

import json
from pathlib import Path

import pytest

from app.content import BuildFileError, read_lesson_tree, read_quiz
from app.courses import Catalog, CourseLoadError, load_catalog
from tests.auth_support import BASE_URL, assert_error, new_client, register
from tests.content_support import account_id, put_progress, snapshot
from tests.course_support import FIXTURE_BUILD, read_manifest, write_manifest

ALPHA_LESSON = "/api/courses/alpha-course/lessons/hello"
GAMMA_QUIZ = "/api/courses/gamma-course/chapters/01-intro/quiz"
LESSON_FILE = Path("private/lessons/alpha-course/hello.json")
QUIZ_FILE = Path("private/quizzes/gamma-course/01-intro.json")


def edit_json(build, relative, change):
    path = build / relative
    document = json.loads(path.read_text(encoding="utf-8"))
    change(document)
    path.write_text(json.dumps(document), encoding="utf-8")


def set_quiz_field(build, change):
    edit_json(build, QUIZ_FILE, lambda document: change(document["questions"][0]))


def logged_text(caplog):
    return caplog.text + "\n".join(str(r.__dict__) for r in caplog.records)


@pytest.fixture
def broken(serve, db, clock, build_copy, caplog):
    """Serve a copy of the build with a signed-in learner; the test then breaks a file.

    The files are read on every request, so a file broken after the start is seen by the next
    request. Returns a client that turns a server fault into a 500 response.
    """
    client = serve("alpha-course,gamma-course", build=build_copy)
    client.base_url = BASE_URL
    assert register(client).status_code == 201
    errors = new_client(raise_server_exceptions=False)
    errors.cookies.set("session", client.cookies.get("session"))
    errors.build = build_copy
    caplog.clear()
    return errors


def assert_internal_error(response, *sentinels, caplog):
    assert_error(response, 500, "internal_error")
    logged = logged_text(caplog)
    for sentinel in sentinels:
        assert sentinel not in response.text
        assert sentinel not in logged


# --- the quiz file ---


def test_a_missing_quiz_file_is_a_500_that_names_the_ids_and_holds_no_file_content(broken, caplog):
    (broken.build / QUIZ_FILE).unlink()

    response = broken.get(GAMMA_QUIZ)

    assert_internal_error(response, "QUESTION-SENTINEL", caplog=caplog)
    assert "gamma-course" in caplog.text
    assert "01-intro" in caplog.text


@pytest.mark.parametrize(
    "content",
    [
        b"{ not json KEY-SENTINEL-1",
        b"",
        b"\xff\xfe KEY-SENTINEL-1",
        b"[" * 100000,  # nests deeper than the parser allows
        b'["KEY-SENTINEL-1"]',
        b'"KEY-SENTINEL-1"',
    ],
)
def test_a_quiz_file_that_is_not_a_json_object_is_a_500_without_its_content(
    broken, caplog, content
):
    (broken.build / QUIZ_FILE).write_bytes(content)

    response = broken.get(GAMMA_QUIZ)

    assert_internal_error(response, "KEY-SENTINEL-1", caplog=caplog)


@pytest.mark.parametrize(
    "change",
    [
        lambda q: q.update(text={"correct": "KEY-SENTINEL-1"}),
        lambda q: q.update(text=None),
        lambda q: q.pop("text"),
        lambda q: q.pop("id"),
        lambda q: q.pop("options"),
        lambda q: q.update(options="KEY-SENTINEL-1"),
        lambda q: q.update(options=[]),
        lambda q: q.update(options=[{"id": "a", "text": 5}]),
        lambda q: q.update(options=[{"id": 1, "text": "KEY-SENTINEL-1"}]),
        lambda q: q.update(options=[{"text": "KEY-SENTINEL-1"}]),
        lambda q: q.update(snippet="KEY-SENTINEL-1"),
        lambda q: q.update(snippet={"language": "python", "code": ["KEY-SENTINEL-1"]}),
        lambda q: q.update(snippet={"language": "python"}),
    ],
)
def test_a_quiz_question_with_the_wrong_shape_is_a_500_that_never_quotes_the_file(
    broken, caplog, change
):
    set_quiz_field(broken.build, change)
    edit_json(broken.build, QUIZ_FILE, lambda d: d["questions"][0].update(correct="KEY-SENTINEL-2"))

    response = broken.get(GAMMA_QUIZ)

    assert_internal_error(
        response, "KEY-SENTINEL", "CORRECT-SENTINEL", "EXPLANATION-SENTINEL", caplog=caplog
    )


@pytest.mark.parametrize(
    "change",
    [
        lambda d: d.update(questions={"correct": "KEY-SENTINEL-1"}),
        lambda d: d.update(questions="KEY-SENTINEL-1"),
        lambda d: d.pop("questions"),
        lambda d: d.update(course_id=5),
        lambda d: d.pop("chapter_id"),
        lambda d: d.update(course_id="alpha-course"),  # another course's quiz in this place
        lambda d: d.update(chapter_id="02-middle"),
    ],
)
def test_a_quiz_file_with_a_bad_top_level_is_a_500_that_never_quotes_the_file(
    broken, caplog, change
):
    edit_json(broken.build, QUIZ_FILE, change)

    response = broken.get(GAMMA_QUIZ)

    assert_internal_error(response, "KEY-SENTINEL", "CORRECT-SENTINEL", caplog=caplog)


def test_a_bad_quiz_file_is_seen_by_the_next_request_because_nothing_is_cached(broken):
    assert broken.get(GAMMA_QUIZ).status_code == 200
    (broken.build / QUIZ_FILE).write_text("{", encoding="utf-8")

    assert_error(broken.get(GAMMA_QUIZ), 500, "internal_error")

    (broken.build / QUIZ_FILE).write_text((FIXTURE_BUILD / QUIZ_FILE).read_text(), encoding="utf-8")
    assert broken.get(GAMMA_QUIZ).status_code == 200


# --- the lesson file ---


def test_a_missing_lesson_file_is_a_500_that_names_the_ids(broken, caplog):
    (broken.build / LESSON_FILE).unlink()

    response = broken.get(ALPHA_LESSON)

    assert_internal_error(response, "LESSON-SENTINEL", caplog=caplog)
    assert "alpha-course" in caplog.text
    assert "hello" in caplog.text


@pytest.mark.parametrize(
    "content", [b"{ nope TREE-SENTINEL-1", b"", b"\xff\xfe TREE-SENTINEL-1", b'["TREE-SENTINEL-1"]']
)
def test_a_lesson_file_that_is_not_a_json_object_is_a_500_without_its_content(
    broken, caplog, content
):
    (broken.build / LESSON_FILE).write_bytes(content)

    response = broken.get(ALPHA_LESSON)

    assert_internal_error(response, "TREE-SENTINEL-1", caplog=caplog)


@pytest.mark.parametrize(
    "change",
    [
        lambda d: d.update(tree="TREE-SENTINEL-1"),
        lambda d: d.update(tree=["TREE-SENTINEL-1"]),
        lambda d: d.update(tree=None),
        lambda d: d.pop("tree"),
        lambda d: d.update(lesson_id=["TREE-SENTINEL-1"]),
        lambda d: d.update(course_id="gamma-course"),
        lambda d: d.update(chapter_id="02-more"),
        lambda d: d.update(lesson_id="01-setup"),
    ],
)
def test_a_lesson_file_with_the_wrong_shape_is_a_500_that_never_quotes_the_file(
    broken, caplog, change
):
    edit_json(broken.build, LESSON_FILE, change)

    response = broken.get(ALPHA_LESSON)

    assert_internal_error(response, "TREE-SENTINEL-1", "LESSON-SENTINEL", caplog=caplog)


def test_a_bad_lesson_file_does_not_hide_the_404_or_the_401_that_come_first(broken):
    (broken.build / LESSON_FILE).write_text("{", encoding="utf-8")
    visitor = new_client(raise_server_exceptions=False)

    assert visitor.get(ALPHA_LESSON).status_code == 500  # hello is a free preview lesson
    assert_error(
        visitor.get("/api/courses/alpha-course/lessons/next-steps"), 401, "not_authenticated"
    )
    assert_error(visitor.get("/api/courses/alpha-course/lessons/nope"), 404, "lesson_not_found")


def test_the_error_of_a_missing_file_has_no_chained_cause():
    catalog = load_catalog("gamma-course", str(FIXTURE_BUILD))
    course = catalog.get("gamma-course")
    chapter = course.chapters[0]

    bad = Catalog(catalog.courses, FIXTURE_BUILD / "private")  # a folder with no such file

    with pytest.raises(BuildFileError) as excinfo:
        read_quiz(bad, course, chapter)

    assert excinfo.value.__cause__ is None
    assert excinfo.value.__suppress_context__
    assert "gamma-course" in str(excinfo.value)


def test_a_bad_quiz_error_is_raised_from_none_so_the_validation_text_is_not_chained(
    tmp_path,
):
    build = tmp_path / "build"
    (build / "private" / "quizzes" / "gamma-course").mkdir(parents=True)
    (build / "private" / "quizzes" / "gamma-course" / "01-intro.json").write_text(
        json.dumps(
            {"course_id": "gamma-course", "chapter_id": "01-intro", "questions": "KEY-SENTINEL"}
        )
    )
    course = load_catalog("gamma-course", str(FIXTURE_BUILD)).get("gamma-course")
    catalog = Catalog((course,), build)

    with pytest.raises(BuildFileError) as excinfo:
        read_quiz(catalog, course, course.chapters[0])

    assert excinfo.value.__cause__ is None
    assert excinfo.value.__suppress_context__
    assert "KEY-SENTINEL" not in str(excinfo.value)
    assert "questions" in str(excinfo.value)  # the field location is named


def test_reading_a_lesson_returns_the_tree_as_the_file_holds_it():
    catalog = load_catalog("alpha-course", str(FIXTURE_BUILD))
    course = catalog.get("alpha-course")
    chapter, lesson = course.find_lesson("hello")

    tree = read_lesson_tree(catalog, course, chapter, lesson)

    document = json.loads((FIXTURE_BUILD / LESSON_FILE).read_text(encoding="utf-8"))
    assert tree == document["tree"]


# --- the build folder boundary ---


def test_a_manifest_cannot_add_a_path_because_its_ids_must_be_plain_ids(build_copy):
    for bad_id in ("../../courses/alpha-course", "a/b", "..", "A", "x.json"):
        manifest = read_manifest(build_copy, "alpha-course")
        manifest["chapters"][0]["lessons"][0]["id"] = bad_id
        write_manifest(build_copy, "alpha-course", manifest)

        with pytest.raises(CourseLoadError):
            load_catalog("alpha-course", str(build_copy))


def test_every_file_the_lesson_and_quiz_routes_read_is_inside_the_build_folder(
    serve, db, clock, monkeypatch
):
    client = serve("alpha-course,gamma-course")
    client.base_url = BASE_URL
    assert register(client).status_code == 201
    put_progress(db, "ana1", "01-intro", passed=True)
    reads = []
    original = Path.read_bytes

    def spy(self):
        reads.append(self)
        return original(self)

    monkeypatch.setattr(Path, "read_bytes", spy)
    odd = ["..%2F..", "%2e%2e", "UPPER", "a" * 300, "x\\y"]

    assert client.get(ALPHA_LESSON).status_code == 200
    assert client.get(GAMMA_QUIZ).status_code == 200
    for lesson in odd:
        client.get(f"/api/courses/alpha-course/lessons/{lesson}")
        client.get(f"/api/courses/gamma-course/chapters/{lesson}/quiz")

    assert len(reads) == 2
    assert all(FIXTURE_BUILD in path.parents for path in reads)


# --- logs ---


def test_the_requests_log_no_token_cookie_account_id_username_or_sentinel(content_api, db, caplog):
    username = "Qx9zLm2"
    assert register(content_api, username=username).status_code == 201
    token = content_api.cookies.get("session")
    put_progress(db, username, "01-open", course="delta-course", passed=True)
    caplog.clear()
    base = "/api/courses/delta-course"

    assert content_api.get(f"{base}/lessons/first-lesson").status_code == 200
    assert content_api.get(f"{base}/lessons/quiz-link-7f3a").status_code == 200
    assert content_api.get(f"{base}/chapters/02-closed/quiz").status_code == 200
    assert (
        content_api.put(
            f"{base}/progress/last-lesson", json={"lesson_id": "second-lesson"}
        ).status_code
        == 204
    )
    assert content_api.get(f"{base}/chapters/01-open/quiz").status_code == 200
    assert new_client().get(f"{base}/lessons/quiz-link-7f3a").status_code == 401
    assert (
        new_client().put(f"{base}/progress/last-lesson", json={"lesson_id": "x"}).status_code == 401
    )
    logged = logged_text(caplog)
    account = str(account_id(db, username))

    assert token not in logged
    assert account not in logged
    assert username not in logged
    assert "session=" not in logged
    assert "SENTINEL" not in logged
    assert "EXPLANATION" not in logged


def test_none_of_the_three_routes_writes_a_log_line_of_its_own(content_api, db, caplog):
    assert register(content_api).status_code == 201
    put_progress(db, "ana1", "01-open", course="delta-course", passed=True)
    caplog.clear()
    base = "/api/courses/delta-course"

    content_api.get(f"{base}/lessons/first-lesson")
    content_api.get(f"{base}/chapters/02-closed/quiz")
    content_api.put(f"{base}/progress/last-lesson", json={"lesson_id": "second-lesson"})

    own = [r for r in caplog.records if r.name.startswith("app")]
    assert own == []
    assert snapshot(db)["chapter_progress"]  # the requests did run
