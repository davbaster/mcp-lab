"""Sessions and the session cookie (#6): attributes, storage, expiry, `me`, `current_learner`."""

import base64
import re
from datetime import timedelta
from typing import Annotated

import pytest
from fastapi import Depends, FastAPI

from app.clock import current_time
from app.errors import ErrorResponse, install_error_handling
from app.sessions import COOKIE_NAME, Learner, current_learner
from tests.auth_support import (
    PASSWORD,
    START,
    URL,
    assert_error,
    cookie_headers,
    cookie_value,
    count,
    login,
    new_client,
    parse_set_cookie,
    register,
    rows,
    stored_hash,
    token_hash,
    with_cookie,
)
from tests.conftest import PASSWORD_SENTINEL

# --- The cookie ---


def _assert_cookie_attributes(response):
    (header,) = cookie_headers(response)
    name, value, attributes = parse_set_cookie(header)
    assert name == "session"
    assert value
    assert sorted(attributes) == sorted(
        ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=86400"]
    )
    assert "domain" not in header.lower()


def test_the_register_cookie_has_the_required_attributes_and_no_domain(client):
    _assert_cookie_attributes(register(client, "ana1"))


def test_the_login_cookie_has_the_required_attributes_and_no_domain(client):
    register(client, "ana1")

    _assert_cookie_attributes(login(new_client(), "ana1"))


def test_secure_is_set_even_when_the_request_came_over_plain_http(client):
    register(client, "ana1")
    plain = new_client()
    plain.base_url = "http://testserver"

    response = login(plain, "ana1")

    assert "Secure" in parse_set_cookie(cookie_headers(response)[0])[2]


def test_secure_is_set_whatever_x_forwarded_proto_says(client):
    register(client, "ana1")

    response = new_client().post(
        f"{URL}/login",
        json={"username": "ana1", "password": PASSWORD},
        headers={"X-Forwarded-Proto": "http"},
    )

    assert "Secure" in parse_set_cookie(cookie_headers(response)[0])[2]


def test_the_cookie_value_is_43_url_safe_characters_from_32_random_bytes(client):
    token = cookie_value(register(client, "ana1"))

    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", token)
    assert len(base64.urlsafe_b64decode(token + "=")) == 32


def test_two_logins_give_different_cookie_values(client):
    register(client, "ana1")

    first = cookie_value(login(new_client(), "ana1"))
    second = cookie_value(login(new_client(), "ana1"))

    assert first != second


def test_the_database_stores_the_sha256_digest_and_never_the_token(client, db):
    token = cookie_value(register(client, "ana1"))

    (row,) = rows(db, "SELECT token_hash FROM app.sessions")
    assert bytes(row[0]) == token_hash(token)
    assert len(bytes(row[0])) == 32


def test_the_token_appears_in_no_column_of_any_table(client, db):
    token = cookie_value(register(client, "ana1"))
    tables = [r[0] for r in rows(db, "SELECT tablename FROM pg_tables WHERE schemaname = 'app'")]

    for table in tables:
        for (text_row,) in rows(db, f"SELECT t::text FROM app.{table} t"):
            assert token not in text_row


def test_expires_at_is_exactly_24_hours_after_created_at_from_the_injected_clock(client, db):
    register(client, "ana1")

    ((created, expires),) = rows(db, "SELECT created_at, expires_at FROM app.sessions")
    assert created == START
    assert expires == START + timedelta(hours=24)


def test_the_account_created_at_comes_from_the_injected_clock(client, db):
    register(client, "ana1")

    assert rows(db, "SELECT created_at FROM app.accounts")[0][0] == START


# --- Expiry ---


def test_a_session_works_one_second_before_it_expires(client, clock):
    register(client, "ana1")
    clock.advance(hours=24, seconds=-1)

    assert client.get(f"{URL}/me").status_code == 200


def test_a_session_is_rejected_at_exactly_expires_at(client, clock):
    register(client, "ana1")
    clock.advance(hours=24)

    assert_error(client.get(f"{URL}/me"), 401, "not_authenticated")


