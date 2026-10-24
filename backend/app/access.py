"""Who may read what: the two access rules for course content, written once.

**Content access** (`require_content_access`; the lesson `GET`, the last-lesson `PUT`, and later
the code steps and chapter ZIPs of #59). A chapter is readable like this:

| Caller                             | `free_preview` | other, `in_progress`/`passed` | other, `locked`        |
|------------------------------------|----------------|-------------------------------|------------------------|
| Visitor (no valid session)         | readable       | 401 `not_authenticated`       | 401 `not_authenticated`|
| Learner (valid session)            | readable       | readable                      | 403 `chapter_locked`   |

A `free_preview` chapter is readable by anyone, whatever the learner's status, so a learner never
reads less than a visitor.

**Quiz access** (`require_quiz_access`; the quiz `GET`, and the attempt `POST` of #16).
`free_preview` is ignored: it never opens a quiz.

| Caller  | `in_progress` or `passed` | `locked`             |
|---------|---------------------------|----------------------|
| Visitor | 401 `not_authenticated`   | 401 `not_authenticated` |
| Learner | allowed                   | 403 `chapter_locked` (even if `free_preview`) |

The decision itself is a pure function (`content_outcome`, `quiz_outcome`) of the caller, the
chapter's `free_preview` flag, and the learner's status, so a test can cover every cell without a
database. The `require_*` functions add the one step that touches the database: the status comes
only from `statuses_for`, computed from one query for the learner's rows of that course, and only
when the decision needs it (a `free_preview` lesson costs no progress query).
"""

from enum import StrEnum

from sqlalchemy.orm import Session

from app.courses import Chapter, Course
from app.errors import ApiError
from app.progress import ChapterStatus, load_progress, statuses_for
from app.sessions import NOT_AUTHENTICATED_MESSAGE, Learner, SignedIn

CHAPTER_LOCKED_MESSAGE = "Finish the earlier chapters to unlock this chapter."


class Outcome(StrEnum):
    ALLOWED = "allowed"
    NOT_AUTHENTICATED = "not_authenticated"  # 401
    CHAPTER_LOCKED = "chapter_locked"  # 403


def content_outcome(
    *, signed_in: bool, free_preview: bool, status: ChapterStatus | None
) -> Outcome:
    """The content-access table. `status` matters only for a signed-in learner."""
    if free_preview:
        return Outcome.ALLOWED
    if not signed_in:
        return Outcome.NOT_AUTHENTICATED
    if status is None:
        raise ValueError("A signed-in learner needs a chapter status.")
    return Outcome.CHAPTER_LOCKED if status is ChapterStatus.LOCKED else Outcome.ALLOWED


def quiz_outcome(*, signed_in: bool, status: ChapterStatus | None) -> Outcome:
    """The quiz-access table. `free_preview` is not an input: it never opens a quiz."""
    if not signed_in:
        return Outcome.NOT_AUTHENTICATED
    if status is None:
        raise ValueError("A signed-in learner needs a chapter status.")
    return Outcome.CHAPTER_LOCKED if status is ChapterStatus.LOCKED else Outcome.ALLOWED


def chapter_status(
    db: Session, learner: Learner, course: Course, chapter: Chapter
) -> ChapterStatus:
    """The learner's status in one chapter: one query for their rows of the course."""
    progress = load_progress(db, learner.account_id, course.id)
    statuses = statuses_for([c.id for c in course.chapters], progress)
    return statuses[course.chapters.index(chapter)]


def _enforce(outcome: Outcome) -> None:
    if outcome is Outcome.NOT_AUTHENTICATED:
        raise ApiError(401, "not_authenticated", NOT_AUTHENTICATED_MESSAGE)
    if outcome is Outcome.CHAPTER_LOCKED:
        raise ApiError(403, "chapter_locked", CHAPTER_LOCKED_MESSAGE)


def require_content_access(course: Course, chapter: Chapter, signed_in: SignedIn | None) -> None:
    """Raise the shared 401 or 403 unless the caller may read this chapter's content."""
    status = None
    if signed_in is not None and not chapter.free_preview:
        status = chapter_status(signed_in.db, signed_in.learner, course, chapter)
    _enforce(
        content_outcome(
            signed_in=signed_in is not None, free_preview=chapter.free_preview, status=status
        )
    )


def require_quiz_access(course: Course, chapter: Chapter, signed_in: SignedIn | None) -> None:
    """Raise the shared 401 or 403 unless the caller may take this chapter's quiz."""
    status = None
    if signed_in is not None:
        status = chapter_status(signed_in.db, signed_in.learner, course, chapter)
    _enforce(quiz_outcome(signed_in=signed_in is not None, status=status))
