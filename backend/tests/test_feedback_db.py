"""The feedback table and migration 0005 (#24)."""

import json
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.helpers import alembic, env_with_url
from tests.test_accounts_db import add_account

NOW = datetime(2030, 1, 1, tzinfo=UTC)
DEFAULTS = {
    "course_id": "mcp-server",
    "chapter_id": "01-intro",
    "lesson_id": "what-is-mcp",
    "question_id": None,
    "category": "bug",
    "message": "A message of ten or more",
    "about_quiz_question": False,
    "page_path": "/courses/mcp-server",
    "app_version": "dev",
    "user_agent": "UA",
    "viewport_width": 360,
    "viewport_height": 640,
    "client_time": NOW,
    "console_errors": "[]",
    "status": "new",
    "created_at": NOW,
}


def add_feedback(conn, account_id, **overrides):
    values = {**DEFAULTS, **overrides}
    columns = ["id", "account_id", *values]
    placeholders = [
        "CAST(:console_errors AS jsonb)" if c == "console_errors" else f":{c}" for c in columns
    ]
    conn.execute(
        text(f"INSERT INTO app.feedback ({', '.join(columns)}) VALUES ({', '.join(placeholders)})"),
        {"id": uuid.uuid4(), "account_id": account_id, **values},
    )


def constraint_of(excinfo) -> str:
    return excinfo.value.orig.diag.constraint_name


def count(db) -> int:
    with db.connect() as conn:
        return conn.execute(text("SELECT count(*) FROM app.feedback")).scalar_one()


def refused(db, **overrides) -> str:
    """The name of the constraint that refuses a row with these values."""
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_feedback(conn, add_account(conn, "Ana1"), **overrides)
    assert count(db) == 0
    return constraint_of(excinfo)


def test_the_table_has_exactly_these_columns_with_these_types(db):
    with db.connect() as conn:
        found = conn.execute(
            text(
                "SELECT column_name, data_type, is_nullable, column_default"
                " FROM information_schema.columns"
                " WHERE table_schema = 'app' AND table_name = 'feedback'"
                " ORDER BY ordinal_position"
            )
        ).all()

    assert [tuple(r) for r in found] == [
        ("id", "uuid", "NO", None),
        ("account_id", "uuid", "NO", None),
        ("course_id", "text", "YES", None),
        ("chapter_id", "text", "YES", None),
        ("lesson_id", "text", "YES", None),
        ("question_id", "text", "YES", None),
        ("category", "text", "NO", None),
        ("message", "text", "NO", None),
        ("about_quiz_question", "boolean", "NO", "false"),
        ("page_path", "text", "NO", None),
        ("app_version", "text", "NO", None),
        ("user_agent", "text", "NO", None),
        ("viewport_width", "integer", "NO", None),
        ("viewport_height", "integer", "NO", None),
        ("client_time", "timestamp with time zone", "NO", None),
        ("console_errors", "jsonb", "NO", None),
        ("status", "text", "NO", "'new'::text"),
        ("created_at", "timestamp with time zone", "NO", None),
    ]


def test_account_id_is_the_only_column_that_could_identify_the_learner(db):
    with db.connect() as conn:
        names = conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns"
                " WHERE table_schema = 'app' AND table_name = 'feedback'"
            )
        ).scalars()
        identifying = [
            n for n in names if any(w in n for w in ("account", "user", "ip", "cookie", "session"))
        ]

    # "user_agent" is the browser's text, not a person; "ip" would match "viewport_*" otherwise.
    assert sorted(identifying) == ["account_id", "user_agent"]


def test_the_primary_key_is_the_id(db):
    with db.connect() as conn:
        key = (
            conn.execute(
                text(
                    "SELECT a.attname FROM pg_index i"
                    " JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)"
                    " WHERE i.indrelid = 'app.feedback'::regclass AND i.indisprimary"
                )
            )
            .scalars()
            .all()
        )

    assert key == ["id"]


def test_there_is_an_index_on_account_id_and_created_at(db):
    with db.connect() as conn:
        definitions = (
            conn.execute(
                text(
                    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'app'"
                    " AND tablename = 'feedback' AND indexname = 'ix_feedback_account_id_created_at'"
                )
            )
            .scalars()
            .all()
        )

    assert len(definitions) == 1
    assert "(account_id, created_at)" in definitions[0]


