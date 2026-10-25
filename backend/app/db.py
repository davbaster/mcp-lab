"""Database access: DATABASE_URL parsing, the engine, and the declarative Base.

Nothing here connects at import time. The engine is created on first use.
"""

import os
from functools import lru_cache

from sqlalchemy import MetaData, create_engine
from sqlalchemy.engine import URL, Engine, make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.orm import DeclarativeBase

from app.db_pool import InstrumentedQueuePool

SCHEMA = "app"
EXPECTED_FORM = "postgresql+psycopg://user:password@host:port/dbname"
CONNECT_TIMEOUT_SECONDS = 5

# The standard SQLAlchemy naming convention, so constraint names are predictable.
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
    """DATABASE_URL is missing or malformed. The message never contains the URL."""


def _error(problem: str) -> DatabaseUrlError:
    return DatabaseUrlError(f"DATABASE_URL {problem}. Expected form: {EXPECTED_FORM}")


def parse_database_url(raw: str | None) -> URL:
    """Validate a DATABASE_URL value and return it as a SQLAlchemy URL on the psycopg driver."""
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
    """Read and validate DATABASE_URL from the environment."""
    return parse_database_url(os.environ.get("DATABASE_URL"))


def create_db_engine(url: URL, **kwargs: object) -> Engine:
    # hide_parameters keeps bound values (a password hash, a username) out of error messages.
    # The pool is SQLAlchemy's default one with its default sizes, plus the numbers the metrics
    # read (app.db_pool). A caller may pass its own `poolclass`.
    kwargs.setdefault("poolclass", InstrumentedQueuePool)
    return create_engine(
        url,
        connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
        hide_parameters=True,
        **kwargs,
    )


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    """The shared engine, created on first use. Tests clear the cache with get_engine.cache_clear()."""
    return create_db_engine(get_database_url())


def peek_engine() -> Engine | None:
    """The shared engine if it has been created, else None. Never creates it or connects."""
    return get_engine() if get_engine.cache_info().currsize else None
