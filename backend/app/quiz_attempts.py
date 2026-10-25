"""Save a graded quiz attempt: one `quiz_attempts` row and one `chapter_progress` upsert.

`record_attempt` is the one place an attempt is written, so it is the place the metrics and the
JSON log of #36 hook in (with `log_attempt`, which the route calls after the commit). It runs both
statements on the caller's session and does not commit: the route commits after it has also read
the new progress, so either everything is saved or nothing is.

The progress upsert is one statement, so concurrent attempts for one chapter cannot lose a score
or raise a duplicate-key error: `best_score` becomes the higher of the stored and the new score
(`GREATEST` ignores a NULL that the last-lesson `PUT` left), and `passed_at` keeps the first pass
time (`COALESCE`). It never sets `last_lesson_id`, and it never lowers a score or removes a pass.
"""

import logging
import uuid
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.metrics import record_quiz_submission
from app.models import ChapterProgress, QuizAttempt

# Under uvicorn only its own loggers print INFO lines (see app.courses).
logger = logging.getLogger("uvicorn.error")


def insert_attempt(
    db: Session,
    *,
    account_id: uuid.UUID,
    course_id: str,
    chapter_id: str,
    score: int,
    passed: bool,
    answers: dict[str, str],
    now: datetime,
) -> None:
    db.add(
        QuizAttempt(
            id=uuid.uuid4(),
            account_id=account_id,
            course_id=course_id,
            chapter_id=chapter_id,
            score=score,
            passed=passed,
            answers=answers,
            created_at=now,
        )
    )
    db.flush()


def upsert_progress(
    db: Session,
    *,
    account_id: uuid.UUID,
    course_id: str,
    chapter_id: str,
    score: int,
    passed: bool,
    now: datetime,
) -> None:
    statement = insert(ChapterProgress).values(
        account_id=account_id,
        course_id=course_id,
        chapter_id=chapter_id,
        best_score=score,
        passed_at=now if passed else None,
    )
    table = ChapterProgress.__table__
    statement = statement.on_conflict_do_update(
        index_elements=["account_id", "course_id", "chapter_id"],
        set_={
            "best_score": func.greatest(table.c.best_score, statement.excluded.best_score),
            "passed_at": func.coalesce(table.c.passed_at, statement.excluded.passed_at),
        },
    )
    db.execute(statement)


def record_attempt(
    db: Session,
    *,
    account_id: uuid.UUID,
    course_id: str,
    chapter_id: str,
    score: int,
    passed: bool,
    answers: dict[str, str],
    now: datetime,
) -> None:
    """Insert the attempt and update the chapter's progress. The caller commits."""
    insert_attempt(
        db,
        account_id=account_id,
        course_id=course_id,
        chapter_id=chapter_id,
        score=score,
        passed=passed,
        answers=answers,
        now=now,
    )
    upsert_progress(
        db,
        account_id=account_id,
        course_id=course_id,
        chapter_id=chapter_id,
        score=score,
        passed=passed,
        now=now,
    )


def log_attempt(*, course_id: str, chapter_id: str, score: int, total: int, passed: bool) -> None:
    """One INFO line and one `quiz_submissions_total` count per saved attempt, called after the
    commit. Only values from the catalog and the grade go in: never the request text, an ID of
    the learner, or an answer."""
    outcome = "passed" if passed else "failed"
    logger.info(
        "Quiz attempt graded: course_id=%s chapter_id=%s score=%d total=%d outcome=%s",
        course_id,
        chapter_id,
        score,
        total,
        outcome,
        extra={
            "course_id": course_id,
            "chapter_id": chapter_id,
            "score": score,
            "total": total,
            "outcome": outcome,
        },
    )
    record_quiz_submission(course_id, passed)
