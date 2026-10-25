"""The engine's connection pool, with the numbers the metrics of #36 read.

`InstrumentedQueuePool` is SQLAlchemy's `QueuePool` (the default pool, with the default sizes)
plus two things:

- It counts the callers that are inside `connect()` and have no connection yet. SQLAlchemy has no
  public count of callers blocked on a full pool, so this counts them here. A caller that is
  opening a new connection is inside `connect()` too, so `waiting` also counts it for the moment
  that takes.
- It reports each failed attempt to get a connection, with the reason from `classify`. Pool
  exhaustion is raised by the pool itself as `sqlalchemy.exc.TimeoutError`, which the engine's
  connection-error event does not see, and a connection that cannot be opened is the driver's
  error. Both pass through `connect()`, so it is the one place that sees every failed attempt.
"""

import threading
from collections.abc import Callable
from typing import Any

import psycopg
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.pool import QueuePool

REASONS = ("auth", "timeout", "refused", "pool_exhausted", "other")

# Set by the metrics when an app starts (see app.metrics); None when nothing listens.
_reporter: Callable[[str], None] | None = None


def set_error_reporter(reporter: Callable[[str], None] | None) -> None:
    global _reporter
    _reporter = reporter


def classify(exc: BaseException) -> str:
    """The reason a connection attempt failed, from the exception type or its SQLSTATE.

    Never from message text. psycopg gives no SQLSTATE for a connection that fails while it is
    being opened, so a password the server asked for and then refused is told from the rest by
    `pgconn.used_password` (and `needs_password`): such a failure is `auth`. An error with no
    SQLSTATE and no password involved is the server not accepting the connection (`refused`: not
    listening, unreachable, or the name does not resolve).
    """
    if isinstance(exc, PoolTimeoutError):
        return "pool_exhausted"
    if isinstance(exc, psycopg.errors.ConnectionTimeout | TimeoutError):
        return "timeout"
    if isinstance(exc, ConnectionRefusedError):
        return "refused"
    sqlstate = getattr(exc, "sqlstate", None)
    if isinstance(sqlstate, str):
        return "auth" if sqlstate.startswith("28") else "other"
    if isinstance(exc, psycopg.OperationalError):
        pgconn = getattr(exc, "pgconn", None)
        if pgconn is not None and (
            getattr(pgconn, "used_password", False) or getattr(pgconn, "needs_password", False)
        ):
            return "auth"
        return "refused"
    return "other"


class InstrumentedQueuePool(QueuePool):
    # SQLAlchemy names a pool's logger after its class. Keep the name of the stock pool, so the
    # pool's own DEBUG lines stay under `sqlalchemy.` and not under this app's `app.` loggers.
    _sqla_logger_namespace = "sqlalchemy.pool.impl.QueuePool"

    def __init__(
        self, creator: Any, pool_size: int = 5, max_overflow: int = 10, **kwargs: Any
    ) -> None:
        super().__init__(creator, pool_size=pool_size, max_overflow=max_overflow, **kwargs)
        self._overflow_limit = max_overflow
        self._lock = threading.Lock()
        self._waiting = 0

    def connect(self) -> Any:
        with self._lock:
            self._waiting += 1
        try:
            return super().connect()
        except Exception as exc:
            report = _reporter
            if report is not None:
                report(classify(exc))
            raise
        finally:
            with self._lock:
                self._waiting -= 1

    @property
    def waiting(self) -> int:
        """Callers inside `connect()` now. Read without a connection."""
        return self._waiting

    @property
    def capacity(self) -> float:
        """The most connections the pool may hold: its size plus the overflow (inf: no limit)."""
        return float("inf") if self._overflow_limit < 0 else self.size() + self._overflow_limit
