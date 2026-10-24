"""scripts/check_images.py: the judgments it makes, and that it fails when Docker is missing.

Building the images is what `make check-images` does (and the docker-images CI job); these tests run without Docker.
"""

import importlib.util
import subprocess
import sys

from tests.dbtools import BACKEND_DIR

SCRIPT = BACKEND_DIR / "scripts" / "check_images.py"


def load():
    spec = importlib.util.spec_from_file_location("check_images", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GOOD_LISTING = """user 10001
dir /app/course-build
file assets-map/sample-course.json
file private/courses/sample-course.json
file private/lessons/sample-course/01-welcome.json
file private/quizzes/sample-course/01-first-steps.json
file public/assets/sample-course/pic-86b20898ccdf344b.png
"""
GOOD_SEARCH = """found /app/course-build
found /app/course-build/private
found /app/course-build/private/courses/sample-course.json
found /app/course-build/private/quizzes/sample-course/01-first-steps.json
"""


def test_a_good_backend_image_has_no_problem():
    assert load().backend_problems(GOOD_LISTING, GOOD_SEARCH) == []


def test_the_backend_image_must_hold_the_files_the_issue_names():
    check = load()
    for missing in (
        "private/courses/sample-course.json",
        "private/lessons/sample-course/01-welcome.json",
        "private/quizzes/sample-course/01-first-steps.json",
        "public/assets/sample-course/pic-86b20898ccdf344b.png",
    ):
        listing = GOOD_LISTING.replace(f"file {missing}\n", "")
        problems = check.backend_problems(listing, GOOD_SEARCH)
        assert len(problems) == 1, missing
        assert "no file" in problems[0]


def test_the_backend_image_must_run_as_a_non_root_user_and_read_every_file():
    check = load()

    assert check.backend_problems(GOOD_LISTING.replace("user 10001", "user 0"), GOOD_SEARCH)
    assert check.backend_problems(GOOD_LISTING.replace("user 10001\n", ""), GOOD_SEARCH)
    problems = check.backend_problems(GOOD_LISTING + "unreadable private/secret.json\n", GOOD_SEARCH)
    assert problems == ["private/secret.json in $COURSE_BUILD_DIR is not readable by the image's user"]
    assert check.backend_problems(GOOD_LISTING.replace("/app/course-build", "/elsewhere"), GOOD_SEARCH)


def test_the_search_is_the_positive_control_so_a_search_that_finds_nothing_fails():
    check = load()

    problems = check.backend_problems(GOOD_LISTING, "")

    assert len(problems) == 4
    assert all("cannot be trusted" in problem for problem in problems)
    assert check.backend_problems(GOOD_LISTING, GOOD_SEARCH.replace("found /app/course-build/private\n", "")) != []


def test_the_frontend_image_must_find_nothing():
    check = load()

    assert check.frontend_problems("") == []
    assert check.frontend_problems("found /usr/share/nginx/html/private\nfound /x/sample-course.json\n") == [
        "the frontend image has /usr/share/nginx/html/private",
        "the frontend image has /x/sample-course.json",
    ]


def test_the_search_looks_for_the_four_names_and_allows_only_an_empty_system_private_folder():
    script = load().SEARCH_SCRIPT

    for name in ("private", "course-build", "01-first-steps.json", "sample-course.json"):
        assert f"-name {name}" in script
    assert "-xdev" in script
    assert "! -path /etc/ssl/private" in script
    assert "find /etc/ssl/private -mindepth 1" in script  # the folder counts again as soon as it holds anything


def test_the_script_fails_and_says_so_when_docker_is_missing(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        env={"PATH": str(tmp_path)},  # a folder without a docker command
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.returncode == 1
    assert "Docker is required" in result.stderr
    assert "check-images FAILED" in result.stderr


def test_the_script_builds_the_backend_with_the_fixture_course_and_the_repo_root_as_context():
    text = SCRIPT.read_text()

    assert 'FIXTURE_COURSES = "content-build/fixtures/valid"' in text
    assert '"-f", "backend/Dockerfile", "--build-arg", f"COURSES_DIR={FIXTURE_COURSES}", "."' in text
    assert 'build(frontend_image, "frontend")' in text
    assert "rmi" in text and "rm" in text  # it removes what it made
