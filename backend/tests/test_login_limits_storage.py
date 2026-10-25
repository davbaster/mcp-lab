"""Where the failed-login counts live (#54): one table of digests, pruned by the requests that
record failures, shared by every process, and failing closed when it cannot be used."""

import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.db_session import DatabaseFailure
from tests.auth_support import PASSWORD, assert_error, count, new_client, rows
from tests.limit_support import (
    IP_A,
    IP_B,
    IP_LIMIT,
    USERNAME_LIMIT,
    WINDOW_SECONDS,
    assert_invalid,
    assert_too_many,
    attempt,
    client_at,
    fail,
    insert_expired,
    key_digest,
    limit_count,
    limit_rows,
    names,
)

# --- the table ---


def test_the_table_holds_only_scope_digest_and_time_with_no_course_id(db):
    with db.connect() as conn:
        columns = (
            conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'app' AND table_name = 'rate_limit_failures' "
                    "ORDER BY ordinal_position"
                )
            )
            .scalars()
            .all()
        )
        indexes = (
            conn.execute(
                text(
                    "SELECT indexdef FROM pg_indexes "
                    "WHERE schemaname = 'app' AND tablename = 'rate_limit_failures'"
                )
            )
            .scalars()
            .all()
        )

    assert columns == ["id", "scope", "key_hash", "failed_at"]
    assert any("(scope, key_hash, failed_at)" in d for d in indexes)
    assert any("(failed_at)" in d for d in indexes)


def _insert(db, scope="login_ip", digest=b"\x00" * 32):
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app.rate_limit_failures (id, scope, key_hash, failed_at) "
                "VALUES (:id, :scope, :digest, now())"
            ),
            {"id": uuid.uuid4(), "scope": scope, "digest": digest},
        )


@pytest.mark.parametrize("scope", ["login_username", "login_ip"])
def test_the_database_accepts_the_two_scopes(db, scope):
    _insert(db, scope)

    assert limit_count(db, scope) == 1


@pytest.mark.parametrize(
    ("kwargs", "constraint"),
    [
        ({"scope": "register_ip"}, "ck_rate_limit_failures_scope_values"),
        ({"digest": b"\x00" * 31}, "ck_rate_limit_failures_key_hash_length"),
        ({"digest": b"\x00" * 33}, "ck_rate_limit_failures_key_hash_length"),
    ],
)
def test_the_database_refuses_an_unknown_scope_and_a_digest_of_the_wrong_length(
    db, kwargs, constraint
):
    with pytest.raises(IntegrityError) as excinfo:
        _insert(db, **kwargs)

    assert excinfo.value.orig.diag.constraint_name == constraint
    assert limit_count(db) == 0


def test_only_digests_are_stored_never_a_username_or_an_address(accounts, db, monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXIES", "10.0.0.0/8")
    username, forwarded = "SENTINEL-USER-7d4a", "198.51.100.77"
    fail(username, "10.0.0.2", headers={"X-Forwarded-For": forwarded})
    fail("ana1", IP_A)

    with db.connect() as conn:
        texts = conn.execute(text("SELECT t::text FROM app.rate_limit_failures t")).scalars().all()
        escaped = (
            conn.execute(text("SELECT encode(key_hash, 'escape') FROM app.rate_limit_failures"))
            .scalars()
            .all()
        )

    assert len(texts) == 4
    everything = "\n".join([*texts, *escaped]).lower()
    for sentinel in (username, forwarded, "ana1", IP_A, "10.0.0.2"):
        assert sentinel.lower() not in everything
    digests = {bytes(r.key_hash) for r in limit_rows(db)}
    assert digests == {
        key_digest(username.lower()),
        key_digest(forwarded),
        key_digest("ana1"),
        key_digest(IP_A),
    }


# --- several processes ---


def test_a_new_client_is_still_blocked_and_the_counts_are_in_the_table(accounts, db):
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_A)

    # Nothing is kept in the app's memory: a fresh client (a new "process") sees the same state.
    assert_too_many(attempt("ana1", PASSWORD, IP_B, client=new_client()))
    assert limit_count(db, "login_username", "ana1") == USERNAME_LIMIT


# --- old rows ---


def test_a_few_new_failures_delete_all_250_expired_rows_in_batches_of_100(accounts, db, clock):
    insert_expired(db, 250, clock.now - timedelta(hours=1))

    def expired():
        return len([r for r in limit_rows(db) if r.failed_at <= clock.now - timedelta(minutes=15)])

    assert expired() == 250
    fail("ana1", IP_A)
    assert expired() == 150
    fail("ben1", IP_A)
    assert expired() == 50
    fail("nobody1", IP_A)
    assert expired() == 0
    assert limit_count(db) == 6  # the three new failures, two rows each


