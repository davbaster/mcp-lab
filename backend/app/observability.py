"""Metrics, request logging, and the request ID, installed on an app with one call.

`install_observability(app)` adds the request middleware, like `install_error_handling` adds the
error handlers, so a test can use it on a throwaway `FastAPI` app. The part that needs the
running app is `observability(app, course_ids)`: a context manager the lifespan enters. It reads
DEPLOYMENT and METRICS_PORT, builds a registry of its own, starts the metrics server, and on exit
stops the server (the port is free again) and stops reporting to the registry.

One process runs per container (see the README): the counters, the pool gauges, and the metrics
server are all per process.
"""

import logging
from collections.abc import Iterable, Iterator
from contextlib import contextmanager

from fastapi import FastAPI

from app import metrics
from app.deployment import read_deployment
from app.metrics_server import MetricsServer, read_metrics_port
from app.request_middleware import RequestObservabilityMiddleware

logger = logging.getLogger("mcp_lab.observability")


def install_observability(app: FastAPI) -> None:
    """Add the request middleware: request ID, request counters, and the request line."""
    app.add_middleware(RequestObservabilityMiddleware)


def check_settings() -> tuple[str, int]:
    """DEPLOYMENT and METRICS_PORT, validated. Raises `DeploymentError` or `MetricsPortError`."""
    return read_deployment(), read_metrics_port()


@contextmanager
def observability(
    course_ids: Iterable[str], deployment: str, port: int, *, serve: bool = True
) -> Iterator[metrics.Metrics]:
    """Build the metrics, serve them on `port` (unless `serve` is false), and report to them.

    A port that is in use raises `MetricsPortError` before anything is left running.
    """
    active = metrics.Metrics(deployment, course_ids)
    server = MetricsServer(active.registry, port) if serve else None
    active.server = server
    metrics.activate(active)
    if server is not None:
        logger.info(
            "metrics listening on port %d", server.port, extra={"metrics_port": server.port}
        )
    try:
        yield active
    finally:
        metrics.deactivate(active)
        if server is not None:
            server.close()
