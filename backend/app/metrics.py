"""The Prometheus metrics of the backend (#36).

A `Metrics` object owns one registry, built each time the app starts, so a test can assert exact
values and nothing leaks from one start to the next. The registry is dedicated: only the series
below are exposed, and each has a `deployment` label. No `process_*`, `python_*`, or
`python_gc_*` series.

Label values come from fixed sets or from the configured courses, never from request input: the
route is the matched route's template (`unmatched` when no route fully matched), the method is
one of eight values, and `course` is a course ID of the catalog. The README lists every series
and the most samples the page can hold (`worst_case_samples`).

The server that shows the page is in `app.metrics_server`; the code that counts requests is in
`app.request_middleware`.
"""

import re
import threading
from collections.abc import Callable, Iterable, Iterator

from prometheus_client import CollectorRegistry, Counter, Histogram, disable_created_metrics
from prometheus_client.core import GaugeMetricFamily, Metric
from prometheus_client.registry import Collector
from sqlalchemy.engine import Engine

from app import db_pool
from app.metrics_server import MetricsServer

BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)
METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
OTHER_METHOD = "other"
UNMATCHED = "unmatched"
OUTCOMES = ("passed", "failed")
# The statuses a request that matched no route can get: not found, wrong method, slash redirect.
UNMATCHED_STATUSES = (307, 404, 405)
# (action, outcome) -> the status of the answer that counts as it (see `auth_outcome`).
AUTH_OUTCOMES = {
    ("login", "success"): 200,
    ("login", "invalid_credentials"): 401,
    ("login", "validation_error"): 422,
    ("login", "rate_limited"): 429,
    ("register", "success"): 201,
    ("register", "username_taken"): 409,
    ("register", "validation_error"): 422,
}
AUTH_ROUTES = {"/api/auth/login": "login", "/api/auth/register": "register"}
LESSON_ROUTE = "/api/courses/{course_id}/lessons/{lesson_id}"
ATTEMPT_ROUTE = "/api/courses/{course_id}/chapters/{chapter_id}/quiz/attempts"
SAMPLES_PER_SERIES = (
    1 + len(BUCKETS) + 3
)  # the counter, and the histogram: buckets, +Inf, sum, count

_CONVERTER = re.compile(r"\{(\w+):\w+\}")


def route_template(path: str) -> str:
    """A route path with its converters removed: `{file_name:asset_name}` becomes `{file_name}`."""
    return _CONVERTER.sub(r"{\1}", path)


def method_label(method: str) -> str:
    return method if method in METHODS else OTHER_METHOD


def auth_outcome(route: str, method: str, status: int) -> tuple[str, str] | None:
    """The (action, outcome) of an answer from a sign-in or sign-up route, else None."""
    action = AUTH_ROUTES.get(route)
    if action is None or method != "POST":
        return None
    for (name, outcome), expected in AUTH_OUTCOMES.items():
        if name == action and expected == status:
            return name, outcome
    return None


class _PoolCollector(Collector):
    """The pool gauges, read when the page is built. Reading opens no connection."""

    def __init__(self, deployment: str, engine: Callable[[], Engine | None]) -> None:
        self._deployment = deployment
        self._engine = engine

    def collect(self) -> Iterator[Metric]:
        in_use = waiting = size = 0.0
        pool = getattr(self._engine(), "pool", None)
        if isinstance(pool, db_pool.InstrumentedQueuePool):
            in_use, waiting, size = float(pool.checkedout()), float(pool.waiting), pool.capacity
        for name, text, value in (
            ("db_pool_in_use", "Connections checked out of the pool now.", in_use),
            ("db_pool_waiting", "Callers waiting for a connection now.", waiting),
            ("db_pool_size", "Most connections the pool may hold (size plus overflow).", size),
        ):
            gauge = GaugeMetricFamily(name, text, labels=["deployment"])
            gauge.add_metric([self._deployment], value)
            yield gauge


