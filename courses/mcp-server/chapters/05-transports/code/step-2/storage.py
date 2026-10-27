import sqlite3
from datetime import datetime, timezone

DB_PATH = "notes.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "title TEXT NOT NULL, "
        "body TEXT NOT NULL, "
        "created_at TEXT NOT NULL)"
    )
    return conn


def create_note(title: str, body: str) -> dict:
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO notes (title, body, created_at) VALUES (?, ?, ?)",
            (title, body, created_at),
        )
        note_id = cursor.lastrowid
    return {"id": note_id, "title": title, "body": body, "created_at": created_at}


def list_notes() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, title, body, created_at FROM notes ORDER BY id"
        ).fetchall()
    return [dict(row) for row in rows]


def get_note(note_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, title, body, created_at FROM notes WHERE id = ?",
            (note_id,),
        ).fetchone()
    return dict(row) if row else None


def update_note(
    note_id: int, title: str | None = None, body: str | None = None
) -> dict | None:
    with _connect() as conn:
        conn.execute(
            "UPDATE notes SET title = COALESCE(?, title), body = COALESCE(?, body) "
            "WHERE id = ?",
            (title, body, note_id),
        )
    return get_note(note_id)


def delete_note(note_id: int) -> bool:
    with _connect() as conn:
        cursor = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    return cursor.rowcount > 0
