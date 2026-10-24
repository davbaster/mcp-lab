# mcp-lab

A web app for guided courses. The first course is "Build an MCP Server" (Python). The plan is in [`_docs/plan.md`](_docs/plan.md).

## Required tools

- [uv](https://docs.astral.sh/uv/) for the backend. uv reads the Python version from `backend/.python-version` and downloads it if it is missing, so Python does not need to be installed separately.
- Node, at the version in [`.nvmrc`](.nvmrc), with npm.
  - `nvm-windows` ignores `.nvmrc`. Read the version in the file and run `nvm use <that version>` (for example `nvm use 24`).
  - With the original `nvm` on macOS or Linux, run `nvm use` in the repo folder.
- [GNU Make](https://www.gnu.org/software/make/) (version 3.81 or newer) runs the targets in the root `Makefile`. macOS and Linux usually have it. On Windows, run `winget install GnuWin32.Make` or `choco install make`, then open a new terminal so `make` is on `PATH`. Run `make` from the repo root (the folder with the `Makefile`).
- Docker (optional) for the [Docker stack](#docker-stack) and for `make test-db-up` (a disposable test database, see [Test database](#test-database)), and on Windows without `sh` for the backend entrypoint tests (see [Test database](#test-database)).

## Commands

The root `Makefile` is the single entry point to install, check, lint, typecheck, and test every part, and CI runs the same targets. Run `make` from the repo root; plain `make` (or `make help`) lists every target with a one-line description.

Run `make install` first, after cloning and after pulling a change to a lock file. The other targets do not install anything: `uv run` syncs the backend by itself, but the frontend and content-build targets fail with "command not found" or "Cannot find module" until `npm ci` has run in that folder.

| Command | What it does |
|---|---|
| `make install` | Install every part (`uv sync --locked` in `backend/`, `npm ci` in `frontend/` and `content-build/`) |
| `make lint` | Lint every part |
| `make typecheck` | Typecheck every part that has one (the frontend and content-build; the backend has none yet) |
| `make test` | Run every test suite (the backend needs `DATABASE_URL`, see [Test database](#test-database)) |
| `make check` | Check that `openapi.yaml` and the generated API client are up to date (needs no database) |

Each part also has its own targets: `install-backend`, `lint-backend`, `test-backend`, `install-frontend`, `lint-frontend`, `typecheck-frontend`, `test-frontend`, `install-content-build`, `lint-content-build`, `typecheck-content-build`, `test-content-build`. `check-openapi` and `check-api-client` are the two steps of `make check`. `migrate-backend` (apply the migrations) and `check-migrations` (models and migrations agree) need a database, so they are in no aggregate. `test-db-up` and `test-db-down` start and stop the disposable test Postgres. A failing command stops `make` with a non-zero exit code. A variable goes after the target and reaches the commands, for example `make test-backend DATABASE_URL=<url>`.

The commands below are what the targets run. Use them directly to run one test file, start the dev servers, or build. Run each on its own line from the repo root. Each starts with `cd`, so it works in PowerShell 5.1 as well as bash.

### Backend (`backend/`)

Install (`make install-backend`; `--locked` fails if `uv.lock` is stale, as it does in CI):

```
cd backend
uv sync --locked
```

Test (`make test-backend`; needs `DATABASE_URL` set to a test database, see [Test database](#test-database); without it pytest stops before running any test). Run one file with `uv run pytest tests/test_home.py`:

```
cd backend
uv run pytest
```

Every response the tests' `TestClient` receives is checked automatically against `openapi.yaml` (see [OpenAPI contract](#openapi-contract)); a mismatch raises `ContractViolation` at the request, naming the route, method, status, or field. If a test fails this check, fix the code or re-export the spec; to accept a status on purpose, mark that test with `@pytest.mark.undocumented_status(<3xx/4xx/5xx statuses>, reason="...")`, and routes the app serves that are not API operations go in `SKIPPED_ROUTES` in `backend/tests/contract.py`. Never silence the check.

Lint (`make lint-backend`):

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

Or set it for one `make` run only, by putting it after the target (the tests need a `_test` database, see [Test database](#test-database)):

```
make test-backend DATABASE_URL=postgresql+psycopg://mcp_lab:secret@127.0.0.1:5432/mcp_lab_test
```

Migrations use Alembic and live in `backend/migrations/`. Run each command on its own line. Apply all migrations (`make migrate-backend`):

```
cd backend
uv run alembic upgrade head
```

Undo all of them (this drops the `app` schema):

```
cd backend
uv run alembic downgrade base
```

Check that the models and the migrations agree (`make check-migrations`; exits non-zero if a migration is missing):

```
cd backend
uv run alembic check
```

The app does not migrate by itself. Only the Docker stack does, on start, because `compose.yaml` sets `RUN_MIGRATIONS_ON_START` to `true` for the backend (the backend image migrates only when that variable is exactly `true`). Production migrates in a separate deploy step ([#35](https://github.com/davbaster/mcp-lab/issues/35)).

#### Test database

The backend tests use a real Postgres database whose name ends in `_test`, taken from `DATABASE_URL`. The suite creates that database itself if it is missing (the role needs the `CREATEDB` permission; otherwise pytest prints the `createdb` command to run by hand), resets it to the migrated schema at the start of every run, and empties the tables before every test. It refuses to run against any other database name, and it stops before running any test if `DATABASE_URL` is unset.

Nine tests in `backend/tests/test_entrypoint.py` run `backend/docker-entrypoint.sh` with `sh`. Where `sh` is on `PATH` (Linux, macOS, CI, or Windows with Git for Windows' `sh`), they use it. On Windows without `sh`, they run the script inside a `python:3.12-slim` container instead (the backend image's base, with no network, removed when it exits), so **Docker Desktop must be running**. If there is neither an `sh` nor a working Docker, these tests fail (they never skip) with a message that says so: start Docker Desktop, or put `sh` on `PATH`. The first run pulls the image.

If `DATABASE_URL` is already set in your terminal for a development database, pytest refuses to run (by design) until you change it to a `_test` database. Run one pytest at a time per test database.

The Docker stack does not publish Postgres to your machine, so the tests use a separate Postgres. Pick one of these.

**a) Docker.** Start a disposable Postgres on `127.0.0.1:5433` (no volume, so nothing is kept). `make test-db-up` runs the `docker run` command below and prints the matching `DATABASE_URL`; `make test-db-up TEST_DB_PORT=5434` uses another host port in both. Postgres needs a few seconds before it accepts connections, and `make` does not wait for it. If Docker fails (port busy, container name already exists), `make` shows Docker's error and exits non-zero.

```
make test-db-up
```

The same, without `make`:

```
docker run --rm -d --name mcp-lab-test-db -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5433:5432 postgres:16
```

Then set `DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test` (PowerShell: `$env:DATABASE_URL = 'postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test'`; bash: `export DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test`; or `make test-backend DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test` for one run) and run the tests. Port 5433 avoids a native Postgres on 5432 and the Docker stack. If 5433 is busy, pick another host port (for example `-p 127.0.0.1:5434:5432`) and use the same port in the URL. Remove the container when you are done (`make test-db-down` runs the same command):

```
docker stop mcp-lab-test-db
```

**b) Windows without Docker.** Install PostgreSQL 16 natively. Use a role with the `CREATEDB` and `CREATEROLE` permissions (the `postgres` role has both; a few tests create temporary roles) and set `DATABASE_URL` to `postgresql+psycopg://<role>:<password>@127.0.0.1:5432/mcp_lab_test`, using your own port if it is not 5432.

Run the tests. `make test-backend` reads `DATABASE_URL` from the environment only (it never sets it and reads no file), so either set it as above or pass it for one run:

```
make test-backend DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test
```

Or, with `DATABASE_URL` already set:

```
cd backend
uv run pytest
```

#### OpenAPI contract

`openapi.yaml` at the repo root is the API contract. It is generated from the backend code. Export it (needs no database and no running server; `make check-openapi` runs the `--check` below):

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

#### Accounts and sessions

A visitor can create an account, and a learner can sign in, ask who they are, and sign out. All routes are JSON under `/api/auth/` and read credentials only from the JSON body (never the URL):

| Route | Success | Errors |
|---|---|---|
| `POST /api/auth/register` | 201 `{"username"}` and a session cookie | 409 `username_taken`, 422 `validation_error` |
| `POST /api/auth/login` | 200 `{"username"}` and a session cookie | 401 `invalid_credentials`, 422 `validation_error` |
| `POST /api/auth/logout` | 204, cookie cleared | none |
| `GET /api/auth/me` | 200 `{"username"}` | 401 `not_authenticated` |

Usernames are 4 to 8 characters from `A-Z`, `a-z`, `0-9`, and `_`, unique ignoring case, and never trimmed. Passwords are 8 to 12 characters, counted after Unicode NFKC normalization. Passwords are stored only as argon2id hashes and session tokens only as SHA-256 hashes.

The session cookie is named `session` with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=86400`, and no `Domain`. `Secure` is always set; no setting turns it off. A session lasts a fixed one day from when it was created: using it does not extend it. Expired rows stay in the table until a cleanup job (#57) removes them.

`Secure` cookies are stored on `http://localhost` by Chrome, Edge, and Firefox. Safari does not store them there, and no browser stores them on a LAN IP address over plain HTTP, so use Chrome, Edge, or Firefox on `http://localhost:8080` for the Docker stack.

The tests get a cookie by building the client with an `https` base URL, `TestClient(app, base_url="https://testserver")`: the client's cookie jar sends a `Secure` cookie only over `https`, so a plain `http://testserver` client would silently drop the session. Time comes from the `current_time` dependency in `backend/app/clock.py`, which tests replace with a fake clock.

To check the cookie by hand, start the Docker stack, open <http://localhost:8080> in Chrome, Edge, or Firefox, and run these in the developer console:

```js
await fetch('/api/auth/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: 'tester1', password: 'secret123'})})
```

The cookie list (Application or Storage tab) then shows `session` with HttpOnly, Secure, and SameSite Lax, and `document.cookie` does not show it. `await fetch('/api/auth/me')` returns 200. `await fetch('/api/auth/logout', {method: 'POST'})` removes the cookie, and `/api/auth/me` then returns 401.

### Frontend (`frontend/`)

Install (`make install-frontend`):

```
cd frontend
npm ci
```

Test (`make test-frontend`):

```
cd frontend
npm test
```

Lint (`make lint-frontend`):

```
cd frontend
npm run lint
```

Typecheck (`make typecheck-frontend`):

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

The dev server proxies `/api` to the backend, so start the backend too (see the backend section) and open <http://localhost:5173/api/health> to check the connection. The proxy target defaults to `http://localhost:8000`. To use another backend address, set `API_PROXY_TARGET` before starting the dev server (bash; in PowerShell use `$env:API_PROXY_TARGET = "http://127.0.0.1:9000"`):

```
cd frontend
API_PROXY_TARGET=http://127.0.0.1:9000 npm run dev
```

`API_PROXY_TARGET` is read by Node in `vite.config.ts` and is never part of the browser bundle. The proxy applies to `npm run dev` only; Docker and production route `/api` through Caddy.

API client (`frontend/src/api/`): the frontend calls the backend only through the typed client generated from `openapi.yaml`. Import `api` from `src/api/client`; direct `fetch` calls are a lint error.

Regenerate the types (writes `src/api/schema.d.ts` from `../openapi.yaml`):

```
cd frontend
npm run generate:api
```

Check that the committed types are up to date (`make check-api-client`; CI runs this; it changes no file and prints the fix when they differ):

```
cd frontend
npm run check:api
```

Run `npm run generate:api` and commit `frontend/src/api/schema.d.ts` in the same change as any `openapi.yaml` change.

### Content build (`content-build/`)

Needs Node 24 (the version in `.nvmrc`): it runs its TypeScript with Node's built-in type stripping, so no TypeScript runner is installed.

Install (`make install-content-build`):

```
cd content-build
npm ci
```

Test (`make test-content-build`), lint (`make lint-content-build`), and typecheck (`make typecheck-content-build`):

```
cd content-build
npm test
```

```
cd content-build
npm run lint
```

```
cd content-build
npm run typecheck
```

Check one course folder against the course format (the path may use `/` or `\`; the fixtures are the examples until `courses/mcp-server` exists):

```
cd content-build
npm run validate -- fixtures/valid/sample-course
```

Every problem is printed on stdout as `<path>[:<line>]: error: <message>` or `<path>[:<line>]: warning: <message>`, followed by `N error(s), M warning(s)`. The command exits non-zero if there is at least one error; warnings alone exit 0. The format is described in [`courses/README.md`](courses/README.md) and the tool in [`content-build/README.md`](content-build/README.md).

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

## Lock files and versions

`backend/uv.lock`, `frontend/package-lock.json`, and `content-build/package-lock.json` are committed. They pin every package, so every machine and every CI run installs the same ones.

- Commit a lock file in the same change as the `pyproject.toml` or `package.json` change.
- `uv add` / `uv remove` and `npm install <pkg>` update the lock file themselves. They add or remove a dependency, so they need approval (see [`AGENTS.md`](AGENTS.md)).
- After you edit a version range by hand, run `uv lock` (backend) or `npm install` (frontend) and commit the result.
- If you forget, CI fails: `uv sync --locked` stops with a "lockfile needs to be updated" error, and `npm ci` stops because `package.json` and `package-lock.json` are out of sync.

To move the backend to another Python minor version, change these together:

- `backend/.python-version`
- `requires-python` in `backend/pyproject.toml`
- both `FROM python:` lines in `backend/Dockerfile`

Every GitHub Action in `.github/workflows/` is pinned to a full commit SHA, followed by a comment with its version (for example `actions/checkout@<sha> # v7.0.1`), because a tag can be moved and a commit cannot. To bump one, find the commit of the new tag, then update the SHA and the version comment together:

```
git ls-remote --tags https://github.com/actions/checkout
```

For an annotated tag, use the line that ends in `^{}`. The uv version CI installs (`version:` of the `setup-uv` step in `ci.yml`) must equal the `uv==` version in `backend/Dockerfile`; change both together.

## CI

Every `run:` step in `.github/workflows/ci.yml` calls a `make` target, so a command that passes locally with `make` passes in CI the same way. The runner needs GNU Make.

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
| `courses/` | Course content. The folder format is in [`courses/README.md`](courses/README.md); the first course comes with [#26](https://github.com/davbaster/mcp-lab/issues/26) onward. |
| `content-build/` | Course validator (and later the MDX compiler), Node and TypeScript. |
| `oncall-mcp/` | The on-call MCP server (filled by [#40](https://github.com/davbaster/mcp-lab/issues/40)). |
