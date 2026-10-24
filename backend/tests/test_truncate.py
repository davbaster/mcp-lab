import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_engine
from tests.dbtools import truncate_app_tables


@pytest.fixture(scope="module")
def scratch_tables(db_engine):
    """Scratch tables for this module only; dropped at the end so the schema matches the migrations."""
    with db_engine.begin() as conn:
        conn.execute(text("CREATE TABLE app.scratch_rows (id serial PRIMARY KEY, label text)"))
        conn.execute(text("CREATE TABLE app.scratch_parent (id serial PRIMARY KEY)"))
        conn.execute(
            text(
                "CREATE TABLE app.scratch_child (id serial PRIMARY KEY, "
                "parent_id int NOT NULL REFERENCES app.scratch_parent (id))"
            )
        )
    yield
    with db_engine.begin() as conn:
        conn.execute(text("DROP TABLE app.scratch_child, app.scratch_parent, app.scratch_rows"))


def _count(engine, table):
    with engine.connect() as conn:
        return conn.execute(text(f"SELECT count(*) FROM app.{table}")).scalar_one()


# These two tests depend on definition order: pytest runs them in file order, and the second
# proves the per-test truncate emptied what the first inserted. Do not reorder or split them.
def test_a_inserts_a_row(db, scratch_tables):
    with db.begin() as conn:
        conn.execute(text("INSERT INTO app.scratch_rows (label) VALUES ('left behind')"))

    assert _count(db, "scratch_rows") == 1


def test_b_sees_the_table_empty(db, scratch_tables):
    assert _count(db, "scratch_rows") == 0


def test_truncate_helper_empties_a_table(db, scratch_tables):
    with db.begin() as conn:
        conn.execute(text("INSERT INTO app.scratch_rows (label) VALUES ('x')"))
    assert _count(db, "scratch_rows") == 1

    truncate_app_tables(db)

    assert _count(db, "scratch_rows") == 0


def test_truncate_helper_empties_tables_linked_by_a_foreign_key(db, scratch_tables):
    with db.begin() as conn:
        conn.execute(text("INSERT INTO app.scratch_parent DEFAULT VALUES"))
        conn.execute(text("INSERT INTO app.scratch_child (parent_id) VALUES (1)"))

    truncate_app_tables(db)

    assert _count(db, "scratch_parent") == 0
    assert _count(db, "scratch_child") == 0


def test_truncate_restarts_identity_and_keeps_alembic_version(db, scratch_tables):
    with db.begin() as conn:
        conn.execute(text("INSERT INTO app.scratch_rows (label) VALUES ('x'), ('y')"))

    truncate_app_tables(db)

    with db.begin() as conn:
        new_id = conn.execute(
            text("INSERT INTO app.scratch_rows (label) VALUES ('z') RETURNING id")
        ).scalar_one()
        versions = conn.execute(text("SELECT count(*) FROM public.alembic_version")).scalar_one()
    assert new_id == 1
    assert versions == 1


def _make_client():
    """A test-only app whose handlers open their own sessions, like real API handlers will."""
    app = FastAPI()

    @app.get("/rows")
    def list_rows():
        with Session(get_engine()) as session:
            return session.execute(text("SELECT label FROM app.scratch_rows")).scalars().all()

    @app.post("/rows/{label}")
    def add_row(label: str):
        with Session(get_engine()) as session:
            session.execute(text("INSERT INTO app.scratch_rows (label) VALUES (:l)"), {"l": label})
            session.commit()
        return {"ok": True}

    return TestClient(app)


# Order-dependent pair, like the one above.
def test_handler_session_sees_rows_written_by_the_test(db, scratch_tables):
    client = _make_client()
    with db.begin() as conn:
        conn.execute(text("INSERT INTO app.scratch_rows (label) VALUES ('from test')"))

    assert client.get("/rows").json() == ["from test"]

    client.post("/rows/from-handler")
    assert sorted(client.get("/rows").json()) == ["from test", "from-handler"]


def test_rows_written_by_a_handler_are_gone_in_the_next_test(db, scratch_tables):
    assert _make_client().get("/rows").json() == []
