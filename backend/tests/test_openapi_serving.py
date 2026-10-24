"""The spec routes and what the real spec contains."""

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.errors import install_error_handling
from app.main import app
from tests.dbtools import BACKEND_DIR

COMMITTED = BACKEND_DIR.parent / "openapi.yaml"
ERROR_REF = "#/components/schemas/ErrorResponse"


@pytest.fixture(scope="module")
def spec():
    return yaml.safe_load(COMMITTED.read_bytes())


def assert_shared_error(response, status, code):
    assert response.status_code == status
    assert response.headers["content-type"] == "application/json"
    body = response.json()
    assert list(body) == ["error"]
    assert sorted(body["error"]) == ["code", "message"]
    assert body["error"]["code"] == code


def test_openapi_json_is_served_as_json_and_equals_openapi_yaml(spec):
    response = TestClient(app).get("/api/openapi.json")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == spec


def test_docs_page_is_html_and_points_at_the_spec():
    response = TestClient(app).get("/api/docs")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "/api/openapi.json" in response.text


@pytest.mark.parametrize(
    "path", ["/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect", "/api/redoc"]
)
def test_other_docs_paths_return_404_with_the_shared_shape(path):
    assert_shared_error(TestClient(app).get(path), 404, "not_found")


def test_docs_and_spec_routes_are_not_listed_in_the_spec(spec):
    assert sorted(spec["paths"]) == [
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/me",
        "/api/auth/register",
        "/api/courses",
        "/api/courses/{course_id}/chapters",
        "/api/courses/{course_id}/chapters/{chapter_id}/quiz",
        "/api/courses/{course_id}/lessons/{lesson_id}",
        "/api/courses/{course_id}/progress",
        "/api/courses/{course_id}/progress/last-lesson",
        "/api/health",
    ]


def test_info_and_servers(spec):
    assert spec["info"]["title"] == "mcp-lab API"
    assert spec["info"]["version"] == "0.1.0"
    assert "servers" not in spec


def test_health_operation(spec):
    operation = spec["paths"]["/api/health"]["get"]

    assert operation["operationId"] == "health"
    ok = operation["responses"]["200"]["content"]["application/json"]["schema"]
    assert ok == {"$ref": "#/components/schemas/HealthResponse"}
    assert spec["components"]["schemas"]["HealthResponse"]["required"] == ["status"]
    assert "422" not in operation["responses"]


def test_error_shape_is_defined_once_and_forbids_extra_properties(spec):
    schemas = spec["components"]["schemas"]

    assert schemas["ErrorResponse"]["required"] == ["error"]
    assert schemas["ErrorResponse"]["additionalProperties"] is False
    assert schemas["ErrorResponse"]["properties"]["error"] == {
        "$ref": "#/components/schemas/ErrorDetail"
    }
    detail = schemas["ErrorDetail"]
    assert sorted(detail["required"]) == ["code", "message"]
    assert detail["additionalProperties"] is False
    assert detail["properties"]["code"]["type"] == "string"
    assert detail["properties"]["message"]["type"] == "string"


def test_default_validation_schemas_are_not_in_the_spec(spec):
    assert "HTTPValidationError" not in spec["components"]["schemas"]
    assert "ValidationError" not in spec["components"]["schemas"]


def test_every_error_response_in_the_spec_is_application_json_error_response(spec):
    checked = 0
    for path_item in spec["paths"].values():
        for operation in path_item.values():
            for status, response in operation["responses"].items():
                if status.startswith(("4", "5")) or status == "default":
                    assert list(response["content"]) == ["application/json"]
                    assert response["content"]["application/json"]["schema"] == {"$ref": ERROR_REF}
                    checked += 1
    assert checked >= 1


def test_every_operation_declares_500(spec):
    for path_item in spec["paths"].values():
        for operation in path_item.values():
            assert "500" in operation["responses"]


class Item(BaseModel):
    name: str


class Payload(BaseModel):
    items: list[Item]


def make_app() -> FastAPI:
    throwaway = FastAPI()
    install_error_handling(throwaway)

    @throwaway.get("/plain")
    def plain() -> dict[str, str]:
        return {}

    @throwaway.post("/things")
    def create(payload: Payload, limit: int = 1) -> dict[str, str]:
        return {}

    return throwaway


def test_app_level_default_declares_422_only_on_operations_with_input():
    spec = make_app().openapi()

    assert "422" not in spec["paths"]["/plain"]["get"]["responses"]
    post = spec["paths"]["/things"]["post"]["responses"]
    for responses in (post, spec["paths"]["/plain"]["get"]["responses"]):
        assert responses["500"]["content"]["application/json"]["schema"] == {"$ref": ERROR_REF}
    assert post["422"]["content"]["application/json"]["schema"] == {"$ref": ERROR_REF}
    assert "HTTPValidationError" not in spec["components"]["schemas"]
    assert "ErrorResponse" in spec["components"]["schemas"]


def test_a_query_parameter_alone_gets_422():
    throwaway = FastAPI()
    install_error_handling(throwaway)

    @throwaway.get("/q")
    def query(limit: int = 1) -> dict[str, str]:
        return {}

    assert "422" in throwaway.openapi()["paths"]["/q"]["get"]["responses"]


def test_real_app_spec_is_not_changed_by_throwaway_apps():
    before = app.openapi()

    make_app().openapi()

    assert app.openapi() == before
    assert "/api/health" in app.openapi()["paths"]
    assert "/q" not in app.openapi()["paths"]