def test_a_session_is_rejected_one_second_after_it_expires(client, clock):
    register(client, "ana1")
    clock.advance(hours=24, seconds=1)

    assert_error(client.get(f"{URL}/me"), 401, "not_authenticated")


def test_expiry_is_fixed_not_sliding(client, clock):
    register(client, "ana1")
    clock.advance(hours=12)
    assert client.get(f"{URL}/me").status_code == 200

    clock.advance(hours=12)

    assert_error(client.get(f"{URL}/me"), 401, "not_authenticated")


def test_an_expired_session_row_is_left_in_place(client, db, clock):
    register(client, "ana1")
    clock.advance(hours=48)

    client.get(f"{URL}/me")

    assert count(db, "sessions") == 1


@pytest.mark.parametrize(
    "value",
    [None, "x" * 43, "", "z" * 5000, "café".encode("latin-1")],
    ids=["missing", "unknown", "empty", "5000-chars", "non-ascii"],
)
def test_me_with_a_bad_cookie_is_the_same_401_as_an_expired_session(client, clock, value):
    expired = new_client()
    register(expired, "ana1")
    clock.advance(hours=25)
    expected = assert_error(expired.get(f"{URL}/me"), 401, "not_authenticated")
    headers = {} if value is None else with_cookie(value)

    response = new_client().get(f"{URL}/me", headers=headers)

    assert assert_error(response, 401, "not_authenticated") == expected


# --- me ---


def test_me_returns_exactly_the_username(client, db):
    token = cookie_value(register(client, "Ana1"))

    response = client.get(f"{URL}/me")

    assert response.status_code == 200
    assert response.json() == {"username": "Ana1"}
    account_id = str(rows(db, "SELECT id FROM app.accounts")[0][0])
    for secret in (account_id, stored_hash(db, "Ana1"), token, token_hash(token).hex()):
        assert secret not in response.text


@pytest.mark.parametrize("action", [register, login, "me"], ids=["register", "login", "me"])
def test_successful_responses_are_marked_no_store(client, action):
    register(client, "ana1")
    other = new_client()
    if action == "me":
        response = client.get(f"{URL}/me")
    elif action is login:
        response = login(other, "ana1")
    else:
        response = register(other, "bob1")

    assert response.status_code in (200, 201)
    assert response.headers["cache-control"] == "no-store"


# --- current_learner ---


def make_app() -> FastAPI:
    throwaway = FastAPI()
    install_error_handling(throwaway)

    @throwaway.get("/whoami", responses={401: {"model": ErrorResponse}})
    def whoami(learner: Annotated[Learner, Depends(current_learner)]) -> dict[str, str]:
        return {"username": learner.username, "id": str(learner.account_id)}

    return throwaway


@pytest.fixture
def probe(db, clock):
    from fastapi.testclient import TestClient

    throwaway = make_app()
    throwaway.dependency_overrides[current_time] = clock
    return TestClient(throwaway, base_url="https://testserver")


def test_current_learner_gives_the_account_id_and_username_for_a_valid_cookie(client, db, probe):
    token = cookie_value(register(client, "Ana1"))

    response = probe.get("/whoami", headers=with_cookie(token))

    assert response.status_code == 200
    account_id = str(rows(db, "SELECT id FROM app.accounts")[0][0])
    assert response.json() == {"username": "Ana1", "id": account_id}


def test_current_learner_without_a_cookie_is_the_shared_401(probe):
    assert_error(probe.get("/whoami"), 401, "not_authenticated")


def test_current_learner_with_an_expired_cookie_is_the_shared_401(client, probe, clock):
    token = cookie_value(register(client, "ana1"))
    clock.advance(hours=24)

    assert_error(probe.get("/whoami", headers=with_cookie(token)), 401, "not_authenticated")


@pytest.mark.parametrize("value", ["x" * 43, "", "z" * 5000], ids=["unknown", "empty", "long"])
def test_current_learner_with_a_garbage_cookie_is_the_shared_401(probe, value):
    assert_error(probe.get("/whoami", headers=with_cookie(value)), 401, "not_authenticated")


