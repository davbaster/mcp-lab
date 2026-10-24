import subprocess
import sys

import pytest

from app.db import EXPECTED_FORM, DatabaseUrlError, get_engine, parse_database_url
from tests.conftest import PASSWORD_SENTINEL
from tests.dbtools import BACKEND_DIR
from tests.helpers import env_with_url


def test_psycopg_url_is_accepted_as_is():
    url = parse_database_url("postgresql+psycopg://u:p@127.0.0.1:5432/mcp_lab")

    assert url.drivername == "postgresql+psycopg"
    assert (url.username, url.password, url.host, url.port, url.database) == (
        "u",
        "p",
        "127.0.0.1",
        5432,
        "mcp_lab",
    )


def test_url_without_driver_uses_psycopg():
    url = parse_database_url("postgresql://u:p@127.0.0.1:5432/mcp_lab")

    assert url.drivername == "postgresql+psycopg"
    assert url.password == "p"


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "   ",
        "sqlite:///x.db",
        "mysql://u:p@h/db",
        "not a url",
        "postgresql+psycopg://u:p@h:5432/",
    ],
    ids=["unset", "empty", "whitespace", "sqlite", "mysql", "not-a-url", "no-database-name"],
)
def test_bad_url_raises_error_naming_variable_and_expected_form(raw):
    with pytest.raises(DatabaseUrlError) as excinfo:
        parse_database_url(raw)

    message = str(excinfo.value)
    assert "DATABASE_URL" in message
    assert "postgresql+psycopg://user:password@host:port/dbname" in message
    assert EXPECTED_FORM in message


@pytest.mark.parametrize(
    "raw", ["  postgresql+psycopg://u:p@h/db\n", "\tpostgresql://u:p@h/db \r\n"]
)
def test_surrounding_whitespace_is_ignored(raw):
    url = parse_database_url(raw)

    assert url.database == "db"
    assert url.password == "p"


@pytest.mark.parametrize(
    "template",
    [
        f"sqlite://u:{PASSWORD_SENTINEL}@h/db",
        f"mysql://u:{PASSWORD_SENTINEL}@h/db",
        f"postgresql+psycopg://u:{PASSWORD_SENTINEL}@h:5432/",
        f"postgresql+psycopg2://u:{PASSWORD_SENTINEL}@h:5432/db",
        f"postgresql+psycopg://u:{PASSWORD_SENTINEL}@h:notaport/db",
        f"not a url {PASSWORD_SENTINEL}",
    ],
)
def test_error_messages_never_contain_the_password(template):
    with pytest.raises(DatabaseUrlError) as excinfo:
        parse_database_url(template)

    assert PASSWORD_SENTINEL not in str(excinfo.value)
    assert PASSWORD_SENTINEL not in repr(excinfo.value)


def test_percent_encoded_password_is_decoded_by_the_engine(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://u:p%40ss%25w@h/db")
    get_engine.cache_clear()
    try:
        assert get_engine().url.password == "p@ss%w"
    finally:
        get_engine.cache_clear()


def test_importing_the_app_with_database_url_unset_does_not_raise():
    proc = subprocess.run(
        [sys.executable, "-c", "import app.main, app.db"],
        cwd=BACKEND_DIR,
        env=env_with_url(None),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert proc.returncode == 0, proc.stderr


def test_engine_is_created_on_first_use_not_at_import():
    code = (
        "import app.db as d;"
        "assert d.get_engine.cache_info().currsize == 0;"
        "e = d.get_engine();"
        "assert d.get_engine.cache_info().currsize == 1"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=BACKEND_DIR,
        env=env_with_url("postgresql+psycopg://u:p@127.0.0.1:1/db"),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert proc.returncode == 0, proc.stderr
