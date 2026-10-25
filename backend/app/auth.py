"""Account routes: register, login, logout, and who am I. All JSON, under /api/auth/."""

import logging
import re
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import Depends, FastAPI, Request, Response
from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import passwords, rate_limit
from app.client_address import client_key
from app.clock import current_time
from app.db_session import DatabaseFailure, get_db_session, hide_database_details
from app.errors import ApiError, ErrorResponse
from app.models import USERNAME_UNIQUE_CONSTRAINT, Account
from app.sessions import (
    COOKIE_NAME,
    Learner,
    clear_session_cookie,
    create_session,
    current_learner,
    delete_session,
    set_session_cookie,
)

USERNAME_PATTERN = r"^[A-Za-z0-9_]{4,8}$"
_REGISTRABLE = re.compile(USERNAME_PATTERN)
PASSWORD_MIN = 8
PASSWORD_MAX = 12
LOGIN_USERNAME_MAX = 64
LOGIN_PASSWORD_MAX = 128
USERNAME_TAKEN_MESSAGE = "That username is taken."
INVALID_CREDENTIALS_MESSAGE = "Wrong username or password."
TOO_MANY_ATTEMPTS_MESSAGE = "Too many failed sign-in attempts. Try again later."
NO_STORE = "no-store"

# Under uvicorn only its own loggers print INFO lines (see app.courses).
logger = logging.getLogger("uvicorn.error")
_SCOPE_NAMES = {rate_limit.LOGIN_USERNAME.scope: "username", rate_limit.LOGIN_IP.scope: "ip"}


def _readable_text(value: object) -> object:
    # A lone surrogate (JSON "\ud800") cannot be encoded as UTF-8 and would crash the database
    # driver. The message never contains the value.
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("Must be valid Unicode text") from None
    return value


def _new_password(value: str) -> str:
    normalized = passwords.normalize(value)
    if not PASSWORD_MIN <= len(normalized) <= PASSWORD_MAX:
        raise ValueError(f"Must be {PASSWORD_MIN} to {PASSWORD_MAX} characters")
    return normalized


Username = Annotated[
    str,
    Field(
        min_length=4,
        max_length=8,
        pattern=USERNAME_PATTERN,
        description="4 to 8 characters: A-Z, a-z, 0-9, and _. Never trimmed.",
    ),
    BeforeValidator(_readable_text),
]
NewPassword = Annotated[
    str,
    Field(
        description=(
            f"{PASSWORD_MIN} to {PASSWORD_MAX} characters, counted after NFKC normalization. "
            "Spaces are kept."
        )
    ),
    BeforeValidator(_readable_text),
    AfterValidator(_new_password),
]
LoginUsername = Annotated[
    str, Field(min_length=1, max_length=LOGIN_USERNAME_MAX), BeforeValidator(_readable_text)
]
LoginPassword = Annotated[
    str,
    Field(min_length=1, max_length=LOGIN_PASSWORD_MAX),
    BeforeValidator(_readable_text),
    AfterValidator(passwords.normalize),
]


class RegisterRequest(BaseModel):
    model_config = ConfigDict(strict=True)

    username: Username
    password: NewPassword


class LoginRequest(BaseModel):
    model_config = ConfigDict(strict=True)

    username: LoginUsername
    password: LoginPassword


class AccountResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str


def _error_responses(*statuses: int) -> dict[int | str, dict[str, object]]:
    return {status: {"model": ErrorResponse} for status in statuses}


_CACHE_HEADER = {
    "description": "Always `no-store`, so a shared cache never serves one learner's response to another.",
    "schema": {"type": "string"},
}
_COOKIE_HEADER = {
    "description": (
        "The new session cookie: `session=<token>; Max-Age=86400; Path=/; HttpOnly; Secure; "
        "SameSite=Lax`, with no Domain."
    ),
    "schema": {"type": "string"},
}
_SIGNED_IN_HEADERS = {"Set-Cookie": _COOKIE_HEADER, "Cache-Control": _CACHE_HEADER}
_TOO_MANY_ATTEMPTS = {
    "model": ErrorResponse,
    "description": (
        "Too many failed sign-in attempts for this username or from this address, in the last "
        "15 minutes. Even the right password is refused until the block ends. The answer is the "
        "same whether or not the username exists."
    ),
    "headers": {
        "Retry-After": {
            "description": "Whole seconds until the block ends, rounded up and at least 1.",
            "schema": {"type": "integer", "minimum": 1},
        },
        "Cache-Control": _CACHE_HEADER,
    },
}


def _old_cookie(request: Request) -> str | None:
    return request.cookies.get(COOKIE_NAME)


