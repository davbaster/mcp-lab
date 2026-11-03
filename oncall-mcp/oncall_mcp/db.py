"""Database access for the ops schema: OPS_DATABASE_URL parsing, the engine, and the declarative Base.

Nothing here connects at import time.
"""

import os

from sqlalchemy import MetaData, create_engine
from sqlalchemy.engine import URL, Engine, make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.orm import DeclarativeBase

SCHEMA = "ops"
# The ops history keeps its own version table, because the app's one is public.alembic_version.
VERSION_TABLE = "ops_alembic_version"
EXPECTED_FORM = "postgresql+psycopg://user:password@host:port/dbname"
CONNECT_TIMEOUT_SECONDS = 5

# The standard SQLAlchemy naming convention, so constraint names are predictable (same as the app's).
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(schema=SCHEMA, naming_convention=NAMING_CONVENTION)


class DatabaseUrlError(ValueError):
    """OPS_DATABASE_URL is missing or malformed. The message never contains the URL."""


def _error(problem: str) -> DatabaseUrlError:
    return DatabaseUrlError(f"OPS_DATABASE_URL {problem}. Expected form: {EXPECTED_FORM}")


def parse_database_url(raw: str | None) -> URL:
    """Validate an OPS_DATABASE_URL value and return it as a SQLAlchemy URL on the psycopg driver."""
    if raw is None or not raw.strip():
        raise _error("is not set")
    try:
        url = make_url(raw.strip())
    except (ArgumentError, ValueError):
        # Not echoed: the value may hold a password.
        raise _error("is not a valid URL") from None
    if url.drivername not in ("postgresql", "postgresql+psycopg"):
        raise _error("must be a PostgreSQL URL")
    if not url.database:
        raise _error("has no database name")
    return url.set(drivername="postgresql+psycopg")


def get_database_url() -> URL:
    """Read and validate OPS_DATABASE_URL from the environment."""
    return parse_database_url(os.environ.get("OPS_DATABASE_URL"))


def create_db_engine(url: URL, **kwargs: object) -> Engine:
    # hide_parameters keeps bound values out of error messages.
    return create_engine(
        url,
        connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
        hide_parameters=True,
        **kwargs,
    )
