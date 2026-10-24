"""Public, read-only course routes: the course list and a course's chapter list.

Both read only the in-memory catalog. The response models list their fields one by one, so a
field added to the manifest later does not reach the client by accident.
"""

from typing import Annotated

from fastapi import Depends, FastAPI
from pydantic import BaseModel, ConfigDict

from app.courses import Catalog, get_catalog
from app.errors import ApiError, ErrorResponse

COURSE_NOT_FOUND_MESSAGE = "Course not found."


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


class CourseChaptersResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    chapters: list[ChapterSummary]


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
    course_id: str, catalog: Annotated[Catalog, Depends(get_catalog)]
) -> CourseChaptersResponse:
    course = catalog.get(course_id)
    if course is None:
        raise ApiError(404, "course_not_found", COURSE_NOT_FOUND_MESSAGE)
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
            )
            for chapter in course.chapters
        ],
    )


def install_course_routes(app: FastAPI) -> None:
    """Add the two routes to `app` (one by one, like the auth routes)."""
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
        responses={404: {"model": ErrorResponse}},
        summary="List the chapters of a course, with their lessons",
    )
