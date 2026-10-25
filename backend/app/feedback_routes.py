"""The feedback route (#24): POST /api/feedback.

The order of checks: login (a dependency, run before the body is read), body shape (FastAPI), the
course in the context, then the duplicate check, the daily limit, and the insert (`app.feedback`).

A stored item and a duplicate get the same response: 202 with no body. Nothing about the item
comes back, and no response, error included, holds anything about the learner. The body's text is
untrusted: it is stored, and never logged or echoed (the shared 422 handler names the field only).
"""

import re
import unicodedata
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Self

from fastapi import Depends, FastAPI, Response
from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    StringConstraints,
    model_validator,
)
from sqlalchemy.orm import Session

from app.clock import current_time
from app.content_routes import LoginFirstRoute
from app.course_routes import CACHE_HEADER, PRIVATE_NO_STORE
from app.courses import Catalog, get_catalog
from app.db_session import get_db_session, hide_database_details
from app.errors import ApiError, ErrorResponse
from app.feedback import FeedbackItem, Outcome, log_feedback, retry_time_text, store_feedback
from app.sessions import NOT_AUTHENTICATED_MESSAGE, Learner, current_learner

MESSAGE_MIN = 10
MESSAGE_MAX = 2000
PAGE_PATH_MAX = 2000
ID_MAX = 100
APP_VERSION_MAX = 100
USER_AGENT_MAX = 1000
VIEWPORT_MAX = 20000
CONSOLE_ERRORS_MAX = 10
CONSOLE_ERROR_MAX = 500
ID_PATTERN = r"^[a-z0-9-]+$"

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
# ISO 8601 date-time with a zone. Pydantic also takes a date alone, a space for the "T", and a
# number of seconds, which a client of ours never sends.
_ISO_WITH_ZONE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})")

Category = Literal["bug", "content_error", "confusing_explanation", "suggestion"]


def _storable(value: str) -> str:
    # Postgres cannot store NUL, and the driver cannot encode a lone surrogate.
    if "\x00" in value or _LONE_SURROGATE.search(value):
        raise ValueError("must not contain a NUL character or a lone surrogate")
    return value


def _page_path(value: str) -> str:
    if not value.startswith("/") or value.startswith("//"):
        raise ValueError("must be a path that starts with a single /")
    if "?" in value or "#" in value:
        raise ValueError("must not have a query string or a fragment")
    if any(unicodedata.category(char) == "Cc" for char in value):
        raise ValueError("must not contain control characters")
    return value


def _iso_string(value: Any) -> Any:
    if not isinstance(value, str) or _ISO_WITH_ZONE.fullmatch(value) is None:
        raise ValueError("must be an ISO 8601 date-time with a time zone")
    return value


def _in_utc_range(value: datetime) -> datetime:
    # A time that is valid in its own zone can fall outside the years 1 to 9999 in UTC, which
    # nothing that reads the row back could represent.
    try:
        value.astimezone(UTC)
    except OverflowError:
        raise ValueError("must be a time between the years 1 and 9999 in UTC") from None
    return value


# Every string in the body goes through `_storable`.
Text = Annotated[StrictStr, AfterValidator(_storable)]
Identifier = Annotated[
    StrictStr, Field(min_length=1, max_length=ID_MAX, pattern=ID_PATTERN), AfterValidator(_storable)
]
Dimension = Annotated[StrictInt, Field(ge=1, le=VIEWPORT_MAX)]


class Viewport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    width: Dimension
    height: Dimension


class FeedbackContext(BaseModel):
    """What the browser reports about the page. All of it is stored as sent."""

    model_config = ConfigDict(extra="forbid")

    page_path: Annotated[
        Text,
        Field(
            min_length=1,
            max_length=PAGE_PATH_MAX,
            description="The path only: starts with one /, no query string, no fragment.",
        ),
        AfterValidator(_page_path),
    ]
    course_id: Annotated[
        Identifier | None, Field(description="null outside a course; else a configured course")
    ]
    chapter_id: Annotated[Identifier | None, Field(description="Needs a course_id")] = None
    lesson_id: Annotated[Identifier | None, Field(description="Needs a course_id")] = None
    question_id: Annotated[Identifier | None, Field(description="Needs a course_id")] = None
    app_version: Annotated[Text, Field(min_length=1, max_length=APP_VERSION_MAX)]
    user_agent: Annotated[Text, Field(max_length=USER_AGENT_MAX)]
    viewport: Viewport
    client_time: Annotated[
        AwareDatetime,
        BeforeValidator(_iso_string),
        AfterValidator(_in_utc_range),
        Field(description="The browser's clock, with a time zone. Stored as sent, never trusted."),
    ]
    console_errors: Annotated[
        list[Annotated[Text, Field(max_length=CONSOLE_ERROR_MAX)]],
        Field(max_length=CONSOLE_ERRORS_MAX),
    ]

    @model_validator(mode="after")
    def _ids_need_a_course(self) -> Self:
        if self.course_id is None and any(
            value is not None for value in (self.chapter_id, self.lesson_id, self.question_id)
        ):
            raise ValueError("chapter_id, lesson_id and question_id need a course_id")
        return self


class FeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: Category
    message: Annotated[
        StrictStr,
        StringConstraints(strip_whitespace=True, min_length=MESSAGE_MIN, max_length=MESSAGE_MAX),
        AfterValidator(_storable),
        Field(
            description="Trimmed of leading and trailing whitespace first, then 10 to 2000 characters."
        ),
    ]
    about_quiz_question: StrictBool = False
    context: FeedbackContext

    @model_validator(mode="after")
    def _quiz_flag_needs_a_question(self) -> Self:
        if self.about_quiz_question and self.context.question_id is None:
            raise ValueError("about_quiz_question needs context.question_id")
        return self


UNKNOWN_COURSE_MESSAGE = "body.context.course_id: Unknown course."
LIMIT_MESSAGE = (
    "You have reached the limit of 10 feedback items in 24 hours. You can send again at {}."
)


def submit_feedback(
    body: FeedbackRequest,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    learner: Annotated[Learner, Depends(current_learner)],
    db: Annotated[Session, Depends(get_db_session)],
    now: Annotated[datetime, Depends(current_time)],
) -> Response:
    # The login check ran first (a dependency), and FastAPI checked the body's shape.
    context = body.context
    course_id = None
    if context.course_id is not None:
        course = catalog.get(context.course_id)
        if course is None:
            raise ApiError(422, "validation_error", UNKNOWN_COURSE_MESSAGE)
        course_id = course.id  # the catalog's value, which is what the log line shows
    item = FeedbackItem(
        category=body.category,
        message=body.message,
        about_quiz_question=body.about_quiz_question,
        page_path=context.page_path,
        course_id=course_id,
        chapter_id=context.chapter_id,
        lesson_id=context.lesson_id,
        question_id=context.question_id,
        app_version=context.app_version,
        user_agent=context.user_agent,
        viewport_width=context.viewport.width,
        viewport_height=context.viewport.height,
        client_time=context.client_time,
        console_errors=list(context.console_errors),
    )
    with hide_database_details():
        result = store_feedback(db, account_id=learner.account_id, item=item, now=now)
        db.commit()
    if result.outcome is Outcome.NO_ACCOUNT:  # the account was deleted after the login check
        raise ApiError(401, "not_authenticated", NOT_AUTHENTICATED_MESSAGE)
    if result.outcome is Outcome.LIMIT_REACHED:
        assert result.retry_at is not None
        raise ApiError(
            429, "feedback_limit_reached", LIMIT_MESSAGE.format(retry_time_text(result.retry_at))
        )
    if result.outcome is Outcome.STORED:
        log_feedback(course_id=course_id, category=item.category)
    # A duplicate gets exactly the response of a stored item.
    return Response(status_code=202, headers={"cache-control": PRIVATE_NO_STORE})


def install_feedback_routes(app: FastAPI) -> None:
    """Add the feedback route to `app`."""
    app.router.add_api_route(
        "/api/feedback",
        submit_feedback,
        methods=["POST"],
        status_code=202,
        response_class=Response,
        tags=["feedback"],
        operation_id="submitFeedback",
        route_class_override=LoginFirstRoute,
        responses={
            202: {
                "description": "Accepted. No body, and nothing about the item.",
                "headers": {"Cache-Control": CACHE_HEADER},
            },
            401: {"model": ErrorResponse},
            429: {"model": ErrorResponse},
        },
        summary="Send feedback as the signed-in learner (10 per 24 hours; the same message "
        "within a minute is ignored)",
    )
