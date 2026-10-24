from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from app.auth import install_auth_routes
from app.errors import install_error_handling

# A fixed string, changed by hand when the API changes in a way clients should notice.
# It is not read from git, the clock, or package metadata, so the exported spec stays the same.
API_VERSION = "0.1.0"

app = FastAPI(
    title="mcp-lab API",
    version=API_VERSION,
    openapi_url="/api/openapi.json",
    docs_url="/api/docs",
    redoc_url=None,
    swagger_ui_oauth2_redirect_url=None,
)
install_error_handling(app)
install_auth_routes(app)


class HealthResponse(BaseModel):
    status: Literal["ok"]


@app.get("/api/health", operation_id="health")
def health() -> HealthResponse:
    return HealthResponse(status="ok")
