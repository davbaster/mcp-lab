"""The asset route (#58): the files, the headers, 304, Range, public access, and not found."""

import builtins
import io
import os
from pathlib import Path
from urllib.parse import unquote

import pytest
from sqlalchemy.engine import Engine

from app.asset_routes import resolve_asset
from app.courses import load_catalog
from app.errors import ApiError
from tests.asset_support import (
    ALPHA,
    BETA,
    BETA_ONLY,
    BY_EXTENSION,
    CACHE_CONTROL,
    DOTTED,
    EMPTY_VTT,
    EXTENSIONS,
    HTML_PNG,
    NO_STORE,
    PNG,
    STRAY,
    SVG,
    SVG_POLICY,
    UNLISTED_FILE,
    VTT,
    file_on_disk,
    map_entries,
    sha256_of,
    url,
)
from tests.auth_support import assert_error, new_client, register, with_cookie
from tests.content_support import VISITOR_KINDS, visitor_headers
from tests.course_support import FIXTURE_BUILD
from tests.helpers import without_request_id

COURSE_NOT_FOUND = "course_not_found"
ASSET_NOT_FOUND = "asset_not_found"


@pytest.fixture
def api(serve):
    """The app serving alpha-course and beta-course from the fixture build."""
    return serve("alpha-course,beta-course")


# --- the 200: bytes, type, length ---


@pytest.mark.parametrize("extension", EXTENSIONS)
def test_each_extension_is_served_with_the_bytes_the_type_and_the_length(api, extension):
    name, content_type = BY_EXTENSION[extension]

    response = api.get(url(ALPHA, name))

    assert response.status_code == 200
    assert response.content == file_on_disk(ALPHA, name).read_bytes()
    assert response.headers["content-type"] == content_type
    assert response.headers["content-length"] == str(map_entries(ALPHA)[name]["size"])


@pytest.mark.parametrize("extension", EXTENSIONS)
def test_every_200_has_the_cache_etag_nosniff_disposition_and_ranges_headers(api, extension):
    name, _ = BY_EXTENSION[extension]

    response = api.get(url(ALPHA, name))

    assert response.headers["cache-control"] == CACHE_CONTROL
    assert response.headers["etag"] == f'"{map_entries(ALPHA)[name]["sha256"]}"'
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-disposition"] == "inline"
    assert response.headers["accept-ranges"] == "none"


def test_the_etag_is_the_sha256_of_the_bytes_and_does_not_depend_on_the_file_time(api):
    path = file_on_disk(ALPHA, PNG)
    before = api.get(url(ALPHA, PNG)).headers["etag"]
    stat = path.stat()
    try:
        os.utime(path, (stat.st_atime + 1000, stat.st_mtime + 1000))
        after = api.get(url(ALPHA, PNG)).headers["etag"]
    finally:
        os.utime(path, (stat.st_atime, stat.st_mtime))

    assert before == after == f'"{sha256_of(path)}"'


def test_the_disposition_names_no_file(api):
    response = api.get(url(ALPHA, PNG))

    assert response.headers["content-disposition"] == "inline"
    assert "filename" not in response.headers["content-disposition"]


def test_the_svg_has_the_exact_security_policy(api):
    response = api.get(url(ALPHA, SVG))

    assert response.headers["content-security-policy"] == SVG_POLICY
    assert response.headers["content-security-policy"].startswith("script-src 'none';")


@pytest.mark.parametrize("extension", [e for e in EXTENSIONS if e != "svg"])
def test_no_other_type_has_a_security_policy(api, extension):
    response = api.get(url(ALPHA, BY_EXTENSION[extension][0]))

    assert "content-security-policy" not in response.headers


def test_the_type_follows_the_extension_not_the_bytes(api):
    response = api.get(url(ALPHA, HTML_PNG))

    assert response.status_code == 200
    assert response.content.startswith(b"<html>")
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_a_zero_byte_file_is_a_200_with_an_empty_body_and_the_etag(api):
    response = api.get(url(ALPHA, EMPTY_VTT))

    assert response.status_code == 200
    assert response.content == b""
    assert response.headers["content-length"] == "0"
    assert response.headers["etag"] == f'"{map_entries(ALPHA)[EMPTY_VTT]["sha256"]}"'


