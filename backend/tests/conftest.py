import logging
import os

import pytest

from app.db import DatabaseUrlError, get_database_url, get_engine
from tests.dbtools import (
    README_HINT,
    DatabaseSetupError,
    check_test_database,
    ensure_database,
    reset_and_migrate,
    truncate_app_tables,
)

# A fake password used in URLs by tests that prove secrets never leak.
PASSWORD_SENTINEL = "PW-SENTINEL-9c1e"


def pytest_configure(config):
    """Validate DATABASE_URL, then create, reset, and migrate the test database.

    Runs before any test is collected. A bad URL stops here, before any connection.
    """
    try:
        url = get_database_url()
    except DatabaseUrlError as exc:
        raise pytest.UsageError(f"{exc}. The tests need a test database. {README_HINT}") from None
    try:
        check_test_database(url)
        ensure_database(url)
        reset_and_migrate(url)
    except DatabaseSetupError as exc:
        raise pytest.UsageError(str(exc)) from None


@pytest.fixture(scope="session")
def database_url():
    return get_database_url()


@pytest.fixture(scope="session")
def db_engine():
    engine = get_engine()
    yield engine
    engine.dispose()
    get_engine.cache_clear()


@pytest.fixture
def db(db_engine):
    """The test engine, with every table in the app schema emptied first.

    Truncate, not rollback: API handlers open their own sessions.
    """
    truncate_app_tables(db_engine)
    return db_engine


@pytest.fixture(autouse=True)
def no_password_in_logs(caplog):
    caplog.set_level(logging.DEBUG)
    yield
    assert PASSWORD_SENTINEL not in caplog.text


@pytest.fixture
def restore_head(database_url):
    """For tests that run Alembic: leave the test database at head, even when they fail."""
    yield
    reset_and_migrate(database_url)


@pytest.fixture
def clean_env():
    """Environment for subprocesses: the current one, without DATABASE_URL."""
    env = dict(os.environ)
    env.pop("DATABASE_URL", None)
    return env