def test_current_learner_reads_the_cookie_with_an_api_key_cookie_scheme():
    scheme = make_app().openapi()["components"]["securitySchemes"]

    assert list(scheme.values()) == [{"type": "apiKey", "in": "cookie", "name": COOKIE_NAME}]


# --- Logs ---


def secrets_for(db, token: str, password: str) -> list[str]:
    digest = token_hash(token)
    return [
        password,
        stored_hash(db, "ana1"),
        token,
        digest.hex(),
        base64.b64encode(digest).decode(),
    ]


def assert_no_secrets(caplog, *secrets: str) -> None:
    for secret in secrets:
        assert secret not in caplog.text


def test_register_success_logs_no_secret(client, db, caplog):
    token = cookie_value(register(client, "ana1", "Zq9uniqpw1"))

    assert_no_secrets(caplog, *secrets_for(db, token, "Zq9uniqpw1"))


def test_register_409_logs_no_secret(client, caplog):
    register(client, "ana1")

    register(new_client(), "ANA1", "Zq9uniqpw1")

    assert_no_secrets(caplog, "Zq9uniqpw1")


def test_register_422_logs_no_secret(client, caplog):
    register(client, "ana1", PASSWORD_SENTINEL)

    assert PASSWORD_SENTINEL not in caplog.text


def test_login_success_logs_no_secret(client, db, caplog):
    register(client, "ana1", "Zq9uniqpw1")
    token = cookie_value(login(new_client(), "ana1", "Zq9uniqpw1"))

    assert_no_secrets(caplog, *secrets_for(db, token, "Zq9uniqpw1"))


def test_login_with_a_wrong_password_logs_no_secret(client, db, caplog):
    register(client, "ana1")

    login(new_client(), "ana1", PASSWORD_SENTINEL)

    assert_no_secrets(caplog, PASSWORD_SENTINEL, stored_hash(db, "ana1"))


def test_login_with_an_unknown_username_logs_no_secret(client, caplog):
    login(new_client(), "nobody1", PASSWORD_SENTINEL)

    assert PASSWORD_SENTINEL not in caplog.text


def test_login_with_the_password_typed_in_the_username_field_logs_no_secret(client, caplog):
    login(new_client(), PASSWORD_SENTINEL, PASSWORD_SENTINEL)
    new_client().post(f"{URL}/login", json={"username": PASSWORD_SENTINEL * 5, "password": "x"})

    assert PASSWORD_SENTINEL not in caplog.text


def test_logout_logs_no_secret(client, db, caplog):
    token = cookie_value(register(client, "ana1"))
    client.post(f"{URL}/logout")

    assert_no_secrets(caplog, *secrets_for(db, token, PASSWORD))


def test_me_with_a_garbage_cookie_logs_no_secret(client, caplog):
    garbage = "garbage-cookie-" + "q" * 28

    new_client().get(f"{URL}/me", headers=with_cookie(garbage))

    assert garbage not in caplog.text
    assert token_hash(garbage).hex() not in caplog.text


def test_a_database_error_while_registering_logs_no_hash_and_no_submitted_value(db, clock, caplog):
    from sqlalchemy import text

    with db.begin() as conn:
        conn.execute(
            text("ALTER TABLE app.accounts ADD CONSTRAINT test_always_fails CHECK (false)")
        )
    try:
        response = new_client(raise_server_exceptions=False).post(
            f"{URL}/register", json={"username": "Zq9xKw", "password": "Zq9uniqpw1"}
        )
    finally:
        with db.begin() as conn:
            conn.execute(text("ALTER TABLE app.accounts DROP CONSTRAINT test_always_fails"))

    assert_error(response, 500, "internal_error")
    assert "SQLSTATE 23514" in caplog.text  # the error really was logged
    for secret in ("$argon2", "Zq9xKw", "zq9xkw", "Zq9uniqpw1"):
        assert secret not in caplog.text
