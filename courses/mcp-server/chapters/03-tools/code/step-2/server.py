from mcp.server.mcpserver import MCPServer

import storage

mcp = MCPServer("notes")


@mcp.tool()
def create_note(title: str, body: str) -> dict:
    """Create a note."""
    return storage.create_note(title, body)


@mcp.tool()
def list_notes() -> list[dict]:
    """List notes."""
    return storage.list_notes()


@mcp.tool()
def get_note(note_id: int) -> dict | str:
    """Get a note."""
    note = storage.get_note(note_id)
    if note is None:
        return f"Note {note_id} not found"
    return note


@mcp.tool()
def update_note(
    note_id: int, title: str | None = None, body: str | None = None
) -> dict | str:
    """Update a note."""
    note = storage.update_note(note_id, title, body)
    if note is None:
        return f"Note {note_id} not found"
    return note


@mcp.tool()
def delete_note(note_id: int) -> str:
    """Delete a note."""
    if storage.delete_note(note_id):
        return f"Note {note_id} deleted"
    return f"Note {note_id} not found"


if __name__ == "__main__":
    mcp.run()
