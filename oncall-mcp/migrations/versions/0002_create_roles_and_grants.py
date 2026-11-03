"""create roles and grants

Four LOGIN roles that keep the on-call system read-only on app data and limited to ops for writes:

- oncall_reader: SELECT on every app.feedback column except account_id, and nothing else in app.
- ops_writer: INSERT, UPDATE (and SELECT, which UPDATE ... WHERE needs) on the ops tables, INSERT
  only on ops.audit_log, nothing on app.
- ops_retention: SELECT and DELETE on ops.audit_log and ops.alert_inbox only. The evidence columns
  of the retention job (#64) are not covered yet; #64 is dropped for now.
- grafana_reader: SELECT on ops.deployments, incidents, incident_events and alerts only.

The passwords come from the environment (ONCALL_READER_PASSWORD, OPS_WRITER_PASSWORD,
OPS_RETENTION_PASSWORD, GRAFANA_READER_PASSWORD). They are hashed here (SCRAM-SHA-256), so no password
reaches a statement, a log line or an error message. Creating roles needs the CREATEROLE attribute.

The grants on app.* are made only if app.feedback exists in this database (the isolated mode keeps
the app in another database). Run this migration again after the app's tables are created or
replaced, or grant by hand: a column added to app.feedback later is not readable until then.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-02
"""

import logging
import os

from alembic import op
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

# Role name -> the environment variable that holds its password.
ROLE_PASSWORDS = {
    "oncall_reader": "ONCALL_READER_PASSWORD",
    "ops_writer": "OPS_WRITER_PASSWORD",
    "ops_retention": "OPS_RETENTION_PASSWORD",
    "grafana_reader": "GRAFANA_READER_PASSWORD",
}

WRITER_TABLES = ("deployments", "alerts", "alert_inbox", "incidents", "incident_events", "feedback_triage")
RETENTION_TABLES = ("audit_log", "alert_inbox")
GRAFANA_TABLES = ("deployments", "incidents", "incident_events", "alerts")

# SQLSTATE "dependent_objects_still_exist": the role is still used by another database.
DEPENDENT_OBJECTS = "2BP01"


def _passwords() -> dict[str, str]:
    """Read every password first, so a missing one stops the migration before any change."""
    passwords = {}
    for role, variable in ROLE_PASSWORDS.items():
        value = os.environ.get(variable)
        if not value:
            # The name of the variable, never a value.
            raise RuntimeError(f"{variable} is not set; it is the password of the {role} role.")
        passwords[role] = value
    return passwords


def _create_or_update_role(conn, role: str, password: str) -> None:
    """Create the LOGIN role (or, if it exists, only set its password)."""
    # A SCRAM verifier is computed here, so the statement below holds a hash, never the password.
    verifier = conn.connection.driver_connection.pgconn.encrypt_password(
        password.encode(), role.encode(), b"scram-sha-256"
    ).decode()
    literal = "'" + verifier.replace("'", "''") + "'"
    exists = conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = :role"), {"role": role}).first()
    verb = "ALTER ROLE" if exists else "CREATE ROLE"
    attributes = "LOGIN" if exists else "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE"
    try:
        # exec_driver_sql: text() would read the ":" of the verifier as a bind parameter.
        conn.exec_driver_sql(f"{verb} {role} {attributes} PASSWORD {literal}")
    except DBAPIError as exc:
        # Only the server's message: SQLAlchemy's own one would repeat the statement.
        raise RuntimeError(f"Could not set up the {role} role: {exc.orig}") from None


def _ops_tables(names) -> str:
    return ", ".join(f"ops.{name}" for name in names)


def upgrade() -> None:
    passwords = _passwords()
    conn = op.get_bind()
    database = conn.dialect.identifier_preparer.quote(conn.execute(text("SELECT current_database()")).scalar_one())

    for role, password in passwords.items():
        _create_or_update_role(conn, role, password)

    # Nothing is readable through PUBLIC, in ops or (if it is in this database) in app.
    op.execute("REVOKE ALL ON SCHEMA ops FROM PUBLIC")
    op.execute("REVOKE ALL ON ALL TABLES IN SCHEMA ops FROM PUBLIC")
    app_exists = conn.execute(text("SELECT to_regnamespace('app') IS NOT NULL")).scalar_one()
    if app_exists:
        op.execute("REVOKE ALL ON SCHEMA app FROM PUBLIC")
        op.execute("REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC")

    for role in ROLE_PASSWORDS:
        op.execute(f"GRANT CONNECT ON DATABASE {database} TO {role}")

    # oncall_reader: app.feedback without account_id (the only column that identifies the learner).
    # No grant on accounts, sessions, quiz_attempts or any other app table.
    feedback_exists = conn.execute(text("SELECT to_regclass('app.feedback') IS NOT NULL")).scalar_one()
    if feedback_exists:
        columns = conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns"
                " WHERE table_schema = 'app' AND table_name = 'feedback' AND column_name <> 'account_id'"
                " ORDER BY ordinal_position"
            )
        ).scalars().all()
        quoted = ", ".join(conn.dialect.identifier_preparer.quote(name) for name in columns)
        op.execute("GRANT USAGE ON SCHEMA app TO oncall_reader")
        op.execute(f"GRANT SELECT ({quoted}) ON app.feedback TO oncall_reader")

    # ops_writer: audit_log is append-only, so it only gets INSERT there.
    op.execute("GRANT USAGE ON SCHEMA ops TO ops_writer")
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON {_ops_tables(WRITER_TABLES)} TO ops_writer")
    op.execute("GRANT INSERT ON ops.audit_log TO ops_writer")
    has_sequences = conn.execute(
        text(
            "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
            " WHERE n.nspname = 'ops' AND c.relkind = 'S' LIMIT 1"
        )
    ).first()
    if has_sequences:
        op.execute("GRANT USAGE ON ALL SEQUENCES IN SCHEMA ops TO ops_writer")

    op.execute("GRANT USAGE ON SCHEMA ops TO ops_retention")
    op.execute(f"GRANT SELECT, DELETE ON {_ops_tables(RETENTION_TABLES)} TO ops_retention")

    op.execute("GRANT USAGE ON SCHEMA ops TO grafana_reader")
    op.execute(f"GRANT SELECT ON {_ops_tables(GRAFANA_TABLES)} TO grafana_reader")


def downgrade() -> None:
    conn = op.get_bind()
    for role in ROLE_PASSWORDS:
        if not conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = :role"), {"role": role}).first():
            continue
        # Removes every grant the role has in this database.
        op.execute(f"DROP OWNED BY {role}")
        try:
            with conn.begin_nested():
                op.execute(f"DROP ROLE {role}")
        except DBAPIError as exc:
            if getattr(exc.orig, "sqlstate", None) != DEPENDENT_OBJECTS:
                raise
            # Roles belong to the whole Postgres server; another database can still use this one.
            log.warning("Role %s is still used by another database, so it was not dropped.", role)
