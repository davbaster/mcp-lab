"""docker-entrypoint.sh, run with a fake `alembic` so the test needs no database.

The script runs with `sh` when there is one on PATH (Linux, macOS, CI). Plain Windows has no
`sh`, so there the same script runs in a `python:3.12-slim` container (the backend image's base)
with the script, the fake `alembic` and the log folder mounted in. Docker Desktop must be running.
"""

import os
import re
import shlex
import shutil
import stat
import subprocess
import uuid
from collections.abc import Callable
from pathlib import Path

import pytest

from tests.dbtools import BACKEND_DIR
from tests.helpers import Result, run

SCRIPT = BACKEND_DIR / "docker-entrypoint.sh"
DOCKERFILE = BACKEND_DIR / "Dockerfile"

NO_RUNNER_MESSAGE = (
    "The entrypoint tests need a way to run docker-entrypoint.sh, and found neither. "
    "Either start Docker Desktop (the script then runs in a container), or put `sh` on PATH "
    "(for example the one that comes with Git for Windows)."
)
# Where the script, the fake `alembic` and the log folder sit inside the container.
_CONTAINER_SCRIPT = "/app/docker-entrypoint.sh"
_CONTAINER_BIN = "/fake-bin"
_CONTAINER_LOGS = "/logs"
_CONTAINER_PATH = "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin"
# A bind mount from Windows may not carry the executable bit, so the container copies the fake
# `alembic` folder, makes it executable, puts the copy first on PATH and then runs the script.
_CONTAINER_WORK = "/tmp/fb"


def launch_script(bin_dir: str = _CONTAINER_BIN, work_dir: str = _CONTAINER_WORK) -> str:
    """The `sh -c` text that makes the fake `alembic` executable on PATH, then runs "$@"."""
    bin_dir, work_dir = shlex.quote(bin_dir), shlex.quote(work_dir)
    return f'cp -r {bin_dir} {work_dir} && chmod +x {work_dir}/* && PATH={work_dir}:$PATH exec sh "$@"'
# `docker run` itself failed (daemon unreachable, image not pullable, bad flag), not the script.
_DOCKER_RUN_FAILED = 125


def backend_image() -> str:
    """The base image of the backend Dockerfile's last stage, tag included."""
    images = re.findall(r"^FROM\s+(\S+)", DOCKERFILE.read_text(), flags=re.MULTILINE)
    return images[-1]


def choose_runner(which: Callable[[str], str | None] = shutil.which) -> str:
    """"sh" when there is one, else "docker" when the docker CLI answers. Fails, never skips."""
    if which("sh"):
        return "sh"
    if which("docker"):
        probe = subprocess.run(
            ["docker", "info"], capture_output=True, text=True, timeout=60, check=False
        )
        if probe.returncode == 0:
            return "docker"
    pytest.fail(NO_RUNNER_MESSAGE, pytrace=False)


def docker_command(
    bin_dir: Path, log_dir: Path, script_args: list[str], env: dict[str, str], name: str
) -> list[str]:
    """`docker run` for the entrypoint script. No network; the container is removed on exit."""
    command = ["docker", "run", "--rm", "--name", name, "--network", "none"]
    if hasattr(os, "getuid"):
        command += ["--user", f"{os.getuid()}:{os.getgid()}"]  # log files stay the caller's
    for source, target, readonly in [
        (SCRIPT, _CONTAINER_SCRIPT, True),
        (bin_dir, _CONTAINER_BIN, True),
        (log_dir, _CONTAINER_LOGS, False),
    ]:
        mount = f"type=bind,source={source},target={target}" + (",readonly" if readonly else "")
        command += ["--mount", mount]
    command += ["-e", f"PATH={_CONTAINER_PATH}"]
    for key, value in env.items():
        command += ["-e", f"{key}={value}"]
    return [*command, backend_image(), "sh", "-c", launch_script(), "sh", _CONTAINER_SCRIPT, *script_args]


def run_script(
    runner: str, bin_dir: Path, log: Path, script_args: list[str], env: dict[str, str]
) -> Result:
    """Run the entrypoint script with `sh` or in a container; `env` is the script's environment."""
    if runner == "sh":
        host_env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "FAKE_LOG": str(log)}
        return run(["sh", str(SCRIPT), *script_args], {**host_env, **env})
    name = f"mcp-lab-entrypoint-test-{uuid.uuid4().hex[:12]}"
    container_env = {"FAKE_LOG": f"{_CONTAINER_LOGS}/{log.name}", **env}
    command = docker_command(bin_dir, log.parent, script_args, container_env, name)
    try:
        # The docker CLI keeps the real environment (DOCKER_HOST, Windows system variables).
        result = run(command, dict(os.environ), timeout=300)
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
        raise
    if result.returncode == _DOCKER_RUN_FAILED:
        pytest.fail(f"{NO_RUNNER_MESSAGE}\n\ndocker run failed:\n{result.output}", pytrace=False)
    return result


