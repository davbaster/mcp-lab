"""The asset route against the real build output, and the absence checks (#58).

The golden build is `content-build/fixtures/expected`: what the content build wrote. These tests
read committed files and run no Node. If the build changes the map, the file names, or the URLs in
the lesson trees, they fail here.
"""

import json

import pytest

from app.asset_routes import CACHE_CONTROL
from tests.asset_support import ALPHA, BETA, BY_EXTENSION, url
from tests.auth_support import assert_error
from tests.course_support import FIXTURE_BUILD, GOLDEN_BUILD

SAMPLE = "sample-course"
CONTENT_TYPES = {name.rsplit(".", 1)[1]: type_ for name, type_ in BY_EXTENSION.values()}
PREFIX = f"/api/courses/{SAMPLE}/assets/"


@pytest.fixture
def golden(serve):
    return serve(SAMPLE, build=GOLDEN_BUILD)


def golden_entries() -> dict[str, dict]:
    document = json.loads((GOLDEN_BUILD / "assets-map" / f"{SAMPLE}.json").read_text())
    return {entry["file"]: entry for entry in document["files"].values()}


def strings_in(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, list):
        for item in node:
            yield from strings_in(item)
    elif isinstance(node, dict):
        for key, value in node.items():
            yield from strings_in(key)
            yield from strings_in(value)


def lesson_urls() -> set[str]:
    found = set()
    for path in (GOLDEN_BUILD / "private" / "lessons" / SAMPLE).glob("*.json"):
        for text in strings_in(json.loads(path.read_text(encoding="utf-8"))):
            if text.startswith(PREFIX):
                found.add(text)
    return found


def test_every_file_in_the_golden_map_is_served_with_its_bytes_and_type(golden):
    entries = golden_entries()
    assert len(entries) == 8

    for name, entry in entries.items():
        response = golden.get(url(SAMPLE, name))

        assert response.status_code == 200, name
        assert response.content == (GOLDEN_BUILD / "public/assets" / SAMPLE / name).read_bytes()
        assert response.headers["content-type"] == CONTENT_TYPES[name.rsplit(".", 1)[1]], name
        assert response.headers["content-length"] == str(entry["size"])
        assert response.headers["etag"] == f'"{entry["sha256"]}"'
        assert response.headers["cache-control"] == CACHE_CONTROL
        assert response.headers["x-content-type-options"] == "nosniff"


def test_the_golden_map_covers_every_extension_except_jpeg():
    extensions = {name.rsplit(".", 1)[1] for name in golden_entries()}

    assert extensions == set(CONTENT_TYPES) - {"jpeg"}


def test_every_asset_url_in_the_golden_lesson_trees_is_served(golden):
    urls = lesson_urls()
    assert {u.removeprefix(PREFIX) for u in urls} == set(golden_entries())

    for asset_url in sorted(urls):
        response = golden.get(asset_url)

        assert response.status_code == 200, asset_url
        assert (
            response.content
            == (
                GOLDEN_BUILD / "public/assets" / SAMPLE / asset_url.removeprefix(PREFIX)
            ).read_bytes()
        )


def test_a_source_path_of_the_golden_map_is_not_served(golden):
    document = json.loads((GOLDEN_BUILD / "assets-map" / f"{SAMPLE}.json").read_text())

    for source in document["files"]:
        assert_error(golden.get(url(SAMPLE, source)), 404, "asset_not_found")


def test_nothing_below_private_is_reachable_through_the_route(golden):
    private = GOLDEN_BUILD / "private"
    names = {
        path.name for path in private.rglob("*") if path.is_file()
    }  # lesson, quiz, code, and manifest file names
    names |= {
        f"../private/{path.relative_to(private).as_posix()}" for path in private.rglob("*.json")
    }
    names |= {
        f"../../private/{path.relative_to(private).as_posix()}" for path in private.rglob("*.json")
    }
    names |= {
        f"..%2F..%2Fprivate%2F{path.relative_to(private).as_posix()}"
        for path in private.rglob("*.json")
    }
    assert any(name.endswith("01-first-steps.json") for name in names)

    for name in sorted(names):
        response = golden.get(url(SAMPLE, name))

        assert response.status_code == 404, name
        assert "explanation" not in response.text


def test_the_golden_quiz_text_is_in_no_asset_response(golden):
    quiz = json.loads(
        (GOLDEN_BUILD / "private/quizzes" / SAMPLE / "01-first-steps.json").read_text()
    )
    secrets = [q["explanation"] for q in quiz["questions"]]
    assert secrets and all(len(secret) > 10 for secret in secrets)
    responses = [golden.get(url(SAMPLE, name)) for name in golden_entries()]
    responses.append(golden.get(url(SAMPLE, "01-first-steps.json")))

    for response in responses:
        haystack = response.text + str(dict(response.headers))
        for secret in secrets:
            assert secret not in haystack


# --- the sentinels of the fixture build ---

FIXTURE_SENTINELS = ("LESSON-SENTINEL", "CORRECT-SENTINEL", "EXPLANATION-SENTINEL", "CODE-SENTINEL")


def test_no_asset_response_holds_a_lesson_quiz_or_code_sentinel(serve):
    client = serve("alpha-course,beta-course,gamma-course,delta-course,epsilon-course")
    names = [(ALPHA, "01-basics.json"), (ALPHA, "hello.json"), (BETA, "01-only.json")]
    names += [(ALPHA, name) for name in _all_alpha_names()]
    names += [(BETA, name) for name in _all_alpha_names()]
    responses = [client.get(url(course, name)) for course, name in names]
    responses.append(client.get(url(ALPHA, "../../private/quizzes/alpha-course/01-basics.json")))
    responses.append(
        client.get(url(ALPHA, "..%2F..%2Fprivate%2Fcode%2Falpha-course%2F01-basics.json"))
    )
    assert sum(r.status_code == 200 for r in responses) >= 9

    for response in responses:
        haystack = response.text + str(dict(response.headers))
        for sentinel in FIXTURE_SENTINELS:
            assert sentinel not in haystack


def test_the_fixture_does_hold_the_sentinels_the_test_above_looks_for():
    text = "".join(path.read_text() for path in (FIXTURE_BUILD / "private").rglob("*.json"))

    for sentinel in FIXTURE_SENTINELS:
        assert sentinel in text


def _all_alpha_names() -> list[str]:
    document = json.loads((FIXTURE_BUILD / "assets-map" / "alpha-course.json").read_text())
    return sorted({entry["file"] for entry in document["files"].values()})
