# Build an MCP Server — Guided Course Plan

## Product boundary

One free, guided web course that teaches beginners how to build a Model Context Protocol (MCP) server in Python. The course has reading, rich media (video, 3D models, diagrams), and code walkthroughs, and a quiz ends each chapter. It is not a lab environment or a hosting service.

**One app, many possible courses.** v1 ships one course, but the app is course-agnostic: course content lives in its own folder (see [Content authoring](#content-authoring)), and every course-related table, endpoint, and log carries a `course_id`. Adding a second course is a content task, not a code fork. The same code and image can run in either mode (see [Deployment modes](#deployment-modes)). Courses are always authored in the repo and built by CI; the app never accepts uploaded HTML, JS, or zip packages at runtime.

Separately from the course content, the repo also contains an internal **on-call MCP server** (`oncall-mcp/`) that the human and LLM on-call engineers use to monitor and fix this app. See [Operations: on-call MCP server](#operations-on-call-mcp-server). Learners never see it.

Throughout the course, learners follow along building a **personal-notes MCP server**. They start with a FastMCP "hello" tool and finish with CRUD tools, resources, prompts, and both transports. The web app shows the code but never runs it. Learners can type it into their own machine if they want, but nothing is checked or graded there.

**Audience:** developers who know basic Python (functions, type hints, `pip`/`uv`) and have never used MCP. A readiness checklist appears before Chapter 1, and [CS50's Introduction to Programming with Python](https://cs50.harvard.edu/python/) is recommended but not required.

**Language:** English only.

## Learner experience

- Free self-enrollment with username and password, using a secure HTTP-only session cookie. Password recovery is out of scope.
- Visitors can read all of Chapter 1 without an account. Taking a quiz or saving progress needs an account.
- The dashboard shows each chapter's status (locked / in progress / passed), the best quiz score per chapter, and a **Resume** button.
- Each chapter is a sequence of short lesson pages, followed by the chapter quiz.
- Lesson pages have prose and rich media built from the [content component library](#content-component-library): video, 3D models, diagrams, images, callouts, and a **code viewer**:
  - syntax highlighting, file tabs, and a copy button
  - "step" mode that highlights the lines changed since the previous step, so learners see the server grow
  - the full project as it stands at the end of each chapter, downloadable as a ZIP
- The layout is responsive and works on desktop, tablet, and phone.

## Quizzes and progression

- Each chapter ends with **5 multiple-choice questions**, each with exactly one correct answer. Some questions include a code snippet.
- A learner needs **4 of 5 (80%)** to pass a chapter and unlock the next one. Chapters unlock in order.
- Retries are unlimited. Option order is shuffled on every attempt.
- After a failed attempt, the learner sees which questions were wrong plus a pointer to the relevant lesson, but not the correct answer.
- After passing, the learner sees every question's correct answer and explanation.
- Answer keys stay on the server. The backend grades submissions and stores every attempt.
- The course is **complete** when all 6 chapters are passed, and the dashboard then shows a completion state. There is no certificate.

## Learner feedback

- Every page has a **Send feedback** button. Signed-in learners can use it; visitors are asked to sign in first.
- **Form fields:**
  - category (required): **Bug**, **Content error** (something is wrong in a lesson, code sample, or quiz), **Confusing explanation**, or **Suggestion**
  - message (required, 10–2000 characters)
  - an optional "this is about the current quiz question" checkbox when the form is opened from a quiz
- **Context collected automatically:** page URL, course, chapter and lesson ID, quiz question ID (if relevant), app version, browser and device, timestamp, and the last 10 frontend console errors. Quiz answers, passwords, and session tokens are never collected.
- **What the learner sees:** a confirmation ("Thanks — we'll review it") and nothing more. There is no status tracking or email.
- **Limits:** 10 submissions per learner per day. The same message submitted twice within a minute is ignored.
- **Storage:** the backend stores each submission in `app.feedback` (status `new`) through `POST /api/feedback`, which is defined in `openapi.yaml` like every other endpoint. The learner's identity is stored as an internal ID only and never leaves the backend.

## Curriculum

The course has 6 chapters, each with about 4–6 short lessons. It targets the official Python SDK (`mcp` package, `mcp.server.fastmcp.FastMCP`) and the current MCP specification.

### Chapter 1 — What is MCP?

Lessons:
1. The problem MCP solves: N apps × M integrations become one protocol.
2. Hosts, clients, and servers: a host runs one client per server connection.
3. The three server primitives and who controls each: tools (model), resources (application), prompts (user).
4. Messages: JSON-RPC 2.0 requests, responses, and notifications.
5. Lifecycle: `initialize` → capability negotiation → `notifications/initialized` → normal operation.
6. Transports at a glance: stdio and Streamable HTTP.

Quiz:
1. In MCP, which component keeps a one-to-one connection with a single server? **Client** · Host · Transport · Registry
2. Which primitive is meant for the *model* to invoke in order to take actions? **Tools** · Resources · Prompts · Roots
3. What message format does MCP use? **JSON-RPC 2.0** · GraphQL · gRPC/Protobuf · Plain REST
4. What is the first request a client sends to a server? **`initialize`** · `tools/list` · `ping` · `resources/read`
5. Prompts are primarily controlled by… **The user (e.g. picked from a menu or slash command)** · The model · The server, automatically · The operating system

### Chapter 2 — Your first server

Lessons:
1. Setup: Python 3.10+, `uv init notes-server`, `uv add "mcp[cli]"`.
2. `server.py`: `mcp = FastMCP("notes")`, an `add(a: int, b: int)` tool, and `mcp.run()`.
3. How FastMCP turns a function into a tool: the name comes from the function, the schema from the type hints, and the description from the docstring.
4. Inspecting the server: `mcp dev server.py` opens the MCP Inspector, where learners walk through `tools/list` and `tools/call`.
5. Reading the raw JSON-RPC traffic in the Inspector.

Quiz:
1. Which command adds the Python MCP SDK with its CLI tools to a uv project? **`uv add "mcp[cli]"`** · `pip install fastmcp-cli` · `uv tool install inspector` · `npm i @mcp/server`
2. *(snippet: `@mcp.tool()` on `def add(a: int, b: int) -> int`)* Under what name do clients see this tool? **`add`** · `tool_1` · `mcp.add` · It has no name until you pass `name=`
3. Where does FastMCP get a tool's input schema? **From the function's type hints** · From a separate JSON file · From the return value · The client infers it
4. What does `mcp dev server.py` do? **Runs the server and opens the MCP Inspector to test it** · Deploys the server · Generates a client · Formats the code
5. What transport does `mcp.run()` use when no argument is given? **stdio** · Streamable HTTP · WebSocket · HTTP+SSE

### Chapter 3 — Building tools: the notes CRUD

Lessons:
1. A small SQLite storage module (provided in full in the code viewer).
2. `create_note`, `list_notes`, `get_note`, `update_note`, and `delete_note`.
3. Writing names and docstrings for an LLM reader: when to call the tool and what each argument means.
4. Return values: plain values versus typed/structured output.
5. Errors: raising an exception produces a tool result with `isError: true`, not a crash.
6. Tool annotations: `readOnlyHint` and `destructiveHint`.

Quiz:
1. Why do tool docstrings matter? **They become the description the model uses to decide when and how to call the tool** · They are required for Python to run · They speed up execution · They are only for human maintainers
2. `get_note` raises `ValueError("Note 42 not found")`. What does the client receive? **A tool result marked `isError: true` with the message** · The server process crashes · The connection closes · An empty successful result
3. Which annotation best fits `delete_note`? **`destructiveHint: true`** · `readOnlyHint: true` · `openWorldHint: false` only · No annotation applies
4. *(snippet: `def get_note(note_id):` with no type hint)* What problem does this cause? **The input schema has no type for `note_id`, so the model gets no guidance on what to pass** · Python raises a `SyntaxError` · The tool is hidden from clients · Nothing; FastMCP infers `int`
5. Which design is generally better for an LLM? **Separate focused tools (`create_note`, `delete_note`, …) with clear schemas** · One `manage_notes(action: str, data: str)` tool · One tool that runs raw SQL · No tools; only prompts

### Chapter 4 — Resources and prompts

Lessons:
1. Resources versus tools: context to read versus actions to take.
2. A static resource: `@mcp.resource("notes://index")`.
3. A resource template: `@mcp.resource("notes://{note_id}")`.
4. Prompts: `@mcp.prompt()` `summarize_note(note_id)`, which returns messages.
5. Choosing the right primitive: a decision guide.

Quiz:
1. What is the main difference between a resource and a tool? **Resources expose read-only context the application chooses to include; tools perform actions the model invokes** · Resources are faster · Tools cannot take arguments · There is no difference
2. `@mcp.resource("notes://{note_id}")` defines a… **Resource template** · Tool · Prompt · Transport
3. Which method does a client call to get a resource's contents? **`resources/read`** · `resources/call` · `tools/call` · `prompts/get`
4. Users should be able to pick "Summarize this note" from a menu in their client. Which primitive fits? **Prompt** · Tool · Resource · Notification
5. Which of these should be a tool rather than a resource? **Creating a new note** · The list of note titles · A single note's content · The notes count

### Chapter 5 — Transports and connecting real clients

Lessons:
1. stdio: the client launches the server as a subprocess, and messages flow over stdin and stdout.
2. The golden rule: never write to stdout. Log to stderr.
3. Connecting to Claude Desktop with `claude_desktop_config.json` (`mcpServers`, `command`, `args`, `env`).
4. Streamable HTTP: `mcp.run(transport="streamable-http")`, which uses a single endpoint, POST for client messages, optional SSE streaming, and the `Mcp-Session-Id` header.
5. Choosing between them: local personal tools versus shared or remote servers.
6. Local HTTP safety: bind to `127.0.0.1`, validate `Origin`, and add authentication before exposing the server remotely.

Quiz:
1. Why does `print("debug")` break a stdio server? **stdout carries the protocol messages, so stray text corrupts them** · `print` is disabled in MCP · It slows the server · It doesn't break anything
2. With the stdio transport, who starts the server process? **The client/host** · The user, manually, every time · A cloud scheduler · The server starts itself at boot
3. *(snippet: Claude Desktop config)* Which top-level key lists the servers to launch? **`mcpServers`** · `servers` · `tools` · `plugins`
4. How does a client send messages to a Streamable HTTP server? **HTTP POST to the server's single MCP endpoint** · A new WebSocket per message · Writing to the server's stdin · DNS TXT records
5. Which setting matters most when running a Streamable HTTP server locally? **Bind to `127.0.0.1` and validate the `Origin` header** · Disable all logging · Use port 80 · Run as administrator

### Chapter 6 — Context, testing, and shipping

Lessons:
1. The `Context` object: `ctx: Context` gives a tool `await ctx.info(...)` for logging and `ctx.report_progress(...)` for progress.
2. Lifespan: open the SQLite connection once and share it with every tool.
3. Testing: unit-test the storage module, then call `list_tools()` / `call_tool()` on the server from pytest.
4. Configuration and secrets through environment variables, passed with the client config's `env` block.
5. Safe inputs: validate IDs, constrain file paths, and never build SQL from strings.
6. Shipping: `pyproject.toml`, `uv run`, and a README with a ready-to-paste client config.

Quiz:
1. How should a tool send log messages to the client? **Accept a `ctx: Context` parameter and call `await ctx.info(...)`** · `print()` to stdout · Return logs inside the tool result · Write them to a resource
2. An `import_notes` tool takes 30 seconds. How do you keep the user informed? **Call `ctx.report_progress(...)` as work proceeds** · Split it into 30 tools · Return early and hope · Raise an exception halfway
3. Where should the server open its SQLite connection so that it happens once for the server's lifetime? **In the server's lifespan handler** · Inside every tool call · In the client · In the docstring
4. The server needs an API key for an external service. Where should it come from? **An environment variable set in the client config's `env`** · Hardcoded in `server.py` · A tool argument the model fills in · A public resource
5. An `export_notes(path: str)` tool writes a file. What is the main risk? **Path traversal: the model could write outside the intended folder, so restrict paths to an allowed directory** · The file may be too small · JSON is not supported · There is no risk

## Content authoring

Each course is a self-contained folder under `courses/`, separate from the app code. It can later move to its own repo without app changes.

```
courses/mcp-server/
├── course.yaml                # id, title, description, chapter order, free-preview chapters
├── assets/                    # images, .glb 3D models, diagram sources (no video)
└── chapters/03-tools/
    ├── 02-crud.mdx            # lesson: front-matter (title, order) + MDX body
    ├── code/step-N/           # real code files for the code viewer
    └── quiz.yaml              # the chapter quiz
```

- **Lessons are restricted MDX:** Markdown plus component tags from the [content component library](#content-component-library), with literal props only, e.g. `<Video src="..." />`. JavaScript expressions, `import`/`export`, inline `<script>`, raw HTML event handlers, and unknown components fail the build.
- **Build output is data, not code.** The content build compiles each lesson to a JSON tree (Markdown nodes plus allowlisted component nodes with validated props). The backend serves that tree through the API, so lesson access control (free preview, locked chapters) stays on the server. The frontend renders it with a fixed component registry. No course ever ships executable code.
- **Code steps** live as real files under `chapters/NN-slug/code/step-N/`. The build computes diffs for step mode and the per-chapter ZIPs.
- **Quizzes:** each chapter's quiz is in `chapters/NN-slug/quiz.yaml` (question, optional snippet, options, correct option, explanation, lesson link). The backend loads it at startup and never sends the correct option or explanation before the learner passes. Quizzes are always platform-rendered and server-graded; course content cannot define its own quiz pages or report scores.
- **Stable IDs:** chapter, lesson, and question IDs come from the folder and file names (or an explicit `id` in front-matter) and must not change once published, because progress, attempts, and feedback reference them. CI fails if a published ID disappears without a migration note.
- **Per-course CI:** CI checks that the code in each chapter's final step passes `python -m py_compile` and the course's own test suite (for this course, the pytest suite from Chapter 6), so the published code stays correct.

### Content component library

Components live in the frontend (`frontend/src/content-components/`). Each one declares a props schema that the content build validates against. Any course can use any component, and adding a new one is a normal reviewed code change to the app, not a content change.

Initial set:

| Component | Purpose | Notes |
|---|---|---|
| `Video` | lesson video | `src` must be on an allowlisted media origin (the app's media bucket/CDN, or YouTube/Vimeo embeds); optional captions (`.vtt`) and poster |
| `Model3D` | interactive 3D model | `.glb`/`.gltf` from the course `assets/`, built on `<model-viewer>`; rotate/zoom, poster image fallback on low-end devices |
| `Diagram` | diagrams | Mermaid source rendered at build time to SVG, or an SVG from `assets/` |
| `Image` | images | from `assets/`, with required `alt` |
| `Callout` | tip / warning / note boxes | |
| `Tabs` | tabbed alternatives (e.g. macOS / Windows) | |
| `CodeSteps` | the code viewer | step mode, file tabs, copy, ZIP download |

**Media hosting:** videos are not stored in the repo or database. They live in object storage behind a CDN (or on YouTube/Vimeo), and the course references them by URL. Images and 3D models ship with the course `assets/` and are served as static files. The frontend's Content-Security-Policy allows only the app's own origin plus the allowlisted media origins.

## Application architecture

The frontend and backend are two separate applications. They communicate **only** through the backend's REST API, and that API is described by `openapi.yaml`.

- **Frontend** (`frontend/`): React, TypeScript, Vite, with Shiki for highlighting. A static build served by its own container. It has no database access and no shared code with the backend. Everything it knows comes from the API.
- **Backend** (`backend/`): Python, FastAPI. It owns all data, authentication, and quiz grading.
- **Database:** PostgreSQL for accounts, sessions, chapter progress, and quiz attempts. Progress, attempts, and feedback rows carry a `course_id`. Accounts are shared across courses within one deployment. Only the backend (and `oncall-mcp`'s read-only role) connects to it.
- **Deployment:** Docker Compose on one VM with separate `frontend`, `backend`, and `postgres` services behind a reverse proxy with TLS. The proxy routes `/api/*` to the backend and everything else to the frontend. The observability stack and `oncall-mcp` described under Operations run alongside.
- **Staging:** a separate Docker Compose project on the same VM with its own ports and database. It never replaces or shares data with production.

### Deployment modes

The courses a deployment serves are set by configuration (`COURSES=mcp-server,...`), never by changing code. There is one codebase and one image, and courses never get their own forks.

- **Shared (default):** one deployment serves every configured course. This uses the least RAM and has one thing to patch and monitor.
- **Isolated:** one deployment per course from the same image, each with its own domain and config. A problem in one deployment cannot reach another's learners or data. To keep memory down, isolated deployments may share one Postgres server (a separate database and role each) and one observability stack (with a `deployment` label on every metric, log, and alert).

v1 runs one course in shared mode.

There are no WebSockets.

### API contract (`openapi.yaml`)

- **Single source of truth:** `openapi.yaml` at the repo root describes every endpoint, request, response, and error shape the frontend may use.
- **The backend produces it:** FastAPI's Pydantic models and routes generate the spec, and a script exports it to `openapi.yaml`. Every backend change to the API commits the updated file in the same PR. The running backend also serves it at `/api/openapi.json`, with interactive docs at `/api/docs`.
- **The frontend consumes it:** a typed TypeScript client is generated from `openapi.yaml` into `frontend/src/api/` and committed. React uses only this client; handwritten `fetch` calls to the API are not allowed.
- **CI enforces the contract.** The build fails if:
  - the spec exported from the backend differs from the committed `openapi.yaml`
  - the generated frontend client differs from what `openapi.yaml` produces
  - the frontend doesn't type-check against the client
  - backend contract tests find responses that don't validate against `openapi.yaml`
- **Errors:** every error uses one shared JSON shape (`{ "error": { "code", "message" } }`) defined in the spec.
- **Auth:** the session cookie is documented in the spec as a cookie security scheme.
- **No version prefix** in v1.

Core endpoints: register / login / logout / me; list courses; list a course's chapters with status; get lesson content (the compiled JSON tree); get quiz (without answers); submit quiz attempt → score, wrong question IDs, and the answers and explanations if passed; get progress; submit feedback. Course-specific endpoints live under `/api/courses/{course_id}/...`.

## Operations: on-call MCP server

An internal MCP server, `oncall-mcp/` in this repo, gives on-call engineers one set of tools to watch the app's performance and investigate and fix issues. Two kinds of callers use the same tools:

- **Human on-call engineer**, from an MCP client such as Claude Code or Claude Desktop.
- **LLM on-call engineer**, an automated agent session started by a critical Grafana alert or by new learner feedback (Phase 4).

### Observability foundation (prerequisite)

- **Metrics:** the FastAPI app exposes Prometheus `/metrics` (request rate, latency, 5xx, quiz-submission errors). A Postgres exporter and node/container exporters cover the database and host. Prometheus scrapes them all. Every series carries a `deployment` label, and course-level series (lesson loads, quiz submissions and errors) also carry `course`, so one observability stack can serve shared and isolated [deployment modes](#deployment-modes).
- **Logs:** container logs are shipped to Loki (via Promtail). The app logs structured JSON with `deployment` and, where relevant, `course_id`, and never logs passwords, session tokens, or quiz answers.
- **Alerts:** Grafana is what wakes up the LLM on-call engineer. A Grafana webhook contact point POSTs its alert JSON payload to the runner's wake endpoint (see [Grafana alert contract](#grafana-alert-contract)). The runner stores alerts and incidents in an `ops` Postgres schema. Initial **critical** alerts:
  - app unavailable or health check failing
  - sustained HTTP 5xx
  - slow API responses (p95 above threshold)
  - Postgres connection failures
  - sustained CPU, memory, or disk pressure

  Warnings are recorded but do not start the LLM engineer.
- **Deploy history:** the deploy script records each deployment (deployment name, environment, app version, commit SHA, the courses served with each course's content commit SHA, time, who) in `ops.deployments`. A content-only change is a deployment like any other, so it shows up when comparing deployments.

### Server design

- Python and FastMCP, in the same style the course teaches.
- **Core plus adapters.** The core holds the tools, resources, prompts, redaction, audit log, and auth. Adapters hide the data sources behind small interfaces: `HealthAdapter`, `MetricsAdapter` (Prometheus), `LogsAdapter` (Loki), `DeploymentsAdapter` (`ops.deployments` + git), and `IssueTracker` (GitHub). Adapters for this app live in `oncall-mcp/adapters/course_app/`. Fake adapters with fixture data are used for tests and local development, and make the core reusable in other projects.
- **Transport:** Streamable HTTP, bound to the internal Docker network. It is not exposed publicly; humans reach it through an SSH tunnel. Every caller has its own bearer token (one per human, one for the LLM engineer), and the token's identity is written to the audit log.
- **One server for all deployments.** A single `oncall-mcp` covers every deployment on the VM, in both shared and isolated modes. Tools and resources accept optional `deployment` and `course` filters. A caller's token can be limited to specific deployments, and the server enforces that limit on every call, so isolated deployments stay isolated during on-call work too. With one shared deployment, the filters can be omitted.

### Capabilities

Each primitive in the course's sense (tool, resource, or prompt):

| Group | Name | Primitive | Notes |
|---|---|---|---|
| Inspect | `list_active_alerts` | tool, read-only | firing alerts with severity, service, deployment, and course (if any) |
| Inspect | `get_service_health` | tool, read-only | health checks for API, frontend, Postgres, and staging, per deployment |
| Inspect | `alert://{id}` | resource | full alert: labels, values, dashboard link |
| Inspect | `incident://{id}` | resource | incident timeline, linked alerts, notes, issues and PRs |
| Investigate | `query_allowed_metrics` | tool, read-only | accepts only **named queries** from an allowlist (e.g. `api_p95_latency`, `http_5xx_rate`) plus service, deployment, optional course, and time window. Never raw PromQL. |
| Investigate | `search_redacted_logs` | tool, read-only | service, deployment, optional course, text filter, and time window, with capped window and result count; output is redacted |
| Investigate | `compare_deployments` | tool, read-only | app commits, per-course content commits, changed files, and key metric deltas between two deployments |
| Respond | `run_staging_checks` | tool, side effect | deploys a git ref to staging, runs the content build for every course, tests, and smoke tests, and returns the report |
| Respond | `open_github_issue` | tool, side effect | redacted title, body, and evidence links, labeled `oncall` |
| Respond | `add_incident_note` | tool, side effect | saves a summary or finding to the incident |
| Feedback | `list_pending_feedback` | tool, read-only | untriaged feedback: ID, category, deployment, course, chapter or lesson, age |
| Feedback | `feedback://{id}` | resource | redacted feedback message and collected context, with the referenced lesson (its `.mdx` source path and source), code step, or quiz question attached |
| Feedback | `search_github_issues` | tool, read-only | searches open and closed issues to find duplicates, optionally filtered by `course:<id>` label |
| Feedback | `triage_feedback` | tool, side effect | records a decision (`valid`, `duplicate`, `invalid`, or `needs_human`) with a reason and an optional issue URL in `ops.feedback_triage` |
| Respond | `incident_summary` | prompt | turns `incident://{id}` into a structured summary |
| Respond | `fix_summary` | prompt | turns an incident and a branch into a PR description: cause, fix, staging result, risk |

Because many MCP clients only attach resources at the user's or application's request, the Phase 4 agent runner attaches the triggering `alert://` and `incident://` resources at the start of each session. Humans attach them with an @-mention.

### Safety rules (enforced in code, not left to the model)

- **Redaction happens in the core** before any tool or resource returns data. It removes passwords, tokens, cookies, emails, usernames, and quiz answers, and has its own tests.
- **Allowlisted metric queries and capped log searches** only.
- **Audit log:** every call writes to `ops.audit_log` (caller, tool or resource, redacted arguments, result size, outcome, time). The log is kept for 30 days, along with incident evidence.
- **No production-changing tools:** no deploy, restart, or database writes to app tables, and no shell access. Health checks and feedback reads use a read-only database role (one per deployment database in isolated mode), and triage decisions are written only to the `ops` schema.
- **Deployment scoping:** a token limited to some deployments cannot read alerts, metrics, logs, incidents, or feedback from any other deployment. Out-of-scope requests are rejected and audited.
- **Feedback is untrusted input.** Learner text is passed to the model as data inside clear delimiters, never as instructions. Feedback triage sessions get only the Feedback tools plus `open_github_issue`. They have no repo, staging, or fix access, so a malicious message cannot trigger anything beyond an issue.
- **Rate limits** on Respond tools per caller, e.g. a cap on GitHub issues opened per hour.
- **Production deploys go only through a GitHub pull request a human has approved**, then the normal deploy pipeline. Code changes are made with the engineer's own repo tools on a branch, not through MCP.

### Grafana alert contract

- **Contact point:** a Grafana webhook contact point sends `POST /alerts/grafana` to the runner (`oncall-mcp/runner/`). The URL is reachable only on the internal Docker network. Grafana sends an `Authorization: Bearer <token>` header, and the runner rejects requests without it.
- **Payload:** Grafana's standard webhook JSON, with top-level `receiver`, `status` (`firing` / `resolved`), `groupKey`, `commonLabels`, `commonAnnotations`, `externalURL`, and an `alerts[]` array. Each alert has `status`, `labels` (including `alertname`, `severity`, `service`), `annotations` (`summary`, `description`, `runbook_url`), `startsAt`, `endsAt`, `fingerprint`, `values`, `generatorURL`, `dashboardURL`, and `panelURL`.
- **Label conventions:** every alert rule must set `severity` (`critical` / `warning`), `service` (`api`, `frontend`, `postgres`, `host`, `staging`), and `deployment` (except host-level rules, which use `deployment=host`). Course-level rules also set `course`. Rules missing required labels are rejected in CI review of the Grafana provisioning files.
- **Handling:**
  1. Validate the token and the JSON shape. Reply `202 Accepted` quickly, and process in the background so Grafana does not time out or retry.
  2. Redact the payload, then store it as incident evidence. Each alert is keyed by `fingerprint`.
  3. `firing` + `severity=critical` → open or update the incident and **wake the LLM engineer**.
  4. `firing` + `warning` → record only, with no wake.
  5. `resolved` → mark the alert resolved, add it to the incident timeline, and let a running session know.
- **No duplicate wake-ups:** at most one active LLM session per incident. Repeat notifications from Grafana for the same `fingerprint` or `groupKey` update the existing incident instead of starting a new session. Incidents are scoped to a deployment, and the woken session's token is limited to that deployment (plus `host` when the alert is host-level).
- **Alert rules and contact point are provisioned as code** (Grafana provisioning YAML in the repo), so staging and production use the same rules.

### LLM on-call engineer flow (Phase 4)

1. Grafana sends a critical `firing` alert as JSON to `POST /alerts/grafana`. The runner validates it and opens or updates the incident.
2. The runner wakes the LLM engineer, an agent session (Claude Agent SDK) connected to `oncall-mcp`. Its starting context is the redacted Grafana alert JSON plus the attached `alert://` and `incident://` resources. A setting turns automatic wake-ups on or off.
3. The agent investigates with the Inspect and Investigate tools and records findings with `add_incident_note`.
4. If it finds a small, safe fix, it commits it to a branch, calls `run_staging_checks`, and opens a PR using `fix_summary`. If staging fails, the change is not promoted. The fix may be in app code or in a course's content (for example, a broken media URL in a lesson). Content fixes touch only `courses/<id>/` and go through the same content build and review.
5. If the problem is broad or uncertain, or anything fails, it calls `open_github_issue` with redacted evidence and next steps. This notifies the human on-call engineer.
6. A human reviews and approves any PR before production.

### Feedback triage flow (Phase 4)

1. The runner checks `app.feedback` in every deployment's database for new items on a schedule: every 15 minutes by default, configurable, or set to manual-only. When it finds new feedback, it wakes the LLM engineer for a triage session with the pending items attached as `feedback://{id}` resources.
2. For each item, the engineer:
   - reads the feedback and the course lesson (`.mdx` source), code step, or quiz question it refers to
   - for bugs, checks logs and metrics around the submission time
   - searches GitHub for an existing issue
3. It records exactly one decision with `triage_feedback`:
   - **valid**: a real bug, content error, or worthwhile suggestion. It opens a GitHub issue with `open_github_issue`, labeled `feedback` plus `bug`, `content`, or `suggestion`, and `course:<id>`, with the chapter or lesson in the title. The issue contains the redacted message, the context, its reasoning, and a proposed fix. Learner identity is never included.
   - **duplicate**: it records the existing issue's URL. No new issue is created.
   - **invalid**: spam, off-topic, or the learner's own misunderstanding where the content is correct. No issue; the reason is recorded.
   - **needs_human**: unclear or sensitive. The item is left for the human on-call engineer, who sees it in `list_pending_feedback`.
4. Human on-call engineers can triage the same way from their MCP client, and can reopen any LLM decision. Every decision is in the audit log.

### Build phases

1. **Observability and staging:** metrics, logs, alert rules, alert receiver, `ops` schema, deploy history, staging stack.
2. **Read-only server:** Inspect, Investigate, and read-only Feedback capabilities, resources, redaction, auth, audit log. Humans start using it.
3. **Response:** Respond tools and prompts, `triage_feedback`, rate limits, GitHub integration. Humans triage feedback manually.
4. **LLM on-call engineer:** the alert-triggered runner and the scheduled feedback-triage runner, following the flows above.

The learner feedback form ships with the course itself. Feedback collected before Phase 3 stays in `new` status until triage exists.

## Exclusions for v1

- In-browser code execution, containers, terminals, and editors. Automated grading of learner code.
- Spanish or any other translation.
- A second course. The app supports it, but v1 ships only the MCP course.
- Runtime upload of courses (zip packages, HTML, or JS), course-defined quiz pages, SCORM/cmi5 import, and an authoring CMS.
- Payments, certificates, and public score verification.
- Instructor or admin views of learner data.
- Password reset and email notifications.
- Feedback status tracking or replies to learners. Feedback from visitors who are not signed in.
- LLM-made fixes from feedback (feedback sessions only open issues).
- Any `oncall-mcp` tool that changes production directly. Automatic production deploys.
- Teaching the on-call server in the course (it is internal tooling only).
- Advanced MCP topics: sampling, elicitation, roots, OAuth authorization flows, and building MCP clients.

## Acceptance criteria

1. A visitor can read Chapter 1 without an account. A registered learner can read every unlocked lesson and use the code viewer (steps, copy, ZIP download) on desktop and phone.
2. Each chapter's quiz has 5 questions. A score of 4/5 or higher unlocks the next chapter. Retries are unlimited and options are reshuffled. Answers and explanations are revealed only after passing.
3. Quiz grading happens on the server, and every attempt and the best score per chapter are saved and shown on the dashboard.
4. Passing all 6 chapters shows the course as complete.
5. The frontend and backend run as separate services and communicate only through the API in `openapi.yaml`. React uses only the committed generated client. CI fails on any drift between the backend, `openapi.yaml`, and the frontend client. `/api/openapi.json` and `/api/docs` match the committed file.
6. CI verifies that every chapter's final code compiles and that the Chapter 6 test suite passes.
7. The content build rejects any lesson that uses JavaScript expressions, imports, scripts, unknown components, or invalid component props, or that references video from a non-allowlisted origin. Lessons render `Video`, `Model3D`, `Diagram`, and `CodeSteps` correctly on desktop and phone.
8. Data and API are course-scoped: every progress, attempt, and feedback row has a `course_id`. Adding a second course folder and listing it in `COURSES` makes it available with no code changes.
9. Each listed critical alert reaches `POST /alerts/grafana` as Grafana webhook JSON and creates or updates an incident readable as `incident://{id}`. Requests without the Grafana token are rejected. A repeat notification for the same alert does not start a second session.
10. A human on-call engineer can connect to `oncall-mcp` through an SSH tunnel with their token and use every Inspect and Investigate capability. Requests without a valid token are rejected. A token limited to one deployment cannot read alerts, metrics, logs, incidents, or feedback from another.
11. Redaction tests prove that no password, token, email, username, or quiz answer leaves `oncall-mcp`. Every call appears in the audit log.
12. `query_allowed_metrics` rejects any query name not on the allowlist. No tool can deploy to, restart, or write to production.
13. Phase 4: a critical alert starts the LLM engineer, which ends with either a staged-and-green PR waiting for human approval or a redacted GitHub issue. Nothing reaches production without human PR approval.
14. A signed-in learner can send feedback from any page in each of the four categories. The context is collected automatically without quiz answers or secrets, and the learner sees a confirmation.
15. Phase 4: every new feedback item gets exactly one triage decision. Valid items produce a GitHub issue labeled with its category and `course:<id>`, with no learner identity, duplicates link the existing issue, and invalid and needs-human items record a reason. A feedback message containing injected instructions cannot make the engineer do anything other than triage it.
