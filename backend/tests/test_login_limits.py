"""The failed-login limits (#54): 5 per username and 20 per client address, each in a rolling
15 minutes. All times come from the fake clock; no test sleeps."""

import pytest
from sqlalchemy import event

from app.db import get_engine
from tests.auth_support import PASSWORD, assert_error, login, new_client, rows
from tests.limit_support import (
    IP_A,
    IP_B,
    IP_LIMIT,
    USERNAME_LIMIT,
    WINDOW_SECONDS,
    WRONG,
    assert_invalid,
    assert_too_many,
    attempt,
    client_at,
    fail,
    limit_count,
    names,
    retry_after,
)

# --- what is counted ---


def test_the_username_limit_blocks_the_sixth_login_even_with_the_right_password(accounts, clock):
    for _ in range(USERNAME_LIMIT):
        assert_invalid(fail("ana1", IP_A))

    assert_too_many(attempt("ana1", PASSWORD, IP_A), WINDOW_SECONDS)

    clock.advance(seconds=WINDOW_SECONDS - 1)
    assert_too_many(attempt("ana1", PASSWORD, IP_A), 1)
    clock.advance(seconds=1)
    assert attempt("ana1", PASSWORD, IP_A).status_code == 200


def test_the_ip_limit_blocks_the_21st_login_for_every_username(accounts, clock):
    for username in names(IP_LIMIT):
        assert_invalid(fail(username, IP_A))  # the 20th is still a 401

    assert_too_many(attempt("ana1", PASSWORD, IP_A), WINDOW_SECONDS)
    assert_too_many(attempt("ben1", PASSWORD, IP_A), WINDOW_SECONDS)

    clock.advance(seconds=WINDOW_SECONDS - 1)
    assert_too_many(attempt("ana1", PASSWORD, IP_A), 1)
    clock.advance(seconds=1)
    assert attempt("ana1", PASSWORD, IP_A).status_code == 200


def test_unknown_and_unregistrable_usernames_count_like_known_ones(accounts):
    unregistrable = ["a b", "x" * 64, "ab", "ana1 ", "with\u0000nul"]
    for number, username in enumerate(unregistrable):
        for _ in range(USERNAME_LIMIT):  # each from its own IP, so only the username limit acts
            assert_invalid(fail(username, f"198.51.100.{number}"))
    for username in unregistrable:
        assert_too_many(attempt(username, PASSWORD, IP_B))


def test_unknown_username_counts_against_the_ip(accounts):
    for username in names(IP_LIMIT):  # none of these exists
        assert_invalid(fail(username, IP_A))

    assert_too_many(attempt("ana1", PASSWORD, IP_A))


def test_a_username_with_a_nul_character_is_a_401_not_a_500(accounts, db):
    response = fail("ana1\u0000", IP_A)

    assert_invalid(response)
    assert limit_count(db, "login_username", "ana1\u0000") == 1
    assert limit_count(db, "login_ip", IP_A) == 1


def test_usernames_that_differ_only_in_case_share_one_count(accounts):
    for username in ("Ana1", "ANA1", "ana1", "aNa1", "ANa1"):
        assert_invalid(fail(username, IP_A))

    assert_too_many(attempt("ana1", PASSWORD, IP_B))
    assert_too_many(attempt("ANA1", PASSWORD, IP_B))
    assert_too_many(attempt("aNA1", PASSWORD, IP_B))


@pytest.mark.parametrize(
    "send",
    [
        pytest.param(
            lambda c: c.post("/api/auth/login", json={"username": "ana1"}), id="no password"
        ),
        pytest.param(lambda c: c.post("/api/auth/login", json={"password": "x"}), id="no username"),
        pytest.param(
            lambda c: c.post("/api/auth/login", json={"username": "ana1", "password": "p" * 129}),
            id="password over 128 characters",
        ),
        pytest.param(
            lambda c: c.post(
                "/api/auth/login", content=b"not json", headers={"content-type": "text/plain"}
            ),
            id="not json",
        ),
        pytest.param(
            lambda c: c.post("/api/auth/login", json={"username": "", "password": "x"}),
            id="empty username",
        ),
    ],
)
def test_a_422_is_not_a_login_attempt(accounts, db, send):
    client = client_at(IP_A)
    for _ in range(IP_LIMIT + USERNAME_LIMIT):
        assert send(client).status_code == 422
    assert limit_count(db) == 0

    # Nothing was used up, and nothing is blocked while blocked: a 422 stays a 422.
    assert attempt("ana1", PASSWORD, IP_A).status_code == 200
    for username in names(IP_LIMIT):
        fail(username, IP_B)
    assert send(client_at(IP_B)).status_code == 422


