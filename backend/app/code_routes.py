"""Code step routes: a chapter's code steps, and its final project as a ZIP.

Both routes are read-only `GET`s that follow the content-access rule of the chapter's lessons
(`app.access.require_content_access`): a `free_preview` chapter is readable by anyone, and any
other chapter needs a signed-in learner whose chapter is `in_progress` or `passed`. They serve what
the content build wrote (`app.code_steps`) and compute no diff and build no ZIP.

Order of checks: the course (404), the chapter (404), access (401 or 403), `has_code` (404
`code_not_found`), then the files (a fault is a 500). Access comes before `code_not_found` on
purpose: `has_code` is in no response, so answering `code_not_found` first would tell a visitor
which locked chapters have code.

Both answers are `private, no-store`: the right to read them depends on who is signed in, so no
shared cache may hand a locked chapter's code to someone else. The ZIP is returned as a plain
`Response` of the bytes that were read and checked, so `Range` and `If-Range` are ignored and the
answer is always 200 with the whole file.
"""

from typing import Annotated

from fastapi import Depends, FastAPI, Response
from pydantic import BaseModel, ConfigDict
from starlette.convertors import Convertor, register_url_convertor

from app.access import require_content_access
from app.code_steps import CodeFileStatus, read_code, read_code_zip
from app.content_routes import CHAPTER_NOT_FOUND_MESSAGE
from app.course_routes import CACHE_HEADER, COURSE_NOT_FOUND_MESSAGE, PRIVATE_NO_STORE
from app.courses import Catalog, Chapter, Course, get_catalog
from app.errors import ApiError, ErrorResponse
from app.sessions import SignedIn, optional_learner

CODE_NOT_FOUND_MESSAGE = "This chapter has no code."
ZIP_MEDIA_TYPE = "application/zip"


class _AnySegmentConvertor(Convertor[str]):
    """One path segment, empty included.

    Starlette's default segment pattern needs at least one character, so `/chapters//code` would
    get the router's generic `not_found`. This pattern takes the empty string (and a `/`, or a
    newline, which the default pattern would also refuse) as the chapter ID, which is then a miss
    in the catalog like any other odd ID: 404 `chapter_not_found`.
    """

    regex = r"[\s\S]*"

    def convert(self, value: str) -> str:
        return value

    def to_string(self, value: str) -> str:
        return value


register_url_convertor("code_chapter_id", _AnySegmentConvertor())


class CodeZip(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str
    file_name: str
    size: int


class CodeFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    status: CodeFileStatus
    content: str
    changed_lines: list[int]


class CodeStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step: int
    files: list[CodeFile]


class ChapterCodeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    chapter_id: str
    zip: CodeZip
    steps: list[CodeStep]


def zip_url(course: Course, chapter: Chapter) -> str:
    """The route of the chapter's ZIP. Both IDs match `[a-z0-9-]+`, so nothing needs encoding."""
    return f"/api/courses/{course.id}/chapters/{chapter.id}/code.zip"


def zip_file_name(chapter: Chapter) -> str:
    """The name the browser saves the ZIP as: the chapter ID, which is also the ZIP's folder."""
    return f"{chapter.id}.zip"


def resolve_code_chapter(
    catalog: Catalog, course_id: str, chapter_id: str, signed_in: SignedIn | None
) -> tuple[Course, Chapter]:
    """The course and chapter for these request strings, if the caller may read their code.

    Raises the 404s, 401, or 403 in the documented order. Nothing is read from disk.
    """
    course = catalog.get(course_id)
    if course is None:
        raise ApiError(404, "course_not_found", COURSE_NOT_FOUND_MESSAGE)
    chapter = course.get_chapter(chapter_id)
    if chapter is None:
        raise ApiError(404, "chapter_not_found", CHAPTER_NOT_FOUND_MESSAGE)
    require_content_access(course, chapter, signed_in)
    if not chapter.has_code:
        raise ApiError(404, "code_not_found", CODE_NOT_FOUND_MESSAGE)
    return course, chapter


def get_chapter_code(
    course_id: str,
    chapter_id: str,
    response: Response,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    signed_in: Annotated[SignedIn | None, Depends(optional_learner)],
) -> ChapterCodeResponse:
    course, chapter = resolve_code_chapter(catalog, course_id, chapter_id, signed_in)
    code = read_code(catalog, course, chapter)
    response.headers["cache-control"] = PRIVATE_NO_STORE
    return ChapterCodeResponse(
        course_id=course.id,
        chapter_id=chapter.id,
        zip=CodeZip(
            url=zip_url(course, chapter), file_name=zip_file_name(chapter), size=code.zip.size
        ),
        steps=[
            CodeStep(
                step=step.step,
                files=[
                    CodeFile(
                        path=file.path,
                        status=file.status,
                        content=file.content,
                        changed_lines=file.changed_lines,
                    )
                    for file in step.files
                ],
            )
            for step in code.steps
        ],
    )


def get_chapter_code_zip(
    course_id: str,
    chapter_id: str,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    signed_in: Annotated[SignedIn | None, Depends(optional_learner)],
) -> Response:
    course, chapter = resolve_code_chapter(catalog, course_id, chapter_id, signed_in)
    data = read_code_zip(catalog, course, chapter)
    return Response(
        content=data,
        media_type=ZIP_MEDIA_TYPE,
        headers={
            "content-disposition": f'attachment; filename="{zip_file_name(chapter)}"',
            "x-content-type-options": "nosniff",
            "cache-control": PRIVATE_NO_STORE,
        },
    )


def _header(description: str) -> dict[str, object]:
    return {"description": description, "schema": {"type": "string"}}


_ZIP_HEADERS = {
    "Content-Disposition": _header(
        'Always `attachment; filename="<chapter_id>.zip"`. The name is the chapter ID from the '
        "catalog, which is also the ZIP's top-level folder."
    ),
    "Cache-Control": CACHE_HEADER,
    "X-Content-Type-Options": _header("Always `nosniff`."),
}


def install_code_routes(app: FastAPI) -> None:
    """Add the code steps route and the ZIP route to `app`."""
    app.add_api_route(
        "/api/courses/{course_id}/chapters/{chapter_id:code_chapter_id}/code",
        get_chapter_code,
        methods=["GET"],
        tags=["courses"],
        operation_id="getChapterCode",
        responses={
            200: {"headers": {"Cache-Control": CACHE_HEADER}},
            401: {"model": ErrorResponse},
            403: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
        },
        # The cookie is optional: a visitor reads the code of a `free_preview` chapter.
        openapi_extra={"security": [{"SessionCookie": []}, {}]},
        summary="A chapter's code steps (every file of every step), for anyone in a free preview "
        "chapter and else for a learner whose chapter is unlocked",
    )
    app.add_api_route(
        "/api/courses/{course_id}/chapters/{chapter_id:code_chapter_id}/code.zip",
        get_chapter_code_zip,
        methods=["GET"],
        response_class=Response,
        tags=["courses"],
        operation_id="getChapterCodeZip",
        responses={
            200: {
                "description": "The final project of the chapter, exactly as the content build "
                "wrote it.",
                "content": {ZIP_MEDIA_TYPE: {"schema": {"type": "string", "format": "binary"}}},
                "headers": _ZIP_HEADERS,
            },
            401: {"model": ErrorResponse},
            403: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
        },
        openapi_extra={"security": [{"SessionCookie": []}, {}]},
        summary="A chapter's final project as a ZIP, with the same access rule as the code steps",
    )
