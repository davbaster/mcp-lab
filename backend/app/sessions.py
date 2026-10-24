"""Session tokens, the session cookie, and the `current_learner` dependency.

The cookie holds a random token. The database holds only its SHA-256 digest. A session lasts
exactly one day from creation: the expiry is fixed, never extended by use.
"""

import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Response
from fastapi.security import APIKeyCookie
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.clock import current_time
from app.db_session import get_db_session
from app.errors import ApiError
from app.models import Account, AuthSession

COOKIE_NAME = "session"
SESSION_LIFETIME = timedelta(days=1)
NOT_AUTHENTICATED_MESSAGE = "You are not signed in."

# secrets.token_urlsafe(32): 32 random bytes as 43 URL-safe base64 characters, no padding.
_TOKEN_SHAPE = re.compile(r"[A-Za-z0-9_-]{43}")

cookie_scheme = APIKeyCookie(name=COOKIE_NAME, scheme_name="SessionCookie", auto_error=False)


@dataclass(frozen=True)
class Learner:
    account_id: UUID
    username: str


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode("ascii")).digest()


def token_hash_from_cookie(value: str | None) -> bytes | None:
    """The digest to look up for a cookie value, or None if it cannot be one of our tokens."""
    if value is None or _TOKEN_SHAPE.fullmatch(value) is None:
        return None
    return hash_token(value)


def _cookie_attributes(value: str, max_age: int) -> str:
    # Written out by hand so the clearing header repeats every attribute of the original (a
    # browser will not overwrite a Secure cookie with a non-Secure one) and the value is bare.
    return f"{COOKIE_NAME}={value}; Max-Age={max_age}; Path=/; HttpOnly; Secure; SameSite=Lax"


def set_session_cookie(response: Response, token: str) -> None:
    max_age = int(SESSION_LIFETIME.total_seconds())
    response.headers.append("set-cookie", _cookie_attributes(token, max_age))


def clear_session_cookie(response: Response) -> None:
    response.headers.append("set-cookie", _cookie_attributes("", 0))


def create_session(db: Session, account_id: UUID, now: datetime) -> str:
    """Add a session row for the account (not committed) and return the cookie token."""
    token = new_token()
    db.add(
        AuthSession(
            token_hash=hash_token(token),
            account_id=account_id,
            created_at=now,
            expires_at=now + SESSION_LIFETIME,
        )
    )
    return token


def delete_session(db: Session, cookie_value: str | None) -> None:
    """Delete the row a cookie points to, if any (not committed). Never fails on garbage."""
    token_hash = token_hash_from_cookie(cookie_value)
    if token_hash is not None:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == token_hash))


def find_learner(db: Session, cookie_value: str | None, now: datetime) -> Learner | None:
    token_hash = token_hash_from_cookie(cookie_value)
    if token_hash is None:
        return None
    row = db.execute(
        select(Account.id, Account.username)
        .join(AuthSession, AuthSession.account_id == Account.id)
        .where(AuthSession.token_hash == token_hash, AuthSession.expires_at > now)
    ).one_or_none()
    return None if row is None else Learner(account_id=row.id, username=row.username)


def current_learner(
    cookie_value: Annotated[str | None, Depends(cookie_scheme)],
    db: Annotated[Session, Depends(get_db_session)],
    now: Annotated[datetime, Depends(current_time)],
) -> Learner:
    """The signed-in learner, or the shared 401 for a missing, unknown, or expired cookie."""
    learner = find_learner(db, cookie_value, now)
    if learner is None:
        raise ApiError(401, "not_authenticated", NOT_AUTHENTICATED_MESSAGE)
    return learner
