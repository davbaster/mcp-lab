"""One JSON object per log record, on one line.

`JsonFormatter` is for the handler in `app/log_config.json` (uvicorn's `--log-config`). Every line
has `timestamp`, `level`, `message`, `deployment`, and `logger`; fields passed with `extra=` are
top-level keys and cannot replace those five. A record written while a request is handled also
has its `request_id`. The formatter never raises: a value that is not JSON is written as its
`str()`.

`ExceptionLoggedOnceFilter` keeps an unhandled exception to one record: the error handler logs
it with its request, and uvicorn would log it a second time as "Exception in ASGI application".
"""

import contextlib
import json
import logging
import math
from datetime import UTC, datetime
from typing import Any

from app.deployment import deployment_or_unknown
from app.log_redaction import STANDARD_ATTRIBUTES, format_exception_safely
from app.request_context import request_id_var

RESERVED_KEYS = frozenset({"timestamp", "level", "message", "deployment", "logger"})
LEVELS = frozenset({"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"})
_MAX_DEPTH = 20
LOGGED_MARK = "_mcp_lab_logged"


def mark_logged(exc: BaseException) -> None:
    """Say that a record with this exception's trace has been written."""
    with contextlib.suppress(AttributeError, TypeError):  # a type that takes no attributes
        setattr(exc, LOGGED_MARK, True)


def _jsonable(value: Any, depth: int = 0) -> Any:
    if value is None or isinstance(value, bool | int | str):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if depth >= _MAX_DEPTH:
        return "..."
    if isinstance(value, dict):
        return {_text(key): _jsonable(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        return [_jsonable(item, depth + 1) for item in value]
    return _text(value)


def _text(value: object) -> str:
    try:
        return value if isinstance(value, str) else str(value)
    except Exception:  # noqa: BLE001  (logging must never raise)
        return "<unprintable>"


def _timestamp(created: float) -> str:
    moment = datetime.fromtimestamp(created, UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        try:
            return self._format(record)
        except Exception:  # noqa: BLE001  (logging must never raise)
            return json.dumps(
                {
                    "timestamp": _timestamp(record.created),
                    "level": "ERROR",
                    "message": "A log record could not be formatted.",
                    "deployment": deployment_or_unknown(),
                    "logger": _text(record.name),
                }
            )

    def _format(self, record: logging.LogRecord) -> str:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001  (a bad format string or argument)
            message = _text(record.msg)
        fields: dict[str, Any] = {
            "timestamp": _timestamp(record.created),
            "level": record.levelname if record.levelname in LEVELS else _text(record.levelname),
            "message": message,
            "deployment": deployment_or_unknown(),
            "logger": record.name,
        }
        request_id = request_id_var.get()
        if request_id is not None:
            fields["request_id"] = request_id
        for key, value in vars(record).items():
            if key not in STANDARD_ATTRIBUTES and key not in RESERVED_KEYS:
                fields[_text(key)] = _jsonable(value)
        trace = record.exc_text
        if not trace and record.exc_info and record.exc_info[1] is not None:
            trace = format_exception_safely(record.exc_info[1])
        if trace:
            fields["stack_trace"] = trace.rstrip("\n")
        if record.stack_info:
            fields["stack_info"] = record.stack_info
        return json.dumps(fields, ensure_ascii=True, allow_nan=False)


class ExceptionLoggedOnceFilter(logging.Filter):
    """Drop a record whose exception already has a record of its own."""

    def filter(self, record: logging.LogRecord) -> bool:
        exc = record.exc_info[1] if record.exc_info else None
        return not (exc is not None and getattr(exc, LOGGED_MARK, False))
