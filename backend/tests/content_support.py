"""Fixtures and helpers shared by the lesson, last-lesson, and quiz tests (#15)."""

from datetime import UTC, datetime

import pytest
import yaml
from sqlalchemy import text

from tests.auth_support import BASE_URL, register, rows, with_cookie
from tests.dbtools import BACKEND_DIR

COURSES = "alpha-course,beta-course,gamma-course,delta-course"
PASSED_AT = datetime(2030, 1, 1, tzinfo=UTC)
VISITOR_KINDS = ["no cookie", "malformed cookie", "unknown token", "expired session"]
# Every table that a read must leave as it is.
SNAPSHOT_TABLES = ("chapter_progress", "sessions", "accounts")


@pytest.fixture
def content_api(serve, db, clock):
    """The app serving all four fixture courses, with a client that keeps its cookies."""
    client = serve(COURSES)
    client.base_url = BASE_URL  # https, so the cookie jar sends the Secure session cookie
    return client


@pytest.fixture
def learner(content_api):
    """The client, signed in as `ana1`."""
    assert register(content_api).status_code == 201
    return content_api


def account_id(db, username="ana1"):
    return rows(db, "SELECT id FROM app.accounts WHERE username = :u", u=username)[0][0]


def put_progress(
    db, username, chapter, *, course="gamma-course", score=None, passed=False, last=None
):
    """Insert a progress row with SQL, the way a pass (#16) or a saved position will leave it."""
    if passed and score is None:
        score = 4
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app.chapter_progress"
                " (account_id, course_id, chapter_id, best_score, passed_at, last_lesson_id)"
                " VALUES (:a, :c, :ch, :s, :p, :l)"
            ),
            {
                "a": account_id(db, username),
                "c": course,
                "ch": chapter,
                "s": score,
                "p": PASSED_AT if passed else None,
                "l": last,
            },
        )


def progress_rows(db, course="gamma-course", username="ana1"):
    """(chapter_id, best_score, passed, last_lesson_id) of a learner's rows, sorted by chapter."""
    return [
        tuple(row)
        for row in rows(
            db,
            "SELECT chapter_id, best_score, passed_at IS NOT NULL, last_lesson_id"
            " FROM app.chapter_progress WHERE account_id = :a AND course_id = :c"
            " ORDER BY chapter_id",
            a=account_id(db, username),
            c=course,
        )
    ]


def snapshot(db) -> dict[str, list]:
    """Every row of the tables a request must not change."""
    return {
        table: [tuple(row) for row in rows(db, f"SELECT * FROM app.{table} ORDER BY 1, 2, 3")]
        for table in SNAPSHOT_TABLES
    }


def visitor_headers(kind: str, signed_in_client, clock) -> dict:
    """A Cookie header for one of the four kinds of visitor.

    The expired kind uses the signed-in client's own session, with the clock at exactly its
    `expires_at`. The client must be signed in before this is called.
    """
    if kind == "no cookie":
        return {}
    if kind == "malformed cookie":
        return with_cookie("garbage")
    if kind == "unknown token":
        return with_cookie("a" * 43)
    token = signed_in_client.cookies.get("session")
    clock.advance(days=1)
    return with_cookie(token)


def committed_spec() -> dict:
    """`openapi.yaml` at the repo root, as plain data."""
    return yaml.safe_load((BACKEND_DIR.parent / "openapi.yaml").read_text(encoding="utf-8"))
