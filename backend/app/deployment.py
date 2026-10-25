"""The DEPLOYMENT setting: which deployment this process belongs to (`local`, `staging`, ...).

Every metric sample and every log line carries it. The app reads it when it starts (in the
lifespan, next to COURSES), and the log formatter reads it per line, so even the uvicorn lines
that come before the lifespan have it. A missing or invalid value stops the app.
"""

import os
import re

DEPLOYMENT_VARIABLE = "DEPLOYMENT"
# The pattern #44 uses to keep label values safe in PromQL and LogQL.
_VALID = re.compile(r"[a-z0-9-]+")
# #37 and #38 use `deployment=host` for the server-wide exporters.
RESERVED = "host"
UNKNOWN = "unknown"
_MAX_SHOWN = 80


class DeploymentError(ValueError):
    """DEPLOYMENT is missing or invalid. The app does not start."""


def parse_deployment(raw: str | None) -> str:
    if raw is None or raw == "":
        raise DeploymentError(
            f"{DEPLOYMENT_VARIABLE} is not set. Set it to a name of lowercase letters, digits,"
            " and hyphens, for example local."
        )
    if raw == RESERVED:
        raise DeploymentError(
            f"{DEPLOYMENT_VARIABLE} cannot be {RESERVED!r}: that value is reserved for the"
            " server-wide metrics. Choose another name."
        )
    if not _VALID.fullmatch(raw):
        shown = raw if len(raw) <= _MAX_SHOWN else raw[:_MAX_SHOWN] + "..."
        raise DeploymentError(
            f"{DEPLOYMENT_VARIABLE} {shown!r} is not valid. Use only lowercase letters a-z,"
            " digits, and hyphens."
        )
    return raw


def read_deployment() -> str:
    return parse_deployment(os.environ.get(DEPLOYMENT_VARIABLE))


def deployment_or_unknown() -> str:
    """The valid DEPLOYMENT value, else `unknown` (a line that reports the problem)."""
    try:
        return read_deployment()
    except DeploymentError:
        return UNKNOWN
