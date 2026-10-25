"""Store learner feedback (#24): the daily limit, the duplicate check, and the insert.

`store_feedback` runs on the caller's session and does not commit. It first locks the learner's
account row (`FOR NO KEY UPDATE`, which does not block the `FOR KEY SHARE` that other tables'
foreign keys take), so the checks and the insert of two requests of one learner never interleave:
the second waits for the first to end its transaction, then reads what the first stored. Another
learner's requests do not wait. Every count reads `app.feedback`, so the limits survive restarts,
and every time comes from the app clock the route passes in (never the client's `client_time`).

The order is fixed: the duplicate check first (a learner at the limit who re-sends the message
they just sent still gets a success), then the daily limit, then the insert.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import Enum

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Account, Feedback

# Under uvicorn only its own loggers print INFO lines (see app.courses).
logger = logging.getLogger("uvicorn.error")

DAILY_LIMIT = 10
DAILY_WINDOW = timedelta(hours=24)
DUPLICATE_WINDOW = timedelta(seconds=60)


class Outcome(Enum):
    STORED = "stored"
    DUPLICATE = "duplicate"
    LIMIT_REACHED = "limit_reached"
    NO_ACCOUNT = "no_account"


@dataclass(frozen=True)
class FeedbackItem:
    """A validated submission. The route builds it, so the IDs and category are checked values."""

    category: str
    message: str
    about_quiz_question: bool
    page_path: str
    course_id: str | None
    chapter_id: str | None
    lesson_id: str | None
    question_id: str | None
    app_version: str
    user_agent: str
    viewport_width: int
    viewport_height: int
    client_time: datetime
    console_errors: list[str]


@dataclass(frozen=True)
class Result:
    outcome: Outcome
    # For LIMIT_REACHED: the first moment the learner is under the limit again.
    retry_at: datetime | None = None


def retry_time_text(moment: datetime) -> str:
    """UTC, to the second, rounded up so the time shown is never one at which sending still fails."""
    moment = moment.astimezone(UTC)
    if moment.microsecond:
        moment = moment.replace(microsecond=0) + timedelta(seconds=1)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def store_feedback(
    db: Session, *, account_id: uuid.UUID, item: FeedbackItem, now: datetime
) -> Result:
    """Insert the item unless it is a duplicate or the learner is at the limit. Does not commit."""
    locked = db.execute(
        select(Account.id).where(Account.id == account_id).with_for_update(key_share=True)
    ).scalar_one_or_none()
    if locked is None:
        return Result(Outcome.NO_ACCOUNT)
    duplicate = db.execute(
        select(Feedback.id)
        .where(
            Feedback.account_id == account_id,
            Feedback.message == item.message,
            Feedback.created_at > now - DUPLICATE_WINDOW,
        )
        .limit(1)
    ).first()
    if duplicate is not None:
        return Result(Outcome.DUPLICATE)
    newest = (
        db.execute(
            select(Feedback.created_at)
            .where(Feedback.account_id == account_id, Feedback.created_at > now - DAILY_WINDOW)
            .order_by(Feedback.created_at.desc())
            .limit(DAILY_LIMIT)
        )
        .scalars()
        .all()
    )
    if len(newest) >= DAILY_LIMIT:
        # The tenth newest item is the one whose expiry brings the count below the limit again.
        return Result(Outcome.LIMIT_REACHED, retry_at=newest[-1] + DAILY_WINDOW)
    db.add(
        Feedback(
            id=uuid.uuid4(),
            account_id=account_id,
            course_id=item.course_id,
            chapter_id=item.chapter_id,
            lesson_id=item.lesson_id,
            question_id=item.question_id,
            category=item.category,
            message=item.message,
            about_quiz_question=item.about_quiz_question,
            page_path=item.page_path,
            app_version=item.app_version,
            user_agent=item.user_agent,
            viewport_width=item.viewport_width,
            viewport_height=item.viewport_height,
            client_time=item.client_time,
            console_errors=item.console_errors,
            status="new",
            created_at=now,
        )
    )
    db.flush()
    return Result(Outcome.STORED)


def log_feedback(*, course_id: str | None, category: str) -> None:
    """One INFO line per stored item. Only the catalog's course ID and the category (one of four
    fixed values) go in: never the message, the context, or anything about the learner."""
    logger.info(
        "Feedback stored: course_id=%s category=%s",
        "none" if course_id is None else course_id,
        category,
    )
