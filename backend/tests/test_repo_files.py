"""Checks on files that are not Python: Docker, compose, CI, and the Alembic layout."""

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field

import yaml

from tests.dbtools import BACKEND_DIR

ROOT = BACKEND_DIR.parent
MAKEFILE = ROOT / "Makefile"


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
    assert (
        'CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers",'
        ' "--no-access-log", "--log-config", "app/log_config.json"]' in dockerfile
    )
    copies = re.findall(r"^COPY (?!--from)(.+)$", dockerfile, re.MULTILINE)
    for path in ("alembic.ini", "migrations", "docker-entrypoint.sh"):  # the build context is the repo root
        assert any(f"backend/{path}" in c.split() for c in copies), path
    assert "RUN_MIGRATIONS_ON_START" not in dockerfile
    assert dockerfile.index("docker-entrypoint.sh ./") < dockerfile.index("USER app")
    assert dockerfile.index("COPY --from=content") < dockerfile.index("USER app")


def _stages(dockerfile):
    """The Dockerfile split into its stages: the `FROM` line and the text up to the next one."""
    parts = re.split(r"^(?=FROM )", dockerfile, flags=re.MULTILINE)
    return [part for part in parts if part.startswith("FROM ")]


def test_backend_dockerfile_builds_the_course_content_in_its_first_stage():
    dockerfile = (BACKEND_DIR / "Dockerfile").read_text()
    stages = _stages(dockerfile)
    node_major = (ROOT / ".nvmrc").read_text().strip()

    assert [stage.splitlines()[0] for stage in stages] == [
        f"FROM node:{node_major}-bookworm AS content",
        "FROM python:3.12-slim AS build",
        "FROM python:3.12-slim",
    ]
    content = stages[0]
    assert "RUN cd content-build && npm ci\n" in content
    # npm ci runs on the lock file alone, before the sources are copied, so the layer is cached.
    assert content.index("package-lock.json") < content.index("npm ci") < content.index("COPY content-build content-build")
    assert "COPY content-build content-build\n" in content
    assert "COPY frontend/src/content-components/schemas frontend/src/content-components/schemas\n" in content
    assert "ARG COURSES_DIR=courses\n" in content
    assert "COPY ${COURSES_DIR} courses\n" in content
    assert content.rstrip().endswith("RUN cd content-build && npm run build -- ../courses ../build")
    # The COURSES variable chooses what is served at run time; the image holds every course.
    assert not re.search(r"^\s*(ARG|ENV) COURSES\b(?!_DIR)", dockerfile, re.MULTILINE)


def test_backend_image_holds_the_build_output_and_tells_the_app_where_it_is():
    dockerfile = (BACKEND_DIR / "Dockerfile").read_text()
    runtime = _stages(dockerfile)[-1]

    assert "COPY --from=content /repo/build /app/course-build\n" in runtime
    assert "COURSE_BUILD_DIR=/app/course-build" in runtime
    # The Python stages copy from backend/, because the build context is the repo root.
    for stage in _stages(dockerfile)[1:]:
        for source in re.findall(r"^COPY (?!--from)(.+) \S+$", stage, re.MULTILINE):
            assert all(path.startswith("backend/") for path in source.split()), source
    assert dockerfile.rstrip().splitlines()[-1].startswith("CMD ")


def test_compose_builds_both_images_from_the_repo_root():
    compose = (ROOT / "compose.yaml").read_text()
    backend = compose.split("  backend:\n", 1)[1].split("\n  frontend:\n", 1)[0]
    frontend = compose.split("  frontend:\n", 1)[1].split("\n  caddy:\n", 1)[0]

    assert re.search(r"^    build:\n(?:      #.*\n)*      context: \.\n      dockerfile: backend/Dockerfile$", backend, re.MULTILINE)
    assert re.search(
        r"^    build:\n(?:      #.*\n)*      context: \.\n      dockerfile: frontend/Dockerfile$", frontend, re.MULTILINE
    )


def _dockerignore_rules(path):
    return [line for line in path.read_text().splitlines() if line.strip() and not line.startswith("#")]