def test_a_blocked_client_does_not_extend_its_own_block(accounts, db, clock):
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_A)
    rows_before = limit_count(db)

    for _ in range(10):
        clock.advance(seconds=10)
        assert_too_many(attempt("ana1", PASSWORD, IP_A))

    assert limit_count(db) == rows_before
    clock.advance(seconds=WINDOW_SECONDS - 100)  # 15 minutes after the failures
    assert attempt("ana1", PASSWORD, IP_A).status_code == 200


def test_a_failure_from_a_blocked_ip_does_not_count_against_the_username(accounts, db):
    for username in names(IP_LIMIT):
        fail(username, IP_A)

    for _ in range(10):
        assert_too_many(fail("zed01", IP_A))

    assert limit_count(db, "login_username", "zed01") == 0
    for _ in range(USERNAME_LIMIT):  # from another IP, zed01 still has its whole allowance
        assert_invalid(fail("zed01", IP_B))
    assert_too_many(fail("zed01", IP_B))


def test_a_failure_for_a_blocked_username_does_not_count_against_the_ip(accounts, db):
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_A)

    for _ in range(10):
        assert_too_many(fail("ana1", IP_A))

    assert limit_count(db, "login_ip", IP_A) == USERNAME_LIMIT
    for username in names(IP_LIMIT - USERNAME_LIMIT):  # the IP has exactly 15 failures left
        assert_invalid(fail(username, IP_A))
    assert_too_many(fail("user99", IP_A))


# --- blocking is independent per key ---


def test_another_username_is_not_affected_by_a_blocked_one(accounts):
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_A)

    assert attempt("ben1", PASSWORD, IP_A).status_code == 200
    assert_invalid(fail("ben1", IP_A))


def test_another_ip_is_not_affected_by_a_blocked_ip_but_keeps_the_username_limit(accounts):
    for username in names(IP_LIMIT):
        fail(username, IP_A)
    assert attempt("ana1", PASSWORD, IP_B).status_code == 200

    for _ in range(USERNAME_LIMIT):
        assert_invalid(fail("ben1", IP_B))
    assert_too_many(attempt("ben1", PASSWORD, IP_B))
    assert_too_many(attempt("ben1", PASSWORD, "198.51.100.5"))  # the username is blocked everywhere


def test_a_blocked_learner_who_is_signed_in_stays_signed_in(accounts, db):
    signed_in = client_at(IP_A)
    assert attempt("ana1", PASSWORD, client=signed_in).status_code == 200
    sessions_before = rows(db, "SELECT token_hash, account_id, created_at FROM app.sessions")
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_B)

    response = attempt("ana1", PASSWORD, client=signed_in)

    assert_too_many(response)
    assert (
        rows(db, "SELECT token_hash, account_id, created_at FROM app.sessions") == sessions_before
    )
    assert signed_in.get("/api/auth/me").json() == {"username": "ana1"}


# --- the retry time ---


def test_retry_after_is_the_time_left_rounded_up_and_never_zero(accounts, clock):
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_A)

    clock.advance(milliseconds=400)
    assert retry_after(attempt("ana1", PASSWORD, IP_A)) == WINDOW_SECONDS  # 899.6 s left
    clock.advance(seconds=WINDOW_SECONDS - 1)  # 0.2 s left
    assert retry_after(attempt("ana1", PASSWORD, IP_A)) == 1


