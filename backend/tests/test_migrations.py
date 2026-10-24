"""Alembic, run through its CLI (`python -m alembic`, the same entry point as `uv run alembic`)."""

import logging
import shutil
import sys
from urllib.parse import quote

import pytest
from alembic import command
from alembic.util import CommandError
from sqlalchemy import Column, Integer, Table, text

from app.db import Base, create_db_engine, get_engine
from tests.conftest import PASSWORD_SENTINEL
from tests.dbtools import BACKEND_DIR, alembic_config, drop_database, ensure_database, with_database
from tests.helpers import alembic, env_with_url, run, url_text

HEAD = "0003"


@pytest.fixture
def env(database_url):
    return env_with_url(database_url)


def _versions(engine):
    with engine.connect() as conn:
        return conn.execute(text("SELECT version_num FROM public.alembic_version")).scalars().all()


def _schemas(engine):
    with engine.connect() as conn:
        return set(
            conn.execute(text("SELECT schema_name FROM information_schema.schemata")).scalars()
        )


@pytest.fixture
def empty_database(db_engine, restore_head):
    """The test database with no app schema and no version table."""
    with db_engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS app CASCADE"))
        conn.execute(text("DROP TABLE IF EXISTS public.alembic_version"))
    return db_engine


def test_upgrade_head_on_empty_database_creates_schema_and_version_row(empty_database, env):
    result = alembic("upgrade", "head", env=env)

    assert result.returncode == 0, result.output
    assert "app" in _schemas(empty_database)
    assert _versions(empty_database) == [HEAD]


def test_history_is_a_linear_chain_with_a_single_head(env):
    heads = alembic("heads", env=env)
    history = alembic("history", env=env)

    assert heads.returncode == 0 and history.returncode == 0, heads.output + history.output
    assert [line for line in heads.output.splitlines() if "(head)" in line] == [
        line for line in heads.output.splitlines() if line.startswith(HEAD)
    ]
    assert len([line for line in heads.output.splitlines() if line.startswith(HEAD)]) == 1
    assert len([line for line in history.output.splitlines() if "->" in line]) == 3


def test_upgrade_works_when_an_empty_app_schema_already_exists(empty_database, env):
    with empty_database.begin() as conn:
        conn.execute(text("CREATE SCHEMA app"))

    result = alembic("upgrade", "head", env=env)

    assert result.returncode == 0, result.output
    assert _versions(empty_database) == [HEAD]


def test_second_upgrade_is_a_no_op(empty_database, env):
    first = alembic("upgrade", "head", env=env)
    second = alembic("upgrade", "head", env=env)

    assert first.returncode == 0 and second.returncode == 0
    assert "Running upgrade" in first.output
    assert "Running upgrade" not in second.output
    assert _versions(empty_database) == [HEAD]


def test_downgrade_base_removes_schema_and_a_following_upgrade_restores_it(
    db_engine, env, restore_head
):
    down = alembic("downgrade", "base", env=env)

    assert down.returncode == 0, down.output
    assert "app" not in _schemas(db_engine)
    assert _versions(db_engine) == []

    up = alembic("upgrade", "head", env=env)

    assert up.returncode == 0, up.output
    assert "app" in _schemas(db_engine)
    assert _versions(db_engine) == [HEAD]


def test_downgrade_fails_loudly_when_a_table_was_left_in_the_schema(db_engine, env, restore_head):
    with db_engine.begin() as conn:
        conn.execute(text("CREATE TABLE app.left_behind (id int)"))

    result = alembic("downgrade", "base", env=env)

    assert result.returncode != 0
    assert "left_behind" in result.output
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM app.left_behind")).scalar_one() == 0
    assert _versions(db_engine) == [HEAD]


@pytest.mark.parametrize("value", [None, "mysql://u:p@h/db"], ids=["unset", "wrong-kind"])
def test_cli_with_bad_database_url_fails_with_a_message_and_no_traceback(value):
    result = alembic("upgrade", "head", env=env_with_url(value))

    assert result.returncode != 0
    assert "DATABASE_URL" in result.output
    assert "Traceback" not in result.output


def test_cli_with_closed_port_fails_fast_without_leaking_the_password():
    url = f"postgresql+psycopg://u:{PASSWORD_SENTINEL}@127.0.0.1:1/x"

    result = alembic("upgrade", "head", env=env_with_url(url), timeout=15)

    assert result.returncode != 0
    assert result.seconds < 15
    assert PASSWORD_SENTINEL not in result.output