def test_a_name_with_a_dot_and_capitals_in_the_stem_is_served(api):
    response = api.get(url(ALPHA, DOTTED))

    assert response.status_code == 200
    assert response.content == b"ASSET-SENTINEL-alpha-dotted"


def test_two_map_entries_with_one_file_are_served_as_one_name(api):
    entries = map_entries(ALPHA)

    response = api.get(url(ALPHA, PNG))

    assert response.status_code == 200
    assert response.content == b"ASSET-SENTINEL-alpha-png"
    assert PNG in entries


def test_the_source_path_of_the_map_is_not_a_name(api):
    for source in ("copies/png-file.png", "images/diagram.svg", "files/png-file.png"):
        response = api.get(url(ALPHA, source))

        assert_error(response, 404, ASSET_NOT_FOUND)


def test_the_message_of_a_missing_asset(api):
    response = api.get(url(ALPHA, "nothing-0123456789abcdef.png"))

    assert assert_error(response, 404, ASSET_NOT_FOUND) == "Asset not found."


def test_an_accept_header_is_ignored(api):
    plain = api.get(url(ALPHA, PNG))

    response = api.get(url(ALPHA, PNG), headers={"Accept": "application/json"})

    assert response.status_code == 200
    assert response.content == plain.content
    assert response.headers["content-type"] == "image/png"


def test_a_query_string_changes_nothing(api):
    plain = api.get(url(ALPHA, SVG))

    response = api.get(url(ALPHA, SVG) + "?v=2&x=%00")

    assert response.status_code == 200
    assert response.content == plain.content
    assert without_request_id(response) == without_request_id(plain)


def test_only_get_is_allowed(api):
    for method in ("post", "put", "delete", "patch"):
        response = getattr(api, method)(url(ALPHA, PNG))

        assert_error(response, 405, "method_not_allowed")


def test_head_is_a_405_like_on_the_other_routes(api):
    response = api.head(url(ALPHA, PNG))

    assert response.status_code == 405  # a HEAD response has no body to read the code from
    assert response.headers["allow"] == "GET"


def test_the_route_sets_no_cookie_and_no_private_cache_header(api):
    response = api.get(url(ALPHA, PNG))

    assert "set-cookie" not in response.headers
    assert NO_STORE not in response.headers["cache-control"]


# --- If-None-Match ---


def etag_of(name, course=ALPHA):
    return f'"{map_entries(course)[name]["sha256"]}"'


@pytest.mark.parametrize("name", [PNG, SVG, VTT])
@pytest.mark.parametrize(
    "form",
    ["exact", "weak", "list", "weak list", "star", "spaced list"],
)
def test_a_matching_if_none_match_is_a_304_with_no_body_and_the_headers(api, name, form):
    etag = etag_of(name)
    value = {
        "exact": etag,
        "weak": f"W/{etag}",
        "list": f'"other", {etag}, "more"',
        "weak list": f'"other",W/{etag}',
        "star": "*",
        "spaced list": f'  "x" ,   {etag}  ',
    }[form]

    response = api.get(url(ALPHA, name), headers={"If-None-Match": value})

    assert response.status_code == 304
    assert response.content == b""
    assert response.headers["etag"] == etag
    assert response.headers["cache-control"] == CACHE_CONTROL
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-disposition"] == "inline"
    assert ("content-security-policy" in response.headers) == (name == SVG)
    if name == SVG:
        assert response.headers["content-security-policy"] == SVG_POLICY
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    "value",
    [
        '"0000000000000000000000000000000000000000000000000000000000000000"',
        'W/"nope"',
        "",
        "garbage",
        "x" * 5000,
        '"a", "b"',
    ],
)
def test_an_if_none_match_that_does_not_match_is_a_200_with_the_body(api, value):
    response = api.get(url(ALPHA, PNG), headers={"If-None-Match": value})

    assert response.status_code == 200
    assert response.content == b"ASSET-SENTINEL-alpha-png"


def test_the_etag_of_another_file_does_not_match(api):
    response = api.get(url(ALPHA, PNG), headers={"If-None-Match": etag_of(VTT)})

    assert response.status_code == 200


def test_the_etag_of_the_same_name_in_another_course_does_not_match(api):
    response = api.get(url(ALPHA, PNG), headers={"If-None-Match": etag_of(PNG, BETA)})

    assert response.status_code == 200
    assert api.get(url(BETA, PNG), headers={"If-None-Match": etag_of(PNG, BETA)}).status_code == 304


