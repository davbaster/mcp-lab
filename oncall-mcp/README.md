# oncall-mcp

The internal on-call MCP server (`MCPServer` from the `mcp` SDK) that on-call engineers, human and LLM, use to monitor and fix the app, plus its adapters and the alert and feedback runners.

The server is added starting with [#40](https://github.com/davbaster/mcp-lab/issues/40). For now this folder holds the `ops` schema, the database the on-call system stores everything in, and the database roles that keep it safe ([#39](https://github.com/davbaster/mcp-lab/issues/39)).

## The `ops` schema

One on-call system serves every deployment, so `ops` has its own Alembic history here, separate from the app's (`backend/`). The app's history manages only the `app` schema and keeps its version table at `public.alembic_version`. The `ops` history keeps its own at `ops.ops_alembic_version` and compares only the `ops` schema, so neither history touches the other's tables.

| Table | What it holds |
|---|---|
| `ops.deployments` | One row per deploy: deployment name, environment, app version, commit SHA, the content SHA of every course (`courses`, JSON), start and end time, who, and the outcome (`succeeded`, `failed_migration`, `failed_health`, `aborted`; NULL while it runs) |
| `ops.alerts` | One row per Grafana `fingerprint` and deployment: status (`firing`, `resolved`), severity (`critical`, `warning`, `info`), service, `course_id`, labels, annotations, first and last seen, resolved time |
| `ops.alert_inbox` | Raw, already redacted webhook payloads, stored before they are processed |
| `ops.incidents` | Deployment, title, status (`open`, `resolved`), opened and resolved time, Grafana's `groupKey` as `group_key` |
| `ops.incident_events` | An incident's timeline: kind (`alert_fired`, `alert_resolved`, `note_added`, `issue_opened`, `pr_opened`), time, author, redacted text |
| `ops.audit_log` | Caller, tool or resource, redacted arguments, result size, outcome (`ok`, `error`, `denied`), time |
| `ops.feedback_triage` | A decision (`valid`, `duplicate`, `invalid`, `needs_human`) about one `app.feedback` item, with reason, issue URL, who and when, and who reopened it and when |

Every `id` is a UUID that the database generates. `deployment` is the deployment's name as text (the backend's `DEPLOYMENT`), not a foreign key. `feedback_triage.feedback_id` has no foreign key either, because `app.feedback` can live in another database. The database enforces the rules: the values above are `CHECK` constraints, `ops.alerts` has one row per (`deployment`, `fingerprint`), and `ops.feedback_triage` has at most one *active* decision per feedback item. A decision is active while `reopened_at` is NULL; reopening sets `reopened_by` and `reopened_at` together and leaves the row as history, so a new decision can be added.

The models are in `oncall_mcp/models.py`, the migrations in `migrations/versions/`.

## Database roles

Migration `0002` creates four `LOGIN` roles and their grants. Nothing is granted to `PUBLIC`.

| Role | Can | Cannot |
|---|---|---|
| `oncall_reader` | `SELECT` every column of `app.feedback` except `account_id`; run health queries (`SELECT 1`) | read `app.accounts`, `app.sessions`, `app.quiz_attempts`, password hashes, or anything in `ops` |
| `ops_writer` | `INSERT`, `UPDATE` and `SELECT` on the `ops` tables, `INSERT` only on `ops.audit_log` | `UPDATE`, `DELETE` or read `ops.audit_log`; `DELETE` anywhere; anything in `app` |
| `ops_retention` | `SELECT` and `DELETE` on `ops.audit_log` and `ops.alert_inbox` | anything else (the evidence columns of the retention job, [#64](https://github.com/davbaster/mcp-lab/issues/64), are not covered yet) |
| `grafana_reader` | `SELECT` on `ops.deployments`, `ops.incidents`, `ops.incident_events` and `ops.alerts` | the other `ops` tables, `app`, any write |

The passwords come from the environment, never from a file in git: `ONCALL_READER_PASSWORD`, `OPS_WRITER_PASSWORD`, `OPS_RETENTION_PASSWORD` and `GRAFANA_READER_PASSWORD` (placeholders in the root `.env.example`). The migration stops with a message naming the missing variable. It hashes each password (SCRAM-SHA-256) before it goes to Postgres, so no password is in a revision file, a statement, a log line or an error message. If a role already exists, only its password is set.

The migration needs a role that may create roles (`CREATEROLE`) and the owner of the `ops` and `app` objects, in practice the database owner or a superuser. Roles belong to the whole Postgres server, not to one database.

The grants on `app.*` are made only if `app.feedback` exists in the database when the migration runs. Run `make migrate-backend` first. When the app is in another database (the isolated mode), `oncall_reader` gets no grant on `app` here and needs the same `GRANT` run against the app's database. A column added to `app.feedback` later is not readable by `oncall_reader` until the grant is run again.

## Commands

Run from the repo root, each on its own line. `make install-oncall-mcp` installs the dependencies (`uv sync --locked`) and `make lint-oncall-mcp` runs ruff.

`OPS_DATABASE_URL` has the same form as the backend's `DATABASE_URL` (see the root README, Database). Set it in your shell. In shared mode it points to the same database as the app, for example the disposable test database (`make test-db-up`):

```
$env:OPS_DATABASE_URL = 'postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test'
$env:ONCALL_READER_PASSWORD = '<a password>'
$env:OPS_WRITER_PASSWORD = '<a password>'
$env:OPS_RETENTION_PASSWORD = '<a password>'
$env:GRAFANA_READER_PASSWORD = '<a password>'
```

(In bash, use `export NAME=value`.) Apply the app's migrations first, then the `ops` ones (`make migrate-oncall-mcp`):

```
make migrate-backend DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5433/mcp_lab_test
make migrate-oncall-mcp
```

Check that the models and the migrations agree (`make check-migrations-oncall-mcp`; exits non-zero if a migration is missing):

```
make check-migrations-oncall-mcp
```

The backend test suite has a test (`test_alembic_check_ignores_other_schemas`) that creates and drops its own `ops` schema in its test database. It fails there while the real `ops` schema exists, and its cleanup would delete it. So for local work, run the `ops` migrations against another database than the one the backend tests use (create it first, then run `make migrate-backend` against it too). CI is not affected, its jobs have separate databases.

Undo them (drops the `ops` tables and the four roles, and leaves the empty `ops` schema with its version table; a role that another database still uses is kept, with a warning):

```
cd oncall-mcp
uv run alembic downgrade base
```
