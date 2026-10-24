import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine

from app.main import app
from tests.conftest import PASSWORD_SENTINEL


@pytest.fixture
def no_connections(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the health route must not open a database connection")

    monkeypatch.setattr(Engine, "connect", refuse)
    monkeypatch.setattr(Engine, "begin", refuse)


def test_health_ok_when_database_url_is_unset(monkeypatch, no_connections):
    monkeypatch.delenv("DATABASE_URL", raising=False)

    response = TestClient(app).get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_ok_and_fast_when_database_is_unreachable(monkeypatch, no_connections):
    monkeypatch.setenv("DATABASE_URL", f"postgresql+psycopg://u:{PASSWORD_SENTINEL}@127.0.0.1:1/x")
    client = TestClient(app)

    start = time.monotonic()
    response = client.get("/api/health")
    elapsed = time.monotonic() - start

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert elapsed < 1
