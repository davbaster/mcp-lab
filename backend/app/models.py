"""Tables: accounts and sessions (shared across courses, so no `course_id`), chapter progress,
quiz attempts, learner feedback, and the counters behind the rate limits.

`chapter_progress` is course-scoped: `course_id` is part of its key. A chapter's status is never
stored; it is computed from these rows and the course's chapter order (`app.progress`).
`quiz_attempts` is the append-only record of every graded attempt, with its `course_id`.
`feedback` is the append-only record of what learners send, with a `course_id` when the page was
in a course.
`rate_limit_failures` holds one row per counted failure, keyed by a digest, never by the username
or address itself. Like `accounts` and `sessions` it is not course data, so it has no `course_id`.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    SmallInteger,
    Text,
    UniqueConstraint,
    text,
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


_FEEDBACK_CATEGORIES = "'bug', 'content_error', 'confusing_explanation', 'suggestion'"


class Feedback(Base):
    """One item of learner feedback. Rows are only ever inserted, and are never returned by the API.

    `account_id` is the only column that identifies the learner, so a read-only role can be
    granted every other column (#39). Everything the learner typed or the browser reported is
    untrusted text: `message` is trimmed and the rest is stored as sent, console errors included.
    `course_id` is NULL for a page outside a course, and then so are the other three IDs. The
    catalog is in memory, so nothing refers to it by foreign key. `status` stays `new`: triage
    decisions live in `ops.feedback_triage` (#49). `created_at` is the app clock, which the daily
    limit and the duplicate check count from.
    """

    __tablename__ = "feedback"
    __table_args__ = (
        CheckConstraint(f"category IN ({_FEEDBACK_CATEGORIES})", name="category_values"),
        CheckConstraint("status = 'new'", name="status_is_new"),
        CheckConstraint(f"course_id IS NULL OR course_id {_ID_FORMAT}", name="course_id_format"),
        CheckConstraint(f"chapter_id IS NULL OR chapter_id {_ID_FORMAT}", name="chapter_id_format"),
        CheckConstraint(f"lesson_id IS NULL OR lesson_id {_ID_FORMAT}", name="lesson_id_format"),
        CheckConstraint(
            f"question_id IS NULL OR question_id {_ID_FORMAT}", name="question_id_format"
        ),
        CheckConstraint(
            "course_id IS NOT NULL OR (chapter_id IS NULL AND lesson_id IS NULL"
            " AND question_id IS NULL)",
            name="ids_need_course",
        ),
        CheckConstraint("char_length(message) BETWEEN 10 AND 2000", name="message_length"),
        CheckConstraint("jsonb_typeof(console_errors) = 'array'", name="console_errors_is_array"),
        CheckConstraint(
            "CASE WHEN jsonb_typeof(console_errors) = 'array'"
            " THEN jsonb_array_length(console_errors) <= 10 ELSE false END",
            name="console_errors_max_items",
        ),
        CheckConstraint(
            "NOT about_quiz_question OR question_id IS NOT NULL",
            name="quiz_flag_needs_question_id",
        ),
        Index("ix_feedback_account_id_created_at", "account_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    course_id: Mapped[str | None] = mapped_column(Text)
    chapter_id: Mapped[str | None] = mapped_column(Text)
    lesson_id: Mapped[str | None] = mapped_column(Text)
    question_id: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(Text)
    message: Mapped[str] = mapped_column(Text)
    about_quiz_question: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    page_path: Mapped[str] = mapped_column(Text)
    app_version: Mapped[str] = mapped_column(Text)
    user_agent: Mapped[str] = mapped_column(Text)
    viewport_width: Mapped[int] = mapped_column(Integer)
    viewport_height: Mapped[int] = mapped_column(Integer)
    client_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    console_errors: Mapped[list[str]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(Text, server_default=text("'new'"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


RATE_LIMIT_SCOPES = "'login_username', 'login_ip'"


class RateLimitFailure(Base):
    """One counted failure for one rate-limited key (`app.rate_limit`). Rows are inserted when an
    attempt is reserved and deleted when they expire or the attempt succeeds.

    `key_hash` is the SHA-256 digest of the key (the lower-cased username, or the client key from
    `app.client_address`), so the table holds no username and no address. `scope` says what the
    key is; #97 adds its own scope to the check. `failed_at` is the app clock: a row counts while
    `failed_at > now - window`.
    """

    __tablename__ = "rate_limit_failures"
    __table_args__ = (
        CheckConstraint(f"scope IN ({RATE_LIMIT_SCOPES})", name="scope_values"),
        CheckConstraint("octet_length(key_hash) = 32", name="key_hash_length"),
        Index("ix_rate_limit_failures_scope_key_hash_failed_at", "scope", "key_hash", "failed_at"),
        Index("ix_rate_limit_failures_failed_at", "failed_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(Text)
    key_hash: Mapped[bytes] = mapped_column(LargeBinary)
    failed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
