from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from app.asset_routes import install_asset_routes
from app.auth import install_auth_routes
from app.client_address import trusted_proxies
from app.code_routes import install_code_routes
from app.content_routes import install_content_routes
from app.course_routes import install_course_routes
from app.courses import load_catalog_from_environment
from app.errors import install_error_handling
from app.feedback_routes import install_feedback_routes
from app.observability import check_settings, install_observability, observability
from app.quiz_routes import install_quiz_routes

# A fixed string, changed by hand when the API changes in a way clients should notice.
# It is not read from git, the clock, or package metadata, so the exported spec stays the same.
API_VERSION = "0.1.0"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Read the settings and load the courses named in COURSES once, before the first request.

    Not done at import: `scripts/export_openapi.py` and most tests import this module with no
    course settings. A problem raises `CourseLoadError` and the app does not start. The
    catalog is read-only memory; it opens no database connection. A bad `TRUSTED_PROXIES` also
    stops the app here (`TrustedProxiesError`, naming the variable), and so do a missing or
    invalid `DEPLOYMENT` and a bad or busy `METRICS_PORT` (the error names the variable). The
    metrics server runs for as long as the app does, and its port is free again afterwards. On exit
    the catalog that was on `app.state` before the start is put back (or removed if there was none),
    and a failed start leaves `app.state` as it was.
    """
    deployment, metrics_port = check_settings()
    trusted_proxies()
    # Put back what was there on exit, so that a lifespan that overlaps another (nested test
    # clients share this one `app`) does not remove the catalog the outer one still serves.
    previous = getattr(app.state, "catalog", None)
    app.state.catalog = load_catalog_from_environment()
    try:
        with observability(
            [course.id for course in app.state.catalog.courses], deployment, metrics_port
        ):
            yield
    finally:
        if previous is not None:
            app.state.catalog = previous
        elif hasattr(app.state, "catalog"):
            del app.state.catalog


app = FastAPI(
    lifespan=lifespan,
    title="mcp-lab API",
    version=API_VERSION,
    openapi_url="/api/openapi.json",
    docs_url="/api/docs",
    redoc_url=None,
    swagger_ui_oauth2_redirect_url=None,
)
install_error_handling(app)
install_observability(app)
install_auth_routes(app)
install_course_routes(app)
install_asset_routes(app)
install_content_routes(app)
install_code_routes(app)
install_quiz_routes(app)
install_feedback_routes(app)


class HealthResponse(BaseModel):
    status: Literal["ok"]


@app.get("/api/health", operation_id="health")
def health() -> HealthResponse:
    return HealthResponse(status="ok")
