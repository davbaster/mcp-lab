"""The two access rules as pure decisions (#15): every cell of both tables, no database."""

import pytest

from app.access import Outcome, content_outcome, quiz_outcome
from app.progress import ChapterStatus

L, I, P = ChapterStatus.LOCKED, ChapterStatus.IN_PROGRESS, ChapterStatus.PASSED
ALLOWED, UNAUTHENTICATED, LOCKED = (
    Outcome.ALLOWED,
    Outcome.NOT_AUTHENTICATED,
    Outcome.CHAPTER_LOCKED,
)


@pytest.mark.parametrize("free_preview", [True, False])
def test_content_a_visitor_reads_only_a_free_preview_chapter(free_preview):
    outcome = content_outcome(signed_in=False, free_preview=free_preview, status=None)

    assert outcome is (ALLOWED if free_preview else UNAUTHENTICATED)


@pytest.mark.parametrize(
    ("free_preview", "status", "expected"),
    [
        (True, I, ALLOWED),
        (True, P, ALLOWED),
        (True, L, ALLOWED),  # a learner never reads less than a visitor
        (False, I, ALLOWED),
        (False, P, ALLOWED),
        (False, L, LOCKED),
    ],
)
def test_content_a_learner_reads_every_unlocked_chapter_and_every_free_preview_chapter(
    free_preview, status, expected
):
    outcome = content_outcome(signed_in=True, free_preview=free_preview, status=status)

    assert outcome is expected


@pytest.mark.parametrize("status", [None, L, I, P])
def test_quiz_a_visitor_is_never_let_in_whatever_the_status(status):
    assert quiz_outcome(signed_in=False, status=status) is UNAUTHENTICATED


@pytest.mark.parametrize(("status", "expected"), [(I, ALLOWED), (P, ALLOWED), (L, LOCKED)])
def test_quiz_a_learner_needs_an_unlocked_chapter(status, expected):
    assert quiz_outcome(signed_in=True, status=status) is expected


def test_quiz_rule_has_no_free_preview_input_so_a_free_chapter_cannot_open_a_quiz():
    with pytest.raises(TypeError):
        quiz_outcome(signed_in=True, free_preview=True, status=L)  # type: ignore[call-arg]


@pytest.mark.parametrize("rule", [content_outcome, quiz_outcome])
def test_a_learner_without_a_status_is_a_programming_error_not_an_allow(rule):
    kwargs = {"free_preview": False} if rule is content_outcome else {}

    with pytest.raises(ValueError, match="status"):
        rule(signed_in=True, status=None, **kwargs)
