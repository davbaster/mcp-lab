"""Course routes: the course list, a course's chapter list, and a learner's progress in a course.

The course list and the chapter list are public and read the in-memory catalog; the chapter list
adds each chapter's status for a signed-in learner (one query), and `null` for a visitor, who
costs no database connection. The progress route needs a login. The response models list their
fields one by one, so a field added to the manifest later does not reach the client by accident.
"""

from typing import Annotated

from fastapi import Depends, FastAPI, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.courses import Catalog, get_catalog
from app.db_session import get_db_session
from app.errors import ApiError, ErrorResponse
from app.progress import ChapterStatus, ProgressRow, load_progress, statuses_for
from app.sessions import Learner, SignedIn, current_learner, optional_learner

COURSE_NOT_FOUND_MESSAGE = "Course not found."
PRIVATE_NO_STORE = "private, no-store"


class CourseSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    description: str
    chapter_count: int


class CoursesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courses: list[CourseSummary]


class LessonSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str


class ChapterSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    free_preview: bool
    lessons: list[LessonSummary]
    status: ChapterStatus | None


class CourseChaptersResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    chapters: list[ChapterSummary]


class ChapterProgressSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    status: ChapterStatus
    best_score: int | None
    last_lesson_id: str | None


class CourseProgressResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    course_complete: bool
    chapters: list[ChapterProgressSummary]


def list_courses(catalog: Annotated[Catalog, Depends(get_catalog)]) -> CoursesResponse:
    return CoursesResponse(
        courses=[
            CourseSummary(
                id=course.id,
                title=course.title,
                description=course.description,
                chapter_count=len(course.chapters),
            )
            for course in catalog.courses
        ]
    )


def list_chapters(
    course_id: str,
    response: Response,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    signed_in: Annotated[SignedIn | None, Depends(optional_learner)],
) -> CourseChaptersResponse:
    course = catalog.get(course_id)
    if course is None:
        raise ApiError(404, "course_not_found", COURSE_NOT_FOUND_MESSAGE)
    statuses: list[ChapterStatus | None] = [None] * len(course.chapters)
    if signed_in is not None:
        progress = load_progress(signed_in.db, signed_in.learner.account_id, course.id)
        statuses = list(statuses_for([chapter.id for chapter in course.chapters], progress))
    response.headers["cache-control"] = PRIVATE_NO_STORE
    return CourseChaptersResponse(
        course_id=course.id,
        chapters=[
            ChapterSummary(
                id=chapter.id,
                title=chapter.title,
                free_preview=chapter.free_preview,
                lessons=[
                    LessonSummary(id=lesson.id, title=lesson.title) for lesson in chapter.lessons
                ],
                status=status,
            )
            for chapter, status in zip(course.chapters, statuses, strict=True)
        ],
    )


def get_progress(
    course_id: str,
    response: Response,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    learner: Annotated[Learner, Depends(current_learner)],
    db: Annotated[Session, Depends(get_db_session)],
) -> CourseProgressResponse:
    # The login check ran first (a dependency), so a visitor asking for any course gets 401.
    course = catalog.get(course_id)
    if course is None:
        raise ApiError(404, "course_not_found", COURSE_NOT_FOUND_MESSAGE)
    progress = load_progress(db, learner.account_id, course.id)
    statuses = statuses_for([chapter.id for chapter in course.chapters], progress)
    empty = ProgressRow(best_score=None, passed=False, last_lesson_id=None)
    response.headers["cache-control"] = PRIVATE_NO_STORE
    return CourseProgressResponse(
        course_id=course.id,
        course_complete=all(status is ChapterStatus.PASSED for status in statuses),
        chapters=[
            ChapterProgressSummary(
                id=chapter.id,
                status=status,
                best_score=progress.get(chapter.id, empty).best_score,
                last_lesson_id=progress.get(chapter.id, empty).last_lesson_id,
            )
            for chapter, status in zip(course.chapters, statuses, strict=True)
        ],
    )


_CACHE_HEADER = {
    "description": (
        "Always `private, no-store`: the response can depend on who is signed in, so no shared "
        "cache may keep it."
    ),
    "schema": {"type": "string"},
}


def install_course_routes(app: FastAPI) -> None:
    """Add the three routes to `app` (one by one, like the auth routes)."""
    app.add_api_route(
        "/api/courses",
        list_courses,
        methods=["GET"],
        tags=["courses"],
        operation_id="listCourses",
        summary="List the courses",
    )
    app.add_api_route(
        "/api/courses/{course_id}/chapters",
        list_chapters,
        methods=["GET"],
        tags=["courses"],
        operation_id="listChapters",
        responses={
            200: {"headers": {"Cache-Control": _CACHE_HEADER}},
            404: {"model": ErrorResponse},
        },
        # The cookie is optional: a visitor gets `status: null`, a signed-in learner gets statuses.
        openapi_extra={"security": [{"SessionCookie": []}, {}]},
        summary="List the chapters of a course, with their lessons and (when signed in) status",
    )
    app.add_api_route(
        "/api/courses/{course_id}/progress",
        get_progress,
        methods=["GET"],
        tags=["courses"],
        operation_id="getProgress",
        responses={
            200: {"headers": {"Cache-Control": _CACHE_HEADER}},
            401: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
        },
        summary="The signed-in learner's status and best score in each chapter of a course",
    )
