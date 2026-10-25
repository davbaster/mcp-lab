"""Code step and chapter ZIP endpoints (#59): damaged builds, secrets in logs, and the contract."""

import hashlib
import json
import logging
from pathlib import Path

import pytest

from tests.auth_support import (
    BASE_URL,
    PASSWORD,
    assert_error,
    new_client,
    register,
    with_cookie,
)
from tests.code_support import (
    COURSE,
    COURSES,
    code_dir,
    code_url,
    read_code_file,
    sentinel,
    write_code_file,
    zip_on_disk,
    zip_url,
)
from tests.content_support import account_id, committed_spec, put_progress
from tests.dbtools import BACKEND_DIR

ROUTES = [code_url, zip_url]
ROUTE_IDS = ["steps", "zip"]
FAULT = "FAULT-SENTINEL-9d2c"
CHAPTER = "01-open"  # a free preview chapter, so no login is needed


def break_file(build: Path, edit) -> None:
    """Apply `edit` to the parsed code file of the chapter and write it back."""
    document = read_code_file(CHAPTER, build)
    edit(document)
    write_code_file(CHAPTER, document, build)


def _set(path: list, value):
    def edit(document):
        target = document
        for part in path[:-1]:
            target = target[part]
        target[path[-1]] = value

    return edit


def _remove(path: list):
    def edit(document):
        target = document
        for part in path[:-1]:
            target = target[part]
        del target[path[-1]]

    return edit


def _renumber(numbers: list[int]):
    def edit(document):
        document["steps"] = [
            {**step, "step": number}
            for step, number in zip(document["steps"], numbers, strict=True)
        ]

    return edit


# Each fault leaves the JSON unusable for both routes.
JSON_FAULTS = {
    "course_id is wrong": _set(["course_id"], FAULT),
    "chapter_id is wrong": _set(["chapter_id"], FAULT),
    "course_id is missing": _remove(["course_id"]),
    "zip is missing": _remove(["zip"]),
    "zip.size is missing": _remove(["zip", "size"]),
    "zip.size is a string": _set(["zip", "size"], FAULT),
    "zip.sha256 is not hex": _set(["zip", "sha256"], FAULT),
    "zip.sha256 is upper case": lambda d: d["zip"].update(sha256=d["zip"]["sha256"].upper()),
    "zip.sha256 is too short": lambda d: d["zip"].update(sha256=d["zip"]["sha256"][:-1]),
    "zip.file is another name": _set(["zip", "file"], f"{FAULT}.zip"),
    "zip.file is a traversal": _set(["zip", "file"], "../../private/courses/alpha-course.json"),
    "zip.file is a backslash path": _set(["zip", "file"], "..\\x.zip"),
    "zip.file is the other chapter's": _set(["zip", "file"], "02-gated-ef5c645f6a202b52.zip"),
    "steps is missing": _remove(["steps"]),
    "steps is empty": _set(["steps"], []),
    "steps is a string": _set(["steps"], FAULT),
    "a step has no files": _set(["steps", 0, "files"], []),
    "a step has no number": _remove(["steps", 0, "step"]),
    "the numbers start at 2": _renumber([2, 3, 4]),
    "a number is skipped": _renumber([1, 3, 4]),
    "a number is repeated": _renumber([1, 1, 2]),
    "the numbers are out of order": _renumber([2, 1, 3]),
    "the numbers start at 0": _renumber([0, 1, 2]),
    "a step number is a string": _set(["steps", 0, "step"], FAULT),
    "a status is unknown": _set(["steps", 0, "files", 0, "status"], FAULT),
    "a status is missing": _remove(["steps", 0, "files", 0, "status"]),
    "a path is missing": _remove(["steps", 0, "files", 0, "path"]),
    "a path is a number": _set(["steps", 0, "files", 0, "path"], 5),
    "content is missing": _remove(["steps", 0, "files", 0, "content"]),
    "content is a number": _set(["steps", 0, "files", 0, "content"], 5),
    "changed_lines is missing": _remove(["steps", 0, "files", 0, "changed_lines"]),
    "changed_lines holds a string": _set(["steps", 0, "files", 0, "changed_lines"], [FAULT]),
    "changed_lines holds zero": _set(["steps", 0, "files", 0, "changed_lines"], [0]),
    "changed_lines holds a negative": _set(["steps", 0, "files", 0, "changed_lines"], [-1]),
    "changed_lines holds a float": _set(["steps", 0, "files", 0, "changed_lines"], [1.5]),
}


