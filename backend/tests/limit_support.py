"""Fixtures and helpers shared by the failed-login limit tests (#54).

Every request is sent from a client with its own address (`client_at`), because the default
test client always has the address `testclient`. The accounts are `ana1` and `ben1`.
"""

import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import passwords
from app.main import app
from tests.auth_support import BASE_URL, PASSWORD, URL, register

IP_A = "203.0.113.9"
IP_B = "203.0.113.10"
WRONG = "wrong-pass"
TOO_MANY_BODY = {
    "error": {
        "code": "too_many_attempts",
        "message": "Too many failed sign-in attempts. Try again later.",
    }
}
USERNAME_LIMIT = 5
IP_LIMIT = 20
WINDOW_SECONDS = 15 * 60


def client_at(ip: str = IP_A, port: int = 50000, raise_server_exceptions: bool = True):
    return TestClient(
        app,
        base_url=BASE_URL,
        client=(ip, port),
        raise_server_exceptions=raise_server_exceptions,
    )


def attempt(username="ana1", password=PASSWORD, ip=IP_A, headers=None, client=None):
    """One login from `ip` (or from `client`, to keep its cookies)."""
    return (client or client_at(ip)).post(
        f"{URL}/login", json={"username": username, "password": password}, headers=headers
    )


def fail(username="ana1", ip=IP_A, **kwargs):
    return attempt(username, WRONG, ip, **kwargs)


def names(count: int, prefix: str = "user") -> list[str]:
    return [f"{prefix}{n:02d}" for n in range(1, count + 1)]


def retry_after(response) -> int:
    return int(response.headers["retry-after"])


def assert_too_many(response, seconds: int | None = None):
    assert response.status_code == 429
    assert response.json() == TOO_MANY_BODY
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers
    if seconds is not None:
        assert retry_after(response) == seconds
    return response


def assert_invalid(response):
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_credentials"


def key_digest(key: str) -> bytes:
    return hashlib.sha256(key.encode()).digest()


def limit_rows(db, scope: str | None = None) -> list:
    where, params = ("WHERE scope = :scope", {"scope": scope}) if scope else ("", {})
    with db.connect() as conn:
        return list(
            conn.execute(
                text(
                    "SELECT scope, key_hash, failed_at FROM app.rate_limit_failures "
                    f"{where} ORDER BY failed_at, scope"
                ),
                params,
            )
        )


def limit_count(db, scope: str | None = None, key: str | None = None) -> int:
    rows = limit_rows(db, scope)
    if key is not None:
        rows = [r for r in rows if bytes(r.key_hash) == key_digest(key)]
    return len(rows)


def insert_expired(db, count: int, failed_at) -> None:
    """`count` rows of one made-up key, all failed at `failed_at`."""
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app.rate_limit_failures (id, scope, key_hash, failed_at) "
                "SELECT gen_random_uuid(), 'login_ip', :digest, :at FROM generate_series(1, :n)"
            ),
            {"digest": key_digest("old-key"), "at": failed_at, "n": count},
        )


def run_together(jobs):
    """Run each job (a function of nothing) in its own thread, all released at once by a
    barrier. Returns the results in order."""
    barrier = threading.Barrier(len(jobs))

    def work(job):
        barrier.wait()
        return job()

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = [pool.submit(work, job) for job in jobs]
        return [future.result(timeout=60) for future in futures]


class VerifyCounter:
    """Counts the password checks (argon2 verifications) the login route starts."""

    def __init__(self, real):
        self.real = real
        self.calls = 0
        self._lock = threading.Lock()

    def __call__(self, password_hash, password):
        with self._lock:
            self.calls += 1
        return self.real(password_hash, password)


@pytest.fixture
def verifications(monkeypatch):
    counter = VerifyCounter(passwords.verify_password)
    monkeypatch.setattr(passwords, "verify_password", counter)
    return counter


@pytest.fixture
def accounts(client):
    """`ana1` and `ben1` exist (both with the password in `auth_support.PASSWORD`)."""
    for username in ("ana1", "ben1"):
        assert register(client, username).status_code == 201
        client.cookies.clear()
    return client
