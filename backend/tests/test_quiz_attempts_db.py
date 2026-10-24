"""The quiz_attempts table and migration 0004 (#16)."""

import json
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.helpers import alembic, env_with_url
from tests.test_accounts_db import add_account

NOW = datetime(2030, 1, 1, tzinfo=UTC)


def add_attempt(
    conn,
    account_id,
    course="mcp-server",
    chapter="01-intro",
    score=3,
    passed=False,
    answers="{}",
    created=NOW,
):
    conn.execute(
        text(
            "INSERT INTO app.quiz_attempts"
            " (id, account_id, course_id, chapter_id, score, passed, answers, created_at)"
            " VALUES (:id, :a, :c, :ch, :s, :p, CAST(:ans AS jsonb), :t)"
        ),
        {
            "id": uuid.uuid4(),
            "a": account_id,
            "c": course,
            "ch": chapter,
            "s": score,
            "p": passed,
            "ans": answers,
            "t": created,
        },
    )


def constraint_of(excinfo) -> str:
    return excinfo.value.orig.diag.constraint_name


def count(db) -> int:
    with db.connect() as conn:
        return conn.execute(text("SELECT count(*) FROM app.quiz_attempts")).scalar_one()


def test_the_table_has_exactly_these_columns_with_these_types(db):
    with db.connect() as conn:
        found = conn.execute(
            text(
                "SELECT column_name, data_type, is_nullable FROM information_schema.columns"
                " WHERE table_schema = 'app' AND table_name = 'quiz_attempts'"
                " ORDER BY ordinal_position"
            )
        ).all()

    assert [tuple(r) for r in found] == [
        ("id", "uuid", "NO"),
        ("account_id", "uuid", "NO"),
        ("course_id", "text", "NO"),
        ("chapter_id", "text", "NO"),
        ("score", "smallint", "NO"),
        ("passed", "boolean", "NO"),
        ("answers", "jsonb", "NO"),
        ("created_at", "timestamp with time zone", "NO"),
    ]


def test_the_primary_key_is_the_id(db):
    with db.connect() as conn:
        key = (
            conn.execute(
                text(
                    "SELECT a.attname FROM pg_index i"
                    " JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)"
                    " WHERE i.indrelid = 'app.quiz_attempts'::regclass AND i.indisprimary"
                )
            )
            .scalars()
            .all()
        )

    assert key == ["id"]


def test_there_is_an_index_on_account_id(db):
    with db.connect() as conn:
        definitions = (
            conn.execute(
                text(
                    "SELECT indexdef FROM pg_indexes"
                    " WHERE schemaname = 'app' AND tablename = 'quiz_attempts'"
                    " AND indexname = 'ix_app_quiz_attempts_account_id'"
                )
            )
            .scalars()
            .all()
        )

    assert len(definitions) == 1
    assert "(account_id)" in definitions[0]


@pytest.mark.parametrize("score", [-1, 6, 100])
def test_a_score_outside_0_to_5_is_rejected(db, score):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_attempt(conn, add_account(conn, "Ana1"), score=score)

    assert constraint_of(excinfo) == "ck_quiz_attempts_score_range"


@pytest.mark.parametrize("score", [0, 5])
def test_a_score_of_0_or_5_is_accepted(db, score):
    with db.begin() as conn:
        add_attempt(conn, add_account(conn, "Ana1"), score=score)

    assert count(db) == 1


def test_a_row_without_a_course_id_is_rejected(db):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        account = add_account(conn, "Ana1")
        conn.execute(
            text(
                "INSERT INTO app.quiz_attempts (id, account_id, chapter_id, score, passed,"
                " answers, created_at) VALUES (:id, :a, 'x', 1, false, '{}', :t)"
            ),
            {"id": uuid.uuid4(), "a": account, "t": NOW},
        )

    assert excinfo.value.orig.diag.column_name == "course_id"


@pytest.mark.parametrize("column", ["chapter_id", "score", "passed", "answers", "created_at"])
def test_every_other_column_is_not_null(db, column):
    values = {
        "id": ":id",
        "account_id": ":a",
        "course_id": "'c'",
        "chapter_id": "'x'",
        "score": "1",
        "passed": "false",
        "answers": "'{}'::jsonb",
        "created_at": ":t",
    }
    values[column] = "NULL"
    sql = (
        f"INSERT INTO app.quiz_attempts ({', '.join(values)}) VALUES ({', '.join(values.values())})"
    )

    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        conn.execute(text(sql), {"id": uuid.uuid4(), "a": add_account(conn, "Ana1"), "t": NOW})

    assert excinfo.value.orig.diag.column_name == column


