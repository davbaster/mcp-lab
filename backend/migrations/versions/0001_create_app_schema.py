"""create app schema

Revision ID: 0001
Revises:
Create Date: 2026-10-24
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS app")


def downgrade() -> None:
    # No CASCADE: if a table was left behind this fails loudly instead of deleting data.
    op.execute("DROP SCHEMA app")
