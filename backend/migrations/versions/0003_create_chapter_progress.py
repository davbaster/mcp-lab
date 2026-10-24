"""create chapter progress

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-24
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

_ID_FORMAT = "~ '^[a-z0-9-]+$'"


def upgrade() -> None:
    op.create_table(
        "chapter_progress",
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Text(), nullable=False),
        sa.Column("chapter_id", sa.Text(), nullable=False),
        sa.Column("best_score", sa.SmallInteger(), nullable=True),
        sa.Column("passed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_lesson_id", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "best_score BETWEEN 0 AND 5", name=op.f("ck_chapter_progress_best_score_range")
        ),
        sa.CheckConstraint(
            "passed_at IS NULL OR best_score IS NOT NULL",
            name=op.f("ck_chapter_progress_passed_has_score"),
        ),
        sa.CheckConstraint(
            f"course_id {_ID_FORMAT}", name=op.f("ck_chapter_progress_course_id_format")
        ),
        sa.CheckConstraint(
            f"chapter_id {_ID_FORMAT}", name=op.f("ck_chapter_progress_chapter_id_format")
        ),
        sa.CheckConstraint(
            f"last_lesson_id IS NULL OR last_lesson_id {_ID_FORMAT}",
            name=op.f("ck_chapter_progress_last_lesson_id_format"),
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["app.accounts.id"],
            name=op.f("fk_chapter_progress_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "account_id", "course_id", "chapter_id", name=op.f("pk_chapter_progress")
        ),
        schema="app",
    )


def downgrade() -> None:
    op.drop_table("chapter_progress", schema="app")
