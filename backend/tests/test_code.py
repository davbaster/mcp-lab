"""The code step and chapter ZIP endpoints (#59): what they return, who may read them, 404s."""

import io
import zipfile

import pytest
from sqlalchemy.engine import Engine

from tests.auth_support import BASE_URL, assert_error, new_client, register, with_cookie
from tests.code_support import (
    CHAPTERS,
    CODE_CHAPTERS,
    COURSE,
    COURSES,
    NO_STORE,
    ZIP_TYPE,
    code_url,
    read_code_file,
    sentinel,
    zip_on_disk,
    zip_url,
)
from tests.content_support import VISITOR_KINDS, put_progress, snapshot, visitor_headers
from tests.course_support import GOLDEN_BUILD

ROUTES = [code_url, zip_url]
ROUTE_IDS = ["steps", "zip"]
ODD_CHAPTER_IDS = [
    "UPPER",
    "%2e%2e",
    "%2e%2e%2fx",
    "..%2f..%2fprivate",
    "a" * 5000,
    "",
    "has space",
    "01-open%0a",
    "%00",
    "a/b",
]
ODD_COURSE_IDS = ["UPPER", "%2e%2e", "a" * 5000, "has space", "zeta-course%0a", "%00"]


@pytest.fixture
def code_api(serve, db, clock):
    """The app serving `zeta-course` and `alpha-course`, with a client that keeps its cookies."""
    client = serve(COURSES)
    client.base_url = BASE_URL  # https, so the cookie jar sends the Secure session cookie
    return client


@pytest.fixture
def learner(code_api):
    """The client, signed in as `ana1`."""
    assert register(code_api).status_code == 201
    return code_api


def pass_chapters(db, *chapters):
    for chapter in chapters:
        put_progress(db, "ana1", chapter, course=COURSE, passed=True)


def assert_no_code_in(response, readable=()):
    """The response holds the sentinel of no chapter except the readable ones."""
    text = response.text + str(dict(response.headers))
    for chapter in CHAPTERS:
        if chapter not in readable:
            assert sentinel(chapter) not in text, chapter


# --- the steps response ---


def test_the_steps_response_has_exactly_the_documented_keys_at_every_level(code_api):
    response = code_api.get(code_url("01-open"))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"course_id", "chapter_id", "zip", "steps"}
    assert set(body["zip"]) == {"url", "file_name", "size"}
    assert len(body["steps"]) == 3
    for step in body["steps"]:
        assert set(step) == {"step", "files"}
        for file in step["files"]:
            assert set(file) == {"path", "status", "content", "changed_lines"}


def test_the_steps_response_holds_neither_the_hash_nor_the_hashed_zip_name(code_api):
    stored = read_code_file("01-open")["zip"]

    text = code_api.get(code_url("01-open")).text

    assert stored["sha256"] not in text
    assert stored["sha256"][:16] not in text
    assert stored["file"] not in text
    assert "sha256" not in text


def test_the_ids_in_the_body_are_the_catalogs(code_api):
    body = code_api.get(code_url("04-late-open")).json()

    assert body["course_id"] == "zeta-course"
    assert body["chapter_id"] == "04-late-open"


def test_the_steps_are_the_steps_of_the_file_in_its_order(code_api):
    for chapter in ("01-open", "04-late-open"):
        body = code_api.get(code_url(chapter)).json()

        assert body["steps"] == read_code_file(chapter)["steps"]
        assert [step["step"] for step in body["steps"]] == list(range(1, len(body["steps"]) + 1))


def test_every_file_has_a_known_status_and_the_right_content_and_changed_lines(code_api):
    seen = set()
    for step in code_api.get(code_url("01-open")).json()["steps"]:
        for file in step["files"]:
            seen.add(file["status"])
            assert file["status"] in {"added", "modified", "deleted", "unchanged"}
            assert all(type(n) is int and n > 0 for n in file["changed_lines"])
            if file["status"] == "deleted":
                assert file["content"] == ""
            if file["status"] in ("deleted", "unchanged"):
                assert file["changed_lines"] == []
            if file["status"] in ("added", "modified") and file["content"]:
                assert file["changed_lines"]

    assert seen == {"added", "modified", "deleted", "unchanged"}


