"""The ops schema: everything the on-call system stores, for every deployment.

`deployment` is the deployment's name as text (the backend's `DEPLOYMENT`), never a foreign key:
alerts and triage decisions can arrive for a deployment that has no `deployments` row yet.
`feedback_triage.feedback_id` has no foreign key either, because `app.feedback` can live in
another database (isolated mode). `ops_writer` writes these tables, and `audit_log` is
append-only (migration 0002).
"""

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oncall_mcp.db import Base

_NEW_ID = sa.text("gen_random_uuid()")
_NOW = sa.text("now()")
_EMPTY_OBJECT = sa.text("'{}'::jsonb")


class Deployment(Base):
    """One deploy of one deployment (#35). `courses` maps each course ID to its content SHA."""

    __tablename__ = "deployments"
    __table_args__ = (
        CheckConstraint(
            "outcome IN ('succeeded', 'failed_migration', 'failed_health', 'aborted')",
            name="outcome_values",
        ),
        CheckConstraint("jsonb_typeof(courses) = 'object'", name="courses_is_object"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=_NEW_ID)
    name: Mapped[str] = mapped_column(Text)
    environment: Mapped[str] = mapped_column(Text)
    app_version: Mapped[str] = mapped_column(Text)
    commit_sha: Mapped[str] = mapped_column(Text)
    courses: Mapped[dict[str, str]] = mapped_column(JSONB, server_default=_EMPTY_OBJECT)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_NOW)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deployed_by: Mapped[str] = mapped_column(Text)
    # NULL while the deploy is running.
    outcome: Mapped[str | None] = mapped_column(Text)


class Alert(Base):
    """One Grafana alert instance: a row per deployment and `fingerprint`, updated as it repeats."""

    __tablename__ = "alerts"
    __table_args__ = (
        UniqueConstraint("deployment", "fingerprint", name="uq_alerts_deployment_fingerprint"),
        CheckConstraint("status IN ('firing', 'resolved')", name="status_values"),
        CheckConstraint("severity IN ('critical', 'warning', 'info')", name="severity_values"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=_NEW_ID)
    deployment: Mapped[str] = mapped_column(Text)
    fingerprint: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    severity: Mapped[str] = mapped_column(Text)
    service: Mapped[str] = mapped_column(Text)
    course_id: Mapped[str | None] = mapped_column(Text)
    labels: Mapped[dict[str, str]] = mapped_column(JSONB, server_default=_EMPTY_OBJECT)
    annotations: Mapped[dict[str, str]] = mapped_column(JSONB, server_default=_EMPTY_OBJECT)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_NOW)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_NOW)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AlertInbox(Base):
    """Raw webhook payloads, already redacted, stored before they are processed (#47)."""

    __tablename__ = "alert_inbox"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=_NEW_ID)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=_NOW, index=True
    )
    payload: Mapped[dict] = mapped_column(JSONB)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Incident(Base):
    """A group of alerts worked as one. `group_key` is Grafana's `groupKey`."""

    __tablename__ = "incidents"
    __table_args__ = (
        CheckConstraint("status IN ('open', 'resolved')", name="status_values"),
        CheckConstraint(
            "resolved_at IS NULL OR status = 'resolved'", name="resolved_at_needs_resolved"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=_NEW_ID)
    deployment: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=sa.text("'open'"))
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_NOW)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    group_key: Mapped[str | None] = mapped_column(Text)


class IncidentEvent(Base):
    """One entry of an incident's timeline. `text` is redacted before it is stored."""

    __tablename__ = "incident_events"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('alert_fired', 'alert_resolved', 'note_added', 'issue_opened', 'pr_opened')",
            name="kind_values",
        ),
        Index("ix_incident_events_incident_id_at", "incident_id", "at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=_NEW_ID)
    incident_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("ops.incidents.id"))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_NOW)
    kind: Mapped[str] = mapped_column(Text)
    author: Mapped[str] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)


class AuditLog(Base):
    """Append-only record of every tool and resource call. `arguments` is redacted."""

    __tablename__ = "audit_log"
    __table_args__ = (
        CheckConstraint("outcome IN ('ok', 'error', 'denied')", name="outcome_values"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=_NEW_ID)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_NOW, index=True)
    caller: Mapped[str] = mapped_column(Text)
    tool_or_resource: Mapped[str] = mapped_column(Text)
    arguments: Mapped[dict] = mapped_column(JSONB, server_default=_EMPTY_OBJECT)
    result_size: Mapped[int | None] = mapped_column(Integer)
    outcome: Mapped[str] = mapped_column(Text)


class FeedbackTriage(Base):
    """A triage decision about one feedback item (#49). Reopening keeps the old row.

    A decision is active while `reopened_at` is NULL, and there is at most one active row per
    feedback item. `feedback_id` is the `id` of an `app.feedback` row, with no foreign key.
    """

    __tablename__ = "feedback_triage"
    __table_args__ = (
        CheckConstraint(
            "decision IN ('valid', 'duplicate', 'invalid', 'needs_human')", name="decision_values"
        ),
        CheckConstraint(
            "(reopened_by IS NULL) = (reopened_at IS NULL)", name="reopened_by_and_at_together"
        ),
        Index(
            "uq_feedback_triage_active_feedback_id",
            "feedback_id",
            unique=True,
            postgresql_where=sa.text("reopened_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, server_default=_NEW_ID)
    feedback_id: Mapped[uuid.UUID]
    deployment: Mapped[str] = mapped_column(Text)
    decision: Mapped[str] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text)
    issue_url: Mapped[str | None] = mapped_column(Text)
    decided_by: Mapped[str] = mapped_column(Text)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_NOW)
    reopened_by: Mapped[str | None] = mapped_column(Text)
    reopened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
