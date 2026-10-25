"""Which address a request came from, for the rate limits (#54; #97 reuses `client_key`).

The connection's peer address (`request.client`) is the default. Only when the peer is a trusted
proxy, one of the addresses or ranges in `TRUSTED_PROXIES`, is `X-Forwarded-For` read, because
any client can send that header. Uvicorn's own proxy-header handling is switched off
(`--no-proxy-headers` in the Dockerfile), so this module is the only place that decides.

The result is a key, not an address to show anyone: it goes into a SHA-256 digest and nowhere
else. An IPv4-mapped IPv6 address counts as its IPv4 address, any other IPv6 address counts per
/64 (one machine usually controls a whole /64), and a peer that is not an IP address at all (the
test client's `testclient`) is used as text.
"""

import ipaddress
import os
from functools import lru_cache

from fastapi import Request

TRUSTED_PROXIES_VARIABLE = "TRUSTED_PROXIES"
UNKNOWN = "unknown"

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


class TrustedProxiesError(ValueError):
    """`TRUSTED_PROXIES` has an entry that is not an IP address or a CIDR range."""


def _short(entry: str) -> str:
    return repr(entry if len(entry) <= 40 else entry[:40] + "...")


@lru_cache(maxsize=8)
def parse_trusted_proxies(raw: str) -> tuple[IPNetwork, ...]:
    """The networks in a comma-separated list of IP addresses and CIDR ranges.

    Spaces around an entry are ignored and empty entries are skipped, so an empty value trusts
    no one. A host bit in a range (`10.0.0.1/8`) is accepted. Raises `TrustedProxiesError`, with a
    message that names `TRUSTED_PROXIES`, for any other entry.
    """
    networks = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            raise TrustedProxiesError(
                f"{TRUSTED_PROXIES_VARIABLE} entry {_short(entry)} is not an IP address or a CIDR "
                "range (for example 10.0.0.0/8 or 192.168.1.5); separate entries with commas."
            ) from None
    return tuple(networks)


def trusted_proxies() -> tuple[IPNetwork, ...]:
    """The configured trusted proxies; none when `TRUSTED_PROXIES` is unset or empty.

    Read on every call (the parse is cached), so a change of the variable takes effect without
    a restart in tests. The app calls it once at startup, so a bad value stops the backend.
    """
    return parse_trusted_proxies(os.environ.get(TRUSTED_PROXIES_VARIABLE, ""))


def _parse_ip(text: str) -> IPAddress | None:
    """The address in `text`, or None. An IPv4-mapped IPv6 address becomes its IPv4 address."""
    try:
        address = ipaddress.ip_address(text.strip())
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _is_trusted(address: IPAddress, networks: tuple[IPNetwork, ...]) -> bool:
    return any(address in network for network in networks)


def _key(address: IPAddress) -> str:
    if isinstance(address, ipaddress.IPv6Address):
        # int() drops a zone ("%eth0"), which must not make one machine look like many.
        return str(ipaddress.IPv6Network((int(address) >> 64 << 64, 64)))
    return str(address)


def _forwarded_client(request: Request, networks: tuple[IPNetwork, ...]) -> IPAddress | None:
    """The client named by `X-Forwarded-For`, or None when the header cannot be used.

    Read from the right, because each proxy appends the address it saw, so the entries on the
    left are whatever the sender claimed. Entries that are trusted proxies themselves are
    skipped; the first other entry is the client. If that entry is not an IP address, or every
    entry is a trusted proxy, nothing is used.
    """
    entries = ",".join(request.headers.getlist("x-forwarded-for")).split(",")
    for entry in reversed(entries):
        address = _parse_ip(entry)
        if address is None:
            return None
        if not _is_trusted(address, networks):
            return address
    return None


def client_key(request: Request) -> str:
    """The key that stands for the sender of `request` in a rate limit."""
    peer = request.client.host if request.client is not None else None
    if peer is None:
        return UNKNOWN
    peer_address = _parse_ip(peer)
    if peer_address is None:
        return peer or UNKNOWN
    networks = trusted_proxies()
    if _is_trusted(peer_address, networks):
        forwarded = _forwarded_client(request, networks)
        if forwarded is not None:
            return _key(forwarded)
    return _key(peer_address)
