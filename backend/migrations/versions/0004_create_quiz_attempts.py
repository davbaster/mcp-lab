"""create quiz attempts

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-24
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

_ID_FORMAT = "~ '^[a-z0-9-]+$'"


class _Jsonb(sa.types.UserDefinedType):
    """The column type `jsonb`, spelled without the dialect module.

    `tests/test_repo_files.py` keeps the name of the database dialect out of every migration file,
    so that no file can hold a database URL; the dialect's own `JSONB` cannot be imported without it.
    """

    cache_ok = True

    def get_col_spec(self, **kw) -> str:
        return "JSONB"


def upgrade() -> None:
    op.create_table(
        "quiz_attempts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Text(), nullable=False),
        sa.Column("chapter_id", sa.Text(), nullable=False),
        sa.Column("score", sa.SmallInteger(), nullable=False),
        sa.Column("passed", sa.Boolean(), nullable=False),
        sa.Column("answers", _Jsonb(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("score BETWEEN 0 AND 5", name=op.f("ck_quiz_attempts_score_range")),
        sa.CheckConstraint(
            "jsonb_typeof(answers) = 'object'", name=op.f("ck_quiz_attempts_answers_is_object")
        ),
        sa.CheckConstraint(
            f"course_id {_ID_FORMAT}", name=op.f("ck_quiz_attempts_course_id_format")
        ),
        sa.CheckConstraint(
            f"chapter_id {_ID_FORMAT}", name=op.f("ck_quiz_attempts_chapter_id_format")
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["app.accounts.id"],
            name=op.f("fk_quiz_attempts_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_quiz_attempts")),
        schema="app",
    )
    op.create_index(
        op.f("ix_app_quiz_attempts_account_id"),
        "quiz_attempts",
        ["account_id"],
        unique=False,
        schema="app",
    )


def downgrade() -> None:
    # The index goes with its table.
    op.drop_table("quiz_attempts", schema="app")