def assert_server_fault(response, caplog):
    assert_error(response, 500, "internal_error")
    text = response.text + str(dict(response.headers)) + caplog.text
    assert FAULT not in text
    for chapter in ("01-open", "02-gated"):
        assert sentinel(chapter) not in response.text
    assert "content-disposition" not in response.headers


@pytest.fixture
def faulty(serve, build_copy):
    """A function that serves a damaged copy of the build, once, and returns a client for it."""

    def start(edit=None):
        if edit is not None:
            break_file(build_copy, edit)
        serve(COURSES, build=build_copy)
        return new_client(raise_server_exceptions=False)

    return start


# --- damaged JSON: both routes ---


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("fault", list(JSON_FAULTS))
def test_a_damaged_code_file_gives_500_and_leaks_nothing(faulty, caplog, route, fault):
    client = faulty(JSON_FAULTS[fault])

    response = client.get(route(CHAPTER))

    assert_server_fault(response, caplog)


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_a_missing_code_file_gives_500(serve, build_copy, caplog, route):
    serve(COURSES, build=build_copy)  # the app checks at startup that the file exists
    (code_dir(build_copy) / f"{CHAPTER}.json").unlink()  # and it is gone by the next request

    assert_server_fault(new_client(raise_server_exceptions=False).get(route(CHAPTER)), caplog)


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize(
    "content",
    [b"{", b"", b"[]", b"null", b'{"a": 1}', b"\xff\xfe\x00{}", b"[" * 100000],
    ids=["truncated", "empty", "list", "null", "wrong shape", "not utf-8", "too deep"],
)
def test_a_code_file_that_is_not_json_of_the_right_shape_gives_500(
    serve, build_copy, caplog, route, content
):
    (code_dir(build_copy) / f"{CHAPTER}.json").write_bytes(content)
    serve(COURSES, build=build_copy)

    assert_server_fault(new_client(raise_server_exceptions=False).get(route(CHAPTER)), caplog)


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_the_500_message_names_the_chapter_and_the_field_and_no_content(faulty, caplog, route):
    client = faulty(_set(["steps", 0, "files", 0, "status"], FAULT))

    response = client.get(route(CHAPTER))

    assert_error(response, 500, "internal_error")
    assert response.json()["error"]["message"] == "Internal server error."
    logged = "\n".join(
        record.getMessage() for record in caplog.records if record.name == "app.errors"
    )
    assert "Code file (course zeta-course, chapter 01-open)" in caplog.text
    assert "steps[0].files[0].status" in caplog.text
    assert FAULT not in caplog.text
    assert logged  # the error was logged by the shared handler


def test_a_damaged_file_of_one_chapter_does_not_break_another(serve, build_copy):
    break_file(build_copy, _remove(["steps"]))
    serve(COURSES, build=build_copy)
    client = new_client(raise_server_exceptions=False)

    assert_error(client.get(code_url(CHAPTER)), 500, "internal_error")
    assert client.get(code_url("04-late-open")).status_code == 200
    assert client.get(zip_url("04-late-open")).status_code == 200


# --- damaged ZIP: the ZIP route fails, the steps route does not need the ZIP ---


def tamper_missing(path: Path) -> None:
    path.unlink()


def tamper_longer(path: Path) -> None:
    path.write_bytes(path.read_bytes() + b"\x00")


def tamper_shorter(path: Path) -> None:
    path.write_bytes(path.read_bytes()[:-1])


def tamper_same_size(path: Path) -> None:
    data = bytearray(path.read_bytes())
    data[-1] ^= 0xFF
    path.write_bytes(bytes(data))


