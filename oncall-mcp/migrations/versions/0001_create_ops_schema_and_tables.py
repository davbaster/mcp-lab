"""create ops schema and tables

Revision ID: 0001
Revises:
Create Date: 2026-11-02
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

# Tables in creation order; the downgrade drops them in reverse.
TABLES = (
    "deployments",
    "alerts",
    "alert_inbox",
    "incidents",
    "incident_events",
    "audit_log",
    "feedback_triage",
)

_NEW_ID = sa.text("gen_random_uuid()")
_NOW = sa.text("now()")
_EMPTY_OBJECT = sa.text("'{}'::jsonb")


def _id() -> sa.Column:
    return sa.Column("id", sa.Uuid(), server_default=_NEW_ID, nullable=False)


def _timestamp(name: str, *, default_now: bool = False) -> sa.Column:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=_NOW if default_now else None,
        nullable=not default_now,
    )


def upgrade() -> None:
    # env.py created the schema already (the version table lives in it); this keeps the revision
    # runnable on its own.
    op.execute("CREATE SCHEMA IF NOT EXISTS ops")

    op.create_table(
        "deployments",
        _id(),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("environment", sa.Text(), nullable=False),
        sa.Column("app_version", sa.Text(), nullable=False),
        sa.Column("commit_sha", sa.Text(), nullable=False),
        sa.Column("courses", JSONB(), server_default=_EMPTY_OBJECT, nullable=False),
        _timestamp("started_at", default_now=True),
        _timestamp("ended_at"),
        sa.Column("deployed_by", sa.Text(), nullable=False),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "outcome IN ('succeeded', 'failed_migration', 'failed_health', 'aborted')",
            name=op.f("ck_deployments_outcome_values"),
        ),
        sa.CheckConstraint(
            "jsonb_typeof(courses) = 'object'", name=op.f("ck_deployments_courses_is_object")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_deployments")),
        schema="ops",
    )

    op.create_table(
        "alerts",
        _id(),
        sa.Column("deployment", sa.Text(), nullable=False),
        sa.Column("fingerprint", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=False),
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column("course_id", sa.Text(), nullable=True),
        sa.Column("labels", JSONB(), server_default=_EMPTY_OBJECT, nullable=False),
        sa.Column("annotations", JSONB(), server_default=_EMPTY_OBJECT, nullable=False),
        _timestamp("first_seen", default_now=True),
        _timestamp("last_seen", default_now=True),
        _timestamp("resolved_at"),
        sa.CheckConstraint("status IN ('firing', 'resolved')", name=op.f("ck_alerts_status_values")),
        sa.CheckConstraint(
            "severity IN ('critical', 'warning', 'info')", name=op.f("ck_alerts_severity_values")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_alerts")),
        sa.UniqueConstraint("deployment", "fingerprint", name=op.f("uq_alerts_deployment_fingerprint")),
        schema="ops",
    )

    op.create_table(
        "alert_inbox",
        _id(),
        _timestamp("received_at", default_now=True),
        sa.Column("payload", JSONB(), nullable=False),
        _timestamp("processed_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_alert_inbox")),
        schema="ops",
    )
    op.create_index(
        op.f("ix_ops_alert_inbox_received_at"),
        "alert_inbox",
        ["received_at"],
        unique=False,
        schema="ops",
    )

    op.create_table(
        "incidents",
        _id(),
        sa.Column("deployment", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'open'"), nullable=False),
        _timestamp("opened_at", default_now=True),
        _timestamp("resolved_at"),
        sa.Column("group_key", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status IN ('open', 'resolved')", name=op.f("ck_incidents_status_values")
        ),
        sa.CheckConstraint(
            "resolved_at IS NULL OR status = 'resolved'",
            name=op.f("ck_incidents_resolved_at_needs_resolved"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_incidents")),
        schema="ops",
    )

    op.create_table(
        "incident_events",
        _id(),
        sa.Column("incident_id", sa.Uuid(), nullable=False),
        _timestamp("at", default_now=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("author", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "kind IN ('alert_fired', 'alert_resolved', 'note_added', 'issue_opened', 'pr_opened')",
            name=op.f("ck_incident_events_kind_values"),
        ),
        sa.ForeignKeyConstraint(
            ["incident_id"],
            ["ops.incidents.id"],
            name=op.f("fk_incident_events_incident_id_incidents"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_incident_events")),
        schema="ops",
    )
    op.create_index(
        "ix_incident_events_incident_id_at",
        "incident_events",
        ["incident_id", "at"],
        unique=False,
        schema="ops",
    )

    op.create_table(
        "audit_log",
        _id(),
        _timestamp("at", default_now=True),
        sa.Column("caller", sa.Text(), nullable=False),
        sa.Column("tool_or_resource", sa.Text(), nullable=False),
        sa.Column("arguments", JSONB(), server_default=_EMPTY_OBJECT, nullable=False),
        sa.Column("result_size", sa.Integer(), nullable=True),
        sa.Column("outcome", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "outcome IN ('ok', 'error', 'denied')", name=op.f("ck_audit_log_outcome_values")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_log")),
        schema="ops",
    )
    op.create_index(op.f("ix_ops_audit_log_at"), "audit_log", ["at"], unique=False, schema="ops")

    op.create_table(
        "feedback_triage",
        _id(),
        # The id of an app.feedback row. No foreign key: app.feedback can be in another database.
        sa.Column("feedback_id", sa.Uuid(), nullable=False),
        sa.Column("deployment", sa.Text(), nullable=False),
        sa.Column("decision", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("issue_url", sa.Text(), nullable=True),
        sa.Column("decided_by", sa.Text(), nullable=False),
        _timestamp("decided_at", default_now=True),
        sa.Column("reopened_by", sa.Text(), nullable=True),
        _timestamp("reopened_at"),
        sa.CheckConstraint(
            "decision IN ('valid', 'duplicate', 'invalid', 'needs_human')",
            name=op.f("ck_feedback_triage_decision_values"),
        ),
        sa.CheckConstraint(
            "(reopened_by IS NULL) = (reopened_at IS NULL)",
            name=op.f("ck_feedback_triage_reopened_by_and_at_together"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_feedback_triage")),
        schema="ops",
    )
    # One active (not reopened) decision per feedback item; a reopened row stays as history.
    op.create_index(
        "uq_feedback_triage_active_feedback_id",
        "feedback_triage",
        ["feedback_id"],
        unique=True,
        schema="ops",
        postgresql_where=sa.text("reopened_at IS NULL"),
    )


def downgrade() -> None:
    # The indexes go with their tables. No CASCADE: if a foreign key or a view outside this
    # history points at a table, this fails loudly instead of deleting it.
    for table in reversed(TABLES):
        op.drop_table(table, schema="ops")
    # The ops schema stays: it holds the version table (ops.ops_alembic_version), which Alembic
    # updates after this step, so DROP SCHEMA would fail. env.py re-creates it if it is missing.
