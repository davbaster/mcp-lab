"""Keep secrets out of log lines: a filter for the JSON handler, and the helpers it uses.

The filter is attached to the handler (see `app/log_config.json`), so it covers records from every
logger: the app's, uvicorn's, SQLAlchemy's, and third-party code. It works on three things:

- Key names. A value under a key whose name (lowercased, `-` read as `_`) contains one of
  `SENSITIVE_WORDS` becomes `[REDACTED]`, in `extra` fields, in `args` mappings, and at any depth
  of dicts and lists. A name such as `session_count` is masked too; over-masking is accepted.
- Text. In every string (the message, the stack trace, any string value) it masks `session=...`,
  `Bearer ...`, `Cookie:`/`Set-Cookie:`/`Authorization:` header text to the end of the line,
  `key=value`, `key: value`, and quoted `'key': 'value'` pairs for the same names, and the query
  string of any URL or path.
- Exceptions. `format_exception_safely` writes a stack trace in which a validation error shows
  only each error's location and type (never `input`, `input_value`, or response data), and a
  database error shows no `DETAIL:` text (Postgres prints the failing row there).
"""

import copy
import logging
import re
import traceback
from collections.abc import Mapping
from types import TracebackType
from typing import Any

import psycopg
from fastapi.exceptions import ValidationException
from pydantic import ValidationError
from sqlalchemy.exc import DBAPIError

REDACTED = "[REDACTED]"
SENSITIVE_WORDS = (
    "password",
    "token",
    "session",
    "cookie",
    "authorization",
    "answers",
    "option_id",
    "correct",
    "explanation",
)
# What a record always has; any other attribute was passed with `extra=`.
STANDARD_ATTRIBUTES = frozenset(vars(logging.makeLogRecord({}))) | {
    "message",
    "asctime",
    "taskName",
    "color_message",
}
MAX_DEPTH = 12
MAX_VALIDATION_ERRORS = 5
MAX_CHAIN = 10

_WORDS = r"password|token|session|cookie|authorization|answers|option[_\-]id|correct|explanation"
# Bounded runs around the word keep the match linear on a long string with no separator.
_KEY = rf"[A-Za-z0-9_\-]{{0,40}}(?:{_WORDS})[A-Za-z0-9_\-]{{0,40}}"
# A run of characters that can be part of a URL or path (it ends at white space and quotes).
_TOKEN = re.compile(r"[^\s\"'<>\\]+")
_HEADER_LINE = re.compile(
    r"\b((?:set-)?cookie|(?:proxy-)?authorization)(\s*:\s*)[^\r\n]*", re.IGNORECASE
)
_BEARER = re.compile(r"\bbearer\s+[^\s,;\"']+", re.IGNORECASE)
_PAIR = re.compile(
    rf"(?P<key>(?P<q>[\"'])?(?:{_KEY})(?P=q)?)(?P<sep>\s*[:=]\s*)"
    r"(?P<value>\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|\[[^\]]*\]|\{[^}]*\}|[^\s,;&)}\]]+)",
    re.IGNORECASE,
)
_DATABASE_DETAIL = re.compile(r"\n(?:DETAIL|CONTEXT|HINT|QUERY):")


def is_sensitive_key(key: object) -> bool:
    if not isinstance(key, str):
        return False
    name = key.lower().replace("-", "_")
    return any(word in name for word in SENSITIVE_WORDS)


def _without_query(token: re.Match[str]) -> str:
    """`/x?a=b` becomes `/x`: a token with a slash before its first `?` is a URL or a path."""
    found = token.group()
    mark = found.find("?")
    return found[:mark] if mark >= 0 and "/" in found[:mark] else found


def redact_text(text: str) -> str:
    """The text with the secrets of the forms in the module docstring replaced."""
    if "?" in text:
        text = _TOKEN.sub(_without_query, text)
    lowered = text.lower()
    if "cookie" in lowered or "authorization" in lowered:
        text = _HEADER_LINE.sub(rf"\1\2{REDACTED}", text)
    if "bearer" in lowered:
        text = _BEARER.sub(f"Bearer {REDACTED}", text)
    if any(word in lowered for word in SENSITIVE_WORDS) or "option-id" in lowered:
        text = _PAIR.sub(rf"\g<key>\g<sep>{REDACTED}", text)
    return text


