"""One database session per request, and a way to keep database details out of the logs."""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.db import get_engine


def get_db_session() -> Iterator[Session]:
    """FastAPI dependency: a session that is closed (and rolled back if open) after the request."""
    with Session(get_engine(), expire_on_commit=False) as session:
        yield session


class DatabaseFailure(RuntimeError):
    """A database error with everything that could hold a submitted value removed.

    Postgres puts the failing row in its error message (a CHECK violation prints every column,
    password hash included), and `hide_parameters` does not cover that. So the route code
    re-raises this, which carries only the SQLSTATE and the constraint name.
    """

    def __init__(self, sqlstate: str | None, constraint: str | None) -> None:
        super().__init__(f"Database error (SQLSTATE {sqlstate or 'unknown'}).")
        self.sqlstate = sqlstate
        self.constraint = constraint


@contextmanager
def hide_database_details() -> Iterator[None]:
    try:
        yield
    except DBAPIError as exc:
        orig = exc.orig
        diag = getattr(orig, "diag", None)
        raise DatabaseFailure(
            getattr(orig, "sqlstate", None), getattr(diag, "constraint_name", None)
        ) from None
