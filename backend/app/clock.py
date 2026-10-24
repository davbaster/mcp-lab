"""The one source of "now". Every time in the auth code comes from here.

Tests replace `current_time` with `app.dependency_overrides` and a fake clock.
"""

from datetime import UTC, datetime


def current_time() -> datetime:
    """The current UTC time as a timezone-aware datetime (a FastAPI dependency)."""
    return datetime.now(UTC)
