"""Course data: read the content build once at startup and keep it in memory.

`load_catalog_from_environment` reads `COURSES` (the course IDs to serve, in order) and
`COURSE_BUILD_DIR` (the output of the content build), loads the manifest
`private/courses/<course_id>.json` of each course, and checks that the lesson, quiz, and code
files the manifest names exist. It reads no lesson, quiz, or code content, so no answer key passes
through this module (`app.content` reads the lesson and quiz files, one request at a time). Any problem raises `CourseLoadError` at the first one; the app then does not
start. Messages hold course IDs, field names, counts, and paths inside the build folder only.

The result is a `Catalog` of frozen data. `app.main` builds it in the lifespan and keeps it on
`app.state.catalog`; routes get it with the `get_catalog` dependency.
"""

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Annotated, Any

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, ValidationError

# The version of the manifest the content build writes (content-build/README.md, "The manifest").
# A test compares it, and the manifest's keys, with the golden manifest of the content build.
MANIFEST_SCHEMA_VERSION = 2

COURSES_VARIABLE = "COURSES"
BUILD_DIR_VARIABLE = "COURSE_BUILD_DIR"

# Under uvicorn only its own loggers print INFO lines, so the load lines go to `uvicorn.error`.
# With another server it is a plain logger that propagates to the root logger.
logger = logging.getLogger("uvicorn.error")

_ID = re.compile(r"[a-z0-9-]+")
_MAX_SHOWN = 80


class CourseLoadError(Exception):
    """The courses cannot be loaded. The message says what is wrong and where."""


@dataclass(frozen=True)
class Lesson:
    id: str
    title: str
    order: int


@dataclass(frozen=True)
class Chapter:
    id: str
    title: str
    free_preview: bool
    has_code: bool
    lessons: tuple[Lesson, ...]

    def neighbours(self, lesson_id: str) -> tuple[str | None, str | None]:
        """The IDs of the lesson before and after this one in this chapter, None at either end."""
        ids = [lesson.id for lesson in self.lessons]
        position = ids.index(lesson_id)
        before = ids[position - 1] if position > 0 else None
        after = ids[position + 1] if position + 1 < len(ids) else None
        return before, after


@dataclass(frozen=True)
class Course:
    id: str
    title: str
    description: str
    chapters: tuple[Chapter, ...]

    @property
    def lesson_count(self) -> int:
        return sum(len(chapter.lessons) for chapter in self.chapters)

    def get_chapter(self, chapter_id: str) -> Chapter | None:
        """The chapter with this ID, else None. Reads nothing from disk."""
        return next((chapter for chapter in self.chapters if chapter.id == chapter_id), None)

    def find_lesson(self, lesson_id: str) -> tuple[Chapter, Lesson] | None:
        """The chapter and lesson with this lesson ID, else None. Reads nothing from disk."""
        for chapter in self.chapters:
            for lesson in chapter.lessons:
                if lesson.id == lesson_id:
                    return chapter, lesson
        return None


@dataclass(frozen=True)
class Catalog:
    """The configured courses, in the order of `COURSES`, and the build folder. Immutable.

    `build_dir` is where `app.content` reads lesson and quiz files from. A file path is built only
    from IDs that are in the catalog, never from a request string.
    """

    courses: tuple[Course, ...]
    build_dir: Path

    def __post_init__(self) -> None:
        by_id = MappingProxyType({course.id: course for course in self.courses})
        object.__setattr__(self, "_by_id", by_id)

    def get(self, course_id: str) -> Course | None:
        """The course with this ID if `COURSES` names it, else None. Reads nothing from disk."""
        return self._by_id.get(course_id)  # type: ignore[attr-defined]

    def __contains__(self, course_id: object) -> bool:
        return course_id in self._by_id  # type: ignore[attr-defined]


def get_catalog(request: Request) -> Catalog:
    """Dependency: the catalog the lifespan loaded."""
    catalog = getattr(request.app.state, "catalog", None)
    if catalog is None:
        raise RuntimeError("The course catalog is not loaded: the app lifespan did not run.")
    return catalog


# --- the manifest, as the content build writes it ---


