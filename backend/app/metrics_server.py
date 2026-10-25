"""The metrics port: a small HTTP server in the app's own process, on its own port.

It answers `GET /metrics` with the Prometheus text format of one registry, and 404 for any other
path. It needs no database. It has no authentication: the access control is the network. The
port is never published on the host and the proxy never routes to it, so only containers on the
Docker networks the backend joins can reach it. It binds every interface so that they can.

It writes no access log (a line would hold the address of the scraper).
"""

import errno
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, generate_latest

METRICS_PORT_VARIABLE = "METRICS_PORT"
DEFAULT_METRICS_PORT = 9000
# How often the server loop looks for a stop request; `close()` waits up to this long.
POLL_SECONDS = 0.02


class MetricsPortError(ValueError):
    """METRICS_PORT is not a port number, or the port cannot be used. The app does not start."""


def parse_metrics_port(raw: str | None) -> int:
    """The port from METRICS_PORT (default 9000). 0 picks a free port, which tests use."""
    if raw is None:
        return DEFAULT_METRICS_PORT
    text = raw.strip()
    if not text.isascii() or not text.isdigit() or int(text) > 65535:
        shown = raw if len(raw) <= 40 else raw[:40] + "..."
        raise MetricsPortError(
            f"{METRICS_PORT_VARIABLE} {shown!r} is not a port number. Use a whole number from 0"
            " to 65535 (the default is 9000)."
        )
    return int(text)


def read_metrics_port() -> int:
    return parse_metrics_port(os.environ.get(METRICS_PORT_VARIABLE))


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    registry: CollectorRegistry


class _Handler(BaseHTTPRequestHandler):
    server: _Server

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/metrics":
            self._reply(404, b"Not found\n", "text/plain; charset=utf-8")
            return
        self._reply(200, generate_latest(self.server.registry), CONTENT_TYPE_LATEST)

    def _reply(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_HEAD = do_GET

    def do_POST(self) -> None:
        self._reply(405, b"Method not allowed\n", "text/plain; charset=utf-8")

    do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_POST

    def log_message(self, format: str, *args: object) -> None:
        pass


class MetricsServer:
    """Serves `registry` on `port` from a thread until `close()`."""

    def __init__(self, registry: CollectorRegistry, port: int) -> None:
        try:
            self._server = _Server(("0.0.0.0", port), _Handler)
        except OSError as exc:
            reason = "is already in use" if exc.errno == errno.EADDRINUSE else "cannot be used"
            raise MetricsPortError(
                f"{METRICS_PORT_VARIABLE}: port {port} {reason}. Choose another port."
            ) from None
        self._server.registry = registry
        self.port: int = self._server.server_address[1]
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            kwargs={"poll_interval": POLL_SECONDS},
            name="metrics-server",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        """Stop serving and free the port."""
        self._server.shutdown()
        self._server.server_close()
        self._thread.join()