def test_retry_after_counts_from_the_fifth_newest_failure(accounts, clock):
    for _ in range(USERNAME_LIMIT):  # failures at 0, 60, 120, 180, 240 seconds
        fail("ana1", IP_A)
        clock.advance(seconds=60)
    clock.advance(seconds=-60)  # the clock is at 240 s: the oldest failure ends the block at 900 s

    assert_too_many(attempt("ana1", PASSWORD, IP_A), WINDOW_SECONDS - 240)
    clock.advance(seconds=WINDOW_SECONDS - 240)  # at 900 s the first failure no longer counts
    assert attempt("ana1", PASSWORD, IP_A).status_code == 200


def test_retry_after_for_the_ip_limit_counts_from_the_twentieth_newest_failure(accounts, clock):
    for username in names(IP_LIMIT):  # failures at 0, 10, ... 190 seconds
        fail(username, IP_A)
        clock.advance(seconds=10)
    clock.advance(seconds=-10)  # the clock is at 190 s; the oldest failure ends the block at 900 s

    assert_too_many(attempt("ana1", PASSWORD, IP_A), WINDOW_SECONDS - 190)


def test_when_both_limits_block_the_later_end_counts(accounts, clock):
    # The username ends its block at 900 s; the IP, whose 20 failures came 300 s later, at 1200 s.
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_B)
    clock.advance(seconds=300)
    for username in names(IP_LIMIT):
        fail(username, IP_A)

    assert_too_many(attempt("ana1", PASSWORD, IP_A), WINDOW_SECONDS)  # 1200 - 300

    # And the other way round: the IP ends first (900 s), the username later (1200 s).
    clock.advance(seconds=WINDOW_SECONDS)
    for username in names(IP_LIMIT, "late"):
        fail(username, "198.51.100.1")
    clock.advance(seconds=300)
    for _ in range(USERNAME_LIMIT):
        fail("ben1", IP_B)

    assert_too_many(attempt("ben1", PASSWORD, "198.51.100.1"), WINDOW_SECONDS)


# --- a successful login ---


def test_a_success_clears_the_usernames_failures(accounts):
    for _ in range(4):
        fail("ana1", IP_A)
    assert attempt("ana1", PASSWORD, IP_A).status_code == 200

    for _ in range(USERNAME_LIMIT):
        assert_invalid(fail("ana1", IP_A))
    assert_too_many(attempt("ana1", PASSWORD, IP_A))


def test_a_success_does_not_reset_the_ip_count(accounts):
    for username in names(IP_LIMIT - 1):
        assert_invalid(fail(username, IP_A))
    assert attempt("ana1", PASSWORD, IP_A).status_code == 200

    assert_invalid(fail("user99", IP_A))  # the 20th failure is still allowed
    assert_too_many(attempt("ana1", PASSWORD, IP_A))  # the 21st attempt is not


def test_successful_logins_are_not_counted_for_either_limit(accounts, db):
    for _ in range(IP_LIMIT + USERNAME_LIMIT):
        assert attempt("ana1", PASSWORD, IP_A).status_code == 200

    assert limit_count(db) == 0


def test_a_success_for_one_username_does_not_touch_another_usernames_count(accounts, db):
    for _ in range(3):
        fail("ben1", IP_B)
    for _ in range(3):
        fail("ana1", IP_A)

    assert attempt("ana1", PASSWORD, IP_A).status_code == 200

    assert limit_count(db, "login_username", "ben1") == 3
    assert limit_count(db, "login_username", "ana1") == 0


# --- no one can tell whether a username exists ---


def _same_answers(accounts, clock, known, unknown):
    """Send the same sequence for both usernames, each from its own IP at the same fake instants."""
    answers = {known: [], unknown: []}
    for step in range(USERNAME_LIMIT + 2):
        for username, ip in ((known, IP_A), (unknown, IP_B)):
            response = attempt(username, WRONG if step < USERNAME_LIMIT + 1 else PASSWORD, ip)
            answers[username].append(
                (response.status_code, response.json(), response.headers.get("retry-after"))
            )
        clock.advance(seconds=7)
    return answers