def register(
    body: RegisterRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db_session)],
    now: Annotated[datetime, Depends(current_time)],
) -> AccountResponse:
    password_hash = passwords.hash_password(body.password)
    try:
        with hide_database_details():
            account_id = uuid.uuid4()
            db.add(
                Account(
                    id=account_id,
                    username=body.username,
                    username_normalized=body.username.lower(),
                    password_hash=password_hash,
                    created_at=now,
                )
            )
            db.flush()  # the unique constraint decides here; no check-then-insert
            delete_session(db, _old_cookie(request))
            token = create_session(db, account_id, now)
            db.commit()
    except DatabaseFailure as failure:
        db.rollback()
        if failure.constraint == USERNAME_UNIQUE_CONSTRAINT:
            raise ApiError(409, "username_taken", USERNAME_TAKEN_MESSAGE) from None
        raise
    set_session_cookie(response, token)
    response.headers["cache-control"] = NO_STORE
    return AccountResponse(username=body.username)


def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db_session)],
    now: Annotated[datetime, Depends(current_time)],
) -> AccountResponse:
    # The attempt is counted, and refused if a limit is reached, before the account is looked up
    # and before any password is checked: the answer does not depend on whether the username
    # exists, and a blocked request costs no argon2 verification. The count is committed here, so
    # no transaction or lock is open during the slow hash. A database error fails closed (500).
    username_key = body.username.lower()
    try:
        with hide_database_details():
            reservation = rate_limit.reserve(
                db,
                [
                    (rate_limit.LOGIN_IP, client_key(request)),
                    (rate_limit.LOGIN_USERNAME, username_key),
                ],
                now,
            )
    except rate_limit.RateLimited as limited:
        raise ApiError(
            429,
            "too_many_attempts",
            TOO_MANY_ATTEMPTS_MESSAGE,
            headers={"Retry-After": str(limited.retry_after), "Cache-Control": NO_STORE},
        ) from None
    account_id = username = password_hash = None
    if _REGISTRABLE.fullmatch(body.username):
        with hide_database_details():
            account = db.scalar(select(Account).where(Account.username_normalized == username_key))
            if account is not None:
                account_id, username, password_hash = (
                    account.id,
                    account.username,
                    account.password_hash,
                )
            db.rollback()  # end the read transaction: nothing is held while the hash runs
    # Exactly one argon2 verification whatever the cause of failure, so timing does not tell
    # an unknown username from a wrong password.
    hash_to_check = password_hash if password_hash is not None else passwords.dummy_hash()
    verified = passwords.verify_password(hash_to_check, body.password)
    if account_id is None or not verified:
        if reservation.reached:
            # One line, only the kind of limit: no username, address, or count.
            logger.info("Login limit reached: scope=%s", _SCOPE_NAMES[reservation.reached[0].scope])
        raise ApiError(401, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE)
    with hide_database_details():
        # A success is not a failure for either limit. It also clears the username's count, but
        # not the address's: otherwise one's own account would reset the count between guesses.
        rate_limit.forgive(db, reservation, reset=[(rate_limit.LOGIN_USERNAME, username_key)])
        delete_session(db, _old_cookie(request))
        token = create_session(db, account_id, now)
        db.commit()
    set_session_cookie(response, token)
    response.headers["cache-control"] = NO_STORE
    return AccountResponse(username=username)


def logout(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db_session)],
) -> None:
    with hide_database_details():
        delete_session(db, _old_cookie(request))
        db.commit()
    clear_session_cookie(response)


def me(
    response: Response, learner: Annotated[Learner, Depends(current_learner)]
) -> AccountResponse:
    response.headers["cache-control"] = NO_STORE
    return AccountResponse(username=learner.username)


def install_auth_routes(app: FastAPI) -> None:
    """Add the four routes to `app`. (Added one by one, not with include_router, so that
    `app.routes` lists plain routes, which the contract test's route check needs.)"""
    app.add_api_route(
        "/api/auth/register",
        register,
        methods=["POST"],
        tags=["auth"],
        operation_id="register",
        status_code=201,
        responses={201: {"headers": _SIGNED_IN_HEADERS}, **_error_responses(409)},
        summary="Create an account and sign in",
    )
    app.add_api_route(
        "/api/auth/login",
        login,
        methods=["POST"],
        tags=["auth"],
        operation_id="login",
        responses={
            200: {"headers": _SIGNED_IN_HEADERS},
            **_error_responses(401),
            429: _TOO_MANY_ATTEMPTS,
        },
        summary="Sign in",
    )
    app.add_api_route(
        "/api/auth/logout",
        logout,
        methods=["POST"],
        tags=["auth"],
        operation_id="logout",
        status_code=204,
        responses={
            204: {
                "headers": {
                    "Set-Cookie": {
                        "description": (
                            "Clears the cookie: `session=; Max-Age=0; Path=/; HttpOnly; Secure; "
                            "SameSite=Lax`. Sent even when the request had no valid session."
                        ),
                        "schema": {"type": "string"},
                    }
                }
            }
        },
        summary="Sign out",
    )
    app.add_api_route(
        "/api/auth/me",
        me,
        methods=["GET"],
        tags=["auth"],
        operation_id="me",
        responses={200: {"headers": {"Cache-Control": _CACHE_HEADER}}, **_error_responses(401)},
        summary="Who is signed in",
    )
