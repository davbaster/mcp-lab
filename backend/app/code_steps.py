"""Read a chapter's code steps and ZIP from the content build, one request at a time.

The files are `private/code/<course_id>/<chapter_id>.json` and
`private/code/<course_id>/<chapter_id>-<first 16 hex digits of the sha256>.zip` in the build folder
(the format is in `content-build/README.md`, "Code steps"). The backend computes no diff and builds
no ZIP: it reads what the content build wrote.

Nothing in a request string reaches the file system. The JSON path is built from the course and
chapter IDs of the catalog. The ZIP path is built from the same two IDs and the `zip.sha256` of the
JSON, which must be 64 lower-case hex digits, and the JSON's `zip.file` must equal that exact name,
so a changed `zip.file` cannot point anywhere else. Nothing is cached: the files are read on every
request, and the ZIP is checked against the size and SHA-256 of its JSON each time.

A file that is missing, is not valid JSON, has the wrong shape, or disagrees with the catalog or
with the ZIP raises `BuildFileError`. That is a server fault, and the shared handler turns it into
a 500. The message names the course and chapter IDs and the field location, and never any content
of a file (`app.content.validate_model` keeps Pydantic's error text, which can hold the input, out
of it).
"""

import hashlib
from enum import StrEnum
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from app.content import BuildFileError, check_ids, read_json, validate_model
from app.courses import Catalog, Chapter, Course

SHA256_PATTERN = r"^[0-9a-f]{64}$"


class CodeFileStatus(StrEnum):
    ADDED = "added"
    MODIFIED = "modified"
    DELETED = "deleted"
    UNCHANGED = "unchanged"


class CodeFileData(BaseModel):
    """A file of a step. Keys other than these four are dropped when the file is parsed."""

    model_config = ConfigDict(extra="ignore")

    path: Annotated[StrictStr, Field(min_length=1)]
    status: CodeFileStatus
    content: StrictStr
    changed_lines: list[Annotated[StrictInt, Field(gt=0)]]


class CodeStepData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    step: StrictInt
    files: Annotated[list[CodeFileData], Field(min_length=1)]


class CodeZipData(BaseModel):
    """The ZIP's name, hash, and size. The hash and the on-disk name never leave the backend."""

    model_config = ConfigDict(extra="ignore")

    file: StrictStr
    sha256: Annotated[StrictStr, Field(pattern=SHA256_PATTERN)]
    size: Annotated[StrictInt, Field(ge=0)]


class ChapterCodeData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    course_id: StrictStr
    chapter_id: StrictStr
    zip: CodeZipData
    steps: Annotated[list[CodeStepData], Field(min_length=1)]


def _code_dir(catalog: Catalog, course: Course) -> Path:
    return catalog.build_dir / "private" / "code" / course.id


def zip_file_name(chapter: Chapter, sha256: str) -> str:
    """The name the content build gives the ZIP: the chapter ID and the first 16 hex digits."""
    return f"{chapter.id}-{sha256[:16]}.zip"


def read_code(catalog: Catalog, course: Course, chapter: Chapter) -> ChapterCodeData:
    """The steps of a chapter and its ZIP's name, hash, and size, checked against the catalog."""
    what = f"Code file (course {course.id}, chapter {chapter.id})"
    path = _code_dir(catalog, course) / f"{chapter.id}.json"
    document = validate_model(ChapterCodeData, read_json(path, what), what)
    check_ids(
        what,
        course_id=(document.course_id, course.id),
        chapter_id=(document.chapter_id, chapter.id),
    )
    for position, step in enumerate(document.steps, start=1):
        if step.step != position:
            raise BuildFileError(
                f"{what}: field steps[{position - 1}].step is not {position} "
                "(steps must be numbered 1, 2, 3, ... in order)."
            )
    if document.zip.file != zip_file_name(chapter, document.zip.sha256):
        raise BuildFileError(f"{what}: field zip.file does not match the catalog.")
    return document


def read_code_zip(catalog: Catalog, course: Course, chapter: Chapter) -> bytes:
    """The bytes of a chapter's ZIP, after checking their size and SHA-256 against the JSON."""
    what = f"Code ZIP (course {course.id}, chapter {chapter.id})"
    zip_info = read_code(catalog, course, chapter).zip
    path = _code_dir(catalog, course) / zip_info.file  # equal to the expected name: see read_code
    try:
        data = path.read_bytes()
    except OSError:
        raise BuildFileError(f"{what}: the file is missing or cannot be read.") from None
    if len(data) != zip_info.size:
        raise BuildFileError(f"{what}: the file size does not match the code file.")
    if hashlib.sha256(data).hexdigest() != zip_info.sha256:
        raise BuildFileError(f"{what}: the file hash does not match the code file.")
    return data