def test_a_not_found_is_never_a_304(api):
    response = api.get(url(ALPHA, STRAY), headers={"If-None-Match": "*"})

    assert_error(response, 404, ASSET_NOT_FOUND)


# --- Range ---


@pytest.mark.parametrize(
    "range_value",
    [
        "bytes=0-3",
        "bytes=abc",
        "bytes=999999-",
        "bytes=0-1,3-4",
        "bytes=-2",
        "items=0-3",
        "",
        "bytes=5-2",
    ],
)
def test_a_range_header_is_ignored_and_the_answer_is_the_whole_file(api, range_value):
    response = api.get(url(ALPHA, PNG), headers={"Range": range_value})

    assert response.status_code == 200
    assert response.content == b"ASSET-SENTINEL-alpha-png"
    assert "content-range" not in response.headers
    assert response.headers["accept-ranges"] == "none"
    assert response.headers["content-length"] == "24"


@pytest.mark.parametrize("if_range", ['"x"', "Sat, 24 Oct 2026 23:14:47 GMT", ""])
def test_an_if_range_header_is_ignored_too(api, if_range):
    response = api.get(url(ALPHA, PNG), headers={"Range": "bytes=0-3", "If-Range": if_range})

    assert response.status_code == 200
    assert response.content == b"ASSET-SENTINEL-alpha-png"


def test_a_range_request_for_a_missing_asset_is_still_the_shared_404(api):
    response = api.get(url(ALPHA, STRAY), headers={"Range": "bytes=0-3"})

    assert_error(response, 404, ASSET_NOT_FOUND)


# --- public: the same for every caller ---


@pytest.mark.parametrize("name", [PNG, SVG])
def test_every_kind_of_caller_gets_the_same_response(content_api, clock, name):
    assert register(content_api).status_code == 201
    token = content_api.cookies.get("session")
    anonymous = new_client().get(url(ALPHA, name))
    learner = new_client().get(url(ALPHA, name), headers=with_cookie(token))
    others = [
        new_client().get(url(ALPHA, name), headers=visitor_headers(kind, content_api, clock))
        for kind in VISITOR_KINDS
    ]

    assert anonymous.status_code == 200
    for response in [learner, *others]:
        assert response.status_code == anonymous.status_code
        assert response.content == anonymous.content
        assert without_request_id(response) == without_request_id(anonymous)
        assert "set-cookie" not in response.headers


def test_a_signed_in_client_sees_nothing_different(content_api):
    anonymous = new_client().get(url(ALPHA, PNG))
    assert register(content_api).status_code == 201

    response = content_api.get(url(ALPHA, PNG))

    assert response.content == anonymous.content
    assert without_request_id(response) == without_request_id(anonymous)
    assert "set-cookie" not in response.headers