def test_an_unknown_and_a_registered_username_get_the_same_answers(accounts, clock):
    answers = _same_answers(accounts, clock, "ana1", "nobody1")

    assert answers["ana1"] == answers["nobody1"]
    assert [a[0] for a in answers["ana1"]] == [401] * 5 + [429, 429]
    assert answers["ana1"][5][2] == str(WINDOW_SECONDS - 5 * 7)


def test_the_same_database_work_is_done_for_known_and_unknown_usernames(accounts, db):
    engine = get_engine()  # the app's engine, which another test may have replaced since `db`
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if "rate_limit_failures" in statement or "advisory" in statement:
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:

        def work(username, ip):
            statements.clear()
            status = attempt(username, WRONG, ip).status_code
            return list(statements), status

        unknown_401 = work("nobody1", IP_A)
        known_401 = work("ben1", IP_B)
        for _ in range(USERNAME_LIMIT):
            fail("nobody2", IP_A)
            fail("ana1", IP_B)
        unknown_429 = work("nobody2", "198.51.100.1")
        known_429 = work("ana1", "198.51.100.2")
    finally:
        event.remove(engine, "before_cursor_execute", record)

    assert unknown_401[1] == known_401[1] == 401
    assert unknown_429[1] == known_429[1] == 429
    assert unknown_401[0] == known_401[0] and len(unknown_401[0]) > 0
    assert unknown_429[0] == known_429[0] and len(unknown_429[0]) > 0


def test_the_counter_table_work_of_a_429_a_401_and_a_success_is_in_a_fixed_order(accounts, db):
    engine = get_engine()  # the app's engine, which another test may have replaced since `db`
    kinds: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if "pg_advisory_xact_lock" in statement:
            kinds.append("lock")
        elif "rate_limit_failures" in statement:
            kinds.append(statement.split()[0].lower())

    def sequence(username, password, ip):
        kinds.clear()
        status = attempt(username, password, ip).status_code
        return status, list(kinds)

    event.listen(engine, "before_cursor_execute", record)
    try:
        for _ in range(USERNAME_LIMIT):
            fail("ben1", IP_B)
        refused = sequence("ben1", PASSWORD, IP_B)
        wrong = sequence("ana1", WRONG, IP_A)
        right = sequence("ana1", PASSWORD, IP_A)
    finally:
        event.remove(engine, "before_cursor_execute", record)

    # The two locks (address, then username), the two counts, one batch of pruning, one insert of
    # the two failures. A success then takes the username lock again before it deletes.
    assert refused == (429, ["lock", "lock", "select", "select"])
    assert wrong == (401, ["lock", "lock", "select", "select", "delete", "insert"])
    assert right == (
        200,
        ["lock", "lock", "select", "select", "delete", "insert", "lock", "delete", "delete"],
    )


def test_a_blocked_login_runs_no_password_check_and_every_401_runs_one(accounts, verifications):
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_A)
        fail("nobody1", IP_B)
    assert verifications.calls == 2 * USERNAME_LIMIT

    assert_too_many(attempt("ana1", PASSWORD, IP_A))
    assert_too_many(attempt("nobody1", PASSWORD, IP_B))
    assert_too_many(fail("ana1", IP_B))
    assert verifications.calls == 2 * USERNAME_LIMIT  # the blocked requests ran none

    assert_invalid(fail("a b", IP_A))  # under its limit, so it is checked: exactly once
    assert verifications.calls == 2 * USERNAME_LIMIT + 1


def test_registration_still_says_the_username_is_taken(accounts):
    for _ in range(USERNAME_LIMIT):
        fail("ana1", IP_A)

    response = client_at(IP_A).post(
        "/api/auth/register", json={"username": "ana1", "password": PASSWORD}
    )

    assert_error(response, 409, "username_taken")


def test_the_login_401_and_422_are_unchanged(accounts):
    response = fail("ana1", IP_A)

    assert response.status_code == 401
    assert response.json() == {
        "error": {"code": "invalid_credentials", "message": "Wrong username or password."}
    }
    assert "retry-after" not in response.headers
    assert login(new_client(), "ana1", "p" * 129).status_code == 422
