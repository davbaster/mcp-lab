"""Rate limits on failed attempts, kept in the database (#54; #97 reuses this for registration).

Every counted failure is a row in `app.rate_limit_failures`, keyed by the SHA-256 digest of the
limited key (a username, or the sender's address from `app.client_address`), so nothing is held
in a process: the limits survive a restart and hold across any number of workers or backend
containers. All times come from the app clock the caller passes in.

How an attempt is counted: `reserve` runs before the password check. In one short transaction
it takes a transaction-scoped advisory lock per key, counts the failures inside the window, and
either refuses the attempt (`RateLimited`) or records a failure for every key and commits. The
lock is what makes "check, then record" one step for two requests of one key; a key has no row of
its own (an unknown username, an address) so there is nothing else to lock. The attempt is thus
counted before the password is checked, no lock or transaction is open while the slow hash runs,
and the number of password checks a burst can start is bounded by the limits. An attempt that
then succeeds takes its own row back with `forgive`.

Locks are always taken in the same order (by `lock_class`, then by digest), so two requests that
share one key and differ in the other never wait on each other in a cycle.
"""

import hashlib
import math
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from app.models import RateLimitFailure

# A failure counts while `failed_at > now - WINDOW`: exactly WINDOW after a failure it no longer
# counts (the same boundary as the feedback limits, #24).
WINDOW = timedelta(minutes=15)
LOGIN_USERNAME_MAX_FAILURES = 5
# 20, not 5: several learners can share one address (a school, an office, a home), so the
# address limit is a loose net against one machine guessing across many usernames, while the
# per-username limit is what stops guessing at one account.
LOGIN_IP_MAX_FAILURES = 20
# Expired rows are deleted by the code that records a failure, at most this many at a time.
PRUNE_BATCH = 100


@dataclass(frozen=True)
class Limit:
    """One kind of limit. `scope` is stored in the table (and listed in its CHECK constraint, so
    a new limit needs a migration). `lock_class` is the first half of the advisory lock key and
    differs for every limit, so two kinds of key never share a lock."""

    scope: str
    lock_class: int
    max_failures: int


LOGIN_USERNAME = Limit("login_username", 1, LOGIN_USERNAME_MAX_FAILURES)
LOGIN_IP = Limit("login_ip", 2, LOGIN_IP_MAX_FAILURES)


class RateLimited(Exception):
    """A key is at its limit. `retry_after` is whole seconds (rounded up, at least 1) until the
    last blocking key is under its limit again."""

    def __init__(self, retry_after: int) -> None:
        super().__init__(f"Rate limited; retry after {retry_after} seconds.")
        self.retry_after = retry_after


@dataclass(frozen=True)
class Reservation:
    """The failures `reserve` recorded: their IDs, and the limits whose count this attempt
    brought up to the maximum (in the order the keys were sorted for locking)."""

    row_ids: tuple[uuid.UUID, ...]
    reached: tuple[Limit, ...]


def key_hash(key: str) -> bytes:
    return hashlib.sha256(key.encode("utf-8")).digest()


def _ordered(keys: Sequence[tuple[Limit, str]]) -> list[tuple[Limit, bytes]]:
    return sorted(((limit, key_hash(key)) for limit, key in keys), key=_lock_order)


def _lock_order(item: tuple[Limit, bytes]) -> tuple[int, bytes]:
    return item[0].lock_class, item[1]


def _lock(db: Session, limit: Limit, digest: bytes) -> None:
    # Two 32-bit halves: the limit's class, and the first four bytes of the digest. A collision
    # between two keys of one limit only makes them wait for each other.
    db.execute(
        text(
            "SELECT pg_advisory_xact_lock(CAST(:class_id AS integer), CAST(:object_id AS integer))"
        ),
        {"class_id": limit.lock_class, "object_id": int.from_bytes(digest[:4], "big", signed=True)},
    )


def reserve(db: Session, keys: Sequence[tuple[Limit, str]], now: datetime) -> Reservation:
    """Refuse the attempt if any key is at its limit; otherwise record a failure for every key.

    Commits (also when it refuses, which ends the transaction and releases the locks), so the
    caller must not have uncommitted work on `db`. A refused attempt records nothing, so it is
    not counted against the keys that were under their limit. Raises `RateLimited`.
    """
    ordered = _ordered(keys)
    for limit, digest in ordered:
        _lock(db, limit, digest)
    cutoff = now - WINDOW
    blocked_until: datetime | None = None
    reached: list[Limit] = []
    for limit, digest in ordered:
        newest = (
            db.execute(
                select(RateLimitFailure.failed_at)
                .where(
                    RateLimitFailure.scope == limit.scope,
                    RateLimitFailure.key_hash == digest,
                    RateLimitFailure.failed_at > cutoff,
                )
                .order_by(RateLimitFailure.failed_at.desc())
                .limit(limit.max_failures)
            )
            .scalars()
            .all()
        )
        if len(newest) >= limit.max_failures:
            # The block ends when the oldest of the newest `max_failures` failures expires.
            ends = newest[limit.max_failures - 1] + WINDOW
            blocked_until = ends if blocked_until is None else max(blocked_until, ends)
        elif len(newest) == limit.max_failures - 1:
            reached.append(limit)
    if blocked_until is not None:
        db.rollback()
        raise RateLimited(max(1, math.ceil((blocked_until - now).total_seconds())))
    _prune(db, cutoff)
    row_ids = []
    for limit, digest in ordered:
        row_id = uuid.uuid4()
        db.add(RateLimitFailure(id=row_id, scope=limit.scope, key_hash=digest, failed_at=now))
        row_ids.append(row_id)
    db.commit()
    return Reservation(tuple(row_ids), tuple(reached))


def _prune(db: Session, cutoff: datetime) -> None:
    """Delete up to PRUNE_BATCH expired rows, skipping any row another request has locked."""
    expired = (
        select(RateLimitFailure.id)
        .where(RateLimitFailure.failed_at <= cutoff)
        .limit(PRUNE_BATCH)
        .with_for_update(skip_locked=True)
    )
    db.execute(delete(RateLimitFailure).where(RateLimitFailure.id.in_(expired)))


def forgive(
    db: Session, reservation: Reservation, *, reset: Sequence[tuple[Limit, str]] = ()
) -> None:
    """For an attempt that succeeded: delete the failures it reserved, and every failure of the
    keys in `reset`. Other keys keep their counts. Does not commit, so the caller can do it in
    the same transaction as the rest of the success (the session)."""
    for limit, digest in _ordered(reset):
        _lock(db, limit, digest)
        db.execute(
            delete(RateLimitFailure).where(
                RateLimitFailure.scope == limit.scope, RateLimitFailure.key_hash == digest
            )
        )
    if reservation.row_ids:
        db.execute(delete(RateLimitFailure).where(RateLimitFailure.id.in_(reservation.row_ids)))