class _ManifestLesson(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Annotated[StrictStr, Field(pattern=r"^[a-z0-9-]+$")]
    title: Annotated[StrictStr, Field(min_length=1)]
    order: StrictInt


class _ManifestChapter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Annotated[StrictStr, Field(pattern=r"^[a-z0-9-]+$")]
    title: Annotated[StrictStr, Field(min_length=1)]
    free_preview: StrictBool
    has_code: StrictBool
    lessons: Annotated[list[_ManifestLesson], Field(min_length=1)]


class _Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: StrictInt
    course_id: StrictStr
    title: Annotated[StrictStr, Field(min_length=1)]
    description: Annotated[StrictStr, Field(min_length=1)]
    chapters: Annotated[list[_ManifestChapter], Field(min_length=1)]


def _short(value: object) -> str:
    text = repr(value)
    return text if len(text) <= _MAX_SHOWN else text[: _MAX_SHOWN - 3] + "..."


def _field(loc: tuple[Any, ...]) -> str:
    text = ""
    for part in loc:
        text += f"[{part}]" if isinstance(part, int) else (f".{part}" if text else str(part))
    return text or "(top level)"


def parse_courses_setting(value: str | None) -> list[str]:
    """The course IDs in `COURSES`, trimmed and in order. Raises `CourseLoadError`."""
    if value is None or not value.strip():
        raise CourseLoadError(
            f"{COURSES_VARIABLE} is not set. Set it to the course IDs to serve, "
            f"separated by commas (for example {COURSES_VARIABLE}=mcp-server)."
        )
    ids = []
    for position, raw in enumerate(value.split(","), start=1):
        entry = raw.strip()
        if not entry:
            raise CourseLoadError(
                f"{COURSES_VARIABLE} has an empty entry (entry {position}); remove the extra comma."
            )
        if not _ID.fullmatch(entry):
            raise CourseLoadError(
                f"{COURSES_VARIABLE} entry {_short(entry)} is not a valid course ID "
                "(lowercase letters, digits, and hyphens only)."
            )
        if entry in ids:
            raise CourseLoadError(f"{COURSES_VARIABLE} lists the course {entry} more than once.")
        ids.append(entry)
    return ids


def _build_dir(value: str | None) -> Path:
    if value is None or not value.strip():
        raise CourseLoadError(
            f"{BUILD_DIR_VARIABLE} is not set. Set it to the folder the content build wrote."
        )
    path = Path(value)
    if not path.is_dir():
        raise CourseLoadError(f"{BUILD_DIR_VARIABLE} is not an existing folder: {value}")
    return path


def _relative(*parts: str) -> str:
    return "/".join(parts)


def _is_file(build_dir: Path, relative: str) -> bool:
    return (build_dir / relative).is_file()


def _read_manifest(build_dir: Path, course_id: str) -> _Manifest:
    relative = _relative("private", "courses", f"{course_id}.json")
    path = build_dir / relative
    if not path.is_file():
        raise CourseLoadError(
            f"No manifest for the course {course_id}: {relative} is not a file in "
            f"{BUILD_DIR_VARIABLE}."
        )
    try:
        document = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError, RecursionError) as error:
        reason = "cannot be read" if isinstance(error, OSError) else "is not valid UTF-8 JSON"
        raise CourseLoadError(f"{relative} {reason} (course {course_id}).") from None
    if not isinstance(document, dict):
        raise CourseLoadError(f"{relative}: the top level must be a JSON object.")
    if "schema_version" in document and document["schema_version"] != MANIFEST_SCHEMA_VERSION:
        raise CourseLoadError(
            f"{relative}: schema_version is {_short(document['schema_version'])}, "
            f"but this backend reads version {MANIFEST_SCHEMA_VERSION}."
        )
    try:
        return _Manifest.model_validate(document)
    except ValidationError as error:
        first = error.errors()[0]  # location and message only: never the input
        raise CourseLoadError(
            f"{relative}: field {_field(first['loc'])}: {first['msg']}."
        ) from None


def _check_manifest(manifest: _Manifest, course_id: str) -> None:
    relative = _relative("private", "courses", f"{course_id}.json")
    if manifest.course_id != course_id:
        raise CourseLoadError(
            f"{relative}: field course_id is {_short(manifest.course_id)}, but the file is for "
            f"the course {course_id} ({COURSES_VARIABLE} entry)."
        )
    chapter_ids: set[str] = set()
    lesson_ids: set[str] = set()
    for c, chapter in enumerate(manifest.chapters):
        if chapter.id in chapter_ids:
            raise CourseLoadError(
                f"{relative}: field chapters[{c}].id: the chapter ID {chapter.id} is used twice."
            )
        chapter_ids.add(chapter.id)
        for n, lesson in enumerate(chapter.lessons):
            if lesson.id in lesson_ids:
                raise CourseLoadError(
                    f"{relative}: field chapters[{c}].lessons[{n}].id: "
                    f"the lesson ID {lesson.id} is used twice."
                )
            lesson_ids.add(lesson.id)


def _check_files(build_dir: Path, manifest: _Manifest) -> None:
    course_id = manifest.course_id
    for chapter in manifest.chapters:
        needed = [
            _relative("private", "lessons", course_id, f"{lesson.id}.json")
            for lesson in chapter.lessons
        ]
        needed.append(_relative("private", "quizzes", course_id, f"{chapter.id}.json"))
        if chapter.has_code:
            needed.append(_relative("private", "code", course_id, f"{chapter.id}.json"))
        for relative in needed:
            if not _is_file(build_dir, relative):
                raise CourseLoadError(
                    f"The course {course_id} needs {relative}, which is not a file in "
                    f"{BUILD_DIR_VARIABLE}."
                )


def _course_from(manifest: _Manifest) -> Course:
    return Course(
        id=manifest.course_id,
        title=manifest.title,
        description=manifest.description,
        chapters=tuple(
            Chapter(
                id=chapter.id,
                title=chapter.title,
                free_preview=chapter.free_preview,
                has_code=chapter.has_code,
                lessons=tuple(
                    Lesson(id=lesson.id, title=lesson.title, order=lesson.order)
                    for lesson in chapter.lessons
                ),
            )
            for chapter in manifest.chapters
        ),
    )


def load_catalog(courses: str | None, build_dir: str | None) -> Catalog:
    """Load the courses named in `courses` (the value of `COURSES`) from `build_dir`."""
    course_ids = parse_courses_setting(courses)
    root = _build_dir(build_dir)
    loaded = []
    for course_id in course_ids:
        manifest = _read_manifest(root, course_id)
        _check_manifest(manifest, course_id)
        _check_files(root, manifest)
        course = _course_from(manifest)
        logger.info(
            "loaded course %s: %d chapters, %d lessons",
            course.id,
            len(course.chapters),
            course.lesson_count,
        )
        loaded.append(course)
    return Catalog(tuple(loaded), root)


def load_catalog_from_environment() -> Catalog:
    return load_catalog(os.environ.get(COURSES_VARIABLE), os.environ.get(BUILD_DIR_VARIABLE))