def test_wrong_password_reports_authentication_failure_without_the_password(database_url):
    # Needs a role that really checks passwords, so create one.
    role = "mcp_lab_authprobe"
    engine = get_engine()
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(text(f"DROP ROLE IF EXISTS {role}"))
        conn.execute(text(f"CREATE ROLE {role} LOGIN PASSWORD 'right-password-1'"))
    try:
        url = database_url.set(username=role, password=PASSWORD_SENTINEL)

        result = alembic("upgrade", "head", env=env_with_url(url_text(url)))
    finally:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(f"DROP ROLE IF EXISTS {role}"))

    assert result.returncode != 0
    assert "authentication failed" in result.output
    assert PASSWORD_SENTINEL not in result.output


def test_percent_encoded_password_works_for_engine_and_alembic(database_url, db_engine):
    role, name, password = "mcp_lab_pctuser", "pct_password_test", "p@ss%w"
    url = database_url.set(username=role, password=password, database=name)
    admin_url = with_database(database_url, "postgres")
    owner_url = url.set(username=database_url.username, password=database_url.password)
    drop_database(owner_url)
    admin = create_db_engine(admin_url, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(text(f"DROP ROLE IF EXISTS {role}"))
            # Driver SQL, where "%%" is the driver's spelling of a literal "%".
            conn.exec_driver_sql(
                f"CREATE ROLE {role} LOGIN PASSWORD '{password.replace('%', '%%')}'"
            )
        ensure_database(owner_url)
        with admin.connect() as conn:
            conn.execute(text(f'ALTER DATABASE "{name}" OWNER TO {role}'))
        assert quote(password, safe="") == "p%40ss%25w"

        result = alembic("upgrade", "head", env=env_with_url(url_text(url)))

        assert result.returncode == 0, result.output
        engine = create_db_engine(url)
        try:
            with engine.connect() as conn:
                assert conn.execute(text("SELECT current_user")).scalar_one() == role
            assert _versions(engine) == [HEAD]
        finally:
            engine.dispose()
    finally:
        drop_database(owner_url)
        with admin.connect() as conn:
            conn.execute(text(f"DROP ROLE IF EXISTS {role}"))
        admin.dispose()


def test_failing_migration_leaves_no_table_and_no_revision(tmp_path, db_engine, env, restore_head):
    folder = tmp_path / "scripts"
    shutil.copytree(
        BACKEND_DIR / "migrations",
        folder / "migrations",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    shutil.copy(BACKEND_DIR / "alembic.ini", folder / "alembic.ini")
    (folder / "migrations" / "versions" / "0004_broken.py").write_text(
        "from alembic import op\n\n"
        'revision = "0004"\ndown_revision = "0003"\nbranch_labels = None\ndepends_on = None\n\n\n'
        "def upgrade():\n"
        '    op.execute("CREATE TABLE app.half_made (id int)")\n'
        '    raise RuntimeError("deliberate failure")\n\n\n'
        "def downgrade():\n    pass\n"
    )
    env = {**env, "PYTHONPATH": str(BACKEND_DIR)}

    result = run(
        [sys.executable, "-m", "alembic", "-c", str(folder / "alembic.ini"), "upgrade", "head"],
        env,
        cwd=folder,
    )

    assert result.returncode != 0
    assert "deliberate failure" in result.output
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT to_regclass('app.half_made')")).scalar_one() is None
    assert _versions(db_engine) == [HEAD]


def test_alembic_check_passes_on_a_migrated_database(env):
    result = alembic("check", env=env)

    assert result.returncode == 0, result.output


def test_alembic_check_fails_when_the_models_have_an_unmigrated_table(database_url):
    # In-process, because the change is to this process's Base.metadata.
    table = Table("not_migrated", Base.metadata, Column("id", Integer, primary_key=True))
    try:
        with pytest.raises(CommandError, match="New upgrade operations detected"):
            command.check(alembic_config())
    finally:
        Base.metadata.remove(table)

    command.check(alembic_config())  # metadata restored: passes again


def test_alembic_check_ignores_other_schemas(db_engine, env):
    with db_engine.begin() as conn:
        conn.execute(text("CREATE SCHEMA ops"))
        conn.execute(text("CREATE TABLE ops.audit_log (id int)"))
    try:
        result = alembic("check", env=env)

        assert result.returncode == 0, result.output
        assert "audit_log" not in result.output
    finally:
        with db_engine.begin() as conn:
            conn.execute(text("DROP SCHEMA ops CASCADE"))


# These two tests depend on definition order (pytest runs a file top to bottom): the second one
# checks that logging still works after the first one ran Alembic in the same process.
def test_a_running_alembic_in_process_keeps_existing_loggers_enabled(database_url):
    existing = logging.getLogger("app.existing_before_alembic")

    command.upgrade(alembic_config(), "head")

    assert existing.disabled is False
    assert logging.getLogger("alembic.runtime.migration").disabled is False


def test_b_caplog_still_captures_after_alembic_ran_in_process(caplog):
    logging.getLogger("app.later").warning("still captured")

    assert "still captured" in caplog.text
