"""Which address a request counts as (#54): the peer, unless it is a trusted proxy, and then the
first `X-Forwarded-For` entry from the right that is not itself a trusted proxy."""

import json
import os
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.client_address import (
    TrustedProxiesError,
    client_key,
    parse_trusted_proxies,
    trusted_proxies,
)
from app.main import app
from tests.auth_support import PASSWORD
from tests.course_support import FIXTURE_BUILD
from tests.dbtools import BACKEND_DIR
from tests.limit_support import (
    IP_LIMIT,
    assert_invalid,
    assert_too_many,
    attempt,
    fail,
    key_digest,
    limit_rows,
    names,
)

PROXIES = "10.0.0.0/8, 192.168.1.5"


def make_request(peer, *headers, client=True):
    """A request from `peer` with raw header lines, in order (`("x-forwarded-for", "1.2.3.4")`)."""
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers],
        "client": (peer, 40000) if client else None,
    }
    return Request(scope)


@pytest.fixture
def proxies(monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXIES", PROXIES)


def xff(*lines):
    return [("x-forwarded-for", line) for line in lines]


# --- the peer address ---


def test_with_no_trusted_proxies_the_peer_is_the_key(monkeypatch):
    monkeypatch.delenv("TRUSTED_PROXIES", raising=False)

    assert client_key(make_request("203.0.113.9", *xff("1.2.3.4"))) == "203.0.113.9"


@pytest.mark.parametrize("value", ["", "   ", " , ,"])
def test_an_empty_value_trusts_no_one(monkeypatch, value):
    monkeypatch.setenv("TRUSTED_PROXIES", value)

    assert trusted_proxies() == ()
    assert client_key(make_request("10.0.0.2", *xff("1.2.3.4"))) == "10.0.0.2"


@pytest.mark.parametrize(
    "header",
    [
        ("x-forwarded-for", "1.2.3.4"),
        ("forwarded", "for=1.2.3.4"),
        ("x-real-ip", "1.2.3.4"),
        ("x-client-ip", "1.2.3.4"),
        ("cf-connecting-ip", "1.2.3.4"),
        ("true-client-ip", "1.2.3.4"),
        ("x-forwarded-host", "1.2.3.4"),
    ],
)
def test_headers_from_an_untrusted_peer_are_ignored(proxies, header):
    assert client_key(make_request("203.0.113.9", header)) == "203.0.113.9"


def test_a_forged_header_from_a_peer_next_to_the_proxy_range_is_ignored(proxies):
    assert client_key(make_request("11.0.0.1", *xff("1.2.3.4"))) == "11.0.0.1"
    assert client_key(make_request("192.168.1.6", *xff("1.2.3.4"))) == "192.168.1.6"


# --- from a trusted proxy ---


def test_a_trusted_peer_gives_the_forwarded_client(proxies):
    assert client_key(make_request("10.1.2.3", *xff("1.2.3.4"))) == "1.2.3.4"
    assert client_key(make_request("192.168.1.5", *xff("1.2.3.4"))) == "1.2.3.4"


def test_a_forged_entry_on_the_left_is_never_used(proxies):
    assert client_key(make_request("10.1.2.3", *xff("9.9.9.9, 1.2.3.4"))) == "1.2.3.4"


def test_a_chain_through_a_second_trusted_proxy_skips_it(proxies):
    assert client_key(make_request("10.1.2.3", *xff("9.9.9.9, 1.2.3.4, 10.7.7.7"))) == "1.2.3.4"
    assert client_key(make_request("10.1.2.3", *xff("1.2.3.4, 10.7.7.7, 192.168.1.5"))) == "1.2.3.4"


def test_header_lines_are_joined_and_read_from_the_right(proxies):
    request = make_request("10.1.2.3", *xff("9.9.9.9", "1.2.3.4, 10.7.7.7"))

    assert client_key(request) == "1.2.3.4"
    assert client_key(make_request("10.1.2.3", *xff("1.2.3.4", "9.9.9.9"))) == "9.9.9.9"


def test_a_header_ending_in_a_trusted_address_still_finds_the_client(proxies):
    assert client_key(make_request("10.1.2.3", *xff("1.2.3.4,10.0.0.9"))) == "1.2.3.4"


def test_spaces_around_entries_are_ignored(proxies):
    assert client_key(make_request("10.1.2.3", *xff("  9.9.9.9 ,   1.2.3.4   "))) == "1.2.3.4"


@pytest.mark.parametrize(
    "lines",
    [
        [],
        [""],
        [" "],
        [","],
        ["unknown"],
        ["not an address"],
        ["1.2.3.4:5678"],
        ["1.2.3.4, 5.6.7.8:80"],
        ["1.2.3.4,"],
        ["1.2.3.4,,10.0.0.9"],
        ["999.1.1.1"],
        ["[2001:db8::1]"],
        ["10.0.0.9"],  # nothing but trusted proxies: there is no client to name
        ["10.0.0.9, 10.0.0.8"],
    ],
)
def test_a_missing_or_unusable_header_falls_back_to_the_peer(proxies, lines):
    assert client_key(make_request("10.1.2.3", *xff(*lines))) == "10.1.2.3"


# --- how an address becomes a key ---


def test_an_ipv4_mapped_ipv6_address_is_its_ipv4_address(proxies):
    assert client_key(make_request("::ffff:203.0.113.9")) == "203.0.113.9"
    assert client_key(make_request("10.1.2.3", *xff("::ffff:1.2.3.4"))) == "1.2.3.4"


def test_an_ipv4_mapped_peer_can_be_a_trusted_proxy(proxies):
    assert client_key(make_request("::ffff:10.1.2.3", *xff("1.2.3.4"))) == "1.2.3.4"


def test_other_ipv6_addresses_count_per_64(proxies):
    same = [
        "2001:db8:1:2::1",
        "2001:db8:1:2:ffff:ffff:ffff:ffff",
        "2001:DB8:1:2:0:0:0:5",
        "2001:db8:1:2::1%eth0",
    ]
    assert {client_key(make_request(address)) for address in same} == {"2001:db8:1:2::/64"}
    assert client_key(make_request("2001:db8:1:3::1")) != client_key(make_request(same[0]))
    assert client_key(make_request("10.1.2.3", *xff("2001:db8:9:9::7"))) == "2001:db8:9:9::/64"


def test_a_peer_that_is_not_an_ip_address_is_used_as_text(proxies):
    assert client_key(make_request("testclient", *xff("1.2.3.4"))) == "testclient"


def test_no_client_at_all_is_the_fixed_text_unknown(proxies):
    assert client_key(make_request(None, client=False)) == "unknown"
    assert client_key(make_request("", *xff("1.2.3.4"))) == "unknown"


# --- TRUSTED_PROXIES ---


def test_addresses_and_ranges_are_parsed_with_spaces_ignored():
    networks = parse_trusted_proxies(" 10.0.0.0/8 ,192.168.1.5,  2001:db8::/32 ")

    assert [str(n) for n in networks] == ["10.0.0.0/8", "192.168.1.5/32", "2001:db8::/32"]


@pytest.mark.parametrize(
    "entry", ["nonsense", "10.0.0.0/33", "10.0.0", "1.2.3.4:80", "10.0.0.0/8;x"]
)
def test_an_invalid_entry_is_an_error_that_names_the_variable(entry):
    with pytest.raises(TrustedProxiesError, match="TRUSTED_PROXIES") as raised:
        parse_trusted_proxies(f"10.0.0.0/8, {entry}")

    assert entry in str(raised.value)


def test_the_app_does_not_start_with_an_invalid_value(monkeypatch):
    monkeypatch.setenv("COURSES", "alpha-course")
    monkeypatch.setenv("COURSE_BUILD_DIR", str(FIXTURE_BUILD))
    monkeypatch.setenv("TRUSTED_PROXIES", "10.0.0.0/8, nonsense")

    with pytest.raises(TrustedProxiesError, match="TRUSTED_PROXIES"), TestClient(app):
        pass


def test_uvicorn_exits_non_zero_and_names_trusted_proxies_when_it_is_invalid():
    env = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
    env.update(COURSES="alpha-course", COURSE_BUILD_DIR=str(FIXTURE_BUILD), TRUSTED_PROXIES="x/y")

    process = subprocess.run(  # noqa: PLW1510 (the exit code is asserted below)
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--port",
            "0",
            "--no-proxy-headers",
            "--no-access-log",
            "--log-config",
            "app/log_config.json",
        ],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert process.returncode != 0
    records = [json.loads(line) for line in process.stderr.splitlines()]
    assert any("TRUSTED_PROXIES" in r["message"] + r.get("stack_trace", "") for r in records)


# --- through the login route ---


def test_forged_headers_from_an_untrusted_peer_do_not_buy_more_tries(accounts, monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXIES", PROXIES)
    for number, username in enumerate(names(IP_LIMIT)):
        headers = {
            "X-Forwarded-For": f"9.9.9.{number}",
            "Forwarded": f"for=9.9.8.{number}",
            "X-Real-IP": f"9.9.7.{number}",
        }
        assert_invalid(fail(username, "203.0.113.9", headers=headers))

    assert_too_many(fail("user99", "203.0.113.9", headers={"X-Forwarded-For": "8.8.8.8"}))


def test_a_trusted_proxy_counts_the_forwarded_client_and_not_a_forged_entry(
    accounts, db, monkeypatch
):
    monkeypatch.setenv("TRUSTED_PROXIES", PROXIES)
    for number, username in enumerate(names(IP_LIMIT)):
        # Whatever the sender writes on the left, the proxy appended the real client: 1.2.3.4.
        headers = {"X-Forwarded-For": f"9.9.9.{number}, 1.2.3.4"}
        assert_invalid(fail(username, "10.0.0.2", headers=headers))

    assert_too_many(fail("user99", "10.0.0.2", headers={"X-Forwarded-For": "7.7.7.7, 1.2.3.4"}))
    assert {bytes(r.key_hash) for r in limit_rows(db, "login_ip")} == {key_digest("1.2.3.4")}
    # Another client behind the same proxy has its own count.
    other = attempt("ana1", PASSWORD, "10.0.0.2", headers={"X-Forwarded-For": "1.2.3.5"})
    assert other.status_code == 200


def test_without_trusted_proxies_everyone_behind_the_proxy_shares_one_count(
    accounts, db, monkeypatch
):
    monkeypatch.delenv("TRUSTED_PROXIES", raising=False)
    for number, username in enumerate(names(IP_LIMIT)):
        assert_invalid(fail(username, "10.0.0.2", headers={"X-Forwarded-For": f"1.2.3.{number}"}))

    assert_too_many(fail("user99", "10.0.0.2", headers={"X-Forwarded-For": "1.2.9.9"}))
    # The address of the proxy was counted, not the header.
    assert {bytes(r.key_hash) for r in limit_rows(db, "login_ip")} == {key_digest("10.0.0.2")}
