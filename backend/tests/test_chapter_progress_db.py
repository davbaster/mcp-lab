"""The chapter_progress table and migration 0003 (#14)."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.helpers import alembic, env_with_url
from tests.test_accounts_db import add_account

NOW = datetime(2030, 1, 1, tzinfo=UTC)
COLUMNS = ["account_id", "course_id", "chapter_id", "best_score", "passed_at", "last_lesson_id"]


def add_progress(
    conn, account_id, course="mcp-server", chapter="01-intro", score=None, passed_at=None, last=None
):
    conn.execute(
        text(
            "INSERT INTO app.chapter_progress"
            " (account_id, course_id, chapter_id, best_score, passed_at, last_lesson_id)"
            " VALUES (:a, :c, :ch, :s, :p, :l)"
        ),
        {"a": account_id, "c": course, "ch": chapter, "s": score, "p": passed_at, "l": last},
    )


def constraint_of(excinfo) -> str:
    return excinfo.value.orig.diag.constraint_name


def count(db) -> int:
    with db.connect() as conn:
        return conn.execute(text("SELECT count(*) FROM app.chapter_progress")).scalar_one()


def test_the_table_has_exactly_these_columns_with_these_types(db):
    with db.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT column_name, data_type, is_nullable FROM information_schema.columns"
                " WHERE table_schema = 'app' AND table_name = 'chapter_progress'"
                " ORDER BY ordinal_position"
            )
        ).all()

    assert [tuple(r) for r in rows] == [
        ("account_id", "uuid", "NO"),
        ("course_id", "text", "NO"),
        ("chapter_id", "text", "NO"),
        ("best_score", "smallint", "YES"),
        ("passed_at", "timestamp with time zone", "YES"),
        ("last_lesson_id", "text", "YES"),
    ]  # no status column: status is computed


def test_the_primary_key_is_account_course_chapter(db):
    with db.connect() as conn:
        key = (
            conn.execute(
                text(
                    "SELECT a.attname FROM pg_index i"
                    " JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)"
                    " WHERE i.indrelid = 'app.chapter_progress'::regclass AND i.indisprimary"
                    " ORDER BY array_position(i.indkey::int[], a.attnum::int)"
                )
            )
            .scalars()
            .all()
        )

    assert key == ["account_id", "course_id", "chapter_id"]


@pytest.mark.parametrize("score", [-1, 6, 100])
def test_a_best_score_outside_0_to_5_is_rejected(db, score):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_progress(conn, add_account(conn, "Ana1"), score=score)

    assert constraint_of(excinfo) == "ck_chapter_progress_best_score_range"


@pytest.mark.parametrize("score", [0, 5, None])
def test_a_best_score_of_0_or_5_or_null_is_accepted(db, score):
    with db.begin() as conn:
        add_progress(conn, add_account(conn, "Ana1"), score=score)

    assert count(db) == 1


def test_a_pass_without_a_score_is_rejected(db):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_progress(conn, add_account(conn, "Ana1"), score=None, passed_at=NOW)

    assert constraint_of(excinfo) == "ck_chapter_progress_passed_has_score"


@pytest.mark.parametrize("score", [0, 4, 5])
def test_a_pass_with_a_score_is_accepted(db, score):
    with db.begin() as conn:
        add_progress(conn, add_account(conn, "Ana1"), score=score, passed_at=NOW)

    assert count(db) == 1


def test_a_row_with_only_a_last_lesson_is_accepted(db):
    with db.begin() as conn:
        add_progress(conn, add_account(conn, "Ana1"), last="hello")

    with db.connect() as conn:
        row = conn.execute(
            text("SELECT best_score, passed_at, last_lesson_id FROM app.chapter_progress")
        ).one()
    assert tuple(row) == (None, None, "hello")


BAD_IDS = [
    "",
    "ok\n",
    "Upper",
    "has space",
    "under_score",
    "dot.dot",
    "slash/x",
    "é",
    "new\nline",
    "a b",
]


@pytest.mark.parametrize("bad", BAD_IDS)
def test_a_course_id_that_is_not_lowercase_digits_and_hyphens_is_rejected(db, bad):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_progress(conn, add_account(conn, "Ana1"), course=bad)

    assert constraint_of(excinfo) == "ck_chapter_progress_course_id_format"


@pytest.mark.parametrize("bad", BAD_IDS)
def test_a_chapter_id_that_is_not_lowercase_digits_and_hyphens_is_rejected(db, bad):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_progress(conn, add_account(conn, "Ana1"), chapter=bad)

    assert constraint_of(excinfo) == "ck_chapter_progress_chapter_id_format"


@pytest.mark.parametrize("bad", BAD_IDS)
def test_a_last_lesson_id_that_is_neither_null_nor_in_that_format_is_rejected(db, bad):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_progress(conn, add_account(conn, "Ana1"), last=bad)

    assert constraint_of(excinfo) == "ck_chapter_progress_last_lesson_id_format"


def test_ids_in_the_allowed_format_are_accepted(db):
    with db.begin() as conn:
        add_progress(conn, add_account(conn, "Ana1"), course="a-1", chapter="01-x", last="9-z")

    assert count(db) == 1


def test_a_second_row_for_the_same_account_course_and_chapter_is_rejected(db):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        account = add_account(conn, "Ana1")
        add_progress(conn, account)
        add_progress(conn, account)

    assert constraint_of(excinfo) == "pk_chapter_progress"


def test_a_row_for_a_missing_account_is_rejected(db):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_progress(conn, uuid.uuid4())

    assert constraint_of(excinfo) == "fk_chapter_progress_account_id_accounts"


def test_the_same_chapter_id_in_two_courses_is_two_rows(db):
    with db.begin() as conn:
        account = add_account(conn, "Ana1")
        add_progress(conn, account, course="alpha-course", chapter="01-x")
        add_progress(conn, account, course="beta-course", chapter="01-x")

    assert count(db) == 2


def test_the_same_chapter_in_two_accounts_is_two_rows(db):
    with db.begin() as conn:
        add_progress(conn, add_account(conn, "Ana1"))
        add_progress(conn, add_account(conn, "Bob1"))

    assert count(db) == 2


def test_deleting_an_account_deletes_only_its_progress(db):
    with db.begin() as conn:
        mine = add_account(conn, "Ana1")
        other = add_account(conn, "Bob1")
        add_progress(conn, mine, chapter="01-a")
        add_progress(conn, mine, chapter="02-b")
        add_progress(conn, other, chapter="01-a")

    with db.begin() as conn:
        conn.execute(text("DELETE FROM app.accounts WHERE id = :id"), {"id": mine})

    with db.connect() as conn:
        left = conn.execute(text("SELECT account_id FROM app.chapter_progress")).scalars().all()
    assert left == [other]


def test_the_per_test_truncate_empties_the_table(db):
    assert count(db) == 0


def test_downgrade_to_0002_drops_the_table_and_upgrade_brings_it_back(
    db, database_url, restore_head
):
    env = env_with_url(database_url)

    down = alembic("downgrade", "0002", env=env)

    assert down.returncode == 0, down.output
    with db.connect() as conn:
        assert conn.execute(text("SELECT to_regclass('app.chapter_progress')")).scalar_one() is None
        assert conn.execute(text("SELECT to_regclass('app.accounts')")).scalar_one() is not None
    up = alembic("upgrade", "head", env=env)
    assert up.returncode == 0, up.output
    with db.connect() as conn:
        assert (
            conn.execute(text("SELECT to_regclass('app.chapter_progress')")).scalar_one()
            is not None
        )


def test_0003_is_the_only_head(database_url):
    heads = alembic("heads", env=env_with_url(database_url))

    assert heads.returncode == 0, heads.output
    assert [line for line in heads.output.splitlines() if "(head)" in line] == [
        line for line in heads.output.splitlines() if line.startswith("0003")
    ]
    assert len([line for line in heads.output.splitlines() if "(head)" in line]) == 1
