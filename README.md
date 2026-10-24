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

## Docker stack

The stack runs the frontend, backend, Postgres, and Caddy together at a single local address, the same way the app runs in production. The native dev servers from the Commands section above remain the fast edit loop; use the Docker stack to check the whole thing end to end.

Docker Desktop (or Docker Engine with the Compose plugin) must be running. Use `docker compose` (with a space), not `docker-compose`. Run each command on its own line from the repo root; they work in PowerShell 5.1 as well as bash.

Optional: copy the example settings. The stack also starts without a `.env` file, because every variable has the same default in `compose.yaml`.

```
cp .env.example .env
```

Start the stack in the foreground (Ctrl+C stops it):

```
docker compose up --build
```

Start it in the background and wait until every service is healthy:

```
docker compose up --build --wait
```

Then open <http://localhost:8080/>. The health check is at <http://localhost:8080/api/health>.

Rebuild after a code change by running `docker compose up --build` again. The source code is not mounted into the containers.

See the logs of one service (here the backend; the others are `frontend`, `postgres`, and `caddy`):

```
docker compose logs -f backend
```

Stop the stack. The database is kept:

```
docker compose down
```

Reset the database. This deletes all stack data. It is also needed after you change a `POSTGRES_*` value, because Postgres reads those only on its first start:

```
docker compose down -v
```

### Port 8080 is busy

Only Caddy is published to your machine, on `127.0.0.1:8080`. If port 8080 is already in use, `docker compose up` fails with "port is already allocated" or "address already in use". Set another port by editing `HTTP_PORT` in `.env` (for example `HTTP_PORT=8081`), then open <http://localhost:8081/>.

On Windows, 8080 can also fall in a Hyper-V excluded port range. List the ranges with:

```
netsh interface ipv4 show excludedportrange protocol=tcp
```

A variable set in the PowerShell session (for example `$env:HTTP_PORT = "8081"`) overrides `.env` until you close the session or remove it with `Remove-Item Env:HTTP_PORT`.

## Branch protection

A repository ruleset (Settings > Rules > Rulesets) applies to `main` only. Work on other branches (`claude/*`, `oncall/*`, and so on) is not restricted. The rule:

- Requires a pull request before merging, with 0 required approvals (the only maintainer is the owner, and GitHub does not let an author approve their own PR).
- Requires the status checks `backend` and `frontend` (the job names in [`.github/workflows/ci.yml`](.github/workflows/ci.yml)), and only those two. Both must come from the GitHub Actions app (app ID 15368).
- Blocks force pushes to `main` and deletion of `main`.
- Has no bypass actors, so the owner is not exempt: direct pushes to `main` are blocked for everyone.
- Does not require branches to be up to date before merging. Two PRs that are green alone could break `main` together. CI also runs on every push to `main`, which catches this. Revisit if `main` goes red this way.

Read the rule that applies to `main`:

```
gh api repos/davbaster/mcp-lab/rules/branches/main
```

### Changing a required check

1. Add the new job and merge it while the old name is still required.
2. Change the rule.
3. Remove or rename the old job.

Do not rename or remove `backend` or `frontend` in the same PR that updates the rule. The PR would be stuck on an "Expected" check that never reports.

### Emergency

If `main` must be changed and the rule is in the way (for example a CI outage), the owner sets the ruleset's enforcement to Disabled in Settings, merges, and sets it back to Active right away. Say so in the PR or issue.

### A failing check

Fix the failure or re-run the job. A test is never skipped or weakened to get a merge (see [`_docs/testing-guidelines.md`](_docs/testing-guidelines.md)).

## Folders

| Folder | What |
|---|---|
| `backend/` | Python, FastAPI. |
| `frontend/` | React, TypeScript, Vite, Vitest. |
| `courses/` | Course content (filled by [#7](https://github.com/davbaster/mcp-lab/issues/7)). |
| `content-build/` | Course validator and MDX compiler (filled by [#7](https://github.com/davbaster/mcp-lab/issues/7)). |
| `oncall-mcp/` | The on-call MCP server (filled by [#40](https://github.com/davbaster/mcp-lab/issues/40)). |
