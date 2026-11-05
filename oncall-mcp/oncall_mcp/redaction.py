"""Keep sensitive values out of everything the on-call server returns: one function, `redact`.

`redact(value)` takes a string, number, boolean, None, or lists and dicts nested to any depth, and
returns a new value. It never changes its input. Each removed value becomes `[REDACTED:<kind>]`,
where the kind (one of `KINDS`) says what was there: `password`, `token`, `cookie`, `email`,
`username` or `quiz_answer`. Running it twice gives the same result as running it once.

It works in two layers.

- Key names. A value under a key whose name (lowercased, `-` read as `_`) matches is replaced
  whole, whatever its type, even a nested dict or list. `password`/`passwd`/`pwd` give `password`;
  `token`, `secret`, `api_key`, `apikey`, `session`, `authorization` give `token`; `cookie` and
  `set_cookie` give `cookie`; `email` gives `email`; `correct`, `option_id`, `answers` and
  `explanation` (so `correct_option_id` too) give `quiz_answer`; `username`, and exactly `user`,
  give `username`. The words match as parts of a name, so `X-Auth-Token` and `session_count` are
  masked (over-masking is accepted), but `user_agent`, `course_id` and `lesson_id` are not. When a
  name has several words, `password` wins over `cookie`, then `token`, `quiz_answer`, `email`,
  `username`.
- Text. Every string is searched for `Cookie:`, `Set-Cookie:` and `Authorization:` header lines (to
  the end of the line), `Bearer ...`, GitHub tokens (`ghp_`, `github_pat_`), Anthropic API keys
  (`sk-ant-`), JWT-shaped strings, `https://user:pass@host`, `key=value`, `key: value` and quoted
  `"key": "value"` pairs for the key words above (also in URL query strings, and with the quotes
  escaped as `\\"`), and email addresses anywhere. In text, `session=...` is a `cookie`; as a dict
  key, `session` is a `token`.
- A string that holds a JSON object or list (up to 1 MB), such as a JSON field inside a JSON
  field, is parsed, redacted as a structure and written back; if it does not parse (cut off,
  malformed), only the text patterns apply.

Limits. What it cannot catch:

- A learner's username (or any name) written as plain text with no key and no pattern around it.
  Feedback resources (#46) must therefore never include identity at all.
- Free-form personal data: names, addresses, phone numbers, text a learner typed.
- Secrets in a format it does not know, with no key or header around them.
- Encoded values: base64, hex, URL-encoded or compressed text are not decoded.
- Truncated or malformed JSON: only the text patterns apply, so a secret that sits under an
  unusual key name is not caught.
- Over-masking is accepted: a key such as `correct_count` or a phrase such as "user: not found"
  is masked too. A value with spaces after an unquoted `key=` loses only its first word.
- Anything deeper than `MAX_DEPTH` levels, and a container that contains itself, is replaced whole
  by `[REDACTED:token]` (the nearest kind; it is a safety stop, not a finding).
"""

import json
import re
from collections.abc import Mapping
from functools import lru_cache
from typing import Any

KINDS = ("password", "token", "cookie", "email", "username", "quiz_answer")
MAX_DEPTH = 50
# A string that holds JSON is parsed only up to this size.
MAX_JSON_CHARS = 1_000_000

_MARKER_TEXT = "[REDACTED:"
_MARKER = re.compile(r"\[REDACTED:(?:password|token|cookie|email|username|quiz_answer)\]")
_STOP = "[REDACTED:token]"

# --- key names ---

_PASSWORD_WORDS = ("password", "passwd", "pwd")
_COOKIE_WORDS = ("cookie",)
_TOKEN_WORDS = ("token", "secret", "api_key", "apikey", "authorization")
_QUIZ_WORDS = ("correct", "option_id", "answers", "explanation")


def _marker(kind: str) -> str:
    return f"[REDACTED:{kind}]"


