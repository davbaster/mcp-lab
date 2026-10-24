import logging
import os

import pytest
from fastapi.testclient import TestClient

from app.db import DatabaseUrlError, get_database_url, get_engine
from tests.contract import (
    MarkerError,
    SpecFileError,
    committed_openapi,
    contract_for,
    exempt_statuses,
)
from tests.dbtools import (
    README_HINT,
    DatabaseSetupError,
    check_test_database,
    ensure_database,
    reset_and_migrate,
    truncate_app_tables,
)

# Fixtures for the account and session tests (#6): client, clock, cheap_hasher.
# Fixtures for the course tests (#13): build_copy, serve.
# Fixtures for the lesson, last-lesson, and quiz tests (#15): content_api, learner.
pytest_plugins = ["tests.auth_support", "tests.course_support", "tests.content_support"]

# A fake password used in URLs by tests that prove secrets never leak.
PASSWORD_SENTINEL = "PW-SENTINEL-9c1e"


def pytest_configure(config):
    """Validate DATABASE_URL, then create, reset, and migrate the test database.

    Runs before any test is collected. A bad URL stops here, before any connection. Also reads
    openapi.yaml, so a missing or broken file stops the run with an error that names it.
    """
    try:
        committed_openapi()
    except SpecFileError as exc:
        raise pytest.UsageError(str(exc)) from None
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


@pytest.fixture(autouse=True)
def contract_check(request, monkeypatch):
    """Check every response a `TestClient` gets against the OpenAPI document (see contract.py).

    Wraps the client's per-hop send, so redirects it follows and `follow_redirects=False`
    responses are checked too, and so is a client a test builds inside its own body.
    """
    try:
        exempt = exempt_statuses(request.node.get_closest_marker("undocumented_status"))
    except MarkerError as exc:
        pytest.fail(str(exc), pytrace=False)
    send = TestClient._send_single_request

    def checked_send(self, http_request):
        response = send(self, http_request)
        try:
            contract_for(self.app).check(http_request, response, exempt)
        except BaseException:
            response.close()
            raise
        return response

    monkeypatch.setattr(TestClient, "_send_single_request", checked_send)
