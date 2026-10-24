"""The accounts and sessions tables and migration 0002 (#6)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.helpers import alembic, env_with_url

NOW = datetime(2030, 1, 1, tzinfo=UTC)


def add_account(conn, username: str, normalized: str | None = None) -> uuid.UUID:
    account_id = uuid.uuid4()
    conn.execute(
        text(
            "INSERT INTO app.accounts (id, username, username_normalized, password_hash, created_at)"
            " VALUES (:id, :u, :n, 'h', :t)"
        ),
        {"id": account_id, "u": username, "n": normalized or username.lower(), "t": NOW},
    )
    return account_id


def add_session(
    conn, account_id, token: bytes = b"t1", created=NOW, expires=NOW + timedelta(days=1)
):
    conn.execute(
        text(
            "INSERT INTO app.sessions (token_hash, account_id, created_at, expires_at)"
            " VALUES (:h, :a, :c, :e)"
        ),
        {"h": token, "a": account_id, "c": created, "e": expires},
    )


def test_a_case_variant_duplicate_username_is_rejected_by_the_database(db):
    with db.begin() as conn:
        add_account(conn, "Ana1")

    with pytest.raises(IntegrityError, match="uq_accounts_username_normalized"), db.begin() as conn:
        add_account(conn, "ANA1")


def test_the_database_rejects_a_normalized_name_that_is_not_the_lowercase(db):
    with (
        pytest.raises(IntegrityError, match="ck_accounts_username_normalized_lower"),
        db.begin() as conn,
    ):
        add_account(conn, "Ana1", normalized="Ana1")


def test_a_session_for_a_missing_account_is_rejected(db):
    with pytest.raises(IntegrityError, match="fk_sessions_account_id_accounts"), db.begin() as conn:
        add_session(conn, uuid.uuid4())


@pytest.mark.parametrize("delta", [timedelta(0), timedelta(seconds=-1)], ids=["equal", "before"])
def test_a_session_that_expires_at_or_before_it_was_created_is_rejected(db, delta):
    with (
        pytest.raises(IntegrityError, match="ck_sessions_expires_after_created"),
        db.begin() as conn,
    ):
        add_session(conn, add_account(conn, "Ana1"), expires=NOW + delta)


def test_deleting_an_account_deletes_its_sessions(db):
    with db.begin() as conn:
        mine = add_account(conn, "Ana1")
        other = add_account(conn, "Bob1")
        add_session(conn, mine, b"t1")
        add_session(conn, mine, b"t2")
        add_session(conn, other, b"t3")

    with db.begin() as conn:
        conn.execute(text("DELETE FROM app.accounts WHERE id = :id"), {"id": mine})

    with db.connect() as conn:
        remaining = conn.execute(text("SELECT token_hash FROM app.sessions")).scalars().all()
    assert [bytes(r) for r in remaining] == [b"t3"]


def test_the_per_test_truncate_empties_the_new_tables(db):
    with db.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM app.accounts")).scalar_one() == 0
        assert conn.execute(text("SELECT count(*) FROM app.sessions")).scalar_one() == 0


def test_the_sessions_table_has_the_indexes_the_design_asks_for(db):
    with db.connect() as conn:
        names = (
            conn.execute(text("SELECT indexname FROM pg_indexes WHERE tablename = 'sessions'"))
            .scalars()
            .all()
        )
    assert {"ix_app_sessions_account_id", "ix_app_sessions_expires_at"} <= set(names)


def test_downgrade_to_0001_drops_the_tables_and_upgrade_brings_them_back(
    db, database_url, restore_head
):
    env = env_with_url(database_url)

    down = alembic("downgrade", "0001", env=env)

    assert down.returncode == 0, down.output
    with db.connect() as conn:
        assert conn.execute(text("SELECT to_regclass('app.accounts')")).scalar_one() is None
        assert conn.execute(text("SELECT to_regclass('app.sessions')")).scalar_one() is None
    up = alembic("upgrade", "head", env=env)
    assert up.returncode == 0, up.output
    with db.connect() as conn:
        assert conn.execute(text("SELECT to_regclass('app.accounts')")).scalar_one() is not None


def test_0001_can_still_be_downgraded_after_0002_was_undone(db, database_url, restore_head):
    env = env_with_url(database_url)

    result = alembic("downgrade", "base", env=env)

    assert result.returncode == 0, result.output