BAD_IDS = ["", "ok\n", "Upper", "has space", "under_score", "dot.dot", "slash/x", "é", "a b"]


@pytest.mark.parametrize("bad", BAD_IDS)
def test_a_course_id_that_is_not_lowercase_digits_and_hyphens_is_rejected(db, bad):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_attempt(conn, add_account(conn, "Ana1"), course=bad)

    assert constraint_of(excinfo) == "ck_quiz_attempts_course_id_format"


@pytest.mark.parametrize("bad", BAD_IDS)
def test_a_chapter_id_that_is_not_lowercase_digits_and_hyphens_is_rejected(db, bad):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_attempt(conn, add_account(conn, "Ana1"), chapter=bad)

    assert constraint_of(excinfo) == "ck_quiz_attempts_chapter_id_format"


@pytest.mark.parametrize("answers", ["[]", '["a"]', '"a"', "1", "null", "true"])
def test_an_answers_value_that_is_not_an_object_is_rejected(db, answers):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_attempt(conn, add_account(conn, "Ana1"), answers=answers)

    assert constraint_of(excinfo) == "ck_quiz_attempts_answers_is_object"


def test_an_answers_object_is_stored_as_it_is(db):
    answers = {"01-first-1": "k3q7-1-1", "01-first-2": "w9d2-1-2-y"}
    with db.begin() as conn:
        add_attempt(conn, add_account(conn, "Ana1"), answers=json.dumps(answers))

    with db.connect() as conn:
        stored = conn.execute(text("SELECT answers FROM app.quiz_attempts")).scalar_one()
    assert stored == answers


def test_a_row_for_a_missing_account_is_rejected(db):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_attempt(conn, uuid.uuid4())

    assert constraint_of(excinfo) == "fk_quiz_attempts_account_id_accounts"


def test_one_learner_may_have_many_attempts_for_one_chapter(db):
    with db.begin() as conn:
        account = add_account(conn, "Ana1")
        for score in (1, 2, 5):
            add_attempt(conn, account, score=score)

    assert count(db) == 3


def test_deleting_an_account_deletes_only_its_attempts(db):
    with db.begin() as conn:
        mine = add_account(conn, "Ana1")
        other = add_account(conn, "Bob1")
        add_attempt(conn, mine)
        add_attempt(conn, mine, chapter="02-b")
        add_attempt(conn, other)

    with db.begin() as conn:
        conn.execute(text("DELETE FROM app.accounts WHERE id = :id"), {"id": mine})

    with db.connect() as conn:
        left = conn.execute(text("SELECT account_id FROM app.quiz_attempts")).scalars().all()
    assert left == [other]


def test_the_per_test_truncate_empties_the_table(db):
    assert count(db) == 0


def test_downgrade_to_0003_drops_the_table_and_upgrade_brings_it_back(
    db, database_url, restore_head
):
    env = env_with_url(database_url)

    down = alembic("downgrade", "0003", env=env)

    assert down.returncode == 0, down.output
    with db.connect() as conn:
        assert conn.execute(text("SELECT to_regclass('app.quiz_attempts')")).scalar_one() is None
        assert (
            conn.execute(text("SELECT to_regclass('app.chapter_progress')")).scalar_one()
            is not None
        )
    up = alembic("upgrade", "head", env=env)
    assert up.returncode == 0, up.output
    with db.connect() as conn:
        assert (
            conn.execute(text("SELECT to_regclass('app.quiz_attempts')")).scalar_one() is not None
        )


def test_0004_follows_0003_and_is_the_only_head(database_url):
    env = env_with_url(database_url)
    heads = alembic("heads", env=env)
    history = alembic("history", env=env)

    assert heads.returncode == 0 and history.returncode == 0, heads.output + history.output
    head_lines = [line for line in heads.output.splitlines() if "(head)" in line]
    assert len(head_lines) == 1 and head_lines[0].startswith("0004")
    assert any(line.startswith("0003 -> 0004") for line in history.output.splitlines())


def test_alembic_check_finds_the_model_and_the_migration_in_agreement(database_url):
    result = alembic("check", env=env_with_url(database_url))

    assert result.returncode == 0, result.output
