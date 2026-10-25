"""create feedback

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

_ID_FORMAT = "~ '^[a-z0-9-]+$'"


class _Jsonb(sa.types.UserDefinedType):
    """The column type `jsonb`, spelled without the dialect module (see migration 0004)."""

    cache_ok = True

    def get_col_spec(self, **kw) -> str:
        return "JSONB"


def _id_check(column: str) -> sa.CheckConstraint:
    return sa.CheckConstraint(
        f"{column} IS NULL OR {column} {_ID_FORMAT}", name=op.f(f"ck_feedback_{column}_format")
    )


def upgrade() -> None:
    op.create_table(
        "feedback",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Text(), nullable=True),
        sa.Column("chapter_id", sa.Text(), nullable=True),
        sa.Column("lesson_id", sa.Text(), nullable=True),
        sa.Column("question_id", sa.Text(), nullable=True),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column(
            "about_quiz_question", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("page_path", sa.Text(), nullable=False),
        sa.Column("app_version", sa.Text(), nullable=False),
        sa.Column("user_agent", sa.Text(), nullable=False),
        sa.Column("viewport_width", sa.Integer(), nullable=False),
        sa.Column("viewport_height", sa.Integer(), nullable=False),
        sa.Column("client_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("console_errors", _Jsonb(), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'new'"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "category IN ('bug', 'content_error', 'confusing_explanation', 'suggestion')",
            name=op.f("ck_feedback_category_values"),
        ),
        sa.CheckConstraint("status = 'new'", name=op.f("ck_feedback_status_is_new")),
        _id_check("course_id"),
        _id_check("chapter_id"),
        _id_check("lesson_id"),
        _id_check("question_id"),
        sa.CheckConstraint(
            "course_id IS NOT NULL OR (chapter_id IS NULL AND lesson_id IS NULL"
            " AND question_id IS NULL)",
            name=op.f("ck_feedback_ids_need_course"),
        ),
        sa.CheckConstraint(
            "char_length(message) BETWEEN 10 AND 2000", name=op.f("ck_feedback_message_length")
        ),
        sa.CheckConstraint(
            "jsonb_typeof(console_errors) = 'array'",
            name=op.f("ck_feedback_console_errors_is_array"),
        ),
        # A CASE, because `jsonb_array_length` raises on a value that is not an array, and a
        # CHECK may run its parts in any order.
        sa.CheckConstraint(
            "CASE WHEN jsonb_typeof(console_errors) = 'array'"
            " THEN jsonb_array_length(console_errors) <= 10 ELSE false END",
            name=op.f("ck_feedback_console_errors_max_items"),
        ),
        sa.CheckConstraint(
            "NOT about_quiz_question OR question_id IS NOT NULL",
            name=op.f("ck_feedback_quiz_flag_needs_question_id"),
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["app.accounts.id"],
            name=op.f("fk_feedback_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_feedback")),
        schema="app",
    )
    op.create_index(
        "ix_feedback_account_id_created_at",
        "feedback",
        ["account_id", "created_at"],
        unique=False,
        schema="app",
    )


def downgrade() -> None:
    # The index goes with its table.
    op.drop_table("feedback", schema="app")
