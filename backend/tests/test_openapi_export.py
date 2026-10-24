"""The export script (scripts/export_openapi.py) and the committed openapi.yaml."""

import importlib.util
import sys

import pytest
import yaml

from app.main import app
from tests.conftest import PASSWORD_SENTINEL
from tests.dbtools import BACKEND_DIR
from tests.helpers import env_with_url, run

ROOT = BACKEND_DIR.parent
SCRIPT = BACKEND_DIR / "scripts" / "export_openapi.py"
COMMITTED = ROOT / "openapi.yaml"
OUT_OF_DATE = "openapi.yaml is out of date, run: uv run python scripts/export_openapi.py"


@pytest.fixture(scope="module")
def script():
    spec = importlib.util.spec_from_file_location("export_openapi", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def export(output, env, *extra, cwd=BACKEND_DIR):
    return run([sys.executable, str(SCRIPT), "--output", str(output), *extra], env, cwd=cwd)


def test_export_writes_the_output_file_and_prints_one_line(tmp_path, clean_env):
    out = tmp_path / "spec.yaml"

    result = export(out, clean_env)

    assert result.returncode == 0, result.output
    assert out.is_file()
    assert len(result.output.strip().splitlines()) == 1
    assert "Wrote" in result.output


def test_export_without_output_writes_the_repo_root_file_from_any_folder(tmp_path, clean_env):
    before = COMMITTED.read_bytes()

    result = run([sys.executable, str(SCRIPT)], clean_env, cwd=tmp_path)

    assert result.returncode == 0, result.output
    assert result.output.strip() == "Wrote openapi.yaml"
    assert COMMITTED.read_bytes() == before  # a fresh export equals the committed file


def test_written_yaml_round_trips_to_the_app_document(tmp_path, clean_env):
    out = tmp_path / "spec.yaml"
    export(out, clean_env)

    assert yaml.safe_load(out.read_bytes()) == app.openapi()


@pytest.mark.parametrize(
    "tricky", ["no", "on", "yes", "null", "2024-01-01", "1e3", "0.10", "~", ""]
)
def test_render_round_trips_strings_that_yaml_would_read_as_other_types(script, tricky):
    document = {"info": {"title": tricky}, "list": [tricky], tricky or "empty": 1}

    assert yaml.safe_load(script.render(document)) == document


def test_render_uses_no_anchors_for_shared_objects(script):
    shared = {"type": "string"}

    text = script.render({"a": shared, "b": shared}).decode()

    assert "&" not in text and "*" not in text


def test_two_runs_give_identical_bytes(tmp_path, clean_env):
    first, second = tmp_path / "a.yaml", tmp_path / "b.yaml"
    export(first, clean_env)
    export(second, clean_env)

    assert first.read_bytes() == second.read_bytes()


def test_output_is_lf_only_utf8_and_ends_with_a_newline(tmp_path, clean_env):
    out = tmp_path / "spec.yaml"
    export(out, clean_env)
    data = out.read_bytes()

    assert b"\r" not in data
    assert data.endswith(b"\n")
    data.decode("utf-8")


def test_committed_file_is_lf_only():
    assert b"\r" not in COMMITTED.read_bytes()


def test_gitattributes_pins_openapi_yaml_to_lf():
    lines = (ROOT / ".gitattributes").read_text().splitlines()

    assert "openapi.yaml text eol=lf" in lines


def test_output_does_not_depend_on_the_environment(tmp_path, clean_env):
    unset, with_url = tmp_path / "unset.yaml", tmp_path / "with-url.yaml"
    export(unset, clean_env)
    url = f"postgresql+psycopg://user:{PASSWORD_SENTINEL}@127.0.0.1:1/db"
    export(with_url, env_with_url(url))

    assert unset.read_bytes() == with_url.read_bytes()
    assert PASSWORD_SENTINEL.encode() not in unset.read_bytes()
    assert PASSWORD_SENTINEL.encode() not in with_url.read_bytes()


def test_output_holds_no_absolute_path_or_username(tmp_path, clean_env):
    out = tmp_path / "spec.yaml"
    export(out, clean_env)
    text = out.read_text()

    assert str(ROOT) not in text
    assert str(tmp_path) not in text
    assert "/home/" not in text and "C:\\" not in text


def test_export_needs_no_database_and_opens_no_connection(tmp_path, clean_env):
    out = tmp_path / "spec.yaml"
    code = (
        "import runpy, sys\n"
        "import psycopg\n"
        "from sqlalchemy.engine import Engine\n"
        "def refuse(*a, **k):\n"
        "    raise AssertionError('the export must not open a database connection')\n"
        "psycopg.connect = refuse\n"
        "Engine.connect = refuse\n"
        "Engine.begin = refuse\n"
        f"sys.argv = ['export_openapi.py', '--output', {str(out)!r}]\n"
        f"runpy.run_path({str(SCRIPT)!r}, run_name='__main__')\n"
    )

    result = run([sys.executable, "-c", code], clean_env)

    assert result.returncode == 0, result.output
    assert out.is_file()


def test_app_does_not_import_yaml_or_the_validator(clean_env):
    code = (
        "import sys, app.main\n"
        "bad = [m for m in ('yaml', 'openapi_spec_validator') if m in sys.modules]\n"
        "assert not bad, bad\n"
    )

    result = run([sys.executable, "-c", code], clean_env)

    assert result.returncode == 0, result.output


def test_invalid_document_exits_non_zero_and_keeps_the_existing_file(
    script, tmp_path, monkeypatch, capsys
):
    out = tmp_path / "spec.yaml"
    out.write_bytes(b"existing: content\n")
    monkeypatch.setattr(script, "get_document", lambda: {"openapi": "3.1.0", "paths": 5})

    code = script.main(["--output", str(out)])

    assert code != 0
    assert capsys.readouterr().err.strip() != ""
    assert out.read_bytes() == b"existing: content\n"


def test_invalid_document_makes_check_fail_too(script, tmp_path, monkeypatch):
    out = tmp_path / "spec.yaml"
    monkeypatch.setattr(script, "get_document", lambda: {"openapi": "3.1.0", "paths": 5})

    assert script.main(["--check", "--output", str(out)]) != 0


def test_check_passes_when_the_file_matches_and_does_not_write(script, tmp_path, capsys):
    out = tmp_path / "spec.yaml"
    script.main(["--output", str(out)])
    modified = out.stat().st_mtime_ns
    capsys.readouterr()

    code = script.main(["--check", "--output", str(out)])

    assert code == 0
    assert out.stat().st_mtime_ns == modified


def test_check_fails_with_the_message_when_the_file_differs(tmp_path, clean_env):
    out = tmp_path / "spec.yaml"
    export(out, clean_env)
    out.write_bytes(out.read_bytes() + b"# edited\n")
    edited = out.read_bytes()

    result = export(out, clean_env, "--check")

    assert result.returncode != 0
    assert OUT_OF_DATE in result.output
    assert out.read_bytes() == edited  # --check never writes


def test_check_fails_when_the_file_is_missing(tmp_path, clean_env):
    out = tmp_path / "missing.yaml"

    result = export(out, clean_env, "--check")

    assert result.returncode != 0
    assert OUT_OF_DATE in result.output
    assert not out.exists()


def test_check_counts_a_crlf_file_as_a_difference(tmp_path, clean_env):
    out = tmp_path / "spec.yaml"
    export(out, clean_env)
    out.write_bytes(out.read_bytes().replace(b"\n", b"\r\n"))

    result = export(out, clean_env, "--check")

    assert result.returncode != 0
    assert OUT_OF_DATE in result.output


def test_committed_openapi_yaml_equals_a_fresh_export(script):
    assert COMMITTED.read_bytes() == script.build()


def test_committed_spec_is_the_same_data_the_app_serves():
    assert yaml.safe_load(COMMITTED.read_bytes()) == app.openapi()


def test_ci_checks_openapi_after_ruff_and_before_alembic_without_a_database_url():
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    backend = ci.split("  backend:\n", 1)[1].split("\n  frontend:\n", 1)[0]
    step = (
        "      - name: Check openapi.yaml is up to date\n"
        "        run: make check-openapi\n"
    )

    assert step in backend  # no `env:` follows it, so no DATABASE_URL and no secrets
    assert not backend.split(step, 1)[1].startswith("        env:")
    assert (
        backend.index("- run: make install-backend")
        < backend.index("- run: make lint-backend")
        < backend.index(step)
        < backend.index("- run: make migrate-backend")
    )
    assert ci.count("name: backend") == 1 and ci.count("name: frontend") == 1