class Metrics:
    def __init__(
        self,
        deployment: str,
        course_ids: Iterable[str],
        engine: Callable[[], Engine | None] | None = None,
    ) -> None:
        from app.db import peek_engine

        disable_created_metrics()  # no `_created` series: they double the page and carry a time
        self.deployment = deployment
        self.courses = tuple(course_ids)
        self.server: MetricsServer | None = None  # set by `observability()` when it serves
        self.registry = CollectorRegistry(auto_describe=False)
        self._requests = Counter(
            "http_requests",
            "HTTP requests, counted when the response has ended.",
            ["deployment", "method", "route", "status"],
            registry=self.registry,
        )
        self._durations = Histogram(
            "http_request_duration_seconds",
            "Seconds from the request received to the response ended.",
            ["deployment", "method", "route", "status"],
            buckets=BUCKETS,
            registry=self.registry,
        )
        self._lessons = Counter(
            "lesson_loads",
            "Lessons answered with 200.",
            ["deployment", "course"],
            registry=self.registry,
        )
        self._submissions = Counter(
            "quiz_submissions",
            "Quiz attempts saved.",
            ["deployment", "course", "outcome"],
            registry=self.registry,
        )
        self._submission_errors = Counter(
            "quiz_submission_errors",
            "Quiz attempts answered with a 5xx.",
            ["deployment", "course"],
            registry=self.registry,
        )
        self._auth = Counter(
            "auth_attempts",
            "Sign-in and sign-up attempts, by the status of the answer.",
            ["deployment", "action", "outcome"],
            registry=self.registry,
        )
        self._db_errors = Counter(
            "db_connection_errors",
            "Failed attempts to get a database connection.",
            ["deployment", "reason"],
            registry=self.registry,
        )
        self.registry.register(_PoolCollector(deployment, engine or peek_engine))
        self._create_series()

    def _create_series(self) -> None:
        """Make every series that has a fixed set of labels, at 0, so `increase()` sees the
        first event."""
        for course in self.courses:
            self._lessons.labels(self.deployment, course)
            self._submission_errors.labels(self.deployment, course)
            for outcome in OUTCOMES:
                self._submissions.labels(self.deployment, course, outcome)
        for action, outcome in AUTH_OUTCOMES:
            self._auth.labels(self.deployment, action, outcome)
        for reason in db_pool.REASONS:
            self._db_errors.labels(self.deployment, reason)

    # --- counting ---

    def request(
        self, method: str, route: str, status: int, seconds: float, course: str | None
    ) -> None:
        """Count one finished request, and the events that its route and status mean."""
        labels = (self.deployment, method_label(method), route, str(status))
        self._requests.labels(*labels).inc()
        self._durations.labels(*labels).observe(seconds)
        found = auth_outcome(route, method, status)
        if found is not None:
            self._auth.labels(self.deployment, *found).inc()
        if course is None:
            return
        if route == LESSON_ROUTE and method == "GET" and status == 200:
            self._lessons.labels(self.deployment, course).inc()
        if route == ATTEMPT_ROUTE and method == "POST" and status >= 500:
            self._submission_errors.labels(self.deployment, course).inc()

    def quiz_submission(self, course: str, passed: bool) -> None:
        self._submissions.labels(self.deployment, course, "passed" if passed else "failed").inc()

    def db_connection_error(self, reason: str) -> None:
        self._db_errors.labels(
            self.deployment, reason if reason in db_pool.REASONS else "other"
        ).inc()


# --- the metrics of the app that is running ---

_lock = threading.Lock()
_active: Metrics | None = None


def activate(metrics: Metrics) -> None:
    """Make `metrics` the one the request middleware, the quiz route, and the pool report to."""
    global _active
    with _lock:
        _active = metrics
    db_pool.set_error_reporter(metrics.db_connection_error)


def deactivate(metrics: Metrics) -> None:
    global _active
    with _lock:
        if _active is metrics:
            _active = None
            db_pool.set_error_reporter(None)


def current() -> Metrics | None:
    return _active


def record_quiz_submission(course_id: str, passed: bool) -> None:
    metrics = _active
    if metrics is not None:
        metrics.quiz_submission(course_id, passed)


# --- the size of the page ---


def worst_case_samples(routes: Iterable[tuple[str, str]], statuses: int, courses: int) -> int:
    """The most samples the page can hold.

    `routes` are the (route, method) pairs of the app and `statuses` is how many distinct
    statuses its routes answer with (the codes in `openapi.yaml`). A matched route answers to its
    own method, so each pair is one series per status. The `unmatched` label can have any of the
    eight method labels and `UNMATCHED_STATUSES`. Each (method, route, status) is a counter and a
    histogram of `SAMPLES_PER_SERIES` samples in all. The rest is fixed: the course series, the
    auth pairs, the connection error reasons, and the three pool gauges.
    """
    matched = len(set(routes)) * statuses
    unmatched = (len(METHODS) + 1) * len(UNMATCHED_STATUSES)
    http = (matched + unmatched) * SAMPLES_PER_SERIES
    per_course = 1 + 1 + len(OUTCOMES)
    return http + courses * per_course + len(AUTH_OUTCOMES) + len(db_pool.REASONS) + 3
