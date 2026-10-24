"""The pytest setup itself: startup guard, database creation, reset at session start."""

import sys

import pytest
from sqlalchemy import text

from app.db import create_db_engine
from tests.conftest import PASSWORD_SENTINEL
from tests.dbtools import (
    DatabaseSetupError,
    drop_database,
    ensure_database,
    reset_and_migrate,
    with_database,
)
from tests.helpers import env_with_url, run, url_text

PYTEST = [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "tests/test_home.py"]


def test_pytest_without_database_url_fails_before_any_test_runs():
    result = run(PYTEST, env_with_url(None))

    assert result.returncode != 0
    assert "DATABASE_URL" in result.output
    assert "Test database" in result.output
    assert "README" in result.output
    assert "passed" not in result.output
    assert "skipped" not in result.output


def test_pytest_with_non_test_database_fails_before_any_connection():
    # Port 1 is closed: a connection attempt would give a connection error, not the guard message.
    url = f"postgresql+psycopg://u:{PASSWORD_SENTINEL}@127.0.0.1:1/mcp_lab"

    result = run(PYTEST, env_with_url(url))

    assert result.returncode != 0
    assert "mcp_lab" in result.output
    assert "_test" in result.output
    assert PASSWORD_SENTINEL not in result.output
    assert "refused" not in result.output.lower()
    assert "passed" not in result.output


def test_pytest_with_unreachable_test_database_fails_without_the_password():
    url = f"postgresql+psycopg://u:{PASSWORD_SENTINEL}@127.0.0.1:1/mcp_lab_test"

    result = run(PYTEST, env_with_url(url))

    assert result.returncode != 0
    assert "Could not connect" in result.output
    assert PASSWORD_SENTINEL not in result.output
    assert "passed" not in result.output


def test_missing_test_database_is_created_including_hyphen_names(database_url):
    url = with_database(database_url, "mcp-lab_probe_test")
    drop_database(url)
    admin = create_db_engine(with_database(database_url, "postgres"))
    try:
        ensure_database(url)
        ensure_database(url)  # already there: no failure

        with admin.connect() as conn:
            found = conn.execute(
                text("SELECT count(*) FROM pg_database WHERE datname = :n"), {"n": url.database}
            ).scalar_one()
        assert found == 1
    finally:
        admin.dispose()
        drop_database(url)


def test_role_that_cannot_create_databases_gets_the_createdb_command(database_url, db_engine):
    role = "mcp_lab_nocreate"
    probe = "nocreate_probe_test"
    drop_database(with_database(database_url, probe))
    with db_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(text(f"DROP ROLE IF EXISTS {role}"))
        conn.execute(text(f"CREATE ROLE {role} LOGIN NOCREATEDB PASSWORD '{PASSWORD_SENTINEL}'"))
    try:
        url = database_url.set(username=role, password=PASSWORD_SENTINEL, database=probe)

        result = run(PYTEST, env_with_url(url_text(url)))
    finally:
        with db_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(f"DROP ROLE IF EXISTS {role}"))

    assert result.returncode != 0
    assert f"createdb {probe}" in result.output
    assert PASSWORD_SENTINEL not in result.output
    assert "passed" not in result.output


def test_unreachable_server_error_has_no_password():
    url = f"postgresql+psycopg://u:{PASSWORD_SENTINEL}@127.0.0.1:1/mcp_lab_test"
    from sqlalchemy.engine import make_url

    with pytest.raises(DatabaseSetupError) as excinfo:
        ensure_database(make_url(url))

    assert PASSWORD_SENTINEL not in str(excinfo.value)


def test_reset_removes_stale_state_and_migrates_to_head(database_url, db_engine, restore_head):
    with db_engine.begin() as conn:
        conn.execute(text("CREATE TABLE app.stale_leftover (id int)"))
        conn.execute(text("UPDATE public.alembic_version SET version_num = 'stale'"))

    reset_and_migrate(database_url)

    with db_engine.connect() as conn:
        tables = (
            conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = 'app'"))
            .scalars()
            .all()
        )
        versions = (
            conn.execute(text("SELECT version_num FROM public.alembic_version")).scalars().all()
        )
    assert tables == []
    assert versions == ["0001"]
