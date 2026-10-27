import pytest

import storage


@pytest.fixture
def conn(tmp_path):
    connection = storage.connect(str(tmp_path / "t.db"))
    yield connection
    connection.close()


def test_create_note(conn):
    note = storage.create_note(conn, "Milk", "Buy milk")
    assert note["id"] == 1
    assert note["title"] == "Milk"


def test_list_notes_oldest_first(conn):
    storage.create_note(conn, "First", "a")
    storage.create_note(conn, "Second", "b")
    assert [n["title"] for n in storage.list_notes(conn)] == ["First", "Second"]


def test_get_note(conn):
    created = storage.create_note(conn, "Milk", "Buy milk")
    assert storage.get_note(conn, created["id"]) == created


def test_get_missing_note_returns_none(conn):
    assert storage.get_note(conn, 99) is None


def test_update_changes_only_given_fields(conn):
    storage.create_note(conn, "Milk", "Buy milk")
    note = storage.update_note(conn, 1, body="Buy oat milk")
    assert note["title"] == "Milk"
    assert note["body"] == "Buy oat milk"


def test_delete_note(conn):
    storage.create_note(conn, "Milk", "Buy milk")
    assert storage.delete_note(conn, 1) is True
    assert storage.delete_note(conn, 1) is False