def test_a_valid_row_is_accepted_and_status_and_the_flag_have_defaults(db):
    with db.begin() as conn:
        account = add_account(conn, "Ana1")
        conn.execute(
            text(
                "INSERT INTO app.feedback (id, account_id, category, message, page_path,"
                " app_version, user_agent, viewport_width, viewport_height, client_time,"
                " console_errors, created_at) VALUES (:id, :a, 'bug', 'ten chars!!', '/', 'dev',"
                " '', 1, 1, :t, '[]', :t)"
            ),
            {"id": uuid.uuid4(), "a": account, "t": NOW},
        )

    with db.connect() as conn:
        row = conn.execute(
            text("SELECT status, about_quiz_question, course_id FROM app.feedback")
        ).one()
    assert tuple(row) == ("new", False, None)


@pytest.mark.parametrize(
    "category", ["bug", "content_error", "confusing_explanation", "suggestion"]
)
def test_each_of_the_four_categories_is_accepted(db, category):
    with db.begin() as conn:
        add_feedback(conn, add_account(conn, "Ana1"), category=category)

    assert count(db) == 1


@pytest.mark.parametrize("category", ["", "Bug", "other", "bug ", "praise"])
def test_a_category_outside_the_four_values_is_refused(db, category):
    assert refused(db, category=category) == "ck_feedback_category_values"


@pytest.mark.parametrize("status", ["triaged", "New", "", "closed"])
def test_a_status_other_than_new_is_refused(db, status):
    assert refused(db, status=status) == "ck_feedback_status_is_new"


@pytest.mark.parametrize("column", ["course_id", "chapter_id", "lesson_id", "question_id"])
@pytest.mark.parametrize(
    "bad", ["", "ok\n", "Upper", "has space", "under_score", "dot.dot", "slash/x", "é"]
)
def test_an_id_that_is_not_lowercase_digits_and_hyphens_is_refused(db, column, bad):
    overrides = {"course_id": "mcp-server", column: bad}

    assert refused(db, **overrides) == f"ck_feedback_{column}_format"


@pytest.mark.parametrize("column", ["course_id", "chapter_id", "lesson_id", "question_id"])
def test_an_id_column_may_be_null_or_well_formed(db, column):
    with db.begin() as conn:
        account = add_account(conn, "Ana1")
        # Without a course the other three IDs must be null too.
        nulls = {"chapter_id": None, "lesson_id": None, "question_id": None}
        add_feedback(
            conn, account, **{**nulls, column: None} if column == "course_id" else {column: None}
        )
        add_feedback(conn, account, **{column: "a-1"})

    assert count(db) == 2


def test_chapter_lesson_and_question_ids_need_a_course(db):
    for column in ("chapter_id", "lesson_id", "question_id"):
        overrides = {"course_id": None, "chapter_id": None, "lesson_id": None, "question_id": None}
        overrides[column] = "x"
        assert refused(db, **overrides) == "ck_feedback_ids_need_course"


def test_a_row_with_no_course_and_no_ids_is_accepted(db):
    nulls = {"course_id": None, "chapter_id": None, "lesson_id": None, "question_id": None}
    with db.begin() as conn:
        add_feedback(conn, add_account(conn, "Ana1"), **nulls)

    assert count(db) == 1


@pytest.mark.parametrize(
    "length,ok", [(9, False), (10, True), (2000, True), (2001, False), (0, False)]
)
def test_a_message_of_10_to_2000_characters_is_accepted(db, length, ok):
    message = "é" * length
    if ok:
        with db.begin() as conn:
            add_feedback(conn, add_account(conn, "Ana1"), message=message)
        assert count(db) == 1
    else:
        assert refused(db, message=message) == "ck_feedback_message_length"


def test_the_message_length_is_in_characters_not_bytes(db):
    with db.begin() as conn:
        add_feedback(conn, add_account(conn, "Ana1"), message="日" * 2000)

    assert count(db) == 1


@pytest.mark.parametrize("value", ["{}", '"a"', "1", "null", "true"])
def test_console_errors_that_is_not_an_array_is_refused(db, value):
    assert refused(db, console_errors=value) == "ck_feedback_console_errors_is_array"


def test_an_object_for_console_errors_is_refused_by_the_check_not_by_an_error_in_it(db):
    # `jsonb_array_length` raises on a non-array; the CASE keeps that out of the check.
    assert refused(db, console_errors='{"a": 1}').startswith("ck_feedback_console_errors_")


@pytest.mark.parametrize("items,ok", [(0, True), (10, True), (11, False), (50, False)])
def test_console_errors_holds_at_most_10_items(db, items, ok):
    errors = json.dumps(["e"] * items)
    if ok:
        with db.begin() as conn:
            add_feedback(conn, add_account(conn, "Ana1"), console_errors=errors)
        assert count(db) == 1
    else:
        assert refused(db, console_errors=errors) == "ck_feedback_console_errors_max_items"


