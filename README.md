# mcp-lab

A web app for guided courses. The first course is "Build an MCP Server" (Python). The plan is in [`_docs/plan.md`](_docs/plan.md).

## Required tools

- [uv](https://docs.astral.sh/uv/) for the backend (it installs the Python version from `backend/pyproject.toml`).
- Node, at the version in [`.nvmrc`](.nvmrc), with npm.
  - `nvm-windows` ignores `.nvmrc`. Read the version in the file and run `nvm use <that version>` (for example `nvm use 24`).
  - With the original `nvm` on macOS or Linux, run `nvm use` in the repo folder.

## Commands

Run each command on its own line from the repo root. Each starts with `cd`, so it works in PowerShell 5.1 as well as bash.

### Backend (`backend/`)

Install:

```
cd backend
uv sync
```

Test:

```
cd backend
uv run pytest
```

Lint:

```
cd backend
uv run ruff check .
```

Typecheck: the backend has no typecheck step yet.

Start the dev server on <http://localhost:8000> (the health check is at <http://localhost:8000/api/health>):

```
cd backend
uv run uvicorn app.main:app --port 8000
```

### Frontend (`frontend/`)

Install:

```
cd frontend
npm ci
```

Test:

```
cd frontend
npm test
```

Lint:

```
cd frontend
npm run lint
```

Typecheck:

```
cd frontend
npm run typecheck
```

Build:

```
cd frontend
npm run build
```

Start the dev server (Vite prints the URL, by default <http://localhost:5173>):

```
cd frontend
npm run dev
```

## Folders

| Folder | What |
|---|---|
| `backend/` | Python, FastAPI. |
| `frontend/` | React, TypeScript, Vite, Vitest. |
| `courses/` | Course content (filled by [#7](https://github.com/davbaster/mcp-lab/issues/7)). |
| `content-build/` | Course validator and MDX compiler (filled by [#7](https://github.com/davbaster/mcp-lab/issues/7)). |
| `oncall-mcp/` | The on-call MCP server (filled by [#40](https://github.com/davbaster/mcp-lab/issues/40)). |
