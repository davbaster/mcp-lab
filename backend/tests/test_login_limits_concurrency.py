"""Failed logins sent at the same time (#54).

Threads wait at a barrier and then post together, each with its own client. The counts are
decided under a database lock before any password check, so the totals are the same for every
order the requests may run in, and nothing sleeps.
"""

from collections import Counter

import pytest
from sqlalchemy import text

from app import passwords
from tests.auth_support import PASSWORD
from tests.limit_support import (
    IP_A,
    IP_B,
    IP_LIMIT,
    USERNAME_LIMIT,
    WRONG,
    attempt,
    limit_count,
    names,
    run_together,
)


def statuses(responses):
    return Counter(r.status_code for r in responses)


def job(username, password, ip):
    return lambda: attempt(username, password, ip)


# --- one step under a lock, committed before the password check ---


@pytest.fixture
def seen_during_verify(db, monkeypatch):
    """Replaces the password check with one that records what the database looks like to
    another connection at that moment, then does the real check."""
    seen = []
    real = passwords.verify_password

    def spy(password_hash, password):
        with db.connect() as conn:
            seen.append(
                {
                    "failures": conn.execute(
                        text("SELECT count(*) FROM app.rate_limit_failures")
                    ).scalar_one(),
                    "advisory_locks": conn.execute(
                        text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'")
                    ).scalar_one(),
                    "idle_in_transaction": conn.execute(
                        text(
                            "SELECT count(*) FROM pg_stat_activity "
                            "WHERE datname = current_database() AND pid <> pg_backend_pid() "
                            "AND state LIKE 'idle in transaction%'"
                        )
                    ).scalar_one(),
                }
            )
        return real(password_hash, password)

    monkeypatch.setattr(passwords, "verify_password", spy)
    return seen


@pytest.mark.parametrize("username", ["ana1", "nobody1", "a b"])
def test_the_attempt_is_committed_and_nothing_is_held_while_the_password_is_checked(
    accounts, seen_during_verify, username
):
    attempt(username, WRONG, IP_A)

    # Two rows (username and address) are already visible to another connection; no advisory
    # lock and no open transaction exists while the slow hash runs.
    assert seen_during_verify == [{"failures": 2, "advisory_locks": 0, "idle_in_transaction": 0}]


def test_a_success_also_sees_its_reservation_committed_and_leaves_no_row(
    accounts, db, seen_during_verify
):
    assert attempt("ana1", PASSWORD, IP_A).status_code == 200

    assert seen_during_verify == [{"failures": 2, "advisory_locks": 0, "idle_in_transaction": 0}]
    assert limit_count(db) == 0


# --- bursts ---


def test_15_wrong_passwords_for_one_username_give_5_401s_10_429s_and_5_password_checks(
    accounts, db, verifications
):
    responses = run_together([job("ana1", WRONG, f"198.51.100.{n}") for n in range(15)])

    assert statuses(responses) == {401: USERNAME_LIMIT, 429: 10}
    assert verifications.calls == USERNAME_LIMIT
    assert limit_count(db, "login_username", "ana1") == USERNAME_LIMIT


def test_30_usernames_from_one_ip_give_20_401s_and_10_429s(accounts, db, verifications):
    responses = run_together([job(username, WRONG, IP_A) for username in names(30)])

    assert statuses(responses) == {401: IP_LIMIT, 429: 10}
    assert verifications.calls == IP_LIMIT
    assert limit_count(db, "login_ip", IP_A) == IP_LIMIT


def test_a_mixed_burst_over_2_ips_and_2_usernames_finishes_with_no_500_and_no_deadlock(
    accounts, db
):
    combinations = [(u, ip) for u in ("ana1", "ben1") for ip in (IP_A, IP_B)]
    # 6 of each crossing combination, interleaved so neighbours differ in both keys.
    jobs = [job(u, WRONG, ip) for _ in range(6) for u, ip in combinations]
    assert len(jobs) == 24

    responses = run_together(jobs)

    # Each username has room for exactly 5 failures and each IP for 20, of which 10 are used.
    assert statuses(responses) == {401: 2 * USERNAME_LIMIT, 429: 24 - 2 * USERNAME_LIMIT}
    assert limit_count(db, "login_username") == 2 * USERNAME_LIMIT
    assert limit_count(db, "login_ip") == 2 * USERNAME_LIMIT


@pytest.mark.parametrize("round_number", range(4))
def test_the_right_password_racing_four_wrong_ones_never_counts_more_than_5_failures(
    accounts, db, round_number
):
    for _ in range(USERNAME_LIMIT - 1):
        attempt("ana1", WRONG, IP_A)
    jobs = [job("ana1", PASSWORD, IP_B)] + [job("ana1", WRONG, f"198.51.100.{n}") for n in range(4)]

    responses = run_together(jobs)

    codes = statuses(responses)
    assert set(codes) <= {200, 401, 429}  # never a 500
    assert codes[200] <= 1 and codes[200] + codes[401] + codes[429] == 5
    assert limit_count(db, "login_username", "ana1") <= USERNAME_LIMIT
    assert limit_count(db, "login_ip", IP_B) <= 1  # the success took its own row back


def test_two_logins_for_different_usernames_and_ips_do_not_wait_for_each_other(accounts):
    responses = run_together(
        [job("ana1", PASSWORD, f"198.51.100.{n}") for n in range(5)]
        + [job("ben1", PASSWORD, f"198.51.101.{n}") for n in range(5)]
    )

    assert statuses(responses) == {200: 10}
