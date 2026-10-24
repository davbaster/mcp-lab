"""Checks on files that are not Python: Docker, compose, CI, and the Alembic layout."""

import re

from tests.dbtools import BACKEND_DIR

ROOT = BACKEND_DIR.parent


def test_alembic_files_hold_no_database_url():
    texts = [(BACKEND_DIR / "alembic.ini").read_text()]
    texts += [p.read_text() for p in (BACKEND_DIR / "migrations").rglob("*.py")]

    assert not any(re.search("postgresql", t, re.IGNORECASE) for t in texts)


def test_migrations_folder_is_not_a_package():
    assert not (BACKEND_DIR / "migrations" / "__init__.py").exists()
    assert (BACKEND_DIR / "migrations" / "env.py").is_file()
    assert (BACKEND_DIR / "migrations" / "versions").is_dir()


def test_dockerfile_starts_through_the_entrypoint_and_does_not_enable_migrations():
    dockerfile = (BACKEND_DIR / "Dockerfile").read_text()

    assert 'ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]' in dockerfile
    assert 'CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]' in dockerfile
    copies = re.findall(r"^COPY (?!--from)(.+)$", dockerfile, re.MULTILINE)
    for path in ("alembic.ini", "migrations", "docker-entrypoint.sh"):
        assert any(path in c.split() for c in copies), path
    assert "RUN_MIGRATIONS_ON_START" not in dockerfile
    assert dockerfile.index("docker-entrypoint.sh ./") < dockerfile.index("USER app")


def test_compose_does_not_publish_postgres_and_keeps_the_db_network_internal():
    compose = (ROOT / "compose.yaml").read_text()
    postgres = compose.split("  postgres:\n", 1)[1].split("\n  backend:\n", 1)[0]

    assert "ports:" not in postgres
    assert re.search(r"^  db:\n    internal: true$", compose, re.MULTILINE)
    assert "restart:" not in compose


def test_compose_sets_database_settings_on_the_backend_only():
    compose = (ROOT / "compose.yaml").read_text()
    sections = re.split(r"^  (?=\w[\w-]*:\n)", compose, flags=re.MULTILINE)
    with_url = [s.split(":", 1)[0] for s in sections if "DATABASE_URL:" in s]
    with_flag = [s.split(":", 1)[0] for s in sections if "RUN_MIGRATIONS_ON_START" in s]

    assert with_url == ["backend"]
    assert with_flag == ["backend"]
    assert 'RUN_MIGRATIONS_ON_START: "true"' in compose
    assert (
        "DATABASE_URL: postgresql+psycopg://${POSTGRES_USER:-mcp_lab}:"
        "${POSTGRES_PASSWORD:-mcp_lab_dev_password}@postgres:5432/${POSTGRES_DB:-mcp_lab}"
    ) in compose


def test_ci_backend_job_has_postgres_service_and_ordered_steps():
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    backend = ci.split("  backend:\n", 1)[1].split("\n  frontend:\n", 1)[0]

    assert "name: backend" in backend
    for expected in (
        "image: postgres:16",
        "POSTGRES_PASSWORD: postgres",
        "POSTGRES_DB: mcp_lab_test",
        "--health-cmd pg_isready",
        "--health-interval",
        "--health-timeout",
        "--health-retries",
        "127.0.0.1:5432:5432",
        "DATABASE_URL: postgresql+psycopg://postgres:postgres@127.0.0.1:5432/mcp_lab_test",
    ):
        assert expected in backend
    steps = re.findall(r"^      - run: (.+)$", backend, re.MULTILINE)
    assert steps == [
        "uv sync",
        "uv run ruff check .",
        "uv run alembic upgrade head",
        "uv run alembic check",
        "uv run pytest",
    ]
