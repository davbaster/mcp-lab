"""Accounts and login (#6): register, login, logout, and `me`, through the test client."""

import json
import threading
from types import SimpleNamespace

import pytest
import yaml

from app import auth, passwords
from tests.auth_support import (
    PASSWORD,
    URL,
    assert_error,
    cookie_headers,
    cookie_value,
    count,
    login,
    new_client,
    register,
    rows,
    stored_hash,
    token_hash,
    with_cookie,
)
from tests.conftest import PASSWORD_SENTINEL
from tests.contract import COMMITTED_SPEC

# --- Registration: the happy path ---


def test_register_returns_201_with_the_username_and_a_session_cookie(client):
    response = register(client, "Ana_1", PASSWORD)

    assert response.status_code == 201
    assert response.json() == {"username": "Ana_1"}
    assert cookie_headers(response)[0].startswith("session=")


def test_the_same_client_can_call_me_after_registering(client):
    register(client)

    assert client.get(f"{URL}/me").status_code == 200


# --- Registration: username ---


@pytest.mark.parametrize("username", ["ana", "a" * 9, ""], ids=["3-chars", "9-chars", "empty"])
def test_username_of_the_wrong_length_is_rejected(client, db, username):
    response = register(client, username)

    assert_error(response, 422, "validation_error")
    assert count(db, "accounts") == 0


@pytest.mark.parametrize(
    "username",
    [
        "ana-1",
        "ana 1",
        " ana1",
        "ana1 ",
        "ana1\n",
        "ánaa",
        "ａｎａ１",
        "١٢٣٤",
    ],
    ids=[
        "hyphen",
        "inner-space",
        "leading-space",
        "trailing-space",
        "trailing-newline",
        "accented-letter",
        "fullwidth",
        "arabic-indic-digits",
    ],
)
def test_username_with_a_character_outside_the_set_is_rejected_not_trimmed(client, db, username):
    response = register(client, username)

    assert_error(response, 422, "validation_error")
    assert count(db, "accounts") == 0


@pytest.mark.parametrize("username", [1234, None, ["ana1"]], ids=["number", "null", "list"])
def test_username_that_is_not_a_string_is_rejected(client, db, username):
    response = register(client, username)

    assert_error(response, 422, "validation_error")
    assert count(db, "accounts") == 0


@pytest.mark.parametrize("username", ["ab_1", "AbCd_123"], ids=["4-chars", "8-chars"])
def test_usernames_of_4_and_8_characters_are_accepted(client, username):
    assert register(client, username).status_code == 201


def test_username_422_names_the_field_and_not_the_value(client):
    message = assert_error(register(client, "bad-user"), 422, "validation_error")

    assert "body.username" in message
    assert "bad-user" not in message


def test_username_uniqueness_ignores_case(client, db):
    register(client, "Ana1")

    lower = register(new_client(), "ana1")
    upper = register(new_client(), "ANA1")

    assert_error(lower, 409, "username_taken")
    assert_error(upper, 409, "username_taken")


def test_a_409_sends_no_cookie_and_creates_no_account_or_session(client, db):
    register(client, "Ana1")
    other = new_client()

    response = register(other, "ana1")

    assert response.status_code == 409
    assert cookie_headers(response) == []
    assert count(db, "accounts") == 1
    assert count(db, "sessions") == 1


def test_me_returns_the_username_in_the_case_it_was_registered_with(client):
    register(client, "Ana1")
    register(new_client(), "ana1")  # 409

    assert client.get(f"{URL}/me").json() == {"username": "Ana1"}


# --- Registration: password ---


@pytest.mark.parametrize("password", ["secret12", "secret123456"], ids=["8-chars", "12-chars"])
def test_passwords_of_8_and_12_characters_are_accepted(client, password):
    assert register(client, "ana1", password).status_code == 201


@pytest.mark.parametrize("password", ["secret1", "secret1234567"], ids=["7-chars", "13-chars"])
def test_passwords_of_7_and_13_characters_are_rejected(client, db, password):
    assert_error(register(client, "ana1", password), 422, "validation_error")
    assert count(db, "accounts") == 0


