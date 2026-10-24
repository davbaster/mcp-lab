"""Chapter status: computed on every request from the learner's rows and the chapter order.

Status is never stored. `chapter_statuses` is a pure function; the routes (and later the lesson,
quiz, and attempt routes) all use it, so they cannot disagree.
"""

from collections.abc import Collection, Sequence
from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ChapterProgress


class ChapterStatus(StrEnum):
    LOCKED = "locked"
    IN_PROGRESS = "in_progress"
    PASSED = "passed"


@dataclass(frozen=True)
class ProgressRow:
    """What the progress route reports from a learner's row for one chapter."""

    best_score: int | None
    passed: bool
    last_lesson_id: str | None


def chapter_statuses(
    chapter_ids: Sequence[str], passed_ids: Collection[str]
) -> list[ChapterStatus]:
    """The status of each chapter, in the order given.

    A chapter in `passed_ids` is `passed`. Any other is `in_progress` if every chapter before it
    is passed (so the first never is `locked`), else `locked`. IDs in `passed_ids` that are not in
    `chapter_ids` are ignored.
    """
    statuses = []
    earlier_all_passed = True
    for chapter_id in chapter_ids:
        if chapter_id in passed_ids:
            statuses.append(ChapterStatus.PASSED)
        else:
            statuses.append(
                ChapterStatus.IN_PROGRESS if earlier_all_passed else ChapterStatus.LOCKED
            )
            earlier_all_passed = False
    return statuses


def load_progress(db: Session, account_id: UUID, course_id: str) -> dict[str, ProgressRow]:
    """The learner's rows for one course, by chapter ID: one query, nothing written."""
    rows = db.execute(
        select(
            ChapterProgress.chapter_id,
            ChapterProgress.best_score,
            ChapterProgress.passed_at,
            ChapterProgress.last_lesson_id,
        ).where(ChapterProgress.account_id == account_id, ChapterProgress.course_id == course_id)
    )
    return {
        row.chapter_id: ProgressRow(
            best_score=row.best_score,
            passed=row.passed_at is not None,
            last_lesson_id=row.last_lesson_id,
        )
        for row in rows
    }


def statuses_for(
    chapter_ids: Sequence[str], progress: dict[str, ProgressRow]
) -> list[ChapterStatus]:
    return chapter_statuses(chapter_ids, {cid for cid, row in progress.items() if row.passed})
