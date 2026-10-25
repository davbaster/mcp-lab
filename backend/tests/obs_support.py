"""Helpers shared by the metrics, request log, and redaction tests (#36).

`page()` reads the metrics page of the app that is running, over HTTP from its metrics port (the
`METRICS_PORT=0` of the test setup picks a free one). `capture_logs` attaches the production JSON
handler (formatter and filters) to the root logger and returns the lines it wrote.
"""

import io
import json
import logging
import urllib.error
import urllib.request
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass

from fastapi import FastAPI
from prometheus_client.parser import text_string_to_metric_families

from app import metrics
from app.errors import install_error_handling
from app.log_format import ExceptionLoggedOnceFilter, JsonFormatter
from app.log_redaction import RedactionFilter
from app.observability import install_observability, observability


def metrics_port() -> int:
    active = metrics.current()
    assert active is not None and active.server is not None, "no app is serving metrics"
    return active.server.port


def fetch(path: str = "/metrics", port: int | None = None) -> tuple[int, str, str]:
    """(status, content type, body) of a GET on the metrics port."""
    url = f"http://127.0.0.1:{port or metrics_port()}{path}"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return response.status, response.headers["Content-Type"], response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.headers["Content-Type"], error.read().decode()


@dataclass(frozen=True)
class Sample:
    name: str
    labels: dict[str, str]
    value: float


class Page:
    """The parsed text of a `/metrics` response."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.samples = [
            Sample(sample.name, dict(sample.labels), sample.value)
            for family in text_string_to_metric_families(text)
            for sample in family.samples
        ]

    def select(self, name: str, **labels: str) -> list[Sample]:
        return [
            s
            for s in self.samples
            if s.name == name and all(s.labels.get(k) == v for k, v in labels.items())
        ]

    def total(self, name: str, **labels: str) -> float:
        """The sum over the series that have these labels (others unconstrained)."""
        return sum(s.value for s in self.select(name, **labels))

    def get(self, name: str, **labels: str) -> float | None:
        """The one series with exactly these labels besides `deployment`, else None."""
        found = [
            s
            for s in self.samples
            if s.name == name and {k: v for k, v in s.labels.items() if k != "deployment"} == labels
        ]
        assert len(found) <= 1, f"{name}{labels} matches {len(found)} series"
        return found[0].value if found else None

    def counters(self) -> dict[tuple, float]:
        """Every counter series (`*_total` and histogram `_count`) as (name, labels) -> value."""
        return {
            (s.name, tuple(sorted(s.labels.items()))): s.value
            for s in self.samples
            if s.name.endswith(("_total", "_count"))
        }


def page() -> Page:
    status, _, body = fetch()
    assert status == 200
    return Page(body)


def changes(before: Page, after: Page) -> dict[tuple, float]:
    """The counter series that rose between two pages, with how much."""
    old = before.counters()
    return {
        key: value - old.get(key, 0)
        for key, value in after.counters().items()
        if value != old.get(key, 0)
    }


def rose(before: Page, after: Page, name: str) -> dict[tuple, float]:
    """`changes()` for one counter name, with the labels as (key, value) pairs minus deployment."""
    return {
        tuple((k, v) for k, v in labels if k != "deployment"): amount
        for (series, labels), amount in changes(before, after).items()
        if series == name
    }


class _ClientSide(logging.Filter):
    """Drops the test client's own loggers: they log the URL the test asked for."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not record.name.startswith(("httpx", "httpcore", "asyncio"))


@contextmanager
def capture_logs(level: int = logging.DEBUG) -> Iterator[io.StringIO]:
    """The production handler on the root logger: JSON formatter, redaction and dedupe filters."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(_ClientSide())
    handler.addFilter(ExceptionLoggedOnceFilter())
    handler.addFilter(RedactionFilter())
    root = logging.getLogger()
    old_level = root.level
    root.addHandler(handler)
    root.setLevel(level)
    try:
        yield stream
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)


def lines_of(stream: io.StringIO) -> list[dict]:
    """The records written, each parsed from its one line."""
    text = stream.getvalue()
    lines = text.splitlines()
    assert len(lines) == text.count("\n"), "a record spans more than one line"
    return [json.loads(line) for line in lines]


def request_lines(stream: io.StringIO) -> list[dict]:
    return [line for line in lines_of(stream) if line["message"] == "request completed"]


def throwaway_app(courses=("alpha-course", "beta-course")) -> FastAPI:
    """A `FastAPI` app with the error handling and the observability installed, whose lifespan
    serves metrics for `courses` on a free port. Add routes, then use it in a `TestClient`."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.catalog = StubCatalog(courses)
        with observability(courses, "test", 0):
            yield

    app = FastAPI(lifespan=lifespan, openapi_url=None, docs_url=None, redoc_url=None)
    install_error_handling(app)
    install_observability(app)
    return app


class StubCatalog:
    """Just enough of the catalog for the request middleware: `get(course_id)`."""

    def __init__(self, ids) -> None:
        self._ids = set(ids)

    def get(self, course_id):
        return _Course(course_id) if course_id in self._ids else None


@dataclass(frozen=True)
class _Course:
    id: str