def test_twelve_emoji_are_accepted_though_they_are_48_bytes(client):
    password = "\U0001f600" * 12
    assert len(password.encode()) == 48

    assert register(client, "ana1", password).status_code == 201


def test_seven_emoji_are_rejected_though_they_are_more_than_8_bytes(client):
    password = "\U0001f600" * 7
    assert len(password.encode()) > 8

    assert_error(register(client, "ana1", password), 422, "validation_error")


def test_eight_precomposed_accented_letters_are_accepted(client):
    assert register(client, "ana1", "é" * 8).status_code == 201


def test_eight_letters_typed_with_combining_accents_are_accepted(client):
    password = "é" * 8
    assert len(password) == 16

    assert register(client, "ana1", password).status_code == 201


@pytest.mark.parametrize("password", [""], ids=["empty"])
def test_an_empty_password_is_rejected(client, password):
    assert_error(register(client, "ana1", password), 422, "validation_error")


def test_a_missing_password_is_rejected(client):
    response = client.post(f"{URL}/register", json={"username": "ana1"})

    message = assert_error(response, 422, "validation_error")
    assert "body.password" in message


@pytest.mark.parametrize(
    "password", [12345678, None, ["secret123"]], ids=["number", "null", "list"]
)
def test_a_password_that_is_not_a_string_is_rejected(client, password):
    assert_error(register(client, "ana1", password), 422, "validation_error")


def test_a_password_registered_combining_logs_in_precomposed(client):
    register(client, "ana1", "caf" + "é" + "1234")

    assert login(new_client(), "ana1", "café" + "1234").status_code == 200


def test_a_password_registered_precomposed_logs_in_combining(client):
    register(client, "ana1", "café" + "1234")

    assert login(new_client(), "ana1", "caf" + "é" + "1234").status_code == 200


def test_the_password_is_hashed_as_its_nfkc_normalized_text(client, db):
    register(client, "ana1", "caf" + "é" + "1234")

    assert passwords.hasher.verify(stored_hash(db, "ana1"), "café" + "1234")


def test_spaces_in_a_password_are_kept(client):
    assert register(client, "ana1", "  secret1 ").status_code == 201

    assert_error(login(new_client(), "ana1", "secret1"), 401, "invalid_credentials")
    assert login(new_client(), "ana1", "  secret1 ").status_code == 200


def test_a_password_with_a_nul_character_registers_and_logs_in(client):
    password = "pass\x00word1"

    assert register(client, "ana1", password).status_code == 201
    assert login(new_client(), "ana1", password).status_code == 200


def test_a_password_with_a_lone_surrogate_is_a_422_not_a_500(client, db):
    body = '{"username": "ana1", "password": "\\ud800abcdefg"}'

    response = client.post(
        f"{URL}/register", content=body, headers={"content-type": "application/json"}
    )

    message = assert_error(response, 422, "validation_error")
    assert "abcdefg" not in message
    assert "ud800" not in message
    assert count(db, "accounts") == 0


def test_a_password_that_is_too_long_gets_a_422_that_does_not_echo_it(client):
    response = register(client, "ana1", PASSWORD_SENTINEL)

    message = assert_error(response, 422, "validation_error")
    assert PASSWORD_SENTINEL not in message
    assert PASSWORD_SENTINEL not in response.text


# --- Registration: storage and races ---


def test_the_password_hash_is_argon2id_from_the_production_hasher(client, db, monkeypatch):
    from argon2 import PasswordHasher

    monkeypatch.setattr(passwords, "hasher", PasswordHasher())

    register(client)

    assert stored_hash(db, "ana1").startswith("$argon2id$")


def test_the_stored_row_does_not_contain_the_password(client, db):
    register(client, "ana1", "Zq9uniqpw1")

    (row,) = rows(db, "SELECT a::text FROM app.accounts a")
    assert "Zq9uniqpw1" not in row[0]


def test_two_accounts_with_the_same_password_have_different_hashes(client, db):
    register(client, "ana1")
    register(new_client(), "bob1")

    assert stored_hash(db, "ana1") != stored_hash(db, "bob1")


def test_username_normalized_is_the_lowercase_of_username(client, db):
    register(client, "AnA_Q1")

    assert rows(db, "SELECT username, username_normalized FROM app.accounts") == [
        ("AnA_Q1", "ana_q1")
    ]