def test_backend_dockerignore_is_an_allowlist_next_to_the_dockerfile():
    assert not (BACKEND_DIR / ".dockerignore").exists()  # it no longer applies: the context is the repo root
    rules = _dockerignore_rules(BACKEND_DIR / "Dockerfile.dockerignore")

    assert rules[0] == "*"
    allowed = [rule[1:] for rule in rules if rule.startswith("!")]
    assert allowed == ["backend", "content-build", "frontend/src/content-components/schemas", "courses"]
    # Excluded again after the allowlist, wherever they are, because a later line wins.
    excluded = rules[1 + len(allowed) :]
    for pattern in (
        "**/.venv",
        "**/__pycache__",
        "**/*.pyc",
        "**/.pytest_cache",
        "**/.ruff_cache",
        "**/.mypy_cache",
        "**/node_modules",
        "**/.env*",
        "backend/tests",
    ):
        assert pattern in excluded, pattern
    assert not any(rule.startswith("!") for rule in excluded)
    # Nothing else of the repo is allowed in: not the root build/ folder, not the rest of frontend/.
    assert "build" not in allowed and "frontend" not in allowed


def test_frontend_dockerignore_is_an_allowlist_next_to_the_dockerfile():
    assert not (ROOT / "frontend" / ".dockerignore").exists()  # it no longer applies: the context is the repo root
    rules = _dockerignore_rules(ROOT / "frontend" / "Dockerfile.dockerignore")

    assert rules[0] == "*"
    # The app, and the one list of media origins that its Content-Security-Policy is built from. Nothing else.
    assert [rule[1:] for rule in rules if rule.startswith("!")] == ["frontend", "content-build/media-config.json"]
    # Course build output must never end up in the frontend image, wherever it is.
    assert "**/build" in rules and "**/private" in rules and "**/node_modules" in rules
    assert rules.index("**/build") > rules.index("!frontend")  # a later line wins


def test_frontend_image_copies_only_its_folder_and_the_media_config_and_ignores_course_output():
    dockerfile = (ROOT / "frontend" / "Dockerfile").read_text()
    sources = [
        source
        for line in re.findall(r"^(?:COPY|ADD) (?!--from)(.+)$", dockerfile, re.MULTILINE)
        for source in line.split()[:-1]
    ]

    assert sources
    for source in sources:
        assert source == "content-build/media-config.json" or source.split("/")[0] == "frontend", source
    assert "courses" not in dockerfile and "course-build" not in dockerfile
    # The build stage makes the CSP from that file, and the runtime stage gets only the result.
    assert "RUN node scripts/csp.mjs ../content-build/media-config.json csp.conf" in dockerfile
    assert "COPY --from=build /app/frontend/csp.conf /etc/nginx/csp.conf" in dockerfile
    runtime = dockerfile.split("FROM nginx")[1]
    assert "content-build" not in runtime


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


def test_compose_gives_the_backend_the_courses_to_serve_and_the_folder_to_build_from():
    compose = (ROOT / "compose.yaml").read_text()
    sections = re.split(r"^  (?=\w[\w-]*:\n)", compose, flags=re.MULTILINE)
    with_courses = [s.split(":", 1)[0] for s in sections if re.search(r"^ +COURSES:", s, re.MULTILINE)]
    backend = compose.split("  backend:\n", 1)[1].split("\n  frontend:\n", 1)[0]

    assert with_courses == ["backend"]
    assert "      COURSES: ${COURSES:-mcp-server}\n" in backend
    # The build argument that the Dockerfile has (ARG COURSES_DIR), so the fixture course can be built in.
    assert re.search(r"^      args:\n(?:        #.*\n)*        COURSES_DIR: \${COURSES_DIR:-courses}$", backend, re.MULTILINE)
    # COURSE_BUILD_DIR comes from the image, not from compose.
    assert "COURSE_BUILD_DIR" not in compose


