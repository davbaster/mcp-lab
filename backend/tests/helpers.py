import os
import subprocess
import sys
import time
from dataclasses import dataclass

from sqlalchemy.engine import URL

from tests.dbtools import BACKEND_DIR


@dataclass
class Result:
    returncode: int
    output: str
    seconds: float


def run(args: list[str], env: dict[str, str], cwd=BACKEND_DIR, timeout: float = 60) -> Result:
    """Run a command; stdout and stderr come back as one string."""
    start = time.monotonic()
    proc = subprocess.run(
        args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout, check=False
    )
    return Result(proc.returncode, proc.stdout + proc.stderr, time.monotonic() - start)


def alembic(*args: str, env: dict[str, str], cwd=BACKEND_DIR, timeout: float = 60) -> Result:
    return run([sys.executable, "-m", "alembic", *args], env, cwd=cwd, timeout=timeout)


def env_with_url(url: str | URL | None, base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(base if base is not None else os.environ)
    env.pop("DATABASE_URL", None)
    if url is not None:
        text = url if isinstance(url, str) else url.render_as_string(hide_password=False)
        env["DATABASE_URL"] = text
    return env


def url_text(url: URL) -> str:
    return url.render_as_string(hide_password=False)
