"""create accounts and sessions

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-24
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "accounts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column("username_normalized", sa.Text(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "username_normalized = lower(username)",
            name=op.f("ck_accounts_username_normalized_lower"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_accounts")),
        sa.UniqueConstraint("username_normalized", name=op.f("uq_accounts_username_normalized")),
        schema="app",
    )
    op.create_table(
        "sessions",
        sa.Column("token_hash", sa.LargeBinary(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "expires_at > created_at", name=op.f("ck_sessions_expires_after_created")
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["app.accounts.id"],
            name=op.f("fk_sessions_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("token_hash", name=op.f("pk_sessions")),
        schema="app",
    )
    op.create_index(
        op.f("ix_app_sessions_account_id"), "sessions", ["account_id"], unique=False, schema="app"
    )
    op.create_index(
        op.f("ix_app_sessions_expires_at"), "sessions", ["expires_at"], unique=False, schema="app"
    )


def downgrade() -> None:
    # Indexes go with their table. Sessions first: they reference accounts.
    op.drop_table("sessions", schema="app")
    op.drop_table("accounts", schema="app")
