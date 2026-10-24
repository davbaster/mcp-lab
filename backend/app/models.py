"""Tables for accounts and sessions. Accounts are shared across courses, so no `course_id`."""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, LargeBinary, Text, UniqueConstraint
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
