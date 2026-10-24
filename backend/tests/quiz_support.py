"""Fixtures and helpers shared by the quiz attempt tests (#16).

The attempt tests use `epsilon-course` (two chapters, a five-question quiz each, option IDs that
are unique and are not `a`, `b`, `c`), `gamma-course` for the access matrix (its quizzes are never
read before a 401 or a 403), and `alpha-course` for the course-scoping cases.
"""

import pytest
from sqlalchemy import text

from tests.auth_support import BASE_URL, new_client, register, rows
from tests.content_support import account_id

ATTEMPT_COURSES = "alpha-course,gamma-course,epsilon-course"
EPSILON = "epsilon-course"
CHAPTERS = {1: "01-first", 2: "02-second"}
# The questions answered correctly for each score.
SCORE_SETS = {0: (), 1: (3,), 2: (2, 5), 3: (1, 3, 5), 4: (1, 2, 3, 4), 5: (1, 2, 3, 4, 5)}
SECRET_MARKERS = ("CORRECT-SENTINEL", "EXPLANATION-SENTINEL", "WRONG-SENTINEL", "k3q7", "w9d2")


def attempt_url(chapter: str = "01-first", course: str = EPSILON) -> str:
    return f"/api/courses/{course}/chapters/{chapter}/quiz/attempts"


def correct_id(chapter_no: int, n: int) -> str:
    return f"k3q7-{chapter_no}-{n}"


def wrong_id(chapter_no: int, n: int, which: str = "x") -> str:
    return f"w9d2-{chapter_no}-{n}-{which}"


def answers(chapter_no: int = 1, right=(1, 2, 3, 4, 5), which: dict | None = None) -> list[dict]:
    """One answer per question: the correct option for the questions in `right`, else a wrong one.

    `which` picks the wrong option ("x" or "y"; only questions 2 and 4 have a "y") by question.
    """
    which = which or {}
    chapter = CHAPTERS[chapter_no]
    return [
        {
            "question_id": f"{chapter}-{n}",
            "option_id": correct_id(chapter_no, n)
            if n in right
            else wrong_id(chapter_no, n, which.get(n, "x")),
        }
        for n in range(1, 6)
    ]


def submit(client, right=(1, 2, 3, 4, 5), chapter_no: int = 1, which: dict | None = None, **kw):
    return client.post(
        attempt_url(CHAPTERS[chapter_no]),
        json={"answers": answers(chapter_no, right, which)},
        **kw,
    )


def pass_chapter(client, chapter_no: int = 1):
    response = submit(client, chapter_no=chapter_no)
    assert response.status_code == 200 and response.json()["passed"] is True
    return response


def attempt_rows(db, username: str | None = "ana1") -> list[tuple]:
    """(course_id, chapter_id, score, passed, answers) of the attempts, oldest first."""
    where, params = (
        ("WHERE account_id = :a", {"a": account_id(db, username)}) if username else ("", {})
    )
    return [
        tuple(row)
        for row in rows(
            db,
            "SELECT course_id, chapter_id, score, passed, answers FROM app.quiz_attempts"
            f" {where} ORDER BY created_at, id",
            **params,
        )
    ]


def attempt_count(db) -> int:
    return rows(db, "SELECT count(*) FROM app.quiz_attempts")[0][0]


def state(db) -> dict:
    """Every attempt and every progress row, to compare before and after a rejected request."""
    return {
        "attempts": [
            tuple(r)
            for r in rows(
                db,
                "SELECT id, account_id, course_id, chapter_id, score, passed, answers::text,"
                " created_at FROM app.quiz_attempts ORDER BY id",
            )
        ],
        "progress": [
            tuple(r)
            for r in rows(db, "SELECT * FROM app.chapter_progress ORDER BY account_id, 2, 3")
        ],
    }


def progress_row(db, chapter="01-first", course=EPSILON, username="ana1"):
    """(best_score, passed_at, last_lesson_id) of one row, else None."""
    found = rows(
        db,
        "SELECT best_score, passed_at, last_lesson_id FROM app.chapter_progress"
        " WHERE account_id = :a AND course_id = :c AND chapter_id = :ch",
        a=account_id(db, username),
        c=course,
        ch=chapter,
    )
    return tuple(found[0]) if found else None


def seed_attempt_row(db, username, chapter, course, score):
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app.chapter_progress (account_id, course_id, chapter_id, best_score)"
                " VALUES (:a, :c, :ch, :s)"
            ),
            {"a": account_id(db, username), "c": course, "ch": chapter, "s": score},
        )


@pytest.fixture
def attempt_api(serve, db, clock):
    """The app serving alpha, gamma, and epsilon, with a client that keeps its cookies."""
    client = serve(ATTEMPT_COURSES)
    client.base_url = BASE_URL
    return client


@pytest.fixture
def ana(attempt_api):
    """The client, signed in as `ana1`."""
    assert register(attempt_api).status_code == 201
    return attempt_api


@pytest.fixture
def server_errors(ana):
    """A client with `ana`'s session that turns a server fault into a 500 response."""
    client = new_client(raise_server_exceptions=False)
    client.cookies.set("session", ana.cookies.get("session"))
    return client
