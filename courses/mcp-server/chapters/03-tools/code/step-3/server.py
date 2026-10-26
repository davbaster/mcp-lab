from mcp.server.mcpserver import MCPServer

import storage

mcp = MCPServer("notes")


@mcp.tool()
def create_note(title: str, body: str) -> dict:
    """Save a new note and return it with its id.

    Call this when the user asks to remember, write down or save something.

    Args:
        title: A short title, a few words.
        body: The full text of the note.
    """
    return storage.create_note(title, body)


@mcp.tool()
def list_notes() -> list[dict]:
    """List every saved note, oldest first.

    Call this to find a note's id, or when the user asks what notes exist.
    Takes no arguments.
    """
    return storage.list_notes()


@mcp.tool()
def get_note(note_id: int) -> dict | str:
    """Get one note by its id.

    Call this when you need the full text of a note you already know the id of.

    Args:
        note_id: The id of the note, as returned by create_note or list_notes.
    """
    note = storage.get_note(note_id)
    if note is None:
        return f"Note {note_id} not found"
    return note


@mcp.tool()
def update_note(
    note_id: int, title: str | None = None, body: str | None = None
) -> dict | str:
    """Change the title or the body of an existing note.

    Call this when the user wants to edit a note. Pass only the fields to
    change; a field you leave out keeps its current value.

    Args:
        note_id: The id of the note to change.
        title: The new title, or leave out to keep the current one.
        body: The new text, or leave out to keep the current one.
    """
    note = storage.update_note(note_id, title, body)
    if note is None:
        return f"Note {note_id} not found"
    return note


@mcp.tool()
def delete_note(note_id: int) -> str:
    """Permanently delete a note by its id.

    Call this only when the user clearly asks to delete a note. It cannot be undone.

    Args:
        note_id: The id of the note to delete.
    """
    if storage.delete_note(note_id):
        return f"Note {note_id} deleted"
    return f"Note {note_id} not found"


if __name__ == "__main__":
    mcp.run()
