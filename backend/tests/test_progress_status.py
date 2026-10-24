"""The chapter status rule (#14): a pure function, no database."""

import pytest

from app.progress import ChapterStatus, chapter_statuses

L, I, P = ChapterStatus.LOCKED, ChapterStatus.IN_PROGRESS, ChapterStatus.PASSED
CHAPTERS = ["c1", "c2", "c3"]


@pytest.mark.parametrize(
    ("passed", "expected"),
    [
        ([], [I, L, L]),
        (["c1"], [P, I, L]),
        (["c1", "c2"], [P, P, I]),
        (["c1", "c2", "c3"], [P, P, P]),
        (["c2"], [I, P, L]),
        (["c3"], [I, L, P]),
        (["c1", "c3"], [P, I, P]),
        (["c2", "c3"], [I, P, P]),
        (["not-a-chapter"], [I, L, L]),
        (["c1", "not-a-chapter"], [P, I, L]),
    ],
    ids=[
        "nothing passed",
        "first passed",
        "first two passed",
        "all passed",
        "only the second passed",
        "only the third passed",
        "first and third passed",
        "second and third passed",
        "a pass for an unknown chapter",
        "a pass for an unknown chapter beside a real one",
    ],
)
def test_statuses_follow_the_rule(passed, expected):
    assert chapter_statuses(CHAPTERS, set(passed)) == expected


def test_an_empty_chapter_list_has_no_statuses():
    assert chapter_statuses([], {"c1"}) == []


@pytest.mark.parametrize("passed", [[], ["c1"], ["c2"], ["c3"], ["c2", "c3"], ["zzz"]])
def test_the_first_chapter_is_never_locked(passed):
    assert chapter_statuses(CHAPTERS, set(passed))[0] is not L


def test_the_order_of_the_chapters_decides_not_their_names():
    assert chapter_statuses(["c3", "c2", "c1"], {"c1"}) == [I, L, P]


def test_a_list_or_tuple_of_passed_ids_works_too():
    assert chapter_statuses(("c1", "c2"), ["c1"]) == [P, I]


def test_the_statuses_are_the_three_documented_strings():
    assert [s.value for s in ChapterStatus] == ["locked", "in_progress", "passed"]
