"""Tables: accounts and sessions (shared across courses, so no `course_id`), chapter progress,
and quiz attempts.

`chapter_progress` is course-scoped: `course_id` is part of its key. A chapter's status is never
stored; it is computed from these rows and the course's chapter order (`app.progress`).
`quiz_attempts` is the append-only record of every graded attempt, with its `course_id`.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    LargeBinary,
    SmallInteger,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

USERNAME_UNIQUE_CONSTRAINT = "uq_accounts_username_normalized"


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        UniqueConstraint("username_normalized"),
        CheckConstraint("username_normalized = lower(username)", name="username_normalized_lower"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Text)
    username_normalized: Mapped[str] = mapped_column(Text)
    password_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AuthSession(Base):
    """A signed-in browser. Only the SHA-256 digest of the cookie token is stored."""

    __tablename__ = "sessions"
    __table_args__ = (CheckConstraint("expires_at > created_at", name="expires_after_created"),)

    token_hash: Mapped[bytes] = mapped_column(LargeBinary, primary_key=True)
    account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


_ID_FORMAT = "~ '^[a-z0-9-]+$'"


class ChapterProgress(Base):
    """One learner's quiz progress in one chapter of one course.

    The catalog is in memory, so nothing refers to it by foreign key: rows for a chapter or
    course that was later removed from `course.yaml` stay and are ignored. A pass is a row with
    `passed_at` set (and then always a `best_score`). `last_lesson_id` may be set before any attempt.
    """

    __tablename__ = "chapter_progress"
    __table_args__ = (
        CheckConstraint("best_score BETWEEN 0 AND 5", name="best_score_range"),
        CheckConstraint("passed_at IS NULL OR best_score IS NOT NULL", name="passed_has_score"),
        CheckConstraint(f"course_id {_ID_FORMAT}", name="course_id_format"),
        CheckConstraint(f"chapter_id {_ID_FORMAT}", name="chapter_id_format"),
        CheckConstraint(
            f"last_lesson_id IS NULL OR last_lesson_id {_ID_FORMAT}", name="last_lesson_id_format"
        ),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    course_id: Mapped[str] = mapped_column(Text, primary_key=True)
    chapter_id: Mapped[str] = mapped_column(Text, primary_key=True)
    best_score: Mapped[int | None] = mapped_column(SmallInteger)
    passed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_lesson_id: Mapped[str | None] = mapped_column(Text)


class QuizAttempt(Base):
    """One graded quiz attempt, passed or failed. Rows are only ever inserted.

    `answers` maps each question ID to the option ID the learner chose. It is the learner's own
    submission, kept for the learner's history; it never goes into a log or a response (a failed
    attempt's response must not echo it). Like `chapter_progress`, nothing refers to the catalog
    by foreign key.
    """

    __tablename__ = "quiz_attempts"
    __table_args__ = (
        CheckConstraint("score BETWEEN 0 AND 5", name="score_range"),
        CheckConstraint("jsonb_typeof(answers) = 'object'", name="answers_is_object"),
        CheckConstraint(f"course_id {_ID_FORMAT}", name="course_id_format"),
        CheckConstraint(f"chapter_id {_ID_FORMAT}", name="chapter_id_format"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    course_id: Mapped[str] = mapped_column(Text)
    chapter_id: Mapped[str] = mapped_column(Text)
    score: Mapped[int] = mapped_column(SmallInteger)
    passed: Mapped[bool] = mapped_column(Boolean)
    answers: Mapped[dict[str, str]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
