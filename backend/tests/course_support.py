"""Fixtures and helpers shared by the course tests (#13).

`FIXTURE_BUILD` is a small, hand-written build folder with the layout of the content build:
`alpha-course` (2 chapters, 3 lessons), `beta-course` (1 chapter, 1 lesson), `gamma-course`
(3 chapters of one lesson each, `free_preview` on the first and third; for the progress tests, #14),
`delta-course` (for the lesson and quiz tests, #15: a `free_preview` chapter of three lessons and a
chapter of one lesson with a five-question quiz, one question with a snippet and two with three
options), `epsilon-course` (for the quiz attempt tests, #16: two chapters of two lessons, each with a
five-question quiz whose option IDs are unique and are not `a`, `b`, or `c`), `zeta-course` (for the
code step and chapter ZIP tests, #59: six chapters of one lesson each, four with real code steps and
a real ZIP written by the content build; see `tests/code_support.py`), and a deliberately broken
`unlisted-course`. Its files hold sentinel strings that no response or log may contain. Load
`delta-course`, `epsilon-course`, and `zeta-course` only by asking for them:
`serve("epsilon-course")`.
"""

import json
import shutil
from contextlib import ExitStack
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.dbtools import BACKEND_DIR

FIXTURE_BUILD = BACKEND_DIR / "tests" / "fixtures" / "course-build"
GOLDEN_BUILD = BACKEND_DIR.parent / "content-build" / "fixtures" / "expected"
SENTINEL_MARKER = "SENTINEL"  # every secret-like string in the fixture build contains it


def manifest_path(build: Path, course_id: str) -> Path:
    return build / "private" / "courses" / f"{course_id}.json"


def read_manifest(build: Path, course_id: str) -> dict:
    return json.loads(manifest_path(build, course_id).read_text(encoding="utf-8"))


def write_manifest(build: Path, course_id: str, document: object) -> None:
    manifest_path(build, course_id).write_text(json.dumps(document), encoding="utf-8")


@pytest.fixture
def build_copy(tmp_path) -> Path:
    """A copy of the fixture build that a test may break."""
    target = tmp_path / "course-build"
    shutil.copytree(FIXTURE_BUILD, target)
    return target


@pytest.fixture
def serve(monkeypatch):
    """`serve("alpha-course,beta-course")` starts the app (lifespan included) and returns a client."""
    stack = ExitStack()

    def start(courses: str = "alpha-course,beta-course", build: Path = FIXTURE_BUILD) -> TestClient:
        monkeypatch.setenv("COURSES", courses)
        monkeypatch.setenv("COURSE_BUILD_DIR", str(build))
        return stack.enter_context(TestClient(app))

    with stack:
        yield start