def tamper_empty(path: Path) -> None:
    path.write_bytes(b"")


def tamper_directory(path: Path) -> None:
    path.unlink()
    path.mkdir()


ZIP_FAULTS = {
    "missing": tamper_missing,
    "a byte longer": tamper_longer,
    "a byte shorter": tamper_shorter,
    "same size, other bytes": tamper_same_size,
    "empty": tamper_empty,
    "a directory": tamper_directory,
}


@pytest.mark.parametrize("fault", list(ZIP_FAULTS))
def test_a_damaged_zip_gives_500_on_the_zip_route(serve, build_copy, caplog, fault):
    ZIP_FAULTS[fault](zip_on_disk(CHAPTER, build_copy))
    serve(COURSES, build=build_copy)

    response = new_client(raise_server_exceptions=False).get(zip_url(CHAPTER))

    assert_server_fault(response, caplog)
    assert response.content.startswith(b"{")  # the error JSON, not a part of the ZIP
    assert "PK" not in response.text


@pytest.mark.parametrize("fault", list(ZIP_FAULTS))
def test_the_steps_route_works_when_the_zip_is_damaged_or_missing(serve, build_copy, fault):
    ZIP_FAULTS[fault](zip_on_disk(CHAPTER, build_copy))
    serve(COURSES, build=build_copy)

    response = new_client(raise_server_exceptions=False).get(code_url(CHAPTER))

    assert response.status_code == 200
    assert response.json()["steps"] == read_code_file(CHAPTER)["steps"]


def test_a_zip_with_the_right_size_and_hash_but_not_the_files_name_is_not_served(
    serve, build_copy, caplog
):
    # The file next to the JSON is renamed: the JSON names it, but the name is not the expected one.
    document = read_code_file(CHAPTER, build_copy)
    path = zip_on_disk(CHAPTER, build_copy)
    renamed = path.with_name(f"{CHAPTER}-0000000000000000.zip")
    path.rename(renamed)
    document["zip"]["file"] = renamed.name
    write_code_file(CHAPTER, document, build_copy)
    serve(COURSES, build=build_copy)

    assert_server_fault(new_client(raise_server_exceptions=False).get(zip_url(CHAPTER)), caplog)


@pytest.mark.parametrize(
    "name", ["../../private/courses/alpha-course.json", "..\\x.zip", "/etc/hostname", "x/y.zip"]
)
@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_a_changed_zip_file_name_opens_no_file_outside_the_code_folder(
    serve, build_copy, monkeypatch, caplog, route, name
):
    # A decoy that the traversal would reach: it has the size and hash that the JSON claims.
    target = (code_dir(build_copy) / name).resolve() if "/" in name else None
    document = read_code_file(CHAPTER, build_copy)
    if target is not None and target.is_file():
        data = target.read_bytes()
        document["zip"]["size"] = len(data)
        document["zip"]["sha256"] = hashlib.sha256(data).hexdigest()
    document["zip"]["file"] = name
    write_code_file(CHAPTER, document, build_copy)
    serve(COURSES, build=build_copy)
    opened = []
    for method in ("read_bytes", "read_text", "open", "stat", "is_file", "exists"):
        original = getattr(Path, method)

        def spy(self, *args, _original=original, **kwargs):
            opened.append(Path(self))
            return _original(self, *args, **kwargs)

        monkeypatch.setattr(Path, method, spy)

    response = new_client(raise_server_exceptions=False).get(route(CHAPTER))

    assert_server_fault(response, caplog)
    assert "SENTINEL" not in response.text
    inside = code_dir(build_copy)
    outside = [path for path in opened if "course-build" in str(path) and path.parent != inside]
    assert outside == []  # only files of private/code/zeta-course were looked at


# --- no secrets in logs ---


