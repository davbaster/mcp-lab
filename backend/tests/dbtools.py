"""Test-database helpers: the `_test` guard, database creation, reset, and truncation.

Never log or print a URL here. Messages name the database, never the password.
"""

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import URL
from sqlalchemy.exc import OperationalError, ProgrammingError

from app.db import create_db_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
README_HINT = "See the 'Test database' section of README.md."
SUFFIX = "_test"
# Postgres error codes: invalid_catalog_name, insufficient_privilege.
_DATABASE_MISSING = "3D000"
_NO_PRIVILEGE = "42501"


class DatabaseSetupError(Exception):
    """The test database cannot be used. The message is safe to print."""


def check_test_database(url: URL) -> None:
    """Refuse any URL that does not clearly point at a `_test` database.

    Judges the database name as parsed by SQLAlchemy, never the raw string.
    """
    overrides = sorted({"dbname", "service"} & set(url.query))
    if overrides:
        raise DatabaseSetupError(
            f"DATABASE_URL has a {overrides[0]}= parameter, which overrides the database name "
            f"when connecting. Remove it. {README_HINT}"
        )
    name = url.database
    if not name:
        raise DatabaseSetupError(
            f"DATABASE_URL has no database name; the tests need a name ending in {SUFFIX}. "
            f"{README_HINT}"
        )
    if not name.endswith(SUFFIX) or len(name) == len(SUFFIX):
        raise DatabaseSetupError(
            f"Refusing to run: DATABASE_URL points at database '{name}', but the tests only run "
            f"against a database whose name ends in {SUFFIX} (they empty every table). "
            f"{README_HINT}"
        )


def with_database(url: URL, database: str) -> URL:
    return url.set(database=database)


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _sqlstate(exc: Exception) -> str | None:
    return getattr(getattr(exc, "orig", None), "sqlstate", None)


def ensure_database(url: URL) -> None:
    """Create the test database through the `postgres` maintenance database if it is missing."""
    check_test_database(url)
    name = url.database
    engine = create_db_engine(url)
    try:
        with engine.connect():
            return
    except OperationalError as exc:
        # A failed connection carries no SQLSTATE, so the server's message is checked too.
        missing = _sqlstate(exc) == _DATABASE_MISSING or "does not exist" in str(exc.orig)
        if not missing:
            raise DatabaseSetupError(
                f"Could not connect to the test database server ({exc.orig}). "
                f"Is the test Postgres running? {README_HINT}"
            ) from None
    finally:
        engine.dispose()

    admin = create_db_engine(with_database(url, "postgres"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(text(f"CREATE DATABASE {_quote(name)}"))
    except (OperationalError, ProgrammingError) as exc:
        if _sqlstate(exc) == _NO_PRIVILEGE:
            raise DatabaseSetupError(
                f"The test database '{name}' does not exist and this role cannot create it. "
                f"Create it by hand with: createdb {name}  "
                f"(add -h, -p and -U for your server). {README_HINT}"
            ) from None
        raise DatabaseSetupError(
            f"Could not create the test database '{name}' ({exc.orig}). "
            f"Create it by hand with: createdb {name}. {README_HINT}"
        ) from None
    finally:
        admin.dispose()


def drop_database(url: URL) -> None:
    """Drop a `_test` database (used by tests that create their own)."""
    check_test_database(url)
    admin = create_db_engine(with_database(url, "postgres"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {_quote(url.database)} WITH (FORCE)"))
    finally:
        admin.dispose()


def alembic_config() -> Config:
    return Config(str(BACKEND_DIR / "alembic.ini"))


def reset_and_migrate(url: URL) -> None:
    """Drop the app schema and the version table, then migrate to head."""
    check_test_database(url)
    engine = create_db_engine(url)
    try:
        with engine.begin() as conn:
            conn.execute(text("DROP SCHEMA IF EXISTS app CASCADE"))
            conn.execute(text("DROP TABLE IF EXISTS public.alembic_version"))
    finally:
        engine.dispose()
    command.upgrade(alembic_config(), "head")


def truncate_app_tables(engine) -> None:
    """Empty every table in the app schema, found in the catalog at run time."""
    with engine.begin() as conn:
        names = (
            conn.execute(
                text("SELECT tablename FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename")
            )
            .scalars()
            .all()
        )
        if names:
            tables = ", ".join(f"app.{_quote(n)}" for n in names)
            conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