@pytest.fixture
def fake_bin(tmp_path):
    """A PATH folder whose `alembic` records its arguments and exits with $FAKE_ALEMBIC_EXIT."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    alembic = bin_dir / "alembic"
    # Bytes, so a Windows checkout cannot turn the LF endings into CRLF (a Linux `sh` would choke).
    alembic.write_bytes(
        b'#!/bin/sh\necho "alembic $*" >> "$FAKE_LOG"\nexit "${FAKE_ALEMBIC_EXIT:-0}"\n'
    )
    alembic.chmod(alembic.stat().st_mode | stat.S_IXUSR)
    return bin_dir


def _run(fake_bin, tmp_path, migrations_flag, alembic_exit="0"):
    env = {"FAKE_ALEMBIC_EXIT": alembic_exit}
    if migrations_flag is not None:
        env["RUN_MIGRATIONS_ON_START"] = migrations_flag
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    log = log_dir / "calls.log"
    result = run_script(choose_runner(), fake_bin, log, ["echo", "command-ran"], env)
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


def _which_with(*names):
    return lambda name: f"/found/{name}" if name in names else None


def test_runner_is_sh_when_sh_is_on_path():
    assert choose_runner(_which_with("sh", "docker")) == "sh"
    assert choose_runner(_which_with("sh")) == "sh"


def test_runner_is_docker_when_sh_is_missing_and_docker_works(monkeypatch):
    probes = []

    def fake_probe(args, **kwargs):
        probes.append(args)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_probe)

    assert choose_runner(_which_with("docker")) == "docker"
    assert probes == [["docker", "info"]]


def test_no_sh_and_no_docker_cli_fails_naming_both_options():
    with pytest.raises(pytest.fail.Exception) as failure:
        choose_runner(_which_with())

    assert "Docker Desktop" in str(failure.value)
    assert "`sh` on PATH" in str(failure.value)


def test_no_sh_and_a_docker_that_does_not_answer_fails_naming_both_options(monkeypatch):
    monkeypatch.setattr(
        subprocess, "run", lambda args, **kw: subprocess.CompletedProcess(args, 1, "", "no daemon")
    )

    with pytest.raises(pytest.fail.Exception) as failure:
        choose_runner(_which_with("docker"))

    assert "Docker Desktop" in str(failure.value)
    assert "`sh` on PATH" in str(failure.value)


def test_the_container_has_no_network_and_is_removed_on_exit(tmp_path):
    command = docker_command(tmp_path / "bin", tmp_path / "logs", ["echo"], {}, "name-one")

    assert command[:2] == ["docker", "run"]
    assert "--rm" in command
    assert command[command.index("--network") + 1] == "none"
    assert command[command.index("--name") + 1] == "name-one"


def test_the_container_uses_the_backend_dockerfiles_pinned_base_image(tmp_path):
    command = docker_command(tmp_path / "bin", tmp_path / "logs", ["echo"], {}, "n")
    from_lines = [ln for ln in DOCKERFILE.read_text().splitlines() if ln.startswith("FROM ")]
    final_image = from_lines[-1].split()[1]

    assert command.count(final_image) == 1
    assert command[command.index(final_image) + 1 :][:2] == ["sh", "-c"]
    assert re.fullmatch(r"[^:@\s]+:(?!latest$)[^:\s]+", final_image), final_image


def test_each_container_run_gets_its_own_name(fake_bin, tmp_path, monkeypatch):
    commands = []

    def fake_run(args, env, **kwargs):
        commands.append(args)
        return Result(0, "", 0.0)

    monkeypatch.setitem(globals(), "run", fake_run)
    for _ in range(2):
        run_script("docker", fake_bin, tmp_path / "calls.log", ["echo"], {})

    names = [c[c.index("--name") + 1] for c in commands]
    assert len(names) == 2 and names[0] != names[1]


def test_the_container_gets_the_script_the_fake_alembic_and_the_log_folder(tmp_path):
    command = docker_command(tmp_path / "bin", tmp_path / "logs", ["echo"], {}, "n")
    mounts = [command[i + 1] for i, arg in enumerate(command) if arg == "--mount"]

    assert f"type=bind,source={SCRIPT},target={_CONTAINER_SCRIPT},readonly" in mounts
    assert f"type=bind,source={tmp_path / 'bin'},target={_CONTAINER_BIN},readonly" in mounts
    assert f"type=bind,source={tmp_path / 'logs'},target={_CONTAINER_LOGS}" in mounts


def test_the_fake_alembic_has_lf_line_endings(fake_bin):
    assert b"\r" not in (fake_bin / "alembic").read_bytes()


def test_the_fake_alembic_runs_even_when_the_mount_does_not_make_it_executable(
    fake_bin, tmp_path
):
    """With a Windows (NTFS) bind mount the file may arrive as 0644. With `sh` this runs the
    container's launch step on the host; without `sh` it is the real container."""
    (fake_bin / "alembic").chmod(0o644)
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    log = log_dir / "calls.log"
    env = {"RUN_MIGRATIONS_ON_START": "true"}

    if choose_runner() == "sh":
        launch = launch_script(str(fake_bin), str(tmp_path / "fb"))
        host_env = {**os.environ, "FAKE_LOG": str(log), **env}
        result = run(["sh", "-c", launch, "sh", str(SCRIPT), "echo", "command-ran"], host_env)
    else:
        result = run_script("docker", fake_bin, log, ["echo", "command-ran"], env)

    assert result.returncode == 0, result.output
    assert log.read_text() == "alembic upgrade head\n"
    assert "command-ran" in result.output