@pytest.fixture
def no_connections(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the asset route must not open a database connection")

    monkeypatch.setattr(Engine, "connect", refuse)
    monkeypatch.setattr(Engine, "begin", refuse)


def test_the_route_opens_no_database_connection(serve, monkeypatch, no_connections):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    client = serve("alpha-course,beta-course")

    for headers in ({}, with_cookie("a" * 43), with_cookie("garbage")):
        assert client.get(url(ALPHA, PNG), headers=headers).status_code == 200
        assert (
            client.get(url(ALPHA, PNG), headers=headers | {"If-None-Match": "*"}).status_code == 304
        )
        assert_error(client.get(url(ALPHA, STRAY), headers=headers), 404, ASSET_NOT_FOUND)


# --- streamed from disk, nothing kept ---


def test_the_file_is_read_from_disk_on_every_request(serve, build_copy):
    client = serve("alpha-course", build=build_copy)
    path = file_on_disk(ALPHA, PNG, build_copy)
    first = client.get(url(ALPHA, PNG)).content

    path.write_bytes(b"CHANGED-ON-DISK-alpha-png!")  # the same size, so the startup check holds

    assert first == b"ASSET-SENTINEL-alpha-png"
    assert client.get(url(ALPHA, PNG)).content == b"CHANGED-ON-DISK-alpha-png!"


def test_an_asset_holds_metadata_only(api):
    from app.main import app

    asset = app.state.catalog.get(ALPHA).get_asset(PNG)

    assert set(vars(asset)) == {"file", "content_type", "sha256", "size"}


def test_a_large_file_is_sent_in_full(serve, build_copy):
    import hashlib
    import json

    data = os.urandom(300_000)  # more than the 64 KiB chunk of the file response
    digest = hashlib.sha256(data).hexdigest()
    name = f"big-{digest[:16]}.glb"
    file_on_disk(ALPHA, name, build_copy).write_bytes(data)
    map_file = build_copy / "assets-map" / "alpha-course.json"
    document = json.loads(map_file.read_text(encoding="utf-8"))
    document["files"]["models/big.glb"] = {"file": name, "sha256": digest, "size": len(data)}
    map_file.write_text(json.dumps(document), encoding="utf-8")
    client = serve("alpha-course", build=build_copy)

    response = client.get(url(ALPHA, name))

    assert response.status_code == 200
    assert response.content == data
    assert response.headers["content-length"] == str(len(data))


# --- the map is read once; a vanished file is a server fault ---


def test_the_map_is_read_once_deleting_it_after_the_start_changes_nothing(serve, build_copy):
    import shutil

    client = serve("alpha-course", build=build_copy)
    before = client.get(url(ALPHA, PNG))

    shutil.rmtree(build_copy / "assets-map")

    after = client.get(url(ALPHA, PNG))
    assert after.status_code == 200
    assert after.content == before.content
    assert without_request_id(after) == without_request_id(before)


def test_a_file_added_to_the_build_after_the_start_is_not_served(serve, build_copy):
    client = serve("alpha-course", build=build_copy)
    name = "late-0123456789abcdef.png"
    file_on_disk(ALPHA, name, build_copy).write_bytes(b"LATE")

    assert_error(client.get(url(ALPHA, name)), 404, ASSET_NOT_FOUND)


def test_a_stray_file_in_the_asset_folder_is_not_served(api):
    assert file_on_disk(ALPHA, STRAY).is_file()

    assert_error(api.get(url(ALPHA, STRAY)), 404, ASSET_NOT_FOUND)


def test_a_file_deleted_after_the_start_is_a_500_in_the_shared_shape_with_no_path(
    serve, build_copy, caplog
):
    serve("alpha-course", build=build_copy)
    errors = new_client(raise_server_exceptions=False)
    file_on_disk(ALPHA, PNG, build_copy).unlink()
    caplog.clear()

    response = errors.get(url(ALPHA, PNG))

    assert_error(response, 500, "internal_error")
    assert str(build_copy) not in response.text
    assert "public" not in response.text
    assert PNG not in response.text
    assert "alpha-course" in caplog.text  # the log names the course and the file, not the path
    assert str(build_copy) not in caplog.text


def test_a_file_replaced_by_a_folder_after_the_start_is_a_500(serve, build_copy):
    serve("alpha-course", build=build_copy)
    errors = new_client(raise_server_exceptions=False)
    path = file_on_disk(ALPHA, PNG, build_copy)
    path.unlink()
    path.mkdir()

    assert_error(errors.get(url(ALPHA, PNG)), 500, "internal_error")


def test_a_deleted_file_still_answers_a_matching_if_none_match_with_304(serve, build_copy):
    client = serve("alpha-course", build=build_copy)
    file_on_disk(ALPHA, PNG, build_copy).unlink()

    # The answer holds no bytes, so it needs no file.
    assert client.get(url(ALPHA, PNG), headers={"If-None-Match": "*"}).status_code == 304


# --- course scoping ---


def test_the_same_file_name_in_two_courses_serves_each_courses_own_bytes(api):
    alpha = api.get(url(ALPHA, PNG))
    beta = api.get(url(BETA, PNG))

    assert alpha.content == b"ASSET-SENTINEL-alpha-png"
    assert beta.content == b"ASSET-SENTINEL-beta-png"
    assert alpha.headers["etag"] != beta.headers["etag"]
    assert beta.headers["etag"] == etag_of(PNG, BETA)


def test_a_name_that_exists_in_one_course_only_is_a_404_in_the_other(api):
    assert api.get(url(BETA, BETA_ONLY)).content == b"ASSET-SENTINEL-beta-only"
    assert_error(api.get(url(ALPHA, BETA_ONLY)), 404, ASSET_NOT_FOUND)
    assert_error(api.get(url(BETA, SVG)), 404, ASSET_NOT_FOUND)
    assert_error(api.get(url(BETA, VTT)), 404, ASSET_NOT_FOUND)


def test_a_course_with_no_assets_serves_nothing(serve):
    client = serve("alpha-course,gamma-course")

    assert_error(client.get(url("gamma-course", PNG)), 404, ASSET_NOT_FOUND)


# --- course not found ---

# A client may fold `..` or decode `%2e` before it sends the URL, so the path a request really had
# is checked: a route that was reached must answer with the course code, any other 404 is the
# router's own. The lookup function is checked with the same IDs below.
BAD_COURSES = [
    "unlisted-course",  # in the build folder, not in COURSES
    "no-such-course",
    "ALPHA-COURSE",
    "Alpha-Course",
    "a" * 5000,
    "..",
    "%2e%2e",
    "%2E%2E",
    "alpha-course%20",
    "alpha_course",
    "alpha-course.",
    "%00",
    "é",
    ".",
]


@pytest.mark.parametrize("course", BAD_COURSES)
def test_a_course_that_is_not_in_courses_is_a_404_never_a_422_or_500(api, course):
    response = api.get(url(course, PNG))

    assert response.status_code == 404
    reached = response.request.url.raw_path.endswith(f"/assets/{PNG}".encode()) and (
        response.request.url.raw_path.count(b"/") == 5
    )
    if reached:
        assert_error(response, 404, COURSE_NOT_FOUND)
        assert response.json()["error"]["message"] == "Course not found."


@pytest.mark.parametrize(
    "course", ["unlisted-course", "no-such-course", "ALPHA-COURSE", "a" * 5000]
)
def test_a_course_that_is_not_in_courses_answers_course_not_found(api, course):
    assert_error(api.get(url(course, PNG)), 404, COURSE_NOT_FOUND)


def test_a_course_in_the_build_folder_but_not_in_courses_is_not_served(api):
    assert file_on_disk("unlisted-course", UNLISTED_FILE).is_file()

    assert_error(api.get(url("unlisted-course", UNLISTED_FILE)), 404, COURSE_NOT_FOUND)


def test_the_course_is_checked_before_the_file_name(api):
    # Both are wrong: the course code wins.
    assert_error(api.get(url("no-such-course", "nothing")), 404, COURSE_NOT_FOUND)
    assert_error(api.get(url("unlisted-course", STRAY)), 404, COURSE_NOT_FOUND)


@pytest.mark.parametrize("course", BAD_COURSES)
def test_the_lookup_function_rejects_a_bad_course_with_course_not_found(course):
    catalog = load_catalog("alpha-course,beta-course", str(FIXTURE_BUILD))

    for candidate in {course, unquote(course)}:
        with pytest.raises(ApiError) as raised:
            resolve_asset(catalog, candidate, PNG)

        assert (raised.value.status_code, raised.value.code) == (404, COURSE_NOT_FOUND)


# --- not found: names ---

# The names as they go into the URL. Some of them are folded or decoded by the client before they
# are sent.
BAD_NAME_URLS = [
    "..",
    "../x",
    "..%2f",
    "..%2F",
    "%2e%2e%2f",
    "%2E%2E/",
    "%2e%2e",
    "....//",
    "a/b.png",
    "a%2Fb.png",
    "a%2fb.png",
    "a\\b.png",
    "a%5Cb.png",
    "..\\",
    "..%5c",
    "/etc/passwd",
    "%2Fetc%2Fpasswd",
    "C:%5Cwindows",
    "C:\\windows",
    "%00",
    f"{PNG}%00",
    f"{PNG}%0a",
    f"{PNG}%0d%0a",
    "%0a",
    "%C3%A9.png",
    "é.png",
    "a" * 5000,
    ("a" * 5000) + ".png",
    "../../assets-map/alpha-course.json",
    "..%2F..%2Fassets-map%2Falpha-course.json",
    "../../private/courses/alpha-course.json",
    "..%2F..%2Fprivate%2Fcourses%2Falpha-course.json",
    f"../beta-course/{PNG}",
    f"..%2Fbeta-course%2F{PNG}",
    f"../beta-course/{BETA_ONLY}",
    # a name next to a real one
    PNG.upper(),
    PNG.replace("asset", "Asset"),
    PNG.replace(".png", ".PNG"),
    f"{PNG}/",
    f"{PNG}%20",
    f"{PNG} ",
    f"%20{PNG}",
    f"{PNG}.",
    f"{PNG}.bak",
    f"x{PNG}",
    PNG.replace(".png", ""),
    PNG.replace("asset-", ""),
    f"{PNG};x",
    f"{PNG}%3Fv=2",
    f"{PNG}%23x",
    # the folder's own files and names from other places
    STRAY,
    BETA_ONLY,
    UNLISTED_FILE,
    "nothing-0123456789abcdef.png",
    "alpha-course.json",
    "hello.json",
    "01-basics.json",
    "unlisted-course",
    "alpha-course",
    "public",
    "",
]


# Names that a client folds or decodes before it sends them (`./name` is sent as `name`), so
# only the lookup function sees them as they are.
LOOKUP_ONLY_NAMES = [
    f"./{PNG}",
    f"{PNG}/.",
    f"{PNG}/..",
    f"x/../{PNG}",
    "x/..",
    "./",
    ".",
    f"{PNG}\n",
    f"\n{PNG}",
    f"{PNG}\r",
    f"{PNG}\x00",
]


def test_a_course_with_an_encoded_slash_is_a_404(api):
    # The server decodes %2F before it routes, so this is a path of its own with no such route.
    assert api.get(url("alpha%2Fbeta", PNG)).status_code == 404


@pytest.mark.parametrize("name", BAD_NAME_URLS)
def test_a_bad_name_is_a_404_and_never_a_file(api, name):
    response = api.get(url(ALPHA, name))

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/json"
    path = response.request.url.raw_path
    if path.startswith(b"/api/courses/alpha-course/assets/"):
        assert_error(response, 404, ASSET_NOT_FOUND)
    assert response.content.count(b"ASSET-SENTINEL") == 0


@pytest.mark.parametrize("name", [*BAD_NAME_URLS, *LOOKUP_ONLY_NAMES])
def test_the_lookup_function_rejects_a_bad_name(name):
    catalog = load_catalog("alpha-course,beta-course", str(FIXTURE_BUILD))

    for candidate in {name, unquote(name)} - {PNG, DOTTED}:
        with pytest.raises(ApiError) as raised:
            resolve_asset(catalog, ALPHA, candidate)

        assert (raised.value.status_code, raised.value.code) == (404, ASSET_NOT_FOUND)


def test_the_lookup_function_finds_exactly_the_names_of_the_map():
    catalog = load_catalog("alpha-course,beta-course", str(FIXTURE_BUILD))
    course = catalog.get(ALPHA)

    for name, entry in map_entries(ALPHA).items():
        found_course, asset = resolve_asset(catalog, ALPHA, name)
        assert found_course is course
        assert (asset.file, asset.sha256, asset.size) == (name, entry["sha256"], entry["size"])
    assert set(course.assets) == set(map_entries(ALPHA))


@pytest.fixture
def disk_spy(monkeypatch):
    """Record every call that opens, stats, or lists something below the fixture build."""
    touched = []
    root = str(FIXTURE_BUILD)

    def spy(original):
        def wrapper(path, *args, **kwargs):
            if isinstance(path, (str, bytes, os.PathLike)) and root in os.fsdecode(path):
                touched.append(os.fsdecode(path))
            return original(path, *args, **kwargs)

        return wrapper

    for owner, attribute in (
        (os, "stat"),
        (os, "lstat"),
        (os, "scandir"),
        (os, "listdir"),
        (os, "open"),
        (os.path, "realpath"),
        (builtins, "open"),
        (io, "open"),
    ):
        monkeypatch.setattr(owner, attribute, spy(getattr(owner, attribute)))
    monkeypatch.setattr(Path, "read_bytes", lambda self: touched.append(str(self)) or b"")
    return touched


@pytest.mark.parametrize("name", BAD_NAME_URLS)
def test_a_bad_name_reads_nothing_from_disk(api, disk_spy, name):
    for course in (ALPHA, "no-such-course"):
        assert api.get(url(course, name)).status_code == 404

    assert disk_spy == []


@pytest.mark.parametrize("name", [*BAD_NAME_URLS, *LOOKUP_ONLY_NAMES])
def test_the_lookup_of_a_bad_name_reads_nothing_from_disk(name):
    catalog = load_catalog("alpha-course,beta-course", str(FIXTURE_BUILD))
    touched = []
    original = os.stat

    def wrapper(path, *args, **kwargs):
        touched.append(path)
        return original(path, *args, **kwargs)

    os_stat = pytest.MonkeyPatch()
    os_stat.setattr(os, "stat", wrapper)
    os_stat.setattr(os, "lstat", wrapper)
    os_stat.setattr(os, "scandir", wrapper)
    os_stat.setattr(os, "listdir", wrapper)
    os_stat.setattr(builtins, "open", wrapper)
    try:
        with pytest.raises(ApiError):
            resolve_asset(catalog, ALPHA, name)
    finally:
        os_stat.undo()

    assert touched == []


def test_the_disk_spy_does_see_a_real_read(api, monkeypatch):
    # Guards the test above: it proves nothing if the spy cannot see the route read a file.
    touched = []
    original = os.stat

    def wrapper(path, *args, **kwargs):
        if isinstance(path, (str, bytes, os.PathLike)) and str(FIXTURE_BUILD) in os.fsdecode(path):
            touched.append(os.fsdecode(path))
        return original(path, *args, **kwargs)

    monkeypatch.setattr(os, "stat", wrapper)

    assert api.get(url(ALPHA, PNG)).status_code == 200
    assert any(PNG in path for path in touched)


@pytest.mark.parametrize("name", [STRAY, "nothing-0123456789abcdef.png", PNG.upper(), "a/b.png"])
def test_a_404_has_no_cache_etag_or_disposition_header(api, name):
    response = api.get(url(ALPHA, name))

    assert response.status_code == 404
    assert "immutable" not in response.headers.get("cache-control", "")
    assert "31536000" not in response.headers.get("cache-control", "")
    assert "etag" not in response.headers
    assert "content-disposition" not in response.headers
    assert "content-security-policy" not in response.headers


def test_a_course_not_found_has_no_cache_etag_or_disposition_header(api):
    response = api.get(url("no-such-course", PNG))

    assert "immutable" not in response.headers.get("cache-control", "")
    assert "etag" not in response.headers
    assert "content-disposition" not in response.headers


# --- the route sees only the map ---


def test_a_file_in_the_map_of_another_course_is_never_served_under_this_one(serve, build_copy):
    # beta lists a file that exists only in alpha's folder: the file is looked up in beta's folder.
    import json

    document = json.loads((build_copy / "assets-map" / "beta-course.json").read_text())
    assert "asset-72be49cfe5aac953.jpg" not in {e["file"] for e in document["files"].values()}
    client = serve("alpha-course,beta-course", build=build_copy)

    assert_error(client.get(url(BETA, "asset-72be49cfe5aac953.jpg")), 404, ASSET_NOT_FOUND)


def test_the_route_is_in_the_spec_as_get_asset():
    from tests.content_support import committed_spec

    spec = committed_spec()
    operation = spec["paths"]["/api/courses/{course_id}/assets/{file_name}"]["get"]

    assert operation["operationId"] == "getAsset"
    assert operation["tags"] == ["courses"]
    assert "security" not in operation
    assert [p["name"] for p in operation["parameters"]] == ["course_id", "file_name"]
    ok = operation["responses"]["200"]
    assert set(ok["content"]) == {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/svg+xml",
        "model/gltf-binary",
        "model/gltf+json",
        "text/vtt",
    }
    assert all(
        body["schema"] == {"type": "string", "format": "binary"} for body in ok["content"].values()
    )
    assert set(ok["headers"]) == {
        "Cache-Control",
        "ETag",
        "X-Content-Type-Options",
        "Content-Disposition",
        "Accept-Ranges",
        "Content-Security-Policy",
    }
    assert "opposite" in ok["headers"]["Cache-Control"]["description"]
    assert "content" not in operation["responses"]["304"]
    for status in ("404", "422", "500"):
        schema = operation["responses"][status]["content"]["application/json"]["schema"]
        assert schema == {"$ref": "#/components/schemas/ErrorResponse"}