def test_no_log_line_holds_the_cookie_the_account_the_password_or_file_content(
    serve, db, clock, caplog, build_copy
):
    caplog.set_level(logging.DEBUG)
    document = read_code_file("02-gated", build_copy)
    document["steps"][0]["files"][0]["status"] = FAULT  # a fault, so that an error is logged too
    write_code_file("02-gated", document, build_copy)
    client = serve(COURSES, build=build_copy)
    client.base_url = BASE_URL
    assert register(client).status_code == 201
    token = client.cookies.get("session")
    put_progress(db, "ana1", "01-open", course=COURSE, passed=True)  # 02-gated is open now
    quiet = new_client(raise_server_exceptions=False)

    statuses = [
        client.get(code_url("01-open")).status_code,
        client.get(zip_url("01-open")).status_code,
        quiet.get(code_url("02-gated"), headers=with_cookie(token)).status_code,
        client.get(zip_url("03-sealed")).status_code,
        new_client().get(code_url("03-sealed")).status_code,
        client.get(code_url("07-nothing")).status_code,
    ]

    assert statuses == [200, 200, 500, 403, 401, 404]
    for secret in (token, "ana1", PASSWORD, str(account_id(db)), FAULT, "CODE-SENTINEL", "print("):
        assert secret not in caplog.text, secret


# --- the contract ---


def test_both_operations_mark_the_cookie_as_optional_and_declare_their_errors():
    paths = committed_spec()["paths"]

    for path, operation_id in (
        ("/api/courses/{course_id}/chapters/{chapter_id}/code", "getChapterCode"),
        ("/api/courses/{course_id}/chapters/{chapter_id}/code.zip", "getChapterCodeZip"),
    ):
        assert list(paths[path]) == ["get"]
        operation = paths[path]["get"]
        assert operation["operationId"] == operation_id
        assert operation["security"] == [{"SessionCookie": []}, {}]
        assert operation["responses"]["200"]["headers"]["Cache-Control"]
        for status in ("401", "403", "404", "500"):
            ref = operation["responses"][status]["content"]["application/json"]["schema"]["$ref"]
            assert ref == "#/components/schemas/ErrorResponse"


def test_the_zip_operation_lists_application_zip_as_binary_with_its_headers():
    path = "/api/courses/{course_id}/chapters/{chapter_id}/code.zip"
    ok = committed_spec()["paths"][path]["get"]["responses"]["200"]

    assert ok["content"] == {"application/zip": {"schema": {"type": "string", "format": "binary"}}}
    assert set(ok["headers"]) == {"Content-Disposition", "Cache-Control", "X-Content-Type-Options"}


def test_the_response_schemas_list_their_fields_and_have_no_hash():
    schemas = committed_spec()["components"]["schemas"]

    assert set(schemas["ChapterCodeResponse"]["properties"]) == {
        "course_id",
        "chapter_id",
        "zip",
        "steps",
    }
    assert set(schemas["CodeZip"]["properties"]) == {"url", "file_name", "size"}
    assert set(schemas["CodeStep"]["properties"]) == {"step", "files"}
    assert set(schemas["CodeFile"]["properties"]) == {
        "path",
        "status",
        "content",
        "changed_lines",
    }
    assert schemas["CodeFileStatus"]["enum"] == ["added", "modified", "deleted", "unchanged"]
    for name in ("ChapterCodeResponse", "CodeZip", "CodeStep", "CodeFile"):
        assert schemas[name]["additionalProperties"] is False
    assert "sha256" not in json.dumps(
        {name: schemas[name] for name in ("ChapterCodeResponse", "CodeZip", "CodeStep", "CodeFile")}
    )


def test_the_fixture_zips_agree_with_their_json():
    for chapter in ("01-open", "02-gated", "03-sealed", "04-late-open"):
        stored = read_code_file(chapter)["zip"]
        data = zip_on_disk(chapter).read_bytes()

        assert stored["file"] == f"{chapter}-{stored['sha256'][:16]}.zip"
        assert stored["size"] == len(data)
        assert stored["sha256"] == hashlib.sha256(data).hexdigest()


def test_gitattributes_keeps_the_fixture_zips_byte_exact_on_windows():
    lines = (BACKEND_DIR.parent / ".gitattributes").read_text().splitlines()

    assert "backend/tests/fixtures/course-build/private/code/**/*.zip binary" in lines
