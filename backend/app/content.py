"""Read lesson trees and quiz questions from the content build, one request at a time.

The files are `private/lessons/<course_id>/<lesson_id>.json` and
`private/quizzes/<course_id>/<chapter_id>.json` in the build folder (the format is in
`content-build/README.md`, "Building the courses"). Every path is built from IDs that are already
in the catalog, never from a request string. Nothing is cached: the files are small and the
operating system caches them.

The quiz file holds the answer key. `read_quiz` parses it with models that declare only the
public fields (`id`, `text`, `snippet`, `options`) and ignore every other key, so `correct`,
`explanation`, and `lesson` are dropped when the file is parsed, and a field added to the file
later cannot reach a client. A reader that needs the key (#16) has its own models.

A file that is missing, is not valid JSON, or has the wrong shape raises `BuildFileError`. That is
a server fault, and the shared handler turns it into a 500. The message names the course,
chapter, and lesson IDs and the field location, and never any content of the file: Pydantic's own
error text can hold the failing input (for a quiz, the answer key), so it is caught and
re-raised `from None`.
"""

import json
from pathlib import Path
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StrictStr, ValidationError

from app.courses import Catalog, Chapter, Course, Lesson


class BuildFileError(Exception):
    """A lesson or quiz file of the build cannot be read. The message holds no file content."""


class PublicSnippet(BaseModel):
    model_config = ConfigDict(extra="ignore")

    language: StrictStr
    code: StrictStr


class PublicOption(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: StrictStr
    text: StrictStr


class PublicQuestion(BaseModel):
    """A question as a learner may see it. No `correct`, `explanation`, or `lesson` field."""

    model_config = ConfigDict(extra="ignore")

    id: StrictStr
    text: StrictStr
    snippet: PublicSnippet | None = None
    options: Annotated[list[PublicOption], Field(min_length=1)]


class _QuizFile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    course_id: StrictStr
    chapter_id: StrictStr
    questions: list[PublicQuestion]


class _LessonFile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    course_id: StrictStr
    chapter_id: StrictStr
    lesson_id: StrictStr
    tree: dict[str, Any]


def _field(loc: tuple[Any, ...]) -> str:
    text = ""
    for part in loc:
        text += f"[{part}]" if isinstance(part, int) else (f".{part}" if text else str(part))
    return text or "(top level)"


def _read_json(path: Path, what: str) -> Any:
    try:
        return json.loads(path.read_bytes().decode("utf-8"))
    except OSError:
        raise BuildFileError(f"{what}: the file is missing or cannot be read.") from None
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise BuildFileError(f"{what}: the file is not valid UTF-8 JSON.") from None


def _validate[Model: BaseModel](model: type[Model], document: Any, what: str) -> Model:
    try:
        return model.model_validate(document)
    except ValidationError as error:
        first = error.errors()[0]  # location only: never the input, which may hold the answer key
        raise BuildFileError(
            f"{what}: field {_field(first['loc'])} is missing or invalid."
        ) from None


def _check_ids(what: str, **pairs: tuple[str, str]) -> None:
    for name, (found, expected) in pairs.items():
        if found != expected:
            raise BuildFileError(f"{what}: field {name} does not match the catalog.")


def read_lesson_tree(catalog: Catalog, course: Course, chapter: Chapter, lesson: Lesson) -> Any:
    """The `tree` of a lesson, unchanged from the file."""
    what = f"Lesson file (course {course.id}, chapter {chapter.id}, lesson {lesson.id})"
    path = catalog.build_dir / "private" / "lessons" / course.id / f"{lesson.id}.json"
    document = _validate(_LessonFile, _read_json(path, what), what)
    _check_ids(
        what,
        course_id=(document.course_id, course.id),
        chapter_id=(document.chapter_id, chapter.id),
        lesson_id=(document.lesson_id, lesson.id),
    )
    return document.tree


def read_quiz(catalog: Catalog, course: Course, chapter: Chapter) -> list[PublicQuestion]:
    """The public part of a chapter's questions, in file order, with options in file order."""
    what = f"Quiz file (course {course.id}, chapter {chapter.id})"
    path = catalog.build_dir / "private" / "quizzes" / course.id / f"{chapter.id}.json"
    document = _validate(_QuizFile, _read_json(path, what), what)
    _check_ids(
        what,
        course_id=(document.course_id, course.id),
        chapter_id=(document.chapter_id, chapter.id),
    )
    return document.questions
