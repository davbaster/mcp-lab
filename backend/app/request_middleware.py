"""One middleware for every HTTP request: the request ID, the metrics, and the request line.

It is plain ASGI (not `BaseHTTPMiddleware`), so it sees the real status of every response and
can add a header to the response without buffering it. Per request it:

- takes `X-Request-ID` if it is valid (letters, digits, and hyphens, 1 to 64 characters, sent
  once), else makes a UUID, puts it in the request context so every record written while the
  request is handled carries it, and returns it in the `X-Request-ID` response header;
- finds the route label (the matched route's template, else `unmatched`) and the course;
- when the response has ended, counts the request in the metrics and writes one INFO line,
  `request completed`, with `request_id`, `method`, `route`, `status`, `latency_ms`, and
  `course_id` for a configured course. It writes no path, query string, header, body, address,
  username, or account ID.

An unhandled exception is seen here, recorded as a 500 once, and raised again: the 500 response
is sent by Starlette's outermost middleware, which also adds the request ID header (see
`app.errors`). Nothing raised while counting or logging reaches the request.
"""

import logging
import re
import time
import uuid
from typing import Any

from starlette.requests import ClientDisconnect
from starlette.routing import Match
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app import metrics
from app.metrics import UNMATCHED, method_label
from app.request_context import request_id_var

REQUEST_ID_HEADER = "x-request-id"
_VALID_REQUEST_ID = re.compile(r"[A-Za-z0-9-]{1,64}")
CLIENT_CLOSED_REQUEST = 499  # the status of a request whose client left before any response

# Not under `app.` or `uvicorn.`: it has its own INFO level in app/log_config.json.
logger = logging.getLogger("mcp_lab.requests")
_bookkeeping_logger = logging.getLogger("mcp_lab.observability")


def request_id_from(scope: Scope) -> str:
    """The ID the middleware gave this request (a new UUID when there is none)."""
    return scope.get("state", {}).get("request_id") or str(uuid.uuid4())


def _choose_request_id(scope: Scope) -> str:
    sent = [value for name, value in scope["headers"] if name == REQUEST_ID_HEADER.encode()]
    if len(sent) == 1:
        candidate = sent[0].decode("latin-1")
        if _VALID_REQUEST_ID.fullmatch(candidate):
            return candidate
    return str(uuid.uuid4())


def _route_of(scope: Scope) -> tuple[str, dict[str, Any]]:
    """(label, path parameters): the template of the first route that fully matches, else
    `unmatched`. A route that only matches the path (a wrong method) is not a match."""
    app = scope.get("app")
    for route in getattr(getattr(app, "router", None), "routes", ()):
        match, child = route.matches(scope)
        if match is Match.FULL:
            return getattr(route, "path_format", UNMATCHED), child.get("path_params", {})
    return UNMATCHED, {}


def _course_of(scope: Scope, params: dict[str, Any]) -> str | None:
    """The course ID if the path names a configured course. It comes from the catalog, never
    from the URL text."""
    catalog = getattr(getattr(scope.get("app"), "state", None), "catalog", None)
    value = params.get("course_id")
    course = catalog.get(value) if catalog is not None and isinstance(value, str) else None
    return course.id if course is not None else None


class RequestObservabilityMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = time.perf_counter()
        request_id = _choose_request_id(scope)
        scope.setdefault("state", {})["request_id"] = request_id
        request_id_var.set(request_id)
        route, params = _route_of(scope)
        course = _course_of(scope, params)
        status: int | None = None
        ended: float | None = None
        recorded = False
        disconnected = False

        def record(final_status: int) -> None:
            nonlocal recorded
            if recorded:
                return
            recorded = True
            seconds = max((ended if ended is not None else time.perf_counter()) - started, 0.0)
            try:
                self._record(scope, route, course, request_id, final_status, seconds)
            except Exception:
                _bookkeeping_logger.warning("Could not record a request.", exc_info=True)

        async def wrapped_receive() -> Message:
            nonlocal disconnected
            message = await receive()
            if message["type"] == "http.disconnect":
                disconnected = True
            return message

        async def wrapped_send(message: Message) -> None:
            nonlocal status, ended
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = [
                    (name, value)
                    for name, value in message.get("headers", [])
                    if name.lower() != REQUEST_ID_HEADER.encode()
                ]
                headers.append((REQUEST_ID_HEADER.encode(), request_id.encode()))
                message = {**message, "headers": headers}
            elif message["type"] == "http.response.body" and not message.get("more_body", False):
                ended = time.perf_counter()
                # Counted before the last bytes go out, so a client that has the whole response
                # also finds it counted.
                record(status if status is not None else 500)
            await send(message)

        try:
            await self.app(scope, wrapped_receive, wrapped_send)
        except (OSError, ClientDisconnect):
            if not disconnected:
                record(status if status is not None else 500)
                raise
            record(status if status is not None else CLIENT_CLOSED_REQUEST)
        except BaseException as exc:
            # Cancellation and the like are not a server fault: nobody was left to answer.
            fallback = 500 if isinstance(exc, Exception) else CLIENT_CLOSED_REQUEST
            record(status if status is not None else fallback)
            raise
        else:
            record(status if status is not None else CLIENT_CLOSED_REQUEST)

    def _record(
        self,
        scope: Scope,
        route: str,
        course: str | None,
        request_id: str,
        status: int,
        seconds: float,
    ) -> None:
        method = scope["method"]
        active = metrics.current()
        if active is not None:
            active.request(method, route, status, seconds, course)
        fields: dict[str, Any] = {
            "request_id": request_id,
            "method": method_label(method),
            "route": route,
            "status": status,
            "latency_ms": round(seconds * 1000, 3),
        }
        if course is not None:
            fields["course_id"] = course
        logger.info("request completed", extra=fields)
