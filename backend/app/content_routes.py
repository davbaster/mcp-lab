"""Lesson and quiz routes, and the route that saves the last lesson a learner visited.

The lesson `GET` is open to a visitor where the content-access rule allows it; the quiz `GET` and
the last-lesson `PUT` need a login. The rules are in `app.access`, the files are read by
`app.content`. A `GET` writes nothing: the `PUT` is the only writer, and it writes only
`last_lesson_id`, so it never touches a score or a pass (#16 writes those into the same row).

The response models list their fields one by one with `extra="forbid"`. The quiz models have no
field for `correct`, `explanation`, or the lesson link, so an answer key cannot reach a client
even by a mistake in the route.
"""

import secrets
from collections.abc import Callable
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request, Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StrictStr
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.access import require_content_access, require_quiz_access
from app.content import read_lesson_tree, read_quiz
from app.course_routes import CACHE_HEADER, COURSE_NOT_FOUND_MESSAGE, PRIVATE_NO_STORE
from app.courses import Catalog, get_catalog
from app.db_session import get_db_session, hide_database_details
from app.errors import ApiError, ErrorResponse
from app.models import ChapterProgress
from app.sessions import Learner, SignedIn, current_learner, optional_learner

LESSON_NOT_FOUND_MESSAGE = "Lesson not found."
CHAPTER_NOT_FOUND_MESSAGE = "Chapter not found."

# An options shuffle must come from the operating system's random source (`secrets`), not from the
# module-level `random` generator, which is not cryptographically secure.
_RANDOM = secrets.SystemRandom()

Shuffle = Callable[[list[Any]], None]


def get_shuffle() -> Shuffle:
    """Dependency: shuffle a list in place. Tests replace it with a deterministic function."""
    return _RANDOM.shuffle


class LessonResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    chapter_id: str
    lesson_id: str
    title: str
    prev_lesson_id: str | None
    next_lesson_id: str | None
    # The compiled lesson tree, unchanged. Its shape is the contract in
    # content-build/schemas/lesson-tree.schema.json; the backend does not re-validate it.
    tree: dict[str, Any]


class QuizSnippet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: str
    code: str


class QuizOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    text: str


class QuizQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    text: str
    snippet: QuizSnippet | None
    options: list[QuizOption]


class QuizResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    chapter_id: str
    questions: list[QuizQuestion]


class LastLessonRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lesson_id: Annotated[StrictStr, Field(min_length=1, max_length=100)]


def get_lesson(
    course_id: str,
    lesson_id: str,
    response: Response,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    signed_in: Annotated[SignedIn | None, Depends(optional_learner)],
) -> LessonResponse:
    # The course and the lesson come first, so a visitor asking for an unknown lesson gets a 404:
    # lesson IDs are public (the chapter list shows them).
    course = catalog.get(course_id)
    if course is None:
        raise ApiError(404, "course_not_found", COURSE_NOT_FOUND_MESSAGE)
    found = course.find_lesson(lesson_id)
    if found is None:
        raise ApiError(404, "lesson_not_found", LESSON_NOT_FOUND_MESSAGE)
    chapter, lesson = found
    require_content_access(course, chapter, signed_in)
    tree = read_lesson_tree(catalog, course, chapter, lesson)
    before, after = chapter.neighbours(lesson.id)
    response.headers["cache-control"] = PRIVATE_NO_STORE
    return LessonResponse(
        course_id=course.id,
        chapter_id=chapter.id,
        lesson_id=lesson.id,
        title=lesson.title,
        prev_lesson_id=before,
        next_lesson_id=after,
        tree=tree,
    )


def get_quiz(
    course_id: str,
    chapter_id: str,
    response: Response,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    learner: Annotated[Learner, Depends(current_learner)],
    db: Annotated[Session, Depends(get_db_session)],
    shuffle: Annotated[Shuffle, Depends(get_shuffle)],
) -> QuizResponse:
    # The login check ran first (a dependency), so a visitor gets 401 whatever else is wrong.
    course = catalog.get(course_id)
    if course is None:
        raise ApiError(404, "course_not_found", COURSE_NOT_FOUND_MESSAGE)
    chapter = course.get_chapter(chapter_id)
    if chapter is None:
        raise ApiError(404, "chapter_not_found", CHAPTER_NOT_FOUND_MESSAGE)
    require_quiz_access(course, chapter, SignedIn(learner=learner, db=db))
    questions = []
    for question in read_quiz(catalog, course, chapter):
        options = [QuizOption(id=option.id, text=option.text) for option in question.options]
        shuffle(options)  # each question on its own, on every request
        snippet = question.snippet
        questions.append(
            QuizQuestion(
                id=question.id,
                text=question.text,
                snippet=None
                if snippet is None
                else QuizSnippet(language=snippet.language, code=snippet.code),
                options=options,
            )
        )
    response.headers["cache-control"] = PRIVATE_NO_STORE
    return QuizResponse(course_id=course.id, chapter_id=chapter.id, questions=questions)


