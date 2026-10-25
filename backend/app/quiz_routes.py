"""The route that grades a quiz attempt (#16): POST .../chapters/{chapter_id}/quiz/attempts.

The order of checks: login (a dependency), body shape (FastAPI), course, chapter, quiz access
(`require_quiz_access`), then the quiz contents. So a learner on a locked chapter learns nothing
about the quiz, not even whether it has a question with some ID.

**What a response may hold.** A failed attempt (score 0 to 3) returns the score and the wrong
questions with their lesson links, and nothing else: no option ID of the learner, no correct
option, no explanation. It is a function of the set of wrong questions only. A passed attempt
(4 or 5) returns every question's correct option and explanation. These two models are the only
place an answer or an explanation leaves the server, and the failed model has no field for either.
"""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Response
from pydantic import BaseModel, ConfigDict, Field, StrictStr
from sqlalchemy.orm import Session

from app.access import require_quiz_access
from app.clock import current_time
from app.content_routes import CHAPTER_NOT_FOUND_MESSAGE, LoginFirstRoute
from app.course_routes import CACHE_HEADER, COURSE_NOT_FOUND_MESSAGE, PRIVATE_NO_STORE
from app.courses import Catalog, get_catalog
from app.db_session import get_db_session, hide_database_details
from app.errors import ApiError, ErrorResponse
from app.progress import ChapterStatus, load_progress, statuses_for
from app.quiz_attempts import log_attempt, record_attempt
from app.quiz_grading import AnswerError, Grade, grade, match_answers
from app.quiz_key import read_quiz_key
from app.sessions import Learner, SignedIn, current_learner

MAX_ANSWERS = 50  # far above the 5 of a quiz: a bound on the body, not a rule of the quiz
MAX_ID_LENGTH = 100


class AnswerItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_id: Annotated[StrictStr, Field(min_length=1, max_length=MAX_ID_LENGTH)]
    option_id: Annotated[StrictStr, Field(min_length=1, max_length=MAX_ID_LENGTH)]


class AttemptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answers: Annotated[list[AnswerItem], Field(max_length=MAX_ANSWERS)]


class WrongQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_id: str
    lesson_id: str


class FailedAttemptResponse(BaseModel):
    """A failed attempt. Nothing here points at a right option."""

    model_config = ConfigDict(extra="forbid")

    course_id: str
    chapter_id: str
    score: Annotated[int, Field(ge=0, le=5)]
    total: int
    passed: Literal[False]
    wrong: list[WrongQuestion]


class QuestionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_id: str
    option_id: str
    correct_option_id: str
    is_correct: bool
    explanation: str
    lesson_id: str


class PassedAttemptResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    chapter_id: str
    score: Annotated[int, Field(ge=0, le=5)]
    total: int
    passed: Literal[True]
    results: list[QuestionResult]
    next_chapter_id: str | None
    course_complete: bool


# A plain union, not `Field(discriminator="passed")`: that makes the spec carry an OpenAPI
# `discriminator`, whose values must be strings, and `passed` is a boolean. The two models cannot
# both match one body (`passed` is `Literal[False]` in one and `Literal[True]` in the other, and
# both forbid extra keys), and a TypeScript client narrows on `passed` all the same.
AttemptResponse = FailedAttemptResponse | PassedAttemptResponse


def failed_response(course_id: str, chapter_id: str, result: Grade) -> FailedAttemptResponse:
    return FailedAttemptResponse(
        course_id=course_id,
        chapter_id=chapter_id,
        score=result.score,
        total=result.total,
        passed=False,
        wrong=[
            WrongQuestion(question_id=wrong.question_id, lesson_id=wrong.lesson_id)
            for wrong in result.wrong
        ],
    )


def passed_response(
    course_id: str,
    chapter_id: str,
    result: Grade,
    next_chapter_id: str | None,
    course_complete: bool,
) -> PassedAttemptResponse:
    return PassedAttemptResponse(
        course_id=course_id,
        chapter_id=chapter_id,
        score=result.score,
        total=result.total,
        passed=True,
        results=[
            QuestionResult(
                question_id=item.question_id,
                option_id=item.option_id,
                correct_option_id=item.correct_option_id,
                is_correct=item.is_correct,
                explanation=item.explanation,
                lesson_id=item.lesson_id,
            )
            for item in result.results
        ],
        next_chapter_id=next_chapter_id,
        course_complete=course_complete,
    )


def submit_quiz_attempt(
    course_id: str,
    chapter_id: str,
    body: AttemptRequest,
    response: Response,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    learner: Annotated[Learner, Depends(current_learner)],
    db: Annotated[Session, Depends(get_db_session)],
    now: Annotated[datetime, Depends(current_time)],
) -> AttemptResponse:
    # The login check ran first (a dependency), and FastAPI checked the body's shape.
    course = catalog.get(course_id)
    if course is None:
        raise ApiError(404, "course_not_found", COURSE_NOT_FOUND_MESSAGE)
    chapter = course.get_chapter(chapter_id)
    if chapter is None:
        raise ApiError(404, "chapter_not_found", CHAPTER_NOT_FOUND_MESSAGE)
    require_quiz_access(course, chapter, SignedIn(learner=learner, db=db))
    questions = read_quiz_key(catalog, course, chapter)
    try:
        chosen = match_answers(questions, [(a.question_id, a.option_id) for a in body.answers])
    except AnswerError as error:
        raise ApiError(422, "validation_error", str(error)) from None
    result = grade(questions, chosen)
    # The IDs written and returned come from the catalog and the key file, never from the client.
    with hide_database_details():
        record_attempt(
            db,
            account_id=learner.account_id,
            course_id=course.id,
            chapter_id=chapter.id,
            score=result.score,
            passed=result.passed,
            answers=chosen,
            now=now,
        )
        # Read inside the same transaction, after the upsert, so this response and the next
        # `GET .../progress` agree.
        progress = load_progress(db, learner.account_id, course.id)
        db.commit()
    log_attempt(
        course_id=course.id,
        chapter_id=chapter.id,
        score=result.score,
        total=result.total,
        passed=result.passed,
    )
    response.headers["cache-control"] = PRIVATE_NO_STORE
    if not result.passed:
        return failed_response(course.id, chapter.id, result)
    statuses = statuses_for([c.id for c in course.chapters], progress)
    position = course.chapters.index(chapter)
    following = course.chapters[position + 1 :][:1]
    return passed_response(
        course.id,
        chapter.id,
        result,
        next_chapter_id=following[0].id if following else None,
        course_complete=all(status is ChapterStatus.PASSED for status in statuses),
    )


def install_quiz_routes(app: FastAPI) -> None:
    """Add the attempt route to `app`."""
    app.router.add_api_route(
        "/api/courses/{course_id}/chapters/{chapter_id}/quiz/attempts",
        submit_quiz_attempt,
        methods=["POST"],
        tags=["courses"],
        operation_id="submitQuizAttempt",
        route_class_override=LoginFirstRoute,
        responses={
            200: {"headers": {"Cache-Control": CACHE_HEADER}},
            401: {"model": ErrorResponse},
            403: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
        },
        summary="Grade a quiz attempt of the signed-in learner and save it; the correct answers "
        "come back only when the attempt passes",
    )
