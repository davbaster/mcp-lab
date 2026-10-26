import json
from typing import TypedDict

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ResourceNotFoundError, ToolError
from mcp.types import ToolAnnotations

import storage

mcp = MCPServer("notes")


class Note(TypedDict):
    id: int
    title: str
    body: str
    created_at: str


@mcp.tool()
def create_note(title: str, body: str) -> Note:
    """Save a new note and return it with its id.

    Call this when the user asks to remember, write down or save something.

    Args:
        title: A short title, a few words.
        body: The full text of the note.
    """
    return storage.create_note(title, body)


@mcp.tool(annotations=ToolAnnotations(read_only_hint=True))
def list_notes() -> list[Note]:
    """List every saved note, oldest first.

    Call this to find a note's id, or when the user asks what notes exist.
    Takes no arguments.
    """
    return storage.list_notes()


@mcp.tool(annotations=ToolAnnotations(read_only_hint=True))
def get_note(note_id: int) -> Note:
    """Get one note by its id.

    Call this when you need the full text of a note you already know the id of.

    Args:
        note_id: The id of the note, as returned by create_note or list_notes.
    """
    note = storage.get_note(note_id)
    if note is None:
        raise ToolError(f"Note {note_id} not found")
    return note


@mcp.tool()
def update_note(
    note_id: int, title: str | None = None, body: str | None = None
) -> Note:
    """Change the title or the body of an existing note.

    Call this when the user wants to edit a note. Pass only the fields to
    change; a field you leave out keeps its current value.

    Args:
        note_id: The id of the note to change.
        title: The new title, or leave out to keep the current one.
        body: The new text, or leave out to keep the current one.
    """
    if title is None and body is None:
        raise ToolError("Give a title, a body or both")
    note = storage.update_note(note_id, title, body)
    if note is None:
        raise ToolError(f"Note {note_id} not found")
    return note


@mcp.tool(
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True)
)
def delete_note(note_id: int) -> None:
    """Permanently delete a note by its id.

    Call this only when the user clearly asks to delete a note. It cannot be undone.
    Returns nothing; raises an error if the note does not exist.

    Args:
        note_id: The id of the note to delete.
    """
    if not storage.delete_note(note_id):
        raise ToolError(f"Note {note_id} not found")


@mcp.resource("notes://index", mime_type="application/json")
def notes_index() -> str:
    """Titles and ids of every saved note."""
    return json.dumps([{"id": n["id"], "title": n["title"]} for n in storage.list_notes()])


@mcp.resource("notes://{note_id}", mime_type="text/plain")
def read_note(note_id: int) -> str:
    """The title and text of one note."""
    note = storage.get_note(note_id)
    if note is None:
        raise ResourceNotFoundError(f"Note {note_id} not found")
    return f"{note['title']}\n\n{note['body']}"


@mcp.prompt()
def summarize_note(note_id: int) -> str:
    """Ask the model to summarize one note."""
    return f"Summarize note {note_id} in two sentences. Read it from notes://{note_id}."


if __name__ == "__main__":
    mcp.run()