def test_concurrent_registrations_of_one_username_create_exactly_one_account(db, clock):
    names = ["Race1", "race1", "RACE1", "rAcE1", "Race1", "race1", "RACE1", "rAcE1"]
    barrier = threading.Barrier(len(names))
    results: list = [None] * len(names)

    def work(index: int) -> None:
        client = new_client()
        barrier.wait()
        try:
            results[index] = register(client, names[index]).status_code, None
        except Exception as exc:  # noqa: BLE001  (reported by the assertion below)
            results[index] = None, repr(exc)

    threads = [threading.Thread(target=work, args=(i,)) for i in range(len(names))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    statuses = sorted(status for status, _ in results)
    assert statuses == [201] + [409] * 7, results
    assert count(db, "accounts") == 1
    assert count(db, "sessions") == 1


def test_a_database_error_other_than_the_username_constraint_stays_a_500(client, db, monkeypatch):
    first = register(client, "ana1")
    assert first.status_code == 201
    (account_id,) = rows(db, "SELECT id FROM app.accounts")[0]
    # Same primary key, different username: a unique violation, but not the username one.
    monkeypatch.setattr(auth, "uuid", SimpleNamespace(uuid4=lambda: account_id))
    other = new_client(raise_server_exceptions=False)

    response = other.post(f"{URL}/register", json={"username": "bob1", "password": PASSWORD})

    assert_error(response, 500, "internal_error")
    assert count(db, "accounts") == 1


def test_registering_with_a_valid_cookie_replaces_the_old_session(client, db):
    first = register(client, "ana1")
    old_token = cookie_value(first)

    second = register(client, "bob1")

    new_token = cookie_value(second)
    assert new_token != old_token
    hashes = [bytes(row[0]) for row in rows(db, "SELECT token_hash FROM app.sessions")]
    assert hashes == [token_hash(new_token)]
    assert client.get(f"{URL}/me").json() == {"username": "bob1"}
    assert_error(
        new_client().get(f"{URL}/me", headers=with_cookie(old_token)), 401, "not_authenticated"
    )


# --- Login ---


def test_login_returns_200_with_the_username_and_a_cookie(client):
    register(client, "Ana1")

    response = login(new_client(), "Ana1")

    assert response.status_code == 200
    assert response.json() == {"username": "Ana1"}
    assert cookie_headers(response)[0].startswith("session=")


def test_login_ignores_case_and_returns_the_registered_case(client):
    register(client, "Ana1")

    response = login(new_client(), "ANA1")

    assert response.status_code == 200
    assert response.json() == {"username": "Ana1"}


def test_failed_logins_give_the_same_401_body_and_no_cookie(client):
    register(client, "ana1")
    wrong_password = login(new_client(), "ana1", "wrong-pass")
    unknown = login(new_client(), "nobody1", PASSWORD)
    unregistrable_space = login(new_client(), "a b", PASSWORD)
    unregistrable_long = login(new_client(), "x" * 64, PASSWORD)

    responses = [wrong_password, unknown, unregistrable_space, unregistrable_long]
    for response in responses:
        assert_error(response, 401, "invalid_credentials")
        assert cookie_headers(response) == []
    assert len({json.dumps(response.json(), sort_keys=True) for response in responses}) == 1


def test_login_does_not_trim_the_username(client):
    register(client, "ana1")

    assert_error(login(new_client(), " ana1"), 401, "invalid_credentials")


def test_login_accepts_a_one_character_username_and_a_one_character_password(client):
    assert_error(login(client, "a", "b"), 401, "invalid_credentials")


def test_login_accepts_the_limits_64_characters_and_128_characters(client):
    assert_error(login(client, "x" * 64, "p" * 128), 401, "invalid_credentials")


@pytest.mark.parametrize(
    "body",
    [
        {"username": "", "password": "secret123"},
        {"username": "x" * 65, "password": "secret123"},
        {"username": "ana1", "password": ""},
        {"username": "ana1", "password": "p" * 129},
        {"password": "secret123"},
        {"username": "ana1"},
        {"username": 1234, "password": "secret123"},
        {"username": "ana1", "password": 12345678},
        {"username": None, "password": "secret123"},
        {"username": "ana1", "password": ["secret123"]},
    ],
    ids=[
        "empty-username",
        "65-char-username",
        "empty-password",
        "129-char-password",
        "missing-username",
        "missing-password",
        "number-username",
        "number-password",
        "null-username",
        "list-password",
    ],
)
def test_login_outside_the_accepted_input_is_a_422(client, body):
    assert_error(client.post(f"{URL}/login", json=body), 422, "validation_error")


def test_login_with_a_lone_surrogate_is_a_422_not_a_500(client):
    body = '{"username": "\\ud800", "password": "secret123"}'

    response = client.post(
        f"{URL}/login", content=body, headers={"content-type": "application/json"}
    )

    assert_error(response, 422, "validation_error")


def test_login_with_a_nul_in_the_username_is_a_401_not_a_500(client):
    assert_error(login(client, "ana\x001"), 401, "invalid_credentials")


class CountingHasher:
    """Wraps the cheap hasher and records every verify call and every hash call."""

    def __init__(self, inner) -> None:
        self.inner = inner
        self.verified: list[str] = []
        self.hashed = 0

    def hash(self, password):
        self.hashed += 1
        return self.inner.hash(password)

    def verify(self, password_hash, password):
        self.verified.append(password_hash)
        return self.inner.verify(password_hash, password)


@pytest.fixture
def counting(monkeypatch):
    wrapper = CountingHasher(passwords.hasher)
    monkeypatch.setattr(passwords, "hasher", wrapper)
    return wrapper


def _parameters(argon_hash: str) -> str:
    return argon_hash.split("$")[3]  # m=...,t=...,p=...


def test_a_wrong_password_runs_one_argon2_verification(client, counting):
    register(client, "ana1")
    counting.verified.clear()

    login(new_client(), "ana1", "wrong-pass")

    assert len(counting.verified) == 1


def test_an_unknown_username_runs_one_argon2_verification(client, counting):
    login(client, "nobody1", PASSWORD)

    assert len(counting.verified) == 1


def test_an_unregistrable_username_runs_one_verification(client, counting):
    login(client, "a b", PASSWORD)

    assert len(counting.verified) == 1


def test_the_dummy_hash_is_built_once_with_the_parameters_of_a_stored_hash(client, db, counting):
    register(client, "ana1")
    counting.hashed = 0
    counting.verified.clear()

    login(new_client(), "nobody1")
    login(new_client(), "nobody2")
    login(new_client(), "a b")

    assert counting.hashed == 1
    assert len(counting.verified) == 3
    assert len(set(counting.verified)) == 1
    assert _parameters(counting.verified[0]) == _parameters(stored_hash(db, "ana1"))


def test_a_password_over_128_characters_is_refused_before_any_hashing(client, counting):
    response = login(client, "ana1", "p" * 129)

    assert response.status_code == 422
    assert counting.verified == []
    assert counting.hashed == 0


def test_login_ignores_credentials_in_the_query_string(client):
    register(client, "ana1")

    response = new_client().post(f"{URL}/login?username=ana1&password=secret123")

    assert_error(response, 422, "validation_error")


def test_login_with_a_body_ignores_credentials_in_the_query_string(client):
    register(client, "ana1")

    response = new_client().post(
        f"{URL}/login?username=other&password=wrong",
        json={"username": "ana1", "password": PASSWORD},
    )

    assert response.status_code == 200
    assert response.json() == {"username": "ana1"}


def test_no_auth_route_declares_a_query_parameter_in_openapi():
    paths = yaml.safe_load(COMMITTED_SPEC.read_bytes())["paths"]

    for path in ("register", "login", "logout", "me"):
        for operation in paths[f"{URL}/{path}"].values():
            assert "parameters" not in operation, path


@pytest.mark.parametrize(
    "content_type",
    ["text/plain", "application/x-www-form-urlencoded"],
    ids=["text-plain", "form-urlencoded"],
)
def test_login_with_a_non_json_content_type_is_a_422_and_creates_no_session(
    client, db, content_type
):
    register(client, "ana1")
    sessions_before = count(db, "sessions")
    body = json.dumps({"username": "ana1", "password": PASSWORD})

    response = new_client().post(
        f"{URL}/login", content=body, headers={"content-type": content_type}
    )

    assert_error(response, 422, "validation_error")
    assert cookie_headers(response) == []
    assert count(db, "sessions") == sessions_before


def test_login_from_two_clients_makes_two_sessions_that_both_work(client, db):
    register(client, "ana1")
    first, second = new_client(), new_client()
    login(first)
    login(second)

    assert count(db, "sessions") == 3  # the registration's, plus two logins
    assert first.get(f"{URL}/me").status_code == 200
    assert second.get(f"{URL}/me").status_code == 200


def test_logging_out_one_session_leaves_the_other_working(client):
    register(client, "ana1")
    first, second = new_client(), new_client()
    login(first)
    login(second)

    first.post(f"{URL}/logout")

    assert first.get(f"{URL}/me").status_code == 401
    assert second.get(f"{URL}/me").status_code == 200


def test_logging_in_again_replaces_the_session_with_a_fresh_token(client, db):
    old_token = cookie_value(register(client, "ana1"))

    new_token = cookie_value(login(client))

    assert new_token != old_token
    assert count(db, "sessions") == 1
    assert_error(
        new_client().get(f"{URL}/me", headers=with_cookie(old_token)), 401, "not_authenticated"
    )
    assert client.get(f"{URL}/me").status_code == 200


# --- Logout ---


def test_logout_returns_204_with_no_body_and_deletes_only_that_session(client, db):
    register(client, "ana1")
    other = new_client()
    other_token = cookie_value(login(other))
    mine = cookie_value(login(client))

    response = client.post(f"{URL}/logout")

    assert response.status_code == 204
    assert response.content == b""
    hashes = [bytes(row[0]) for row in rows(db, "SELECT token_hash FROM app.sessions")]
    assert hashes == [token_hash(other_token)]
    assert token_hash(mine) not in hashes


def test_replaying_the_old_cookie_after_logout_is_a_401(client):
    token = cookie_value(register(client, "ana1"))
    client.post(f"{URL}/logout")

    response = new_client().get(f"{URL}/me", headers=with_cookie(token))

    assert_error(response, 401, "not_authenticated")


def test_the_clearing_cookie_repeats_every_attribute_of_the_original(client):
    register(client, "ana1")

    response = client.post(f"{URL}/logout")

    (header,) = cookie_headers(response)
    assert header.split("; ")[0] == "session="
    assert sorted(header.split("; ")[1:]) == sorted(
        ["Max-Age=0", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]
    )
    assert "domain" not in header.lower()


def test_logout_without_a_cookie_is_a_204(client):
    assert client.post(f"{URL}/logout").status_code == 204


def test_a_second_logout_with_the_same_cookie_is_a_204(client):
    token = cookie_value(register(client, "ana1"))
    client.post(f"{URL}/logout", headers=with_cookie(token))

    assert new_client().post(f"{URL}/logout", headers=with_cookie(token)).status_code == 204


@pytest.mark.parametrize(
    "value",
    ["x" * 43, "", "z" * 5000, "café".encode("latin-1"), "A" * 43],
    ids=["unknown-43-chars", "empty", "5000-chars", "non-ascii", "token-shaped-not-stored"],
)
def test_logout_with_a_garbage_cookie_is_a_204_deletes_nothing_and_keeps_other_sessions(
    client, db, value
):
    register(client, "ana1")
    other = new_client()
    login(other)

    response = new_client().post(f"{URL}/logout", headers=with_cookie(value))

    assert response.status_code == 204
    assert count(db, "sessions") == 2
    assert other.get(f"{URL}/me").status_code == 200


def test_logout_with_an_expired_session_is_a_204_and_removes_the_row(client, db, clock):
    token = cookie_value(register(client, "ana1"))
    clock.advance(hours=25)

    response = new_client().post(f"{URL}/logout", headers=with_cookie(token))

    assert response.status_code == 204
    assert count(db, "sessions") == 0


@pytest.mark.parametrize("route", ["register", "login", "logout"])
def test_get_on_a_state_changing_route_is_a_405(client, db, route):
    response = client.get(f"{URL}/{route}")

    assert_error(response, 405, "method_not_allowed")
    assert count(db, "sessions") == 0