def test_the_quiz_flag_needs_a_question_id(db):
    assert (
        refused(db, about_quiz_question=True, question_id=None)
        == "ck_feedback_quiz_flag_needs_question_id"
    )


def test_the_quiz_flag_with_a_question_id_is_accepted(db):
    with db.begin() as conn:
        add_feedback(conn, add_account(conn, "Ana1"), about_quiz_question=True, question_id="q-1")

    assert count(db) == 1


@pytest.mark.parametrize(
    "column",
    [
        "category",
        "message",
        "about_quiz_question",
        "page_path",
        "app_version",
        "user_agent",
        "viewport_width",
        "viewport_height",
        "client_time",
        "console_errors",
        "status",
        "created_at",
    ],
)
def test_every_required_column_is_not_null(db, column):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_feedback(conn, add_account(conn, "Ana1"), **{column: None})

    assert excinfo.value.orig.diag.column_name == column


def test_a_row_for_a_missing_account_is_refused(db):
    with pytest.raises(IntegrityError) as excinfo, db.begin() as conn:
        add_feedback(conn, uuid.uuid4())

    assert constraint_of(excinfo) == "fk_feedback_account_id_accounts"


def test_deleting_an_account_deletes_only_its_feedback(db):
    with db.begin() as conn:
        mine = add_account(conn, "Ana1")
        other = add_account(conn, "Bob1")
        add_feedback(conn, mine)
        add_feedback(conn, mine, message="Another message here")
        add_feedback(conn, other)

    with db.begin() as conn:
        conn.execute(text("DELETE FROM app.accounts WHERE id = :id"), {"id": mine})

    with db.connect() as conn:
        left = conn.execute(text("SELECT account_id FROM app.feedback")).scalars().all()
    assert left == [other]


def test_one_learner_may_have_many_rows_with_the_same_message(db):
    with db.begin() as conn:
        account = add_account(conn, "Ana1")
        for _ in range(3):
            add_feedback(conn, account)

    assert count(db) == 3


def test_the_migration_file_has_no_database_dialect_name_and_defines_its_own_jsonb():
    from tests.dbtools import BACKEND_DIR

    source = (BACKEND_DIR / "migrations" / "versions" / "0005_create_feedback.py").read_text(
        encoding="utf-8"
    )

    assert "postgresql" not in source.lower()
    assert "class _Jsonb" in source


def test_0005_follows_0004_and_is_the_only_head(database_url):
    env = env_with_url(database_url)
    heads = alembic("heads", env=env)
    history = alembic("history", env=env)

    assert heads.returncode == 0 and history.returncode == 0, heads.output + history.output
    head_lines = [line for line in heads.output.splitlines() if "(head)" in line]
    assert len(head_lines) == 1 and head_lines[0].startswith("0005")
    assert any(line.startswith("0004 -> 0005") for line in history.output.splitlines())


def test_downgrade_to_0004_drops_the_table_and_upgrade_brings_it_back(
    db, database_url, restore_head
):
    env = env_with_url(database_url)

    down = alembic("downgrade", "0004", env=env)

    assert down.returncode == 0, down.output
    with db.connect() as conn:
        assert conn.execute(text("SELECT to_regclass('app.feedback')")).scalar_one() is None
        assert (
            conn.execute(text("SELECT to_regclass('app.quiz_attempts')")).scalar_one() is not None
        )
        assert (
            conn.execute(
                text("SELECT to_regclass('app.ix_feedback_account_id_created_at')")
            ).scalar_one()
            is None
        )
    up = alembic("upgrade", "head", env=env)
    assert up.returncode == 0, up.output
    with db.connect() as conn:
        assert conn.execute(text("SELECT to_regclass('app.feedback')")).scalar_one() is not None


def test_alembic_check_finds_the_model_and_the_migration_in_agreement(database_url):
    result = alembic("check", env=env_with_url(database_url))

    assert result.returncode == 0, result.output


def test_the_model_and_the_migration_name_the_same_constraints(db):
    from app.models import Feedback

    model_names = {c.name for c in Feedback.__table__.constraints if c.name is not None}
    with db.connect() as conn:
        db_names = set(
            conn.execute(
                text("SELECT conname FROM pg_constraint WHERE conrelid = 'app.feedback'::regclass")
            ).scalars()
        )

    assert model_names <= db_names
    assert {n for n in db_names if n.startswith("ck_")} == {
        n for n in model_names if n.startswith("ck_")
    }