def test_the_files_come_back_sorted_by_path_in_code_unit_order_as_the_file_has_them(code_api):
    steps = code_api.get(code_url("01-open")).json()["steps"]

    assert [file["path"] for file in steps[0]["files"]] == ["Z.py", "a.py", "old.py"]
    assert [file["path"] for file in steps[1]["files"]] == [
        "Z.py",
        "a.py",
        "old.py",
        "pkg/__init__.py",
        "pkg/util.py",
    ]
    assert [file["path"] for file in steps[2]["files"]] == [
        "Z.py",
        "a.py",
        "pkg/__init__.py",
        "pkg/util.py",
    ]


def test_the_files_are_not_re_sorted_whatever_the_order_in_the_file(serve, build_copy):
    from tests.code_support import write_code_file

    document = read_code_file("04-late-open", build_copy)
    document["steps"][0]["files"] = [
        {"path": "b.py", "status": "added", "content": "b", "changed_lines": [1]},
        {"path": "B.py", "status": "added", "content": "B", "changed_lines": [1]},
    ]
    write_code_file("04-late-open", document, build_copy)
    client = serve(COURSES, build=build_copy)

    files = client.get(code_url("04-late-open")).json()["steps"][0]["files"]

    assert [file["path"] for file in files] == ["b.py", "B.py"]


def test_the_golden_steps_of_the_content_build_come_back_equal_as_json(serve):
    golden = read_code_file("01-first-steps", GOLDEN_BUILD, "sample-course")
    client = serve("sample-course", build=GOLDEN_BUILD)

    response = client.get("/api/courses/sample-course/chapters/01-first-steps/code")

    assert response.status_code == 200  # a free preview chapter; the golden build has no ZIP file
    body = response.json()
    assert body["steps"] == golden["steps"]
    assert len(body["steps"]) == 3
    assert any(f["status"] == "deleted" for s in body["steps"] for f in s["files"])
    assert body["zip"] == {
        "url": "/api/courses/sample-course/chapters/01-first-steps/code.zip",
        "file_name": "01-first-steps.zip",
        "size": golden["zip"]["size"],
    }
    assert body["course_id"] == "sample-course"


def test_the_zip_block_has_the_url_the_file_name_and_the_size_of_the_file(code_api):
    stored = read_code_file("01-open")["zip"]

    zip_block = code_api.get(code_url("01-open")).json()["zip"]

    assert zip_block == {
        "url": "/api/courses/zeta-course/chapters/01-open/code.zip",
        "file_name": "01-open.zip",
        "size": stored["size"],
    }


@pytest.mark.parametrize("chapter", CODE_CHAPTERS[:1] + CODE_CHAPTERS[3:])
def test_the_zip_url_of_the_steps_response_gives_the_zip(code_api, chapter):
    zip_block = code_api.get(code_url(chapter)).json()["zip"]

    response = code_api.get(zip_block["url"])

    assert response.status_code == 200
    assert response.headers["content-type"] == ZIP_TYPE
    assert len(response.content) == zip_block["size"]


def test_a_key_added_to_the_code_file_does_not_reach_the_response(serve, build_copy):
    from tests.code_support import write_code_file

    document = read_code_file("01-open", build_copy)
    document["hint"] = "HINT-SENTINEL"
    document["zip"]["hint"] = "HINT-SENTINEL"
    document["steps"][0]["hint"] = "HINT-SENTINEL"
    document["steps"][0]["files"][0]["hint"] = "HINT-SENTINEL"
    write_code_file("01-open", document, build_copy)
    client = serve(COURSES, build=build_copy)

    steps = client.get(code_url("01-open"))
    archive = client.get(zip_url("01-open"))

    assert steps.status_code == 200
    assert "HINT-SENTINEL" not in steps.text + str(dict(steps.headers))
    assert archive.status_code == 200
    assert "HINT-SENTINEL" not in str(dict(archive.headers))
    assert set(steps.json()["steps"][0]["files"][0]) == {
        "path",
        "status",
        "content",
        "changed_lines",
    }


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_the_response_is_private_no_store_for_visitors_and_learners(code_api, route):
    visitor = new_client().get(route("01-open"))
    assert register(code_api).status_code == 201
    learner = code_api.get(route("01-open"))

    assert visitor.status_code == learner.status_code == 200
    assert visitor.headers["cache-control"] == NO_STORE
    assert learner.headers["cache-control"] == NO_STORE


