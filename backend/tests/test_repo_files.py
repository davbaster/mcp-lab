"""Checks on files that are not Python: Docker, compose, CI, and the Alembic layout."""

import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field

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


def test_ci_frontend_job_installs_with_npm_ci_and_reads_the_node_version_file():
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    frontend = ci.split("\n  frontend:\n", 1)[1]
    assert "node-version-file: .nvmrc" in frontend
    assert "cache-dependency-path: frontend/package-lock.json" in frontend
    assert "working-directory" not in frontend  # make runs from the repo root
    steps = re.findall(r"^      - run: (.+)$", frontend, re.MULTILINE)
    assert steps[0] == "make install-frontend"
    assert _rules()["install-frontend"].recipe == ["cd frontend && npm ci"]
    assert not any(c.startswith("npm install") for r in _rules().values() for c in r.recipe)


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


def test_per_part_targets_run_the_part_commands_from_the_parts_folder():
    rules = _rules()

    assert {name: rules[name].recipe for name in rules if name.endswith(("-backend", "-frontend"))} | {
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
    }
    assert "typecheck-backend" not in rules


def test_aggregate_targets_call_only_the_per_part_targets_they_should():
    rules = _rules()

    assert {name: rules[name].prerequisites for name in ("install", "lint", "typecheck", "test", "check")} == {
        "install": ["install-backend", "install-frontend"],
        "lint": ["lint-backend", "lint-frontend"],
        "typecheck": ["typecheck-frontend"],
        "test": ["test-backend", "test-frontend"],
        "check": ["check-openapi", "check-api-client"],
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
