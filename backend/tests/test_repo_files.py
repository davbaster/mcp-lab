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
        "- 5432\n",
        "postgresql+psycopg://postgres:postgres@127.0.0.1:${{ job.services.postgres.ports['5432'] }}/mcp_lab_test",
    ):
        assert expected in backend
    assert "127.0.0.1:5432:5432" not in backend  # no fixed host port on the self-hosted runner
    assert "self-hosted" in backend
    steps = re.findall(r"^      - run: (.+)$", backend, re.MULTILINE)
    # Every step that talks to the database gets DATABASE_URL (job-level env cannot use `job`).
    assert backend.count("DATABASE_URL:") == 3
    assert re.findall(r"^      - uses: (.+)$", backend, re.MULTILINE) == [
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
        "astral-sh/setup-uv@37802adc94f370d6bfd71619e3f0bf239e1f3b78 # v7.6.0",
    ]
    assert steps == [
        "uv sync --locked",
        "uv run ruff check .",
        "uv run alembic upgrade head",
        "uv run alembic check",
        "uv run pytest",
    ]


WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.y*ml"))
SHA_PINNED_USES = re.compile(r"^[\w.-]+/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$")


def _workflow_lines(path):
    """The workflow's lines without full-line comments."""
    return [line for line in path.read_text().splitlines() if not line.lstrip().startswith("#")]


def _minor(version):
    major, minor = version.split(".")[:2]
    return int(major), int(minor)


def test_python_version_file_is_a_minor_version_not_below_requires_python():
    text = (BACKEND_DIR / ".python-version").read_text()
    assert re.fullmatch(r"\d+\.\d+\n", text), "expected the minor version and one newline, e.g. 3.12"

    pyproject = (BACKEND_DIR / "pyproject.toml").read_text()
    minimum = re.search(r'^requires-python = ">=(\d+\.\d+)(?:\.\d+)?"$', pyproject, re.MULTILINE)
    assert minimum, "requires-python must be a plain >= lower bound"
    assert _minor(text.strip()) >= _minor(minimum.group(1))


def test_python_version_file_matches_the_dockerfile_base_images():
    version = (BACKEND_DIR / ".python-version").read_text().strip()
    dockerfile = (BACKEND_DIR / "Dockerfile").read_text()
    assert re.findall(r"^FROM python:(\S+?)(?:-slim)?(?: AS \w+)?$", dockerfile, re.MULTILINE) == [
        version,
        version,
    ]


def test_workflows_do_not_install_python_by_other_means():
    assert WORKFLOWS
    for path in WORKFLOWS:
        text = "\n".join(_workflow_lines(path))
        assert "setup-python" not in text, path.name
        assert "python-version" not in text, path.name


def test_every_workflow_action_is_pinned_to_a_commit_sha_with_a_version_comment():
    uses = [
        (path.name, match.group(1).strip())
        for path in WORKFLOWS
        for line in _workflow_lines(path)
        if (match := re.match(r"^\s*(?:-\s+)?uses:\s*(.+)$", line))
    ]
    assert uses
    for name, value in uses:
        if value.startswith("./"):  # a local action lives in this repo
            continue
        assert SHA_PINNED_USES.match(value), f"{name}: {value!r} is not owner/repo@<40-char sha> # vX.Y.Z"


def test_every_uv_sync_in_the_workflows_is_locked():
    commands = [
        (path.name, line.strip())
        for path in WORKFLOWS
        for line in _workflow_lines(path)
        if "uv sync" in line
    ]
    assert commands, "the backend job installs with uv sync"
    for name, line in commands:
        assert re.search(r"\buv sync\b.*\s--locked(\s|$)", line), f"{name}: {line!r} lacks --locked"


def test_ci_installs_the_uv_version_the_dockerfile_installs():
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    step = re.search(r"uses: astral-sh/setup-uv@\S+.*\n\s+with:\n((?:\s+.+\n)+)", ci)
    assert step, "the setup-uv step must have a with: block"
    ci_version = re.search(r"^\s+version: (\S+)$", step.group(1), re.MULTILINE)
    assert ci_version, "setup-uv must be given an explicit version"
    assert "enable-cache" not in step.group(1)

    dockerfile = (BACKEND_DIR / "Dockerfile").read_text()
    docker_version = re.search(r"\buv==(\S+)", dockerfile)
    assert docker_version
    assert ci_version.group(1) == docker_version.group(1)


def test_ci_frontend_job_installs_with_npm_ci_and_reads_the_node_version_file():
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    frontend = ci.split("\n  frontend:\n", 1)[1]
    assert "node-version-file: .nvmrc" in frontend
    steps = re.findall(r"^      - run: (.+)$", frontend, re.MULTILINE)
    assert steps[0] == "npm ci"
    assert not any(step.startswith("npm install") for step in steps)
