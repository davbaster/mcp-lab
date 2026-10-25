"""create rate limit failures

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rate_limit_failures",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("key_hash", sa.LargeBinary(), nullable=False),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "scope IN ('login_username', 'login_ip')",
            name=op.f("ck_rate_limit_failures_scope_values"),
        ),
        sa.CheckConstraint(
            "octet_length(key_hash) = 32", name=op.f("ck_rate_limit_failures_key_hash_length")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_rate_limit_failures")),
        schema="app",
    )
    op.create_index(
        "ix_rate_limit_failures_scope_key_hash_failed_at",
        "rate_limit_failures",
        ["scope", "key_hash", "failed_at"],
        unique=False,
        schema="app",
    )
    op.create_index(
        "ix_rate_limit_failures_failed_at",
        "rate_limit_failures",
        ["failed_at"],
        unique=False,
        schema="app",
    )


def downgrade() -> None:
    # The indexes go with their table.
    op.drop_table("rate_limit_failures", schema="app")