# --- the ZIP response ---


@pytest.mark.parametrize("chapter", CODE_CHAPTERS[:1] + CODE_CHAPTERS[3:])
def test_the_zip_is_exactly_the_bytes_of_the_file_with_its_length(code_api, chapter):
    expected = zip_on_disk(chapter).read_bytes()

    response = code_api.get(zip_url(chapter))

    assert response.status_code == 200
    assert response.content == expected
    assert response.headers["content-length"] == str(len(expected))


def test_the_zip_has_exactly_the_documented_headers(code_api):
    response = code_api.get(zip_url("01-open"))

    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"] == 'attachment; filename="01-open.zip"'
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == NO_STORE
    assert "etag" not in response.headers
    assert "last-modified" not in response.headers
    assert "content-range" not in response.headers


@pytest.mark.parametrize(
    "query", ["?filename=evil.zip", "?name=%0d%0aX:y", "?filename=%22%2f..%5c;x", "?a=b&a=c"]
)
def test_the_file_name_comes_from_the_catalog_and_not_from_the_query(code_api, query):
    response = code_api.get(zip_url("01-open") + query)

    assert response.status_code == 200
    header = response.headers["content-disposition"]
    assert header == 'attachment; filename="01-open.zip"'
    name = header.removeprefix('attachment; filename="').removesuffix('"')
    assert header.count('"') == 2
    assert not any(character in name for character in '/\\;"\r\n ')
    assert "X" not in response.headers


@pytest.mark.parametrize("chapter", CODE_CHAPTERS[:1] + CODE_CHAPTERS[3:])
def test_the_zip_opens_and_holds_the_files_of_the_final_step_under_the_chapter_folder(
    code_api, chapter
):
    steps = code_api.get(code_url(chapter)).json()["steps"]
    response = code_api.get(zip_url(chapter))

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        contents = {name: archive.read(name).decode("utf-8") for name in names}

    final = [f for f in steps[-1]["files"] if f["status"] != "deleted"]
    assert names == [f"{chapter}/{f['path']}" for f in final]
    assert contents == {f"{chapter}/{f['path']}": f["content"] for f in final}


def test_the_zip_of_a_chapter_with_a_deleted_file_in_an_earlier_step_does_not_hold_it(code_api):
    with zipfile.ZipFile(io.BytesIO(code_api.get(zip_url("01-open")).content)) as archive:
        assert "01-open/old.py" not in archive.namelist()
        assert len(archive.namelist()) == 4


@pytest.mark.parametrize("range_header", ["bytes=0-3", "bytes=abc", "bytes=999999-", "bytes=-5"])
def test_a_range_header_is_ignored_and_the_whole_file_comes_back(code_api, range_header):
    expected = zip_on_disk("01-open").read_bytes()

    response = code_api.get(zip_url("01-open"), headers={"Range": range_header})

    assert response.status_code == 200
    assert response.content == expected
    assert "content-range" not in response.headers


def test_an_if_range_header_is_ignored_too(code_api):
    response = code_api.get(
        zip_url("01-open"), headers={"Range": "bytes=0-3", "If-Range": '"anything"'}
    )

    assert response.status_code == 200
    assert response.content == zip_on_disk("01-open").read_bytes()


def test_two_requests_return_identical_bytes(code_api):
    assert (
        code_api.get(zip_url("04-late-open")).content
        == code_api.get(zip_url("04-late-open")).content
    )


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_head_gets_the_shared_405(code_api, route):
    response = code_api.head(route("01-open"))

    assert response.status_code == 405
    assert response.headers["allow"] == "GET"


# --- access: visitors ---


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("kind", VISITOR_KINDS)
def test_a_visitor_reads_the_code_of_a_free_preview_chapter(code_api, clock, route, kind):
    assert register(code_api).status_code == 201
    headers = visitor_headers(kind, code_api, clock)

    for chapter in ("01-open", "04-late-open"):
        response = new_client().get(route(chapter), headers=headers)

        assert response.status_code == 200
        if route is code_url:
            assert sentinel(chapter) in response.text


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("kind", VISITOR_KINDS)
def test_a_visitor_gets_401_for_every_chapter_that_is_not_free_preview_with_or_without_code(
    code_api, clock, route, kind
):
    assert register(code_api).status_code == 201
    headers = visitor_headers(kind, code_api, clock)

    for chapter in ("02-gated", "03-sealed", "05-plain"):  # 05-plain has no code at all
        response = new_client().get(route(chapter), headers=headers)

        assert_error(response, 401, "not_authenticated")
        assert_no_code_in(response)
        assert "content-disposition" not in response.headers


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_a_visitor_gets_code_not_found_for_a_free_preview_chapter_without_code(code_api, route):
    response = new_client().get(route("06-open-plain"))

    message = assert_error(response, 404, "code_not_found")
    assert message == "This chapter has no code."