def test_a_row_exactly_15_minutes_old_is_expired_and_one_a_second_younger_is_not(
    accounts, db, clock
):
    insert_expired(db, 1, clock.now - timedelta(minutes=15))
    insert_expired(db, 1, clock.now - timedelta(minutes=15) + timedelta(seconds=1))

    fail("ana1", IP_A)

    (left,) = [r for r in limit_rows(db) if bytes(r.key_hash) == key_digest("old-key")]
    assert left.failed_at == clock.now - timedelta(minutes=15) + timedelta(seconds=1)


def test_pruning_never_waits_for_rows_another_request_has_locked(accounts, db, clock):
    insert_expired(db, 120, clock.now - timedelta(hours=1))
    held = db.connect()
    transaction = held.begin()
    held.execute(text("SELECT id FROM app.rate_limit_failures FOR UPDATE"))
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(fail, "ana1", IP_A)
        try:
            response = future.result(timeout=20)  # a request that waited for the locks would hang
        finally:
            transaction.rollback()  # also frees a request that did wait, so the pool can end
            held.close()

    assert_invalid(response)
    expired = [r for r in limit_rows(db) if bytes(r.key_hash) == key_digest("old-key")]
    assert len(expired) == 120  # all locked, so none was touched


def test_blocked_requests_delete_nothing(accounts, db, clock):
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_A)
    insert_expired(db, 10, clock.now - timedelta(hours=1))

    assert_too_many(fail("ana1", IP_A))

    assert limit_count(db, "login_ip", "old-key") == 10


# --- the table cannot be used ---


@pytest.fixture
def broken_table(db):
    """The counter table renamed away for the test."""
    with db.begin() as conn:
        conn.execute(text("ALTER TABLE app.rate_limit_failures RENAME TO rate_limit_gone"))
    yield
    with db.begin() as conn:
        conn.execute(text("ALTER TABLE app.rate_limit_gone RENAME TO rate_limit_failures"))


def test_when_the_table_cannot_be_read_the_login_fails_closed(
    accounts, db, broken_table, verifications, caplog
):
    sessions_before = count(db, "sessions")
    client = client_at(IP_A, raise_server_exceptions=False)

    for password in (PASSWORD, "wrong-pass"):  # the right password is not enough
        response = attempt("ana1", password, client=client)

        assert_error(response, 500, "internal_error")
        assert "set-cookie" not in response.headers
    assert verifications.calls == 0
    assert count(db, "sessions") == sessions_before
    # The error that was logged is the one with the database details removed.
    errors = [r.exc_info[1] for r in caplog.records if r.exc_info]
    assert errors and all(isinstance(e, DatabaseFailure) for e in errors)


@pytest.fixture
def failing_trigger(db):
    """A trigger that makes writes to the table fail: `operation` is INSERT or DELETE."""

    def install(operation):
        with db.begin() as conn:
            conn.execute(
                text(
                    "CREATE FUNCTION app.refuse_write() RETURNS trigger LANGUAGE plpgsql AS "
                    "$$ BEGIN RAISE EXCEPTION 'refused'; END $$"
                )
            )
            conn.execute(
                text(
                    f"CREATE TRIGGER refuse BEFORE {operation} ON app.rate_limit_failures "
                    "FOR EACH ROW EXECUTE FUNCTION app.refuse_write()"
                )
            )

    yield install
    with db.begin() as conn:
        conn.execute(text("DROP TRIGGER IF EXISTS refuse ON app.rate_limit_failures"))
        conn.execute(text("DROP FUNCTION IF EXISTS app.refuse_write()"))


def test_when_a_failure_cannot_be_recorded_the_login_fails_closed(
    accounts, db, failing_trigger, verifications
):
    sessions_before = count(db, "sessions")
    failing_trigger("INSERT")
    client = client_at(IP_A, raise_server_exceptions=False)

    response = attempt("ana1", PASSWORD, client=client)

    assert_error(response, 500, "internal_error")
    assert verifications.calls == 0
    assert count(db, "sessions") == sessions_before
    assert limit_count(db) == 0


def test_when_the_success_cannot_be_recorded_no_session_is_created(accounts, db, failing_trigger):
    attempt("ana1", "wrong-pass", IP_B)  # one row to clear on success
    sessions_before = count(db, "sessions")
    failing_trigger("DELETE")
    client = client_at(IP_A, raise_server_exceptions=False)

    response = attempt("ana1", PASSWORD, client=client)

    assert_error(response, 500, "internal_error")
    assert "set-cookie" not in response.headers
    assert count(db, "sessions") == sessions_before