@lru_cache(maxsize=2048)
def _key_kind(key: str) -> str | None:
    """The kind a key name stands for, or None. `user` matches only as the whole name."""
    name = key.lower().replace("-", "_")
    if any(word in name for word in _PASSWORD_WORDS):
        return "password"
    if any(word in name for word in _COOKIE_WORDS):
        return "cookie"
    if "session" in name or any(word in name for word in _TOKEN_WORDS):
        return "token"
    if any(word in name for word in _QUIZ_WORDS):
        return "quiz_answer"
    if "email" in name:
        return "email"
    if "username" in name or name == "user":
        return "username"
    return None


# --- text patterns ---

_FLAGS = re.IGNORECASE | re.ASCII
# Each value class refuses to start on a marker, so a second pass changes nothing.
_NOT_MARKER = r"(?!\\?[\"']?\[REDACTED:)"
_KEY_CHARS = r"[A-Za-z0-9_\-]"
_TOKEN_PREFIXES = ("ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk-ant-")


def _pair(words: str) -> re.Pattern[str]:
    """`key=value`, `key: value` and `"key": "value"` (quotes may be escaped) for the key words.

    The key may continue after the word (`token_count`) for at most 40 more characters. A quoted
    value runs to its closing quote, any other value to a separator.
    """
    return re.compile(
        rf"(?P<head>(?:{words}){_KEY_CHARS}{{0,40}}"
        r"(?:\\?[\"'])?+[ \t]{0,8}+[:=][ \t]{0,8}+"
        + _NOT_MARKER
        + r"(?P<q>\\\"|\"|')?+)"
        r"(?(q)(?:(?!(?P=q))(?:[^\\\r\n]|\\.))++"
        r"|(?:\[[^\]]*+\]?|\{[^}]*+\}?|[^\s,;&\"'<>)\]}\\]++))"
        r"(?P<tail>(?P=q)?)",
        _FLAGS,
    )


# In order, so that a name with two words gets the kind of the first (the precedence of the keys).
# The cheap lowercase substrings let a string with none of them skip the pattern. `session=` in
# text is a cookie pair, so it comes after the token words (`session_token=` stays a token).
_PAIRS = tuple(
    (hints, _pair(words), rf"\g<head>{_marker(kind)}\g<tail>")
    for hints, words, kind in (
        (("password", "passwd", "pwd"), "password|passwd|pwd", "password"),
        (("cookie",), "cookie", "cookie"),
        (
            ("token", "secret", "api", "authorization"),
            r"token|secret|api[_\-]?key|authorization",
            "token",
        ),
        (("session",), "session", "cookie"),
        (
            ("correct", "option", "answers", "explanation"),
            r"correct|option[_\-]id|answers|explanation",
            "quiz_answer",
        ),
        (("email",), "email", "email"),
        (("username",), "username", "username"),
        (("user",), rf"(?<!{_KEY_CHARS})user(?!{_KEY_CHARS})", "username"),
    )
)
_HEADER_COOKIE = re.compile(
    r"\b(?P<head>(?:set-)?cookie[ \t]{0,5}+:[ \t]*+)(?!\[REDACTED:)[^\r\n]++", _FLAGS
)
_HEADER_AUTH = re.compile(
    r"\b(?P<head>(?:proxy-)?authorization[ \t]{0,5}+:[ \t]*+)(?!\[REDACTED:)[^\r\n]++", _FLAGS
)
_BEARER = re.compile(r"\b(?P<head>bearer[ \t]++)(?!\[REDACTED:)[^\s,;\"'\\]++", _FLAGS)
_PROVIDER_TOKEN = re.compile(
    r"(?:gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,}|sk-ant-[A-Za-z0-9_\-]{6,})"
)
# The lookbehind lets a match start only at the start of a run, so a long run is read once.
_JWT = re.compile(
    r"(?<![A-Za-z0-9_\-])eyJ[A-Za-z0-9_\-]{5,}+\.[A-Za-z0-9_\-]{5,}+\.[A-Za-z0-9_\-]*+"
)
_USERINFO = re.compile(r"://(?P<info>[^\s:/@?#\"'\\\[\]<>]++:[^\s/@?#\"'\\\[\]<>]++)@")
_EMAIL = re.compile(
    r"(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]++@[A-Za-z0-9\-]++(?:\.[A-Za-z0-9\-]++)++"
)