def redact_value(value: object, depth: int = 0) -> Any:
    """A copy of `value` that is safe to write: strings redacted, sensitive keys masked."""
    if value is None or isinstance(value, bool | int | float):
        return value
    if depth >= MAX_DEPTH:
        return REDACTED
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        return {
            (key if isinstance(key, str) else _safe_str(key)): REDACTED
            if is_sensitive_key(key)
            else redact_value(item, depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, list | tuple | set | frozenset):
        return [redact_value(item, depth + 1) for item in value]
    if isinstance(value, bytes | bytearray):
        return redact_text(bytes(value).decode("utf-8", "replace"))
    if isinstance(value, BaseException):
        return redact_text(safe_exception_text(value))
    return redact_text(_safe_str(value))


def _safe_str(value: object) -> str:
    try:
        return str(value)
    except Exception:  # noqa: BLE001  (logging must never raise)
        return "<unprintable>"


# --- exceptions ---


def _location(loc: object) -> str:
    parts = loc if isinstance(loc, tuple | list) else (loc,)
    text = ""
    for part in parts:
        text += f"[{part}]" if isinstance(part, int) else (f".{part}" if text else str(part))
    return text or "body"


def _validation_summary(errors: list[Any]) -> str:
    shown = [f"{_location(e.get('loc'))} ({e.get('type')})" for e in errors[:MAX_VALIDATION_ERRORS]]
    more = len(errors) - MAX_VALIDATION_ERRORS
    if more > 0:
        shown.append(f"and {more} more")
    return f"{len(errors)} validation errors: " + "; ".join(shown)


def safe_exception_text(exc: BaseException) -> str:
    """`str(exc)`, except for the exceptions whose text holds submitted or stored values."""
    try:
        if isinstance(exc, ValidationException):
            return _validation_summary(list(exc.errors()))
        if isinstance(exc, ValidationError):
            return _validation_summary(
                exc.errors(include_url=False, include_context=False, include_input=False)
            )
        text = str(exc)
    except Exception:  # noqa: BLE001  (logging must never raise)
        return "<unprintable>"
    if isinstance(exc, psycopg.Error | DBAPIError):
        text = _DATABASE_DETAIL.split(text)[0]
    return text


def _exception_name(exc: BaseException) -> str:
    cls = type(exc)
    return (
        cls.__qualname__ if cls.__module__ == "builtins" else f"{cls.__module__}.{cls.__qualname__}"
    )


def format_exception_safely(
    exc: BaseException | None, tb: TracebackType | None = None, _depth: int = 0
) -> str:
    """A traceback like the standard one, with `safe_exception_text` for each exception."""
    if exc is None:
        return ""
    tb = tb if tb is not None else exc.__traceback__
    parts: list[str] = []
    if _depth < MAX_CHAIN:
        if exc.__cause__ is not None:
            parts += [
                format_exception_safely(exc.__cause__, None, _depth + 1),
                "\nThe above exception was the direct cause of the following exception:\n\n",
            ]
        elif exc.__context__ is not None and not exc.__suppress_context__:
            parts += [
                format_exception_safely(exc.__context__, None, _depth + 1),
                "\nDuring handling of the above exception, another exception occurred:\n\n",
            ]
    if tb is not None:
        parts.append("Traceback (most recent call last):\n")
        parts.extend(traceback.format_tb(tb))
    parts.append(f"{_exception_name(exc)}: {safe_exception_text(exc)}\n")
    return "".join(parts)


# --- the filter ---


class RedactionFilter(logging.Filter):
    """Replace secrets in a record before the handler writes it.

    Returns a redacted copy, so another handler on the same logger (a test's `caplog`) still
    sees the record as it was logged.
    """

    def filter(self, record: logging.LogRecord) -> logging.LogRecord:  # type: ignore[override]
        clean = copy.copy(record)
        args = record.args
        if isinstance(args, Mapping):
            clean.args = redact_value(args)
        elif isinstance(args, tuple):
            clean.args = tuple(redact_value(item) for item in args)
        if isinstance(clean.msg, BaseException):
            clean.msg = safe_exception_text(clean.msg)
        try:
            message = clean.getMessage()
        except Exception:  # noqa: BLE001  (a bad format string or argument)
            message = _safe_str(redact_value(record.msg))
        clean.msg = redact_text(message)
        clean.args = None
        if record.exc_info and record.exc_info[1] is not None:
            clean.exc_text = redact_text(format_exception_safely(record.exc_info[1]))
        elif record.exc_text:
            clean.exc_text = redact_text(record.exc_text)
        clean.stack_info = redact_text(record.stack_info) if record.stack_info else None
        for key, value in vars(record).items():
            if key not in STANDARD_ATTRIBUTES:
                clean.__dict__[key] = REDACTED if is_sensitive_key(key) else redact_value(value)
        return clean