def test_no_session_row_is_left_by_a_blocked_login(accounts, db):
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_A)

    sessions_before = count(db, "sessions")

    assert_too_many(attempt("ana1", PASSWORD, IP_A))

    assert count(db, "sessions") == sessions_before


# --- logs ---

SENTINEL_USER = "USER-SENTINEL-8b2d"
SENTINEL_REGISTERED = "Sntl9c1e"
SENTINEL_IP = "198.51.100.77"
PROXY = "10.0.0.2"


def _app_records(caplog):
    quiet = ("httpx", "httpcore", "asyncio", "mcp_lab.requests")
    return [r for r in caplog.records if not r.name.startswith(quiet)]


def test_nothing_about_a_login_attempt_is_logged_but_one_line_when_a_limit_is_reached(
    accounts, db, monkeypatch, caplog
):
    monkeypatch.setenv("TRUSTED_PROXIES", "10.0.0.0/8")
    caplog.set_level(logging.DEBUG)
    forged = {"X-Forwarded-For": f"9.9.9.9, {SENTINEL_IP}"}

    for _ in range(USERNAME_LIMIT + 5):  # 5 failures reach the limit; the other 5 are blocked
        attempt(SENTINEL_USER, "PW-SENTINEL-9c1e", PROXY, headers=forged)
    attempt("ana1", PASSWORD, PROXY, headers=forged)  # a success

    records = _app_records(caplog)
    assert [r.getMessage() for r in records] == ["Login limit reached: scope=username"]
    assert records[0].levelno == logging.INFO


def test_the_ip_limit_logs_its_own_line_once(accounts, caplog):
    caplog.set_level(logging.DEBUG)

    for username in names(IP_LIMIT + 3):
        fail(username, IP_A)

    assert [r.getMessage() for r in _app_records(caplog)] == ["Login limit reached: scope=ip"]


def test_a_success_that_takes_the_last_place_logs_no_limit_line(accounts, caplog):
    caplog.set_level(logging.DEBUG)
    for _ in range(USERNAME_LIMIT - 1):
        fail("ana1", IP_A)

    assert attempt("ana1", PASSWORD, IP_A).status_code == 200

    assert _app_records(caplog) == []


def test_no_sentinel_reaches_a_log_a_response_or_a_table(accounts, db, monkeypatch, caplog):
    from tests.auth_support import register

    monkeypatch.setenv("TRUSTED_PROXIES", "10.0.0.0/8")
    caplog.set_level(logging.DEBUG)
    password = "PW-SENTINEL-9c1e"  # the wrong password sent again and again
    right = "PwSent9c1eXY"  # the registered account's real password (12 characters at most)
    assert register(client_at(IP_A), SENTINEL_REGISTERED, right).status_code == 201
    forged = {"X-Forwarded-For": f"9.9.9.9, {SENTINEL_IP}"}
    responses = []
    for username in (SENTINEL_USER, SENTINEL_REGISTERED):
        for _ in range(USERNAME_LIMIT + 2):  # 401s, then 429s
            responses.append(attempt(username, password, PROXY, headers=forged))
    responses.append(attempt(SENTINEL_REGISTERED.upper(), right, PROXY, headers=forged))
    for username in names(IP_LIMIT):  # and the address limit
        responses.append(attempt(username, password, PROXY, headers=forged))
    assert {r.status_code for r in responses} == {401, 429}

    shown = "\n".join(
        [caplog.text]
        + [str(r.__dict__) for r in caplog.records]
        + [f"{r.status_code} {dict(r.headers)} {r.text}" for r in responses]
        + [str(tuple(row)) for row in rows(db, "SELECT t::text FROM app.rate_limit_failures t")]
    )
    for secret in (SENTINEL_USER, SENTINEL_REGISTERED, SENTINEL_IP, password, right):
        assert secret.lower() not in shown.lower()


def test_the_429_body_and_headers_hold_no_username_address_or_count(accounts):
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_A)

    response = attempt("ana1", PASSWORD, IP_A)

    assert_too_many(response, WINDOW_SECONDS)
    assert set(response.headers) == {
        "x-request-id",
        "retry-after",
        "cache-control",
        "content-type",
        "content-length",
    }
    shown = f"{dict(response.headers)} {response.text}".lower()
    assert "ana1" not in shown and IP_A not in shown
