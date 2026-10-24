import pytest
from sqlalchemy.engine import make_url

from tests.dbtools import DatabaseSetupError, check_test_database

BASE = "postgresql+psycopg://u:p@127.0.0.1:5432"


@pytest.mark.parametrize(
    "suffix",
    [
        "/mcp_lab_test",
        "/mcp_lab_test?sslmode=disable",
        "/a_test",
        "/mcp-lab_test",
    ],
)
def test_guard_accepts_test_databases(suffix):
    check_test_database(make_url(BASE + suffix))


@pytest.mark.parametrize(
    ("suffix", "name"),
    [
        ("/mcp_lab", "mcp_lab"),
        ("/foo_test_x", "foo_test_x"),
        ("/mcp_lab_testing", "mcp_lab_testing"),
        ("/test", "test"),
        ("/_test", "_test"),
        ("/MCP_LAB_TEST", "MCP_LAB_TEST"),
        ("/mcp_lab?application_name=foo_test", "mcp_lab"),
        ("/mcp_lab?options=-c%20search_path%3Dx_test", "mcp_lab"),
    ],
)
def test_guard_refuses_other_databases_and_names_the_one_it_found(suffix, name):
    with pytest.raises(DatabaseSetupError) as excinfo:
        check_test_database(make_url(BASE + suffix))

    assert f"'{name}'" in str(excinfo.value)
    assert "_test" in str(excinfo.value)


def test_guard_refuses_url_with_no_database_name():
    with pytest.raises(DatabaseSetupError, match="no database name"):
        check_test_database(make_url(BASE + "/"))


@pytest.mark.parametrize("param", ["dbname", "service"])
def test_guard_refuses_test_database_with_overriding_parameter(param):
    with pytest.raises(DatabaseSetupError, match=param):
        check_test_database(make_url(f"{BASE}/mcp_lab_test?{param}=mcp_lab"))


def test_guard_message_never_contains_the_password():
    url = make_url("postgresql+psycopg://u:PW-GUARD-1@127.0.0.1:5432/mcp_lab")

    with pytest.raises(DatabaseSetupError) as excinfo:
        check_test_database(url)

    assert "PW-GUARD-1" not in str(excinfo.value)
