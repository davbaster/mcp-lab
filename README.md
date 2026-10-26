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
| `make check` | Check that `openapi.yaml`, the generated API client, and the `ids.json` of every course are up to date (needs no database and no git history) |

Each part also has its own targets: `install-backend`, `lint-backend`, `test-backend`, `install-frontend`, `lint-frontend`, `typecheck-frontend`, `test-frontend`, `install-content-build`, `lint-content-build`, `typecheck-content-build`, `test-content-build`. `check-openapi`, `check-api-client`, and `check-content-ids` are the steps of `make check`. `build-content` (build every course into `build/`), `update-content-ids` (write `courses/<id>/ids.json`), `check-content-ids-base` (no published ID was removed without a note, used as `make check-content-ids-base BASE=origin/main`, which needs git history), and `check-images` (build both Docker images and look inside them, see [Docker stack](#docker-stack)) write files or need git or Docker, so they are in no aggregate. `migrate-backend` (apply the migrations) and `check-migrations` (models and migrations agree) need a database, so they are in no aggregate. `test-db-up` and `test-db-down` start and stop the disposable test Postgres. A failing command stops `make` with a non-zero exit code. A variable goes after the target and reaches the commands, for example `make test-backend DATABASE_URL=<url>`.

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

Start the dev server on <http://localhost:8000> (the health check is at <http://localhost:8000/api/health>). It loads the courses at startup, so set `COURSES` and `COURSE_BUILD_DIR` first (see [Courses](#courses)), and `DEPLOYMENT` (for example `local`, see [Metrics and logs](#metrics-and-logs)). `--log-config` makes every log line, uvicorn's too, one JSON object, and `--no-access-log` turns off uvicorn's access log (the app writes its own request line instead):

```
cd backend
uv run uvicorn app.main:app --port 8000 --no-access-log --log-config app/log_config.json
```

#### Courses

At startup the backend loads the built data of every course named in `COURSES` from the build folder `COURSE_BUILD_DIR` (the output of `make build-content`, see the content build below), keeps it in memory, and does not start if anything is missing or broken. The first problem stops it, and the message names the variable, course, file (path inside the build folder), or field. It opens no database connection for this. The load prints one INFO line per course, for example `loaded course alpha-course: 2 chapters, 3 lessons`. It then serves `GET /api/courses` (the courses in the order of `COURSES`) and `GET /api/courses/{course_id}/chapters` (chapters and lessons in order), both public. It also loads the asset map `assets-map/<course_id>.json` of each course and checks the files it lists, and `GET /api/courses/{course_id}/assets/{file_name}` serves only the file names in that map (public, cached for a year).

| Variable | Meaning |
|---|---|
| `COURSES` | The course IDs to serve, separated by commas (`alpha-course,beta-course`; spaces around an entry are ignored). Each is lowercase letters, digits, and hyphens. Required: unset, empty, an empty entry, an invalid ID, or a repeated ID stops the backend. A course in the build folder that is not listed is not served and not read. |
| `COURSE_BUILD_DIR` | The folder the content build wrote (the one with `private/`). Required, and it has no default in the code. The Docker image sets it to `/app/course-build`. |

To run the fixture course natively, build it and point the backend at the result (from the repo root, then the `backend/` folder). In PowerShell use `$env:COURSES = "sample-course"` instead of `export`:

```
cd content-build
npm run build -- fixtures/valid ../build
```

```
cd backend
export COURSES=sample-course COURSE_BUILD_DIR=../build DEPLOYMENT=local
uv run uvicorn app.main:app --port 8000 --no-access-log --log-config app/log_config.json
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
| `POST /api/auth/login` | 200 `{"username"}` and a session cookie | 401 `invalid_credentials`, 422 `validation_error`, 429 `too_many_attempts` |
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

#### Failed-login limits

Repeated failed logins are blocked: 5 failed logins per username and 20 per client address, each in a rolling 15 minutes (`backend/app/rate_limit.py`; the address limit is higher because several learners can share one address). A failure is any login that gets the `invalid_credentials` 401, for an unknown or unregistrable username as well as for a wrong password, and `Ana1`, `ANA1`, and `ana1` share one count. Requests refused with 422 are not login attempts. Once a key is at its limit, every login for it is a 429 with the fixed message `Too many failed sign-in attempts. Try again later.` and `code` `too_many_attempts` (even with the right password, and the same for a username that exists and one that does not), plus `Retry-After` (whole seconds until the block ends) and `Cache-Control: no-store`. A blocked request is not counted, so waiting is the only way out. A successful login clears the count of its username, not the count of its address. The limits are decided before the account is looked up and before any password is checked, so a blocked request costs no password hash.

The counts are rows of `app.rate_limit_failures`, holding only SHA-256 digests (no username and no address), so the limits do not depend on the worker count: they hold across restarts, several uvicorn workers, and several backend containers. Expired rows are deleted by the requests that record new failures. A login that cannot read or write the table fails with the shared 500 `internal_error` instead of skipping the limit. The only log line is `Login limit reached: scope=username` (or `ip`), when a failure first reaches a limit.

The client address is the connection's peer address, unless the peer is a trusted proxy. `TRUSTED_PROXIES` lists those proxies, as comma-separated IP addresses or CIDR ranges (spaces are ignored). Unset or empty trusts no one; a bad entry stops the backend at startup. From a trusted proxy, `X-Forwarded-For` is read from the right, skipping other trusted proxies; the first other entry is the client (the entries on the left are what the sender claimed, so they are never used while a valid entry stands to their right). Without a usable header the peer address is used. From any other peer, `X-Forwarded-For`, `Forwarded`, and `X-Real-IP` are ignored. An IPv4-mapped IPv6 address counts as its IPv4 address and any other IPv6 address per `/64`. The Docker image starts uvicorn with `--no-proxy-headers`, so only this code decides (a native `uvicorn` run still rewrites the address for a peer on `127.0.0.1`; add `--no-proxy-headers` when you test with forged headers).

| Variable | Meaning |
|---|---|
| `TRUSTED_PROXIES` | The proxies whose `X-Forwarded-For` is believed. Unset: everyone behind the proxy shares one count (the proxy's address), so a few learners' typos can block everyone. Too wide: any sender who can reach the backend within the range can forge the header and get fresh counts. `compose.yaml` sets Docker's private ranges (`172.16.0.0/12,192.168.0.0/16,10.0.0.0/8`), which is safe there because the backend publishes no port; in that stack every browser reaches Caddy through Docker's gateway address, so all local sign-ins share one address count. Production and staging set their own value ([#114](https://github.com/davbaster/mcp-lab/issues/114)). |

#### Metrics and logs

The backend serves Prometheus metrics on a separate, internal-only port and writes one JSON line per log event (#36). Both carry the deployment, and the course where the event belongs to one. No password, session token, cookie, quiz answer, query string, username, or IP address reaches a metric label or a log line.

| Variable | Meaning |
|---|---|
| `DEPLOYMENT` | The deployment name, the `deployment` label of every sample and the `deployment` field of every log line: lowercase letters, digits, and hyphens (`^[a-z0-9-]+$`). Required, read when the app starts. Unset, empty, invalid, or `host` (reserved for the server-wide exporters of #37 and #38) stops the backend with a message naming `DEPLOYMENT`. `compose.yaml` sets `${DEPLOYMENT:-local}`. |
| `METRICS_PORT` | The port of the metrics server, default `9000`. A value that is not a port number, or a port already in use, stops the backend with a message naming `METRICS_PORT`. The server runs in the backend's own process and is closed when the app shuts down. (`0` picks a free port, which the tests use.) |

**Access.** `GET /metrics` on the metrics port returns the Prometheus text format and needs no database (a scrape opens no connection, so it works while the database is down). The main app does not serve metrics: `GET /metrics` and `GET /api/metrics` on port 8000 are 404 in the shared error shape, and the routes are not in `openapi.yaml`. The metrics port has no authentication: the network is the control. `compose.yaml` publishes no port for it and Caddy proxies only `backend:8000`, so only containers on the Docker networks the backend joins can reach it. The local `caddy/Caddyfile` answers `/metrics` with 404 itself (otherwise it would fall through to the frontend's `index.html` with status 200). The production site file is #34's.

Only the app's own series are on the page (a dedicated registry: no `process_*`, `python_*`, or `python_gc_*`), and every sample has `deployment`. Label values come from fixed sets or from the configured courses, never from request input.

| Series | Type | Labels | Counted |
|---|---|---|---|
| `http_requests_total` | counter | `deployment`, `method`, `route`, `status` | once per HTTP request when its response has ended |
| `http_request_duration_seconds` | histogram | `deployment`, `method`, `route`, `status` | same moment; seconds from request received to response ended; buckets `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` |
| `lesson_loads_total` | counter | `deployment`, `course` | `GET /api/courses/{course_id}/lessons/{lesson_id}` answered 200 |
| `quiz_submissions_total` | counter | `deployment`, `course`, `outcome` (`passed`, `failed`) | an attempt was saved |
| `quiz_submission_errors_total` | counter | `deployment`, `course` | the quiz-attempt route answered 5xx for a configured course |
| `auth_attempts_total` | counter | `deployment`, `action`, `outcome` | by route and status: `login` `success` (200), `invalid_credentials` (401), `validation_error` (422), `rate_limited` (429); `register` `success` (201), `username_taken` (409), `validation_error` (422). Any other status is only in `http_requests_total` |
| `db_connection_errors_total` | counter | `deployment`, `reason` (`auth`, `timeout`, `refused`, `pool_exhausted`, `other`) | each failed attempt to get a database connection |
| `db_pool_in_use`, `db_pool_waiting`, `db_pool_size` | gauge | `deployment` | read at scrape time: connections checked out now, callers waiting for one now, and the most connections the engine may hold (pool size plus overflow, 15 with SQLAlchemy's defaults) |

- `method` is `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS`; any other method is `other`. `status` is the numeric code as a string. There is no separate 5xx series: use `http_requests_total{status=~"5.."}`. An unhandled exception is recorded once, as `500`.
- `route` is the matched route's template with converters removed (`/api/courses/{course_id}/assets/{file_name}`), equal to a path in `openapi.yaml` for every API route (`/api/docs` and `/api/openapi.json` use their own paths). A request whose route did not fully match (an unknown path, a wrong method, a slash redirect) is `unmatched`. A route that matched and then answered 404 itself keeps its template.
- `course` is a course ID of the catalog (logs call the same thing `course_id`). A request for an unknown course counts in the HTTP series and in no course series.
- Every course-level series, every `auth_attempts_total` pair, and every `db_connection_errors_total` reason exists at 0 from startup, so `increase()` sees the first event.
- `db_connection_errors_total` is classified from the exception type, never from message text. The driver gives no SQLSTATE for a connection that fails while it opens, so `auth` is a failure after the server asked for and got a password (or needs one) and `refused` is a failure with no SQLSTATE and no password involved (not listening, unreachable, name does not resolve). `timeout` is the driver's connect timeout, `pool_exhausted` is SQLAlchemy's `TimeoutError` from a full pool, `other` is anything else. `db_pool_waiting` counts callers inside the pool's `connect()` (SQLAlchemy has no public count of blocked callers), which includes one that is opening a new connection for the moment that takes. The pool keeps SQLAlchemy's default sizes and timeout (#113).
- **Sample budget (for `sample_limit` in #37).** The page holds at most **3619 samples** with one configured course: (18 route and method pairs x 12 statuses + 8 method labels x 3 statuses for `unmatched`) x 15 samples per series (the counter, and the histogram's 11 buckets, `+Inf`, sum, and count) = 3600, plus 4 per course (`lesson_loads`, `quiz_submission_errors`, two `quiz_submissions`), 7 `auth_attempts_total`, 5 `db_connection_errors_total`, and 3 pool gauges. Each further course adds 4. The 12 statuses are the codes in `openapi.yaml`; a test fails when a new route or status makes the number change, and this paragraph is updated with it. Random paths, methods, and course IDs add no series.

**One process per container.** The backend runs one uvicorn process per container: the Dockerfile `CMD` has no `--workers`, and `compose.yaml` sets no `WEB_CONCURRENCY` or `UVICORN_WORKERS` (a test checks all three). The counters, the pool gauges, and the metrics server are per process and share a port, so more processes would give a scrape of one of them. If #113 raises the worker count, it switches to `prometheus-client` multiprocess mode in the same change.

**Logs.** Standard-library `logging` with a small JSON formatter (`app/log_format.py`), set up by `app/log_config.json` (uvicorn's `--log-config`, in the Dockerfile `CMD` and in the dev command above). Each record is one line on stderr holding one JSON object with `timestamp` (UTC, ISO 8601 with milliseconds and a `Z`), `level`, `message`, `deployment`, and `logger`, for every record in the process, uvicorn's startup and shutdown lines included. Fields passed with `extra=` are top-level keys and cannot replace those five. The only line that may carry `"deployment": "unknown"` is the one that reports a missing or invalid `DEPLOYMENT`. The existing lines keep their text and gain fields: `Quiz attempt graded` has `course_id`, `chapter_id`, `score`, `total`, `outcome`; `Feedback stored` has `course_id` and `category`; `loaded course` has `course_id`; `Login limit reached` has `scope`.

- **Request line.** Every HTTP request writes one `INFO` line when its response ends, with `message` `request completed`, `request_id`, `method`, `route` (the metric's label), `status`, `latency_ms`, and `course_id` for a configured course. It has no path, query string, header, body, address, username, or account ID. Uvicorn's access log is off.
- **Request ID.** A valid `X-Request-ID` request header (letters, digits, and hyphens, 1 to 64 characters, sent once) is kept; anything else is replaced by a new UUID. It is returned in the `X-Request-ID` response header of every response, including the 500 after an unhandled exception, and every record written while the request is handled carries it as `request_id` (also in the thread a sync route runs in). It is not in the JSON error body and not in `openapi.yaml`. Records outside a request have no `request_id`, `method`, `route`, `status`, or `latency_ms` key.
- **Stack traces.** An unhandled exception writes one `ERROR` record with the whole trace in the single string field `stack_trace`; the second record that uvicorn would write for the same exception is dropped. For a validation error the trace and the message hold each error's location and type only, never the submitted or returned values; a database error's trace stops before Postgres's `DETAIL:` (the failing row).
- **Redaction.** A filter on the handler covers records of every logger. It replaces with `[REDACTED]` the value of any key whose name (lowercased, `-` read as `_`) contains `password`, `token`, `session`, `cookie`, `authorization`, `answers`, `option_id`, `correct`, or `explanation`, in `extra` fields, in `args` mappings, and at any depth of dicts and lists. In every string it masks `session=...`, `Bearer ...`, `Cookie:`, `Set-Cookie:`, and `Authorization:` header text to the end of the line, `key=value`, `key: value`, and quoted `'key': 'value'` pairs for the same names, and the query string of any URL or path. A name such as `session_count` is masked too; over-masking is accepted.

**Look at it in the Docker stack.** The stack publishes only Caddy. `curl -i http://localhost:8080/metrics` and `/api/metrics` are both 404 and neither body holds `http_requests_total`. Inside the network:

```
docker compose exec backend python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:9000/metrics').read().decode())"
```

and `docker compose logs backend` shows the JSON lines.

**Notes for #37 and #38.** Prometheus renames a scraped label that clashes with a target label to `exported_deployment` unless the job sets `honor_labels: true`. The backend sets `deployment` itself, so #37's backend job must keep the app's label (or not set one on that target). The container health check (every 5 seconds) and the blackbox probe both hit `/api/health`, which would dilute request-rate and 5xx-ratio queries at quiet hours; the `route` label lets a recording rule exclude `route="/api/health"`.

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

Install (`make install-content-build`; it runs both commands):

```
cd content-build
npm ci
```

```
cd content-build
npm run install:browser
```

`npm ci` installs the packages and downloads no browser. `npm run install:browser` downloads **chrome-headless-shell** (about 120 MiB to download, 274 MB on disk, a few seconds) into puppeteer's cache (`~/.cache/puppeteer`, `%USERPROFILE%\.cache\puppeteer` on Windows; `PUPPETEER_CACHE_DIR` changes it). Only `npm run build` needs it, and only when a lesson has a `<Diagram source="...">` that is not in the cache; `validate`, `compile`, and `ids:*` never start it, and a build without such a diagram works with no browser installed.

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

Build every course in `courses/` into `build/` (`make build-content`; `COURSES=<id>,<id>` limits the build; the build writes nothing if any course has an error). The folder `build/` is ignored by git; with no course in `courses/` it holds only empty `private/` and `public/`:

```
cd content-build
npm run build -- ../courses ../build
```

#### Diagrams

A diagram is `<Diagram alt="..." source="..." />` with Mermaid text. The build draws it to an SVG file (in a Chromium that it starts), so lessons ship no diagram code and the learner's browser never loads Mermaid. How to write one:

- Write a double quote in a label as `&quot;`, or put the prop in single quotes.
- MDX removes the spaces at the start of every line of the prop, so indentation cannot carry meaning.
- The supported types are `flowchart`, `graph`, `sequenceDiagram`, `classDiagram`, `stateDiagram`, `stateDiagram-v2`, `erDiagram`, and `pie`. The first word of the first line that is not blank and not a `%%` comment is the type.

The rules for authors are in [`courses/README.md`](courses/README.md#diagrams). The settings, the cache, the browser flags, the Linux libraries the browser needs, the two tiers of tests, how to upgrade Mermaid or Chromium and regenerate the golden SVGs, why Linux is the reference platform for diagram bytes, and the Windows note are in [`content-build/README.md`](content-build/README.md#diagrams).

The checks on the drawn SVG are one layer. `Image` and `Diagram` show an SVG as an `<img>` (#19), which does not run scripts, and the asset route sends `Content-Security-Policy: script-src 'none'; default-src 'none'; style-src 'unsafe-inline'; sandbox` (#58). The browser has no network and runs with its sandbox on, except that `--no-sandbox` is added when the build runs as root or when `MERMAID_NO_SANDBOX=1` is set (Ubuntu 24.04 can block the sandbox for a normal user). That is acceptable because the page holds only Mermaid and lesson text from this repo, offline.

Write the `ids.json` of every course (`make update-content-ids`), check that they are up to date (`make check-content-ids`), and check that no published ID was removed without a note in `MIGRATIONS.md` (`make check-content-ids-base BASE=origin/main`; needs git history, so a shallow clone fails and says so):

```
cd content-build
npm run ids:update -- ../courses
```

```
cd content-build
npm run ids:check -- ../courses
```

```
cd content-build
npm run ids:check -- ../courses --base origin/main
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

The backend image builds the course content itself, in its first stage (`FROM node:24-alpine AS content`, the major version of `.nvmrc`): it runs `npm ci` and `npm run build -- ../courses ../build` on every course in `courses/`, and the runtime stage holds the result in `/app/course-build` (`COURSE_BUILD_DIR`). No other step is needed, and a course with an error stops `docker compose up --build`. The build context of the backend is the repo root (`compose.yaml`: `context: .`, `dockerfile: backend/Dockerfile`), and `backend/Dockerfile.dockerignore` is an allowlist, so a local `build/` folder and the rest of `frontend/` never enter it. The frontend image never holds course data. To see the output in the running stack (with no course in `courses/` yet, the folders are empty):

```
docker compose exec backend ls /app/course-build/private
```

`make check-images` builds both images (the backend one with the fixture course in place of `courses/`), looks for the build output in the backend image, readable by its non-root user, and searches the frontend image for any folder named `private` or `course-build` and any `01-first-steps.json` or `sample-course.json` (the empty system folder `/etc/ssl/private` of the base image is allowed). The same search in the backend image must find them, so it cannot pass by finding nothing. It needs Docker, fails when Docker is missing, and removes the images and containers it made. `COURSES` is read by the backend at run time (#13), not at image build.

The backend serves the courses named in `COURSES`, which compose sets to `${COURSES:-mcp-server}`. Until the first course exists in `courses/` ([#26](https://github.com/davbaster/mcp-lab/issues/26)), `docker compose up` therefore stops the backend with `No manifest for the course mcp-server`. To run the fixture course instead, set both lines in `.env` (see `.env.example`): `COURSES_DIR=content-build/fixtures/valid` (the folder the image builds its courses from; compose passes it as the build argument) and `COURSES=sample-course`, then run `docker compose up --build` again.

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
- both `FROM python:` lines in `backend/Dockerfile` (the `FROM node:` line of its first stage follows the major version in `.nvmrc`)

Every GitHub Action in `.github/workflows/` is pinned to a full commit SHA, followed by a comment with its version (for example `actions/checkout@<sha> # v7.0.1`), because a tag can be moved and a commit cannot. To bump one, find the commit of the new tag, then update the SHA and the version comment together:

```
git ls-remote --tags https://github.com/actions/checkout
```

For an annotated tag, use the line that ends in `^{}`. The uv version CI installs (`version:` of the `setup-uv` step in `ci.yml`) must equal the `uv==` version in `backend/Dockerfile`; change both together.

## CI

Every `run:` step in `.github/workflows/ci.yml` calls a `make` target, so a command that passes locally with `make` passes in CI the same way. The runner needs GNU Make.

CI runs on the self-hosted runner on the owner's VPS (labels `self-hosted`, `Linux`, `X64`, `ubuntu-24`), not on GitHub-hosted runners. Jobs queue while that runner is busy or offline. The runner needs Docker, because the `backend` job starts a Postgres service container and the `docker-images` job builds the images.

The `content-build` job checks out the whole history (`fetch-depth: 0`). `make install-content-build` also downloads the headless Chromium (a few seconds; the runner does not keep `~/.cache/puppeteer` between jobs unless it is set up to), and the tests of both tiers need it. The runner needs the `unzip` command to unpack the browser, and the browser needs the system libraries listed in its `deb.deps` file (see [`content-build/README.md`](content-build/README.md#the-browser)); if the runner lacks some, install them on the runner, not from the job. The runner is Ubuntu 24.04, where AppArmor blocks the browser's sandbox for a normal user (`No usable sandbox`), so the job sets `MERMAID_NO_SANDBOX: 1` in its `env:` (this job only). That is acceptable because the page holds only Mermaid and lesson text from this repository, and the browser has no network. After the tests it runs `make build-content`, which builds every course in `courses/` (so CI proves the real courses build), and `make check-content-ids-base`, which fails when a published chapter, lesson, or question ID was removed or renamed without a note in the course's `MIGRATIONS.md`. For a pull request, or a push to a branch other than `main`, it compares with `origin/main`; for a push to `main`, with the commit before the push (`github.event.before`; the first push, whose base is all zeros, skips the comparison). The base reaches the Makefile through the step's `env: BASE:`. The job is not a required check yet (that is a ruleset change, see Branch protection). The `docker-images` job runs `make check-images`.

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
| `content-build/` | Course validator, MDX compiler, and build, Node and TypeScript. |
| `oncall-mcp/` | The on-call MCP server (filled by [#40](https://github.com/davbaster/mcp-lab/issues/40)). |
