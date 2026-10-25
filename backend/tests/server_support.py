"""A real `uvicorn` process for the tests of #36, started the way the docs say.

`Server` runs the documented command (with the log config) in `backend/`, collects every line the
process writes to stderr, and stops it with SIGTERM. Requests go over a plain socket with
`http.client`, so a test chooses every header.
"""

import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time

from tests.course_support import FIXTURE_BUILD
from tests.dbtools import BACKEND_DIR

START_COMMAND = [
    "--no-proxy-headers",
    "--no-access-log",
    "--log-config",
    "app/log_config.json",
]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def server_env(**extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in ("COURSES", "COURSE_BUILD_DIR")}
    env.update(
        DEPLOYMENT="e2e-test",
        COURSES="alpha-course,epsilon-course",
        COURSE_BUILD_DIR=str(FIXTURE_BUILD),
        PYTHONUNBUFFERED="1",
    )
    env.update(extra)
    return env


class Server:
    def __init__(self, app: str = "app.main:app", env: dict[str, str] | None = None) -> None:
        self.port = free_port()
        self.metrics_port = free_port()
        environment = {
            **(env if env is not None else server_env()),
            "METRICS_PORT": str(self.metrics_port),
        }
        self.process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                app,
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
                *START_COMMAND,
            ],
            cwd=BACKEND_DIR,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.lines: list[str] = []
        self._changed = threading.Condition()
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    def _pump(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            with self._changed:
                self.lines.append(line.rstrip("\n"))
                self._changed.notify_all()

    # --- reading the output ---

    def records(self, since: int = 0) -> list[dict]:
        """The JSON lines written so far (from line number `since`); a line that is not JSON
        fails the test."""
        with self._changed:
            lines = list(self.lines[since:])
        return [json.loads(line) for line in lines]

    def wait_until(self, condition, seconds: float = 60.0) -> None:
        deadline = time.monotonic() + seconds
        with self._changed:
            while not condition():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError("the server did not log what the test waited for")
                self._changed.wait(remaining)

    def wait_for_message(self, message: str, since: int = 0) -> None:
        def seen() -> bool:
            return any(message in line for line in self.lines[since:])

        self.wait_until(seen)

    def requests_logged(self) -> int:
        with self._changed:
            return sum('"request completed"' in line for line in self.lines)

    def wait_for_requests(self, total: int) -> None:
        """Wait until `total` request lines have been written since the process started."""
        self.wait_until(lambda: sum('"request completed"' in line for line in self.lines) >= total)

    def wait_until_started(self) -> None:
        self.wait_for_message("Application startup complete.")

    # --- requests ---

    def request(self, method: str, path: str, headers=None, body=None):
        """(status, headers, text) of one request. `body` is sent as JSON."""
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        sent = dict(headers or {})
        payload = None
        if body is not None:
            payload = json.dumps(body)
            sent["Content-Type"] = "application/json"
        try:
            connection.request(method, path, body=payload, headers=sent)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode()
        finally:
            connection.close()

    def scrape(self, path: str = "/metrics") -> tuple[int, str]:
        connection = http.client.HTTPConnection("127.0.0.1", self.metrics_port, timeout=60)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, response.read().decode()
        finally:
            connection.close()

    # --- stopping ---

    def stop(self) -> int:
        """SIGTERM, then wait for the process to end and for its last line to be read."""
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
        code = self.process.wait(timeout=60)
        self._reader.join(timeout=30)
        return code

    def everything(self) -> str:
        with self._changed:
            return "\n".join(self.lines)
