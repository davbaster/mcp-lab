"""Password hashing: the one argon2 hasher, and the text rules that go with it.

Passwords are NFKC-normalized before hashing and before counting characters, so the same
password typed as `é` or as `e` plus U+0301 is the same password.
"""

import unicodedata

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

# Library defaults (argon2id). Tests may replace this with a cheaper hasher.
hasher = PasswordHasher()

_dummy: tuple[PasswordHasher, str] | None = None


def normalize(password: str) -> str:
    return unicodedata.normalize("NFKC", password)


def hash_password(password: str) -> str:
    """Hash an already-normalized password."""
    return hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    """One argon2 verification of an already-normalized password."""
    try:
        return hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def dummy_hash() -> str:
    """A hash made once by the same hasher, to verify against when the account does not exist."""
    global _dummy
    if _dummy is None or _dummy[0] is not hasher:
        _dummy = (hasher, hasher.hash("dummy-password-never-matches"))
    return _dummy[1]