def test_compose_trusts_only_private_ranges_as_proxies_and_the_backend_publishes_no_port():
    from app.client_address import parse_trusted_proxies

    compose = (ROOT / "compose.yaml").read_text()
    backend = compose.split("  backend:\n", 1)[1].split("\n  frontend:\n", 1)[0]
    example = (ROOT / ".env.example").read_text()
    readme = (ROOT / "README.md").read_text()
    default = "172.16.0.0/12,192.168.0.0/16,10.0.0.0/8"

    assert f"      TRUSTED_PROXIES: ${{TRUSTED_PROXIES:-{default}}}\n" in backend
    assert "ports:" not in backend
    assert [str(n) for n in parse_trusted_proxies(default)] == default.split(",")
    assert f"\nTRUSTED_PROXIES={default}\n" in example
    assert "| `TRUSTED_PROXIES` |" in readme
    assert "TRUSTED_PROXIES" not in compose.split("  frontend:\n", 1)[1]


def test_compose_sets_the_deployment_and_the_metrics_port_and_publishes_no_backend_port():
    compose = (ROOT / "compose.yaml").read_text()
    backend = compose.split("  backend:\n", 1)[1].split("\n  frontend:\n", 1)[0]
    example = (ROOT / ".env.example").read_text()
    services = yaml.safe_load(compose)["services"]

    assert "      DEPLOYMENT: ${DEPLOYMENT:-local}\n" in backend
    assert "      METRICS_PORT: ${METRICS_PORT:-9000}\n" in backend
    assert "ports" not in services["backend"]
    assert "expose" not in services["backend"]
    # Only Caddy publishes a port, and it is not 9000: the metrics port is reached inside the stack.
    published = {name: s["ports"] for name, s in services.items() if "ports" in s}
    assert list(published) == ["caddy"]
    assert not [p for p in published["caddy"] if "9000" in p]
    assert "\nDEPLOYMENT=local\n" in example
    assert "\nMETRICS_PORT=9000\n" in example


def test_the_backend_runs_one_process_per_container():
    dockerfile = (BACKEND_DIR / "Dockerfile").read_text()
    compose = (ROOT / "compose.yaml").read_text()
    readme = (ROOT / "README.md").read_text()

    assert "--workers" not in dockerfile
    assert "WEB_CONCURRENCY" not in dockerfile + compose
    assert "UVICORN_WORKERS" not in dockerfile + compose
    assert "one process per container" in readme.lower()


def test_the_image_starts_uvicorn_with_the_json_log_config_that_it_copies():
    dockerfile = (BACKEND_DIR / "Dockerfile").read_text()
    config = BACKEND_DIR / "app" / "log_config.json"

    assert '"--log-config", "app/log_config.json"' in dockerfile
    assert '"--no-access-log"' in dockerfile
    assert "COPY backend/app ./app" in dockerfile  # the config is inside the folder the image copies
    assert json.loads(config.read_text())["version"] == 1


def test_the_local_proxy_answers_404_for_metrics_before_it_reaches_the_frontend():
    caddyfile = (ROOT / "caddy" / "Caddyfile").read_text()
    site = caddyfile.split(":8080 {", 1)[1]

    assert "@metrics path /metrics /metrics/*" in site
    block = site.split("handle @metrics {", 1)[1].split("}", 1)[0]
    assert block.strip() == "respond 404"
    # before the catch-all, which would answer with the frontend's index.html and status 200
    assert site.index("handle @metrics") < site.index("handle /api/*") < site.index("\n\thandle {")
    assert "9000" not in caddyfile  # no route to the metrics port
    assert "reverse_proxy" in site and site.count("reverse_proxy") == 2  # backend:8000 and frontend
    assert "backend:8000" in site and "backend:9000" not in site


