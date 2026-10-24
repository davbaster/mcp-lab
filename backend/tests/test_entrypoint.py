"""docker-entrypoint.sh, run with a fake `alembic` so the test needs no database."""

import os
import stat

import pytest

from tests.dbtools import BACKEND_DIR
from tests.helpers import run

SCRIPT = BACKEND_DIR / "docker-entrypoint.sh"


@pytest.fixture
def fake_bin(tmp_path):
    """A PATH folder whose `alembic` records its arguments and exits with $FAKE_ALEMBIC_EXIT."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    alembic = bin_dir / "alembic"
    alembic.write_text(
        '#!/bin/sh\necho "alembic $*" >> "$FAKE_LOG"\nexit "${FAKE_ALEMBIC_EXIT:-0}"\n'
    )
    alembic.chmod(alembic.stat().st_mode | stat.S_IXUSR)
    return bin_dir


def _run(fake_bin, tmp_path, migrations_flag, alembic_exit="0"):
    env = {
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "FAKE_LOG": str(tmp_path / "calls.log"),
        "FAKE_ALEMBIC_EXIT": alembic_exit,
    }
    if migrations_flag is not None:
        env["RUN_MIGRATIONS_ON_START"] = migrations_flag
    result = run(["sh", str(SCRIPT), "echo", "command-ran"], env)
    log = tmp_path / "calls.log"
    return result, (log.read_text() if log.exists() else "")


def test_migrations_run_before_the_command_when_flag_is_exactly_true(fake_bin, tmp_path):
    result, calls = _run(fake_bin, tmp_path, "true")

    assert result.returncode == 0, result.output
    assert calls == "alembic upgrade head\n"
    assert result.output.index("running database migrations") < result.output.index("command-ran")


@pytest.mark.parametrize("flag", [None, "false", "TRUE", "True", "1", "yes", ""])
def test_migrations_are_skipped_for_anything_but_true(fake_bin, tmp_path, flag):
    result, calls = _run(fake_bin, tmp_path, flag)

    assert result.returncode == 0, result.output
    assert calls == ""
    assert "skipping database migrations" in result.output
    assert "command-ran" in result.output


def test_a_failing_migration_stops_the_script_before_the_command(fake_bin, tmp_path):
    result, calls = _run(fake_bin, tmp_path, "true", alembic_exit="3")

    assert result.returncode == 3
    assert calls == "alembic upgrade head\n"
    assert "command-ran" not in result.output


def test_script_ends_with_exec_so_the_command_is_pid_1():
    lines = [ln for ln in SCRIPT.read_text().splitlines() if ln.strip() and not ln.startswith("#")]

    assert "set -e" in lines
    assert lines[-1] == 'exec "$@"'