def test_a_session_one_second_before_it_expires_is_a_learner_and_gets_403_not_401(code_api, clock):
    assert register(code_api).status_code == 201
    token = code_api.cookies.get("session")
    clock.advance(days=1, seconds=-1)

    for route in ROUTES:
        response = new_client().get(route("02-gated"), headers=with_cookie(token))

        assert_error(response, 403, "chapter_locked")


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_a_session_that_expires_while_reading_still_gives_a_free_chapter_but_not_a_closed_one(
    code_api, clock, db, route
):
    assert register(code_api).status_code == 201
    pass_chapters(db, "01-open")
    assert code_api.get(route("02-gated")).status_code == 200
    clock.advance(days=1)

    assert code_api.get(route("01-open")).status_code == 200
    assert_error(code_api.get(route("02-gated")), 401, "not_authenticated")


# --- access: learners (every cell of the table, both routes) ---

# Each row: the chapters the learner has passed, and for chapters 01 to 06 the status code, with
# the error code for a status that is not 200.
CODE_NOT_FOUND = "code_not_found"
LOCKED = "chapter_locked"
SCENARIOS = {
    "new learner": (
        [],
        [200, (403, LOCKED), (403, LOCKED), 200, (403, LOCKED), (404, CODE_NOT_FOUND)],
    ),
    "01 passed": (
        ["01-open"],
        [200, 200, (403, LOCKED), 200, (403, LOCKED), (404, CODE_NOT_FOUND)],
    ),
    "01 and 02 passed": (
        ["01-open", "02-gated"],
        [200, 200, 200, 200, (403, LOCKED), (404, CODE_NOT_FOUND)],
    ),
    "only 02 passed (out of order)": (
        ["02-gated"],
        [200, 200, (403, LOCKED), 200, (403, LOCKED), (404, CODE_NOT_FOUND)],
    ),
    "01 to 04 passed": (
        ["01-open", "02-gated", "03-sealed", "04-late-open"],
        [200, 200, 200, 200, (404, CODE_NOT_FOUND), (404, CODE_NOT_FOUND)],
    ),
    "everything passed": (
        CHAPTERS,
        [200, 200, 200, 200, (404, CODE_NOT_FOUND), (404, CODE_NOT_FOUND)],
    ),
}


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("scenario", list(SCENARIOS))
def test_the_access_matrix_for_a_learner(learner, db, route, scenario):
    passed, expected = SCENARIOS[scenario]
    pass_chapters(db, *passed)

    for chapter, outcome in zip(CHAPTERS, expected, strict=True):
        response = learner.get(route(chapter))

        if outcome == 200:
            assert response.status_code == 200, chapter
            assert_no_code_in(response, readable=(chapter,))
        else:
            status, code = outcome
            assert_error(response, status, code)
            assert_no_code_in(response)
            assert "content-disposition" not in response.headers


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_a_learner_reads_a_locked_free_preview_chapter_like_a_visitor(learner, db, route):
    # 04-late-open is free_preview and locked for a new learner: never less than a visitor.
    assert new_client().get(route("04-late-open")).status_code == 200

    response = learner.get(route("04-late-open"))

    assert response.status_code == 200


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_a_locked_learner_still_gets_403_for_a_chapter_with_no_code(learner, route):
    assert_error(learner.get(route("05-plain")), 403, "chapter_locked")


# --- access: no connection, no queries, no writes ---