def test_env_example_and_readme_document_the_course_settings():
    example = (ROOT / ".env.example").read_text()
    readme = (ROOT / "README.md").read_text()

    assert "# COURSES_DIR=content-build/fixtures/valid\n# COURSES=sample-course\n" in example
    assert "mcp-server" in example
    for text in (example, readme):
        assert "COURSE_BUILD_DIR" in text
    assert "| `COURSES` |" in readme
    assert "| `COURSE_BUILD_DIR` |" in readme


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
    assert re.findall(
        r"^      - run: (.+)\n        env:\n(?:          #.*\n)*          DATABASE_URL: ",
        backend,
        re.MULTILINE,
    ) == ["make migrate-backend", "make check-migrations", "make test-backend"]
    assert "working-directory" not in backend  # make runs from the repo root
    assert re.findall(r"^      - uses: (.+)$", backend, re.MULTILINE) == [
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
        "astral-sh/setup-uv@37802adc94f370d6bfd71619e3f0bf239e1f3b78 # v7.6.0",
    ]
    assert steps == [
        "make install-backend",
        "make lint-backend",
        "make migrate-backend",
        "make check-migrations",
        "make test-backend",
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


def test_every_uv_sync_in_the_makefile_and_workflows_is_locked():
    commands = [("Makefile", line) for line in _recipe_lines() if "uv sync" in line]
    commands += [
        (path.name, line.strip())
        for path in WORKFLOWS
        for line in _workflow_lines(path)
        if "uv sync" in line
    ]
    assert commands, "install-backend runs uv sync"
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


def _ci_job(name):
    """The text of one job in ci.yml: from its `  name:` line to the next job, or the end of the file."""
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    after = ci.split(f"\n  {name}:\n", 1)[1]
    return re.split(r"\n  [\w-]+:\n", after, maxsplit=1)[0]


def test_ci_frontend_job_installs_with_npm_ci_and_reads_the_node_version_file():
    frontend = _ci_job("frontend")
    assert "node-version-file: .nvmrc" in frontend
    assert "cache-dependency-path: frontend/package-lock.json" in frontend
    assert "working-directory" not in frontend  # make runs from the repo root
    assert "content-build" not in frontend  # a job after this one is not part of it
    steps = re.findall(r"^      - run: (.+)$", frontend, re.MULTILINE)
    assert steps[0] == "make install-frontend"
    assert _rules()["install-frontend"].recipe == ["cd frontend && npm ci"]
    assert not any(c.startswith("npm install") for r in _rules().values() for c in r.recipe)


def test_ci_content_build_job_runs_the_make_targets_with_the_node_version_file():
    content_build = _ci_job("content-build")
    frontend = _ci_job("frontend")

    assert "name: content-build" in content_build
    assert re.search(r"^    runs-on: \[self-hosted, Linux, X64, ubuntu-24\]$", content_build, re.MULTILINE)
    guard = re.search(r"^    if: (.+)$", content_build, re.MULTILINE)
    assert guard, "the job needs the fork-PR guard"
    assert guard.group(0) in frontend  # the same guard as the other jobs
    assert re.findall(r"^      - uses: (.+)$", content_build, re.MULTILINE) == [
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
        "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
    ]
    assert re.search(
        r"setup-node@.*\n        with:\n"
        r"          node-version-file: \.nvmrc\n"
        r"          cache: npm\n"
        r"          cache-dependency-path: content-build/package-lock\.json\n",
        content_build,
    )
    assert re.findall(r"^      - run: (.+)$", content_build, re.MULTILINE) == [
        "make install-content-build",
        "make lint-content-build",
        "make typecheck-content-build",
        "make test-content-build",
        "make build-content",
        "make check-content-ids-base",
    ]
    assert "working-directory" not in content_build  # make runs from the repo root
    assert "npm " not in content_build  # only make targets, no direct npm
    assert "frontend" not in content_build


def test_ci_content_build_job_turns_the_browser_sandbox_off_and_no_other_job_does():
    content_build = _ci_job("content-build")

    # Ubuntu 24.04 (AppArmor) blocks Chromium's sandbox for a normal user, and the diagram tests start Chromium (#55).
    env = re.search(r"^    env:\n((?:      .*\n)+)    steps:\n", content_build + "\n", re.MULTILINE)
    assert env, "the content-build job needs a job-level env: block, before steps:"
    assert [line.strip() for line in env.group(1).splitlines() if not line.strip().startswith("#")] == ["MERMAID_NO_SANDBOX: 1"]
    assert "AppArmor" in env.group(1)
    for other in ("backend", "frontend", "docker-images"):
        assert "MERMAID_NO_SANDBOX" not in _ci_job(other)


def test_ci_content_build_job_checks_out_the_whole_history_for_the_id_check():
    content_build = _ci_job("content-build")

    # The ID check compares with the merge base, so a shallow clone would make it fail.
    assert re.search(
        r"actions/checkout@\S+ # v\S+\n        with:\n(?:          #.*\n)*          fetch-depth: 0\n", content_build
    )
    assert content_build.index("fetch-depth: 0") < content_build.index("setup-node")
    for other in ("backend", "frontend"):
        assert "fetch-depth" not in _ci_job(other)


def test_ci_id_check_gets_its_base_from_the_step_env_and_never_from_a_run_line():
    content_build = _ci_job("content-build")
    step = re.search(r"^      - run: make check-content-ids-base\n        env:\n((?:          .*\n)+)", content_build + "\n", re.MULTILINE)

    assert step, "make check-content-ids-base needs an env: block with BASE"
    values = [line.strip() for line in step.group(1).splitlines() if not line.strip().startswith("#")]
    # A pull request or a push to another branch compares with main; a push to main with the commit before the push.
    assert values == [
        "BASE: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && github.event.before || 'origin/main' }}"
    ]
    assert "${{" not in "\n".join(re.findall(r"^\s*(?:-\s+)?run:.*$", content_build, re.MULTILINE))  # nothing expanded in a run: line


def test_ci_docker_images_job_runs_the_image_check_like_the_other_jobs():
    job = _ci_job("docker-images")

    assert "name: docker-images" in job
    assert re.search(r"^    runs-on: \[self-hosted, Linux, X64, ubuntu-24\]$", job, re.MULTILINE)
    assert re.search(r"^    if: (.+)$", job, re.MULTILINE).group(0) in _ci_job("frontend")  # the fork guard
    assert re.findall(r"^      - uses: (.+)$", job, re.MULTILINE) == [
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
        "astral-sh/setup-uv@37802adc94f370d6bfd71619e3f0bf239e1f3b78 # v7.6.0",
    ]
    assert re.findall(r"^      - run: (.+)$", job, re.MULTILINE) == ["make install-backend", "make check-images"]
    assert re.search(r"^          version: (\S+)$", job, re.MULTILINE).group(1) == re.search(
        r"\buv==(\S+)", (BACKEND_DIR / "Dockerfile").read_text()
    ).group(1)
    assert "working-directory" not in job
    assert "fetch-depth" not in job


def test_content_build_uses_the_shared_node_version_and_requires_it():
    assert not (ROOT / "content-build" / ".nvmrc").exists()  # one .nvmrc at the root
    package = json.loads((ROOT / "content-build" / "package.json").read_text())

    assert package["private"] is True
    assert package["type"] == "module"
    assert package["engines"] == {"node": f">={(ROOT / '.nvmrc').read_text().strip()}"}
    assert {"validate", "test", "lint", "typecheck", "build", "ids:update", "ids:check"} <= set(package["scripts"])


# --- The root Makefile ------------------------------------------------------------------


@dataclass
class Rule:
    prerequisites: list[str]
    recipe: list[str] = field(default_factory=list)


def _makefile_text():
    return MAKEFILE.read_text()


def _recipe_lines():
    """Every recipe line (tab-indented, not a continuation of a variable or .PHONY list)."""
    lines, previous = [], ""
    for line in _makefile_text().splitlines():
        if line.startswith("\t") and not previous.endswith("\\"):
            lines.append(line[1:])
        previous = line
    return lines


def _rules():
    """The Makefile's rules by target: prerequisites and recipe lines, without @ and - prefixes."""
    rules, current = {}, None
    for line in _makefile_text().splitlines():
        head = re.match(r"^([a-z][\w-]*):(?!=)\s*(.*)$", line)
        if head:
            current = Rule(head.group(2).split())
            rules[head.group(1)] = current
        elif line.startswith("\t") and current is not None:
            current.recipe.append(line[1:].lstrip("@-+ "))
        elif line.strip():
            current = None
    return rules


def _phony_targets():
    joined = _makefile_text().replace("\\\n", " ")
    declared = re.findall(r"^\.PHONY:(.*)$", joined, re.MULTILINE)
    return [target for line in declared for target in line.split()]


def _help_targets():
    joined = _makefile_text().replace("\\\n", " ")
    listed = re.search(r"^HELP_TARGETS\s*=(.*)$", joined, re.MULTILINE)
    return listed.group(1).split() if listed else []


def _help_description(target):
    found = re.search(rf"^HELP\.{re.escape(target)}\s*=\s*(\S.*)$", _makefile_text(), re.MULTILINE)
    return found.group(1) if found else None


def _make(*args):
    make = shutil.which("make")
    assert make, "GNU Make is a required tool (see 'Required tools' in README.md)"
    # When pytest itself runs under `make test`, MAKEFLAGS would leak into this make.
    env = {k: v for k, v in os.environ.items() if k not in ("MAKEFLAGS", "MAKELEVEL", "MFLAGS")}
    return subprocess.run(
        [make, *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60, check=False
    )


def test_makefile_help_lists_every_phony_target_with_a_description():
    phony = _phony_targets()

    assert phony
    assert sorted(_help_targets()) == sorted(phony)
    assert len(set(phony)) == len(phony)
    for target in phony:
        assert _help_description(target), f"no HELP.{target} description"
    help_recipe = _rules()["help"].recipe
    assert any("$(foreach" in line and "$(HELP_TARGETS)" in line for line in help_recipe)


def test_every_phony_target_has_a_rule_and_every_rule_is_phony():
    assert sorted(_rules()) == sorted(_phony_targets())


def test_plain_make_runs_help_and_prints_every_target_with_its_description():
    plain, help_ = _make(), _make("help")

    assert plain.returncode == 0, plain.stderr
    assert plain.stdout == help_.stdout
    assert "Nothing to be done" not in plain.stdout + plain.stderr
    printed = plain.stdout.splitlines()
    for target in _phony_targets():
        assert f"{target}: {_help_description(target)}" in printed


def test_makefile_first_rule_is_help():
    assert next(iter(_rules())) == "help"


def test_makefile_uses_only_plain_recipes_that_work_with_sh_and_cmd():
    unix_tools = {"grep", "awk", "sed", "rm", "cp", "test", "cat", "ls", "mkdir", "mv", "find", "tee"}
    recipe = _recipe_lines()

    assert recipe
    for line in recipe:
        command = line.lstrip("@-+ ")
        where = f"recipe line {line!r}"
        assert not line.endswith("\\"), where
        for banned in ("|", ";", "'", "`", "$(shell", "$(file", "$(eval", "$$"):
            assert banned not in line, f"{where} contains {banned!r}"
        if command.startswith(("$(info", "$(foreach")):  # Make's own functions, no shell runs
            continue
        assert command.count("&&") <= 1 and "&" not in command.replace("&&", ""), where
        if "&&" in command:
            assert re.fullmatch(r"cd [\w./-]+ && \S.*", command), f"{where} must be `cd <dir> && <command>`"
        first = command.split("&&")[-1].split()[0]
        assert not re.fullmatch(r"[A-Za-z_]\w*=\S*", first), f"{where} has a VAR=value prefix"
        assert first not in unix_tools, f"{where} uses the Unix-only tool {first}"


def test_makefile_uses_no_make_features_newer_than_3_81_and_does_not_set_the_shell():
    text = "\n".join(
        line for line in _makefile_text().splitlines() if not line.lstrip().startswith("#")
    )

    for feature in (".ONESHELL", "$(file", "&:", ".SHELLFLAGS", "$(shell", ".RECIPEPREFIX"):
        assert feature not in text, feature
    assert not re.search(r"^\s*(export\s+|override\s+)?SHELL\s*[:?+]?=", text, re.MULTILINE)
    assert not re.search(r"^\s*(export\s+)?SHELL\b", text, re.MULTILINE)
    assert b"\r" not in MAKEFILE.read_bytes()


def test_gitattributes_pins_the_makefile_to_lf():
    assert "Makefile text eol=lf" in (ROOT / ".gitattributes").read_text().splitlines()


def test_gitattributes_pins_the_id_files_and_the_golden_build_output_to_lf():
    lines = (ROOT / ".gitattributes").read_text().splitlines()

    for pattern in (
        "courses/*/ids.json text eol=lf",
        "content-build/fixtures/**/ids.json text eol=lf",
        "content-build/fixtures/expected/**/*.json text eol=lf",
        "content-build/fixtures/expected/private/** text eol=lf",
    ):
        assert pattern in lines, pattern


def test_gitignore_ignores_the_build_folder_at_the_repo_root_only():
    lines = (ROOT / ".gitignore").read_text().splitlines()

    assert "/build/" in lines
    assert "build/" not in lines


def test_per_part_targets_run_the_part_commands_from_the_parts_folder():
    rules = _rules()

    parts = ("-backend", "-frontend", "-content-build")
    assert {name: rules[name].recipe for name in rules if name.endswith(parts)} | {
        name: rules[name].recipe for name in ("check-openapi", "check-migrations", "check-api-client")
    } == {
        "install-backend": ["cd backend && uv sync --locked"],
        "lint-backend": ["cd backend && uv run ruff check ."],
        "test-backend": ["cd backend && uv run pytest"],
        "migrate-backend": ["cd backend && uv run alembic upgrade head"],
        "install-frontend": ["cd frontend && npm ci"],
        "lint-frontend": ["cd frontend && npm run lint"],
        "typecheck-frontend": ["cd frontend && npm run typecheck"],
        "test-frontend": ["cd frontend && npm test"],
        "check-openapi": ["cd backend && uv run python scripts/export_openapi.py --check"],
        "check-migrations": ["cd backend && uv run alembic check"],
        "check-api-client": ["cd frontend && npm run check:api"],
        # npm ci downloads no browser; the second line downloads chrome-headless-shell for the Mermaid diagrams (#55).
        "install-content-build": ["cd content-build && npm ci", "cd content-build && npm run install:browser"],
        "lint-content-build": ["cd content-build && npm run lint"],
        "typecheck-content-build": ["cd content-build && npm run typecheck"],
        "test-content-build": ["cd content-build && npm test"],
    }
    assert "typecheck-backend" not in rules


CONTENT_TARGETS = ("build-content", "update-content-ids", "check-content-ids", "check-content-ids-base")


def test_check_images_runs_the_script_from_the_backend_folder_and_is_in_no_aggregate():
    rules = _rules()

    assert rules["check-images"].recipe == ["cd backend && uv run python scripts/check_images.py"]
    assert rules["check-images"].prerequisites == []
    assert "check-images" in _phony_targets() and _help_description("check-images")
    assert "check-images" not in {p for r in rules.values() for p in r.prerequisites}  # it needs Docker


def test_content_targets_run_the_content_build_commands_from_its_folder():
    rules = _rules()

    assert {name: rules[name].recipe for name in CONTENT_TARGETS} == {
        "build-content": ["cd content-build && npm run build -- ../courses ../build"],
        "update-content-ids": ["cd content-build && npm run ids:update -- ../courses"],
        "check-content-ids": ["cd content-build && npm run ids:check -- ../courses"],
        "check-content-ids-base": ["cd content-build && npm run ids:check -- ../courses --base $(BASE)"],
    }
    for name in CONTENT_TARGETS:
        assert rules[name].prerequisites == [], name
        assert name in _phony_targets() and _help_description(name), name


def test_only_the_read_only_id_check_without_a_base_is_in_an_aggregate():
    rules = _rules()
    in_aggregates = {p for name in ("install", "lint", "typecheck", "test", "check") for p in rules[name].prerequisites}

    # build-content and update-content-ids write files, and the base check needs git history, like migrate-backend needs a database.
    assert in_aggregates & set(CONTENT_TARGETS) == {"check-content-ids"}


def test_check_content_ids_base_passes_the_base_variable_to_the_command():
    result = _make("-n", "check-content-ids-base", "BASE=origin/main")

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["cd content-build && npm run ids:check -- ../courses --base origin/main"]


def test_check_content_ids_base_without_a_base_ends_the_command_at_the_flag_so_the_tool_prints_its_usage():
    result = _make("-n", "check-content-ids-base")

    assert result.returncode == 0, result.stderr
    assert [line.rstrip() for line in result.stdout.splitlines()] == [
        "cd content-build && npm run ids:check -- ../courses --base"
    ]


def test_aggregate_targets_call_only_the_per_part_targets_they_should():
    rules = _rules()

    assert {name: rules[name].prerequisites for name in ("install", "lint", "typecheck", "test", "check")} == {
        "install": ["install-backend", "install-frontend", "install-content-build"],
        "lint": ["lint-backend", "lint-frontend", "lint-content-build"],
        "typecheck": ["typecheck-frontend", "typecheck-content-build"],
        "test": ["test-backend", "test-frontend", "test-content-build"],
        "check": ["check-openapi", "check-api-client", "check-content-ids"],
    }
    for name in ("install", "lint", "typecheck", "test", "check"):
        assert rules[name].recipe == [], name
    needs_database = {"migrate-backend", "check-migrations"}
    assert not needs_database & {p for r in rules.values() for p in r.prerequisites}


def test_makefile_never_sets_or_reads_database_url_for_the_tests():
    text = _makefile_text()

    assert not re.search(r"^\s*(export\s+|override\s+)?DATABASE_URL\s*[:?+]*=", text, re.MULTILINE)
    assert not re.search(r"^-?(s?include)\b|\.env\b|dotenv", text, re.MULTILINE)
    for name in ("test-backend", "migrate-backend", "check-migrations"):
        assert not any("DATABASE_URL" in line for line in _rules()[name].recipe), name


def test_test_db_up_starts_the_readme_container_on_port_5433_and_prints_the_url():
    result = _make("-n", "test-db-up")

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        (
            "docker run --rm -d --name mcp-lab-test-db -e POSTGRES_PASSWORD=postgres"
            " -p 127.0.0.1:5433:5432 postgres:16"
        ),
        "echo DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test",
        "echo Postgres needs a few seconds before it accepts connections.",
    ]
    assert result.stdout.splitlines()[0] in (ROOT / "README.md").read_text()


def test_test_db_up_uses_the_port_given_on_the_command_line_in_the_run_and_the_url():
    result = _make("-n", "test-db-up", "TEST_DB_PORT=5434")

    assert result.returncode == 0, result.stderr
    assert "-p 127.0.0.1:5434:5432" in result.stdout
    assert "@127.0.0.1:5434/mcp_lab_test" in result.stdout
    assert "5433" not in result.stdout


def test_test_db_targets_do_not_wait_retry_or_ignore_docker_errors():
    rules = _rules()

    assert rules["test-db-down"].recipe == ["docker stop mcp-lab-test-db"]
    assert rules["test-db-up"].prerequisites == rules["test-db-down"].prerequisites == []
    assert not any(line.startswith(("-", "@-")) for line in _recipe_lines()), "a - hides errors"
    assert not any("sleep" in line or "pg_isready" in line for line in _recipe_lines())


def _workflow_commands():
    """The `run:` command of every workflow step (single-line only)."""
    commands = []
    for path in WORKFLOWS:
        for line in _workflow_lines(path):
            match = re.match(r"^\s*(?:-\s+)?run:\s*(.*)$", line)
            if match:
                assert match.group(1) not in ("", "|", ">", "|-", ">-"), (
                    f"{path.name}: use one `run: make <target>` line, not a script block"
                )
                commands.append((path.name, match.group(1).strip()))
    return commands


def test_workflow_steps_call_make_and_never_uv_npm_or_alembic_directly():
    commands = _workflow_commands()

    assert commands
    for name, command in commands:
        assert command.startswith("make "), f"{name}: {command!r} must call a make target"


def test_every_make_target_a_workflow_calls_exists_in_the_makefile():
    targets = set(_phony_targets())
    called = [
        (name, word)
        for name, command in _workflow_commands()
        if command.startswith("make ")
        for word in command.split()[1:]
    ]

    assert called
    for name, word in called:
        assert word in targets, f"{name}: `make {word}` is not a target in the Makefile"
