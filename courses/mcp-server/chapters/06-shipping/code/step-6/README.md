# notes-server

A small MCP server for notes. It keeps notes in a SQLite database and gives an AI app seven tools to work with them (create, list, get, update, delete, import and export), a `notes://` resource for each note, and a prompt that summarizes one.

## Install

You need Python 3.10 or newer and [uv](https://docs.astral.sh/uv/).

```
uv sync
```

## Run

```
uv run server.py
```

The server talks to its client over stdio. To serve Streamable HTTP on `http://127.0.0.1:8000/mcp` instead, add the flag:

```
uv run server.py --http
```

## Configuration

Set these environment variables to change the defaults. All of them are optional.

- `NOTES_DB_PATH`: the SQLite file (default `notes.db`)
- `NOTES_DATA_DIR`: the folder that `import_notes` and `export_notes` may read and write (default `data`)
- `NOTES_LOG_LEVEL`: the log level, such as `INFO` or `DEBUG` (default `INFO`)

## Use it with Claude Desktop

Add this to `claude_desktop_config.json`, replace the paths with your own, and restart Claude Desktop:

```json
{
  "mcpServers": {
    "notes": {
      "command": "uv",
      "args": ["--directory", "/ABSOLUTE/PATH/TO/notes-server", "run", "server.py"],
      "env": {
        "NOTES_LOG_LEVEL": "INFO",
        "NOTES_DB_PATH": "/ABSOLUTE/PATH/TO/notes.db",
        "NOTES_DATA_DIR": "/ABSOLUTE/PATH/TO/notes-data"
      }
    }
  }
}
```

## Tests

```
uv run pytest
```
