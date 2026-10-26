import json
import logging
import os
import sqlite3
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ResourceNotFoundError, ToolError
from mcp.types import ToolAnnotations
from typing_extensions import TypedDict

import storage

# Logs go to stderr: stdout belongs to the protocol. This must run before
# MCPServer(...), because basicConfig does nothing once a handler exists.
logging.basicConfig(stream=sys.stderr, level=os.environ.get("NOTES_LOG_LEVEL", "INFO"))
logger = logging.getLogger("notes")



@dataclass
class AppState:
    conn: sqlite3.Connection
    data_dir: Path


# Static resources cannot take a Context, so the lifespan also leaves the state here.
current: AppState | None = None


@asynccontextmanager
async def lifespan(server: MCPServer) -> AsyncIterator[AppState]:
    global current
    # Read the settings when the server starts, so tests can set them first.
    db_path = os.environ.get("NOTES_DB_PATH", "notes.db")
    data_dir = Path(os.environ.get("NOTES_DATA_DIR", "data")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    conn = storage.connect(db_path)
    logger.info("Opened %s", db_path)
    current = AppState(conn=conn, data_dir=data_dir)
    try:
        yield current
    finally:
        current = None
        conn.close()
        logger.info("Closed %s", db_path)


mcp = MCPServer("notes", lifespan=lifespan)

Ctx = Context[AppState]


class Note(TypedDict):
    id: int
    title: str
    body: str
    created_at: str


def check_id(note_id: int) -> None:
    if note_id < 1:
        raise ToolError("note_id must be a positive integer")


def safe_path(data_dir: Path, name: str) -> Path:
    """Resolve name inside data_dir, or raise ToolError."""
    # resolve() removes "..", follows symlinks and keeps an absolute name as it is.
    path = (data_dir / name).resolve()
    if not path.is_relative_to(data_dir):
        raise ToolError("Path must stay inside the data folder")
    return path


@mcp.tool()
async def create_note(title: str, body: str, ctx: Ctx) -> Note:
    """Save a new note and return it with its id.

    Call this when the user asks to remember, write down or save something.

    Args:
        title: A short title, a few words.
        body: The full text of the note.
    """
    note = storage.create_note(ctx.request_context.lifespan_context.conn, title, body)
    await ctx.info(f"Created note {note['id']}")
    return note


@mcp.tool(annotations=ToolAnnotations(read_only_hint=True))
def list_notes(ctx: Ctx) -> list[Note]:
    """List every saved note, oldest first.

    Call this to find a note's id, or when the user asks what notes exist.
    Takes no arguments.
    """
    return storage.list_notes(ctx.request_context.lifespan_context.conn)


@mcp.tool(annotations=ToolAnnotations(read_only_hint=True))
def get_note(note_id: int, ctx: Ctx) -> Note:
    """Get one note by its id.

    Call this when you need the full text of a note you already know the id of.

    Args:
        note_id: The id of the note, as returned by create_note or list_notes.
    """
    check_id(note_id)
    note = storage.get_note(ctx.request_context.lifespan_context.conn, note_id)
    if note is None:
        raise ToolError(f"Note {note_id} not found")
    return note


@mcp.tool()
def update_note(
    ctx: Ctx, note_id: int, title: str | None = None, body: str | None = None
) -> Note:
    """Change the title or the body of an existing note.

    Call this when the user wants to edit a note. Pass only the fields to
    change; a field you leave out keeps its current value.

    Args:
        note_id: The id of the note to change.
        title: The new title, or leave out to keep the current one.
        body: The new text, or leave out to keep the current one.
    """
    check_id(note_id)
    if title is None and body is None:
        raise ToolError("Give a title, a body or both")
    conn = ctx.request_context.lifespan_context.conn
    note = storage.update_note(conn, note_id, title, body)
    if note is None:
        raise ToolError(f"Note {note_id} not found")
    return note


@mcp.tool(
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True)
)
def delete_note(note_id: int, ctx: Ctx) -> None:
    """Permanently delete a note by its id.

    Call this only when the user clearly asks to delete a note. It cannot be undone.
    Returns nothing; raises an error if the note does not exist.

    Args:
        note_id: The id of the note to delete.
    """
    check_id(note_id)
    if not storage.delete_note(ctx.request_context.lifespan_context.conn, note_id):
        raise ToolError(f"Note {note_id} not found")


@mcp.tool(
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False)
)
def export_notes(path: str, ctx: Ctx) -> str:
    """Write every note to a JSON file in the data folder.

    Call this when the user wants a backup or a copy of their notes in a file.

    Args:
        path: The file name, inside the data folder.
    """
    state = ctx.request_context.lifespan_context
    target = safe_path(state.data_dir, path)
    notes = storage.list_notes(state.conn)
    target.write_text(json.dumps(notes, indent=2), encoding="utf-8")
    return f"Exported to {target.name}"


@mcp.tool(
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False)
)
async def import_notes(path: str, ctx: Ctx) -> str:
    """Add the notes in a JSON file to the database.

    Call this when the user wants to load notes from a file. The file holds a
    list of objects with a title and a body.

    Args:
        path: The file name, inside the data folder.
    """
    state = ctx.request_context.lifespan_context
    source = safe_path(state.data_dir, path)
    try:
        items = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(items, list):
            raise ValueError("not a list")
    except (OSError, ValueError):
        raise ToolError("Could not read a JSON list of notes from that file")
    for i, item in enumerate(items, start=1):
        storage.create_note(state.conn, item["title"], item["body"])
        await ctx.report_progress(i, len(items), f"Imported {i} of {len(items)}")
    await ctx.info(f"Imported {len(items)} notes")
    return f"Imported {len(items)} notes"


@mcp.resource("notes://index", mime_type="application/json")
def notes_index() -> str:
    """Titles and ids of every saved note."""
    assert current is not None
    notes = storage.list_notes(current.conn)
    return json.dumps([{"id": n["id"], "title": n["title"]} for n in notes])


@mcp.resource("notes://{note_id}", mime_type="text/plain")
def read_note(note_id: int, ctx: Ctx) -> str:
    """The title and text of one note."""
    note = storage.get_note(ctx.request_context.lifespan_context.conn, note_id)
    if note is None:
        raise ResourceNotFoundError(f"Note {note_id} not found")
    return f"{note['title']}\n\n{note['body']}"


@mcp.prompt()
def summarize_note(note_id: int) -> str:
    """Ask the model to summarize one note."""
    return f"Summarize note {note_id} in two sentences. Read it from notes://{note_id}."


if __name__ == "__main__":
    if "--http" in sys.argv:
        # On 127.0.0.1 the SDK checks the Host and Origin headers for you.
        # With any other host, pass transport_security=... or protection is off.
        mcp.run(transport="streamable-http", host="127.0.0.1", port=8000)
    else:
        mcp.run()
