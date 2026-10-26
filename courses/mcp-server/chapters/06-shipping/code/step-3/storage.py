import sqlite3
from datetime import datetime, timezone


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "title TEXT NOT NULL, "
        "body TEXT NOT NULL, "
        "created_at TEXT NOT NULL)"
    )
    return conn


def create_note(conn: sqlite3.Connection, title: str, body: str) -> dict:
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with conn:
        cursor = conn.execute(
            "INSERT INTO notes (title, body, created_at) VALUES (?, ?, ?)",
            (title, body, created_at),
        )
    return {"id": cursor.lastrowid, "title": title, "body": body, "created_at": created_at}


def list_notes(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT id, title, body, created_at FROM notes ORDER BY id"
    ).fetchall()
    return [dict(row) for row in rows]


def get_note(conn: sqlite3.Connection, note_id: int) -> dict | None:
    row = conn.execute(
        "SELECT id, title, body, created_at FROM notes WHERE id = ?", (note_id,)
    ).fetchone()
    return dict(row) if row else None


def update_note(
    conn: sqlite3.Connection,
    note_id: int,
    title: str | None = None,
    body: str | None = None,
) -> dict | None:
    with conn:
        conn.execute(
            "UPDATE notes SET title = COALESCE(?, title), body = COALESCE(?, body) "
            "WHERE id = ?",
            (title, body, note_id),
        )
    return get_note(conn, note_id)


def delete_note(conn: sqlite3.Connection, note_id: int) -> bool:
    with conn:
        cursor = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    return cursor.rowcount > 0
