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

Test (needs `DATABASE_URL` set to a test database, see [Test database](#test-database); without it pytest stops before running any test):

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

#### Database

The backend reads one setting, `DATABASE_URL`, from the environment. It does not read `.env` files. Format:

```
postgresql+psycopg://user:password@host:port/dbname
```

For example `postgresql+psycopg://mcp_lab:secret@127.0.0.1:5432/mcp_lab`. `postgresql://...` (no driver) also works and uses the psycopg driver. Percent-encode special characters in the password: `@` becomes `%40` and `%` becomes `%25` (so `p@ss%w` is written `p%40ss%25w`). Use `127.0.0.1`, not `localhost`: on Windows `localhost` may resolve to IPv6 first.

Set it for the current terminal session only. In PowerShell:

```
$env:DATABASE_URL = 'postgresql+psycopg://mcp_lab:secret@127.0.0.1:5432/mcp_lab'
```

In bash:

```
export DATABASE_URL=postgresql+psycopg://mcp_lab:secret@127.0.0.1:5432/mcp_lab
```

Migrations use Alembic and live in `backend/migrations/`. Run each command on its own line. Apply all migrations:

```
cd backend
uv run alembic upgrade head
```

Undo all of them (this drops the `app` schema):

```
cd backend
uv run alembic downgrade base
```

Check that the models and the migrations agree (exits non-zero if a migration is missing):

```
cd backend
uv run alembic check
```

The app does not migrate by itself. Only the Docker stack does, on start, because `compose.yaml` sets `RUN_MIGRATIONS_ON_START` to `true` for the backend (the backend image migrates only when that variable is exactly `true`). Production migrates in a separate deploy step ([#35](https://github.com/davbaster/mcp-lab/issues/35)).

#### Test database

The backend tests use a real Postgres database whose name ends in `_test`, taken from `DATABASE_URL`. The suite creates that database itself if it is missing (the role needs the `CREATEDB` permission; otherwise pytest prints the `createdb` command to run by hand), resets it to the migrated schema at the start of every run, and empties the tables before every test. It refuses to run against any other database name, and it stops before running any test if `DATABASE_URL` is unset.

If `DATABASE_URL` is already set in your terminal for a development database, pytest refuses to run (by design) until you change it to a `_test` database. Run one pytest at a time per test database.

The Docker stack does not publish Postgres to your machine, so the tests use a separate Postgres. Pick one of these.

**a) Docker.** Start a disposable Postgres on `127.0.0.1:5433` (no volume, so nothing is kept):

```
docker run --rm -d --name mcp-lab-test-db -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5433:5432 postgres:16
```

Then set `DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test` (PowerShell: `$env:DATABASE_URL = 'postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test'`; bash: `export DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test`) and run the tests. Port 5433 avoids a native Postgres on 5432 and the Docker stack. If 5433 is busy, pick another host port (for example `-p 127.0.0.1:5434:5432`) and use the same port in the URL. Remove the container when you are done:

```
docker stop mcp-lab-test-db
```

**b) Windows without Docker.** Install PostgreSQL 16 natively. Use a role with the `CREATEDB` and `CREATEROLE` permissions (the `postgres` role has both; a few tests create temporary roles) and set `DATABASE_URL` to `postgresql+psycopg://<role>:<password>@127.0.0.1:5432/mcp_lab_test`, using your own port if it is not 5432.

Run the tests:

```
cd backend
uv run pytest
```

#### OpenAPI contract

`openapi.yaml` at the repo root is the API contract. It is generated from the backend code. Export it (needs no database and no running server):

```
cd backend
uv run python scripts/export_openapi.py
```

Check that the committed file is up to date (this is what CI runs; it exits non-zero and writes nothing when the file differs):

```
cd backend
uv run python scripts/export_openapi.py --check
```

The running app serves the same document at <http://localhost:8000/api/openapi.json> and interactive docs at <http://localhost:8000/api/docs> (through the Docker stack: <http://localhost:8080/api/docs>). The docs page loads Swagger UI from a CDN, so it needs internet access.

Re-export in the same change as any API change (see "API contract" in [`AGENTS.md`](AGENTS.md)). Upgrading FastAPI, Pydantic, or PyYAML can change the output too, so re-export after such an upgrade and commit the new file.

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

On start, the backend container applies the database migrations (`alembic upgrade head`) before it starts the server, and stops with the error in its logs if a migration fails. Restarting is safe: the migration is a no-op when the database is up to date.

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

## CI

CI runs on the self-hosted runner on the owner's VPS (labels `self-hosted`, `Linux`, `X64`, `ubuntu-24`), not on GitHub-hosted runners. Jobs queue while that runner is busy or offline. The runner needs Docker, because the `backend` job starts a Postgres service container.

Because the repo is public, the jobs skip pull requests from forks, so outside code never runs on the VPS. A skipped job counts as passing for branch protection, so review a fork PR's code before merging it, or push its branch to this repo to get a real CI run.

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