def _redact_text(text: str) -> str:
    """`text` with the secrets of the forms in the module docstring replaced."""
    lowered = text.lower()
    if "bearer" in lowered:
        text = _BEARER.sub(rf"\g<head>{_marker('token')}", text)
    if any(prefix in text for prefix in _TOKEN_PREFIXES):
        text = _PROVIDER_TOKEN.sub(_marker("token"), text)
    if "eyJ" in text:
        text = _JWT.sub(_marker("token"), text)
    # Every other form has a `:`, `=` or `@` in it.
    if not (":" in text or "=" in text or "@" in text):
        return text
    if "cookie" in lowered:
        text = _HEADER_COOKIE.sub(rf"\g<head>{_marker('cookie')}", text)
    if "authorization" in lowered:
        text = _HEADER_AUTH.sub(rf"\g<head>{_marker('token')}", text)
    if "://" in text and "@" in text:
        text = _USERINFO.sub(f"://{_marker('password')}@", text)
    for hints, pattern, template in _PAIRS:
        if any(hint in lowered for hint in hints):
            text = pattern.sub(template, text)
    if "@" in text:
        text = _EMAIL.sub(_marker("email"), text)
    return text


# --- values ---

# A short name made of word characters holds none of the text forms, so it is not searched.
_PLAIN_KEY = re.compile(r"[A-Za-z0-9_\-]{1,30}")


def _redact_json(text: str, depth: int) -> str | None:
    """The redacted JSON text, or None when `text` is not a JSON object or list."""
    try:
        parsed = json.loads(text)
    except (ValueError, RecursionError):
        return None
    if not isinstance(parsed, dict | list):
        return None
    clean = _walk(parsed, depth + 1, set())
    # Untouched JSON stays byte for byte as it came; only a changed one is written again.
    return text if clean == parsed else json.dumps(clean, ensure_ascii=False)


def _redact_string(text: str, depth: int) -> str:
    if len(text) < 3 or _MARKER.fullmatch(text):
        return text
    if depth < MAX_DEPTH and len(text) <= MAX_JSON_CHARS + 1024:
        stripped = text.strip()
        if stripped[:1] in ("{", "[") and len(stripped) <= MAX_JSON_CHARS:
            clean = _redact_json(stripped, depth)
            if clean is not None:
                return text if clean is stripped else clean
    return _redact_text(text)


def _walk(value: Any, depth: int, active: set[int]) -> Any:
    if value is None or isinstance(value, bool | int | float):
        return value
    if isinstance(value, str):
        return _redact_string(value, depth)
    if isinstance(value, bytes | bytearray):
        return _redact_string(bytes(value).decode("utf-8", "replace"), depth)
    if not isinstance(value, Mapping | list | tuple | set | frozenset):
        return _redact_string(str(value), depth)
    if depth >= MAX_DEPTH or id(value) in active:
        return _STOP
    active.add(id(value))
    try:
        if isinstance(value, Mapping):
            clean: dict[Any, Any] = {}
            for key, item in value.items():
                kind = _key_kind(key) if isinstance(key, str) else None
                new_key = key
                if isinstance(key, str) and not _PLAIN_KEY.fullmatch(key):
                    new_key = _redact_text(key)
                if kind is None:
                    clean[new_key] = _walk(item, depth + 1, active)
                elif isinstance(item, str) and _MARKER.fullmatch(item):
                    clean[new_key] = item
                else:
                    clean[new_key] = _marker(kind)
            return clean
        return [_walk(item, depth + 1, active) for item in value]
    finally:
        active.discard(id(value))


def redact(value: Any) -> Any:
    """A copy of `value` with the sensitive parts replaced by `[REDACTED:<kind>]`."""
    return _walk(value, 0, set())
