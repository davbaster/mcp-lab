"""Fixtures and helpers shared by the account and session tests (#6)."""

import hashlib
from datetime import UTC, datetime, timedelta

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import passwords
from app.clock import current_time
from app.main import app

BASE_URL = "https://testserver"  # https, so the client's cookie jar sends the Secure cookie
START = datetime(2030, 1, 15, 12, 0, 0, tzinfo=UTC)
PASSWORD = "secret123"
URL = "/api/auth"


class FakeClock:
    def __init__(self, now: datetime = START) -> None:
        self.now = now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture(autouse=True)
def cheap_hasher(monkeypatch):
    """A fast argon2 hasher, so the suite stays quick. One test uses the production one."""
    monkeypatch.setattr(
        passwords, "hasher", PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)
    )


@pytest.fixture
def clock():
    fake = FakeClock()
    app.dependency_overrides[current_time] = fake
    yield fake
    app.dependency_overrides.pop(current_time, None)


@pytest.fixture
def client(db, clock):
    return new_client()


def new_client(raise_server_exceptions: bool = True) -> TestClient:
    return TestClient(app, base_url=BASE_URL, raise_server_exceptions=raise_server_exceptions)


def register(client, username="ana1", password=PASSWORD):
    return client.post(f"{URL}/register", json={"username": username, "password": password})


def login(client, username="ana1", password=PASSWORD):
    return client.post(f"{URL}/login", json={"username": username, "password": password})


def cookie_headers(response) -> list[str]:
    return response.headers.get_list("set-cookie")


def cookie_value(response) -> str:
    (header,) = cookie_headers(response)
    return header.split(";", 1)[0].split("=", 1)[1]


def parse_set_cookie(header: str) -> tuple[str, str, list[str]]:
    """(name, value, attribute tokens) from a raw Set-Cookie header."""
    first, *attributes = [part.strip() for part in header.split(";")]
    name, _, value = first.partition("=")
    return name, value, attributes


def with_cookie(value: str | bytes) -> dict[str, str | bytes]:
    """A Cookie header written by hand (the client's own jar forgets what the server deleted)."""
    if isinstance(value, str):
        return {"Cookie": f"session={value}"}
    return {"Cookie": b"session=" + value}


def token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def rows(db, sql: str, **params) -> list:
    with db.connect() as conn:
        return list(conn.execute(text(sql), params))


def count(db, table: str) -> int:
    return rows(db, f"SELECT count(*) FROM app.{table}")[0][0]


def stored_hash(db, username: str) -> str:
    return rows(db, "SELECT password_hash FROM app.accounts WHERE username = :u", u=username)[0][0]


def assert_error(response, status, code):
    assert response.status_code == status
    body = response.json()
    assert list(body) == ["error"]
    assert body["error"]["code"] == code
    return body["error"]["message"]