def save_last_lesson(
    course_id: str,
    body: LastLessonRequest,
    response: Response,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    learner: Annotated[Learner, Depends(current_learner)],
    db: Annotated[Session, Depends(get_db_session)],
) -> None:
    course = catalog.get(course_id)
    if course is None:
        raise ApiError(404, "course_not_found", COURSE_NOT_FOUND_MESSAGE)
    found = course.find_lesson(body.lesson_id)
    if found is None:
        raise ApiError(404, "lesson_not_found", LESSON_NOT_FOUND_MESSAGE)
    chapter, lesson = found
    require_content_access(course, chapter, SignedIn(learner=learner, db=db))
    # The chapter and lesson IDs come from the catalog, never from the client. One statement, and
    # it sets only `last_lesson_id`: a score or a pass in the same row is left as it is.
    statement = insert(ChapterProgress).values(
        account_id=learner.account_id,
        course_id=course.id,
        chapter_id=chapter.id,
        last_lesson_id=lesson.id,
    )
    statement = statement.on_conflict_do_update(
        index_elements=["account_id", "course_id", "chapter_id"],
        set_={"last_lesson_id": statement.excluded.last_lesson_id},
    )
    with hide_database_details():
        db.execute(statement)
        db.commit()
    response.headers["cache-control"] = PRIVATE_NO_STORE


class _TolerantJsonRequest(Request):
    """A request whose body that is not JSON reads as an empty list instead of raising.

    FastAPI decodes the body before it runs any dependency, so a body that is not JSON would get
    its 422 before the login check. This hands the body on as something the model rejects, and the
    422 comes after the login check, like every other body error.
    """

    async def json(self) -> Any:
        try:
            return await super().json()
        except (ValueError, RecursionError):  # also an invalid UTF-8 body
            return []


class LoginFirstRoute(APIRoute):
    """A route that checks the login before it complains about the body."""

    def get_route_handler(self) -> Callable[[Request], Any]:
        handler = super().get_route_handler()

        async def app(request: Request) -> Response:
            return await handler(_TolerantJsonRequest(request.scope, request.receive))

        return app


def install_content_routes(app: FastAPI) -> None:
    """Add the lesson, last-lesson, and quiz routes to `app`."""
    app.add_api_route(
        "/api/courses/{course_id}/lessons/{lesson_id}",
        get_lesson,
        methods=["GET"],
        tags=["courses"],
        operation_id="getLesson",
        responses={
            200: {"headers": {"Cache-Control": CACHE_HEADER}},
            401: {"model": ErrorResponse},
            403: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
        },
        # The cookie is optional: a visitor reads a lesson of a `free_preview` chapter.
        openapi_extra={"security": [{"SessionCookie": []}, {}]},
        summary="A lesson's compiled tree, for anyone in a free preview chapter and else for a "
        "learner whose chapter is unlocked",
    )
    app.router.add_api_route(
        "/api/courses/{course_id}/progress/last-lesson",
        save_last_lesson,
        methods=["PUT"],
        status_code=204,
        tags=["courses"],
        operation_id="saveLastLesson",
        route_class_override=LoginFirstRoute,
        responses={
            204: {"headers": {"Cache-Control": CACHE_HEADER}},
            401: {"model": ErrorResponse},
            403: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
        },
        summary="Save the last lesson the signed-in learner visited, in the lesson's chapter",
    )
    app.add_api_route(
        "/api/courses/{course_id}/chapters/{chapter_id}/quiz",
        get_quiz,
        methods=["GET"],
        tags=["courses"],
        operation_id="getQuiz",
        responses={
            200: {"headers": {"Cache-Control": CACHE_HEADER}},
            401: {"model": ErrorResponse},
            403: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
        },
        summary="A chapter's quiz questions, without answers, for a learner whose chapter is "
        "unlocked",
    )