def test_cookie_less_and_malformed_cookie_requests_open_no_database_connection(serve, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("a visitor's code read must not open a database connection")

    monkeypatch.setattr(Engine, "connect", refuse)
    monkeypatch.setattr(Engine, "begin", refuse)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    client = serve(COURSES)

    for cookie in (None, "garbage", "x" * 42, "x" * 44, ""):
        headers = {} if cookie is None else {"Cookie": f"session={cookie}"}
        for route in ROUTES:
            assert client.get(route("01-open"), headers=headers).status_code == 200
            assert client.get(route("04-late-open"), headers=headers).status_code == 200
            for chapter in ("02-gated", "05-plain"):
                assert_error(client.get(route(chapter), headers=headers), 401, "not_authenticated")
            assert_error(client.get(route("06-open-plain"), headers=headers), 404, CODE_NOT_FOUND)


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_a_learner_reading_a_free_preview_chapter_needs_no_progress_query(
    learner, monkeypatch, route
):
    import app.access

    calls = []
    original = app.access.load_progress

    def counting(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(app.access, "load_progress", counting)

    assert learner.get(route("04-late-open")).status_code == 200  # free, and locked for ana1
    assert learner.get(route("01-open")).status_code == 200
    assert learner.get(route("06-open-plain")).status_code == 404
    assert calls == []
    assert_error(learner.get(route("02-gated")), 403, "chapter_locked")
    assert len(calls) == 1  # one query for the learner's rows of the course


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_a_read_writes_nothing(learner, db, route):
    pass_chapters(db, "01-open")
    put_progress(db, "ana1", "02-gated", course=COURSE, score=3, last="gated-lesson")
    before = snapshot(db)

    for chapter in CHAPTERS:
        learner.get(route(chapter))
    new_client().get(route("01-open"))

    assert snapshot(db) == before


# --- not found ---


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("course", ["unlisted-course", "gamma-course", *ODD_COURSE_IDS])
def test_an_unknown_course_is_404_for_a_visitor_and_a_learner(learner, route, course):
    # `unlisted-course` is in the build folder, `gamma-course` too, but neither is in COURSES.
    url = route("01-open", course)

    assert_error(new_client().get(url), 404, "course_not_found")
    assert_error(learner.get(url), 404, "course_not_found")


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("chapter", ["07-missing", "01-basics", "02-more", *ODD_CHAPTER_IDS])
def test_an_unknown_chapter_is_404_for_a_visitor_and_a_learner_never_401_first(
    learner, route, chapter
):
    # `01-basics` and `02-more` are chapters of alpha-course, which is served too.
    url = route(chapter)

    assert_error(new_client().get(url), 404, "chapter_not_found")
    assert_error(learner.get(url), 404, "chapter_not_found")


@pytest.mark.parametrize("chapter", ["UPPER", "%2e%2e", "a" * 5000, "", "has space", "%2e%2e%2fx"])
def test_an_odd_chapter_id_reads_nothing_from_disk(code_api, monkeypatch, chapter):
    from pathlib import Path

    touched = []
    for name in ("read_bytes", "read_text", "open", "stat", "is_file", "exists"):
        original = getattr(Path, name)

        def spy(self, *args, _original=original, _name=name, **kwargs):
            touched.append((_name, str(self)))
            return _original(self, *args, **kwargs)

        monkeypatch.setattr(Path, name, spy)

    for route in ROUTES:
        assert code_api.get(route(chapter)).status_code == 404

    assert [path for _, path in touched if "private" in path] == []


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_a_learner_on_an_unlocked_chapter_with_no_code_gets_code_not_found(learner, db, route):
    pass_chapters(db, "01-open", "02-gated", "03-sealed", "04-late-open")  # 05-plain is in progress

    message = assert_error(learner.get(route("05-plain")), 404, CODE_NOT_FOUND)

    assert message == "This chapter has no code."
    assert "05-plain" not in message


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_the_error_bodies_hold_no_code_and_no_file_headers(learner, route):
    responses = [
        new_client().get(route("02-gated")),  # 401
        learner.get(route("03-sealed")),  # 403
        learner.get(route("05-plain")),  # 403
        new_client().get(route("06-open-plain")),  # 404 code_not_found
        learner.get(route("99-nothing")),  # 404 chapter_not_found
        learner.get(route("01-open", "no-course")),  # 404 course_not_found
    ]

    assert [r.status_code for r in responses] == [401, 403, 403, 404, 404, 404]
    for response in responses:
        assert_no_code_in(response)
        assert "content-disposition" not in response.headers
        assert "application/zip" not in response.headers["content-type"]
