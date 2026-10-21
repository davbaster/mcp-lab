# Backlog

Tasks for building the app described in [`plan.md`](plan.md). They are listed in a suggested order, and each one should fit in a single session (under about 90K tokens). Each description says which parts of the repo it touches and what it expects to exist already. The plan is the reference for every detail.

---

## 1. Empty project with passing tests and CI
Goal: Create the repo layout with one passing backend test, one passing frontend test, and CI that runs both.
Description: Create `backend/` (Python 3.12, uv, FastAPI, pytest) with a `GET /api/health` route and a pytest that calls it, and `frontend/` (Vite, React, TypeScript, Vitest) with one component test. Add empty `courses/`, `content-build/`, and `oncall-mcp/` folders with READMEs. Add a GitHub Actions workflow with separate backend jobs (ruff, pytest) and frontend jobs (ESLint, `tsc --noEmit`, Vitest) that later tasks can extend.

## 2. Local Docker Compose stack
Goal: Start frontend, backend, Postgres, and a reverse proxy with one command.
Description: Add Dockerfiles for `backend/` and `frontend/`, and a `compose.yaml` with `frontend`, `backend`, `postgres`, and a reverse proxy (Caddy or nginx) that sends `/api/*` to the backend and everything else to the frontend. Document `docker compose up` in the README and check that `/api/health` works through the proxy.

## 3. Database access and migrations
Goal: Connect the backend to Postgres with versioned migrations and a test database.
Description: Add SQLAlchemy and Alembic to `backend/`, read the database URL from an environment variable, and create an empty first migration that creates the `app` schema. Add a pytest fixture that gives each test a clean database, and run migrations in CI against a Postgres service container.

## 4. OpenAPI export and shared error shape
Goal: Make `openapi.yaml` at the repo root the exported, CI-checked API contract.
Description: Add the shared error model (`{ "error": { "code", "message" } }`) and a FastAPI exception handler that uses it everywhere. Add a script that exports the app's OpenAPI spec to `openapi.yaml`, serve it at `/api/openapi.json` with docs at `/api/docs`, and add a CI step that fails if the exported spec differs from the committed file.

## 5. Generated TypeScript API client
Goal: Generate a typed client from `openapi.yaml` and make it the only way the frontend calls the API.
Description: Pick a generator (for example `openapi-typescript` with `openapi-fetch`), generate the client into `frontend/src/api/`, and commit it. Add a CI step that fails if the regenerated client differs from the committed one, and an ESLint rule that forbids direct `fetch` calls to `/api` outside that folder.

## 6. Accounts, login, and session cookie
Goal: Let visitors register and learners sign in and out with a secure session cookie.
Description: Add `app.accounts` (internal ID, unique username, argon2 or bcrypt password hash) and `app.sessions` tables, plus `POST /api/auth/register`, `login`, `logout`, and `GET /api/auth/me`. The cookie must be HTTP-only, Secure, and SameSite=Lax, and the session scheme must be documented in the spec. Add a reusable "current learner" dependency for protected routes, test success, a duplicate username, a bad password, and expired or invalid sessions, and re-export `openapi.yaml`.

## 7. Course folder format and `course.yaml` validator
Goal: Define and validate the structure of a course folder.
Description: In `content-build/` (Node + TypeScript), define the schema for `courses/<id>/course.yaml` (id, title, description, chapter order, free-preview chapters) and the folder layout described under "Content authoring" in the plan. Add a small fixture course under `content-build/fixtures/` and tests that reject missing fields, unknown chapters, and malformed folders.

## 8. Restricted MDX compiler
Goal: Compile lesson `.mdx` files to JSON trees and reject anything that isn't plain Markdown or an allowlisted component.
Description: In `content-build/`, parse MDX and output a JSON tree of Markdown nodes and component nodes with literal props. Fail with a file and line number on JS expressions, `import`/`export`, `<script>`, event-handler attributes, unknown components, or props that don't match the component's schema, which is read from `frontend/src/content-components/schemas/*.json`. Test every rejection case and a valid lesson.

## 9. Content assets, media allowlist, and diagrams
Goal: Handle images, 3D models, video URLs, and Mermaid diagrams in the content build.
Description: Copy course `assets/` to the build output with content hashes, and check that every asset a lesson references exists. Check `Video` URLs against a configured media-origin allowlist, and render Mermaid `Diagram` sources to SVG at build time. Each check gets its own failing-fixture test.

## 10. Code steps: diffs and chapter ZIPs
Goal: Turn `chapters/NN-slug/code/step-N/` folders into step diffs and downloadable ZIPs.
Description: In `content-build/`, read each chapter's code steps and output, for each step, the files plus the lines changed since the previous step. Also produce one ZIP per chapter with the project as it stands at the final step. Test with a fixture chapter that has three steps, including an added file and a deleted file.

## 11. Quiz YAML validator
Goal: Validate every chapter's `quiz.yaml` during the content build.
Description: Define the schema (question ID, text, optional code snippet, options, correct option, explanation, lesson link) and enforce the rules: exactly 5 questions, exactly one correct option each, unique IDs, and lesson links that point to real lessons. Output quiz data to a separate build file that is never served as a static file, and test every failure case.

## 12. Content build in CI and Docker, with stable ID check
Goal: Run the content build automatically, protect published IDs, and make the output available to the backend.
Description: Add a `content-build` CI job that builds every course under `courses/`, and select which courses to build and serve with the `COURSES` setting. Have the build write a committed manifest of chapter, lesson, and question IDs per course, and fail CI if an ID disappears without a note in `courses/<id>/MIGRATIONS.md`. Wire the build output into the backend Docker image or a shared volume.

## 13. Backend course loading and listing endpoints
Goal: Load compiled courses at startup and expose them through the API.
Description: Make the backend load the compiled output for each course in `COURSES` at startup, and fail fast if a course is missing or invalid. Add `GET /api/courses` and `GET /api/courses/{course_id}/chapters` (titles, order, and lesson list), with tests that use a fixture build, and re-export `openapi.yaml`.

## 14. Chapter progress and status
Goal: Track and report each learner's status per chapter.
Description: Add an `app.chapter_progress` table keyed by learner, `course_id`, and chapter, holding status (locked / in progress / passed), best score, and last lesson visited. Add `GET /api/courses/{course_id}/progress`, and add status to the chapters endpoint. Chapters unlock in order, and a learner's first chapter starts unlocked.

## 15. Lesson and quiz read endpoints with access control
Goal: Serve lessons and quizzes only to people who may see them, with no answer data.
Description: Add `GET /api/courses/{course_id}/lessons/{lesson_id}`, which returns the compiled JSON tree and records the learner's last lesson visited. Visitors may read only free-preview chapters, signed-in learners may read unlocked chapters, and locked chapters return a clear error code. Add `GET .../chapters/{chapter_id}/quiz` for signed-in learners on unlocked chapters, returning questions and options in a new random order on each request with stable option IDs. Tests must prove the quiz response never contains the correct option or the explanation.

## 16. Submit and grade quiz attempts
Goal: Grade quiz submissions on the server and save every attempt.
Description: Add `POST .../quiz/attempts`. It grades the submission against the server-side key and saves the attempt in `app.quiz_attempts` with `course_id`. It returns the score and wrong question IDs with lesson links, plus every answer and explanation only when the score is 4/5 or higher. A pass updates the best score, marks the chapter passed, unlocks the next one, and marks the course complete when every chapter is passed.

## 17. App shell, routing, and auth pages
Goal: Give the frontend its page structure, navigation, and sign-in flow.
Description: Set up routing for the course list, a course dashboard, lesson pages, quiz pages, and register/login pages, inside a shared responsive layout with a header (no horizontal scrolling at 360px width). Build the register and login forms and a sign-out control with the generated API client, keep the current learner in app-wide state loaded from `/api/auth/me`, and show API errors using the shared error shape. Add component tests for the forms.

## 18. Course dashboard
Goal: Show a learner where they are in a course.
Description: Build the dashboard from the chapters and progress endpoints. It shows each chapter's status and best score, a Resume button that opens the last lesson visited, and a completion state when the course is finished. Visitors see the chapter list with a sign-in prompt instead of progress.

## 19. Lesson renderer and basic components
Goal: Render a lesson's JSON tree with a fixed component registry.
Description: In `frontend/src/content-components/`, build a renderer that turns the Markdown nodes into safe React elements (no `dangerouslySetInnerHTML` for author content) and maps component nodes to a fixed registry. Implement `Image`, `Callout`, `Tabs`, and `Diagram` (pre-rendered SVG), each with its props schema JSON. Add the lesson page with previous/next navigation, and component tests.

## 20. Video and Model3D components with Content-Security-Policy
Goal: Show lesson videos and interactive 3D models, loading media only from allowed origins.
Description: Implement `Video` (CDN files with `.vtt` captions and a poster, or YouTube/Vimeo embeds) and `Model3D` (`<model-viewer>` for `.glb`/`.gltf` course assets, loaded only on pages that use it, with a poster fallback on small or low-power devices or without WebGL), and add their props schemas. Set a Content-Security-Policy on the frontend that allows only the app's origin and the configured media origins, and check that a video from another origin is blocked.

## 21. Code viewer: files, highlighting, copy, and ZIP download
Goal: Show a code step's files with syntax highlighting.
Description: Implement the `CodeSteps` component for a single step using the content build's step data. It has Shiki syntax highlighting (with a small, lazily loaded set of languages), file tabs, a copy button per file, and a download button for the chapter ZIP. It must stay usable on a phone, with tests for tab switching and copying.

## 22. Code viewer step mode
Goal: Let learners step through the code and see what changed.
Description: Add step navigation to `CodeSteps` that switches between a chapter's steps and highlights the lines changed since the previous step, using the diff data from the content build. Show added and deleted files clearly, keep the selected file when it still exists in the new step, and add tests for step switching and highlighting.

## 23. Quiz page UI
Goal: Let learners take a chapter quiz and see the result.
Description: Build the quiz page with the quiz and attempt endpoints. It renders questions with optional code snippets and lets the learner pick one option per question. After submitting, a failed attempt shows which questions were wrong with links to the lessons, and a passed attempt shows every answer and explanation. Retry reloads a newly shuffled quiz.

## 24. Feedback API
Goal: Accept and store learner feedback.
Description: Add `POST /api/feedback` for signed-in learners. It takes a category (Bug, Content error, Confusing explanation, Suggestion), a message of 10–2000 characters, an optional quiz-question flag, and the context fields from the plan (including `course_id`). Store each item in `app.feedback` with status `new`, enforce 10 submissions per learner per day, ignore the same message sent twice within a minute, and test each rule.

## 25. Feedback button and form
Goal: Let learners send feedback from any page.
Description: Add a Send feedback button to the layout that opens a form with the category, the message, and, on quiz pages, the "about the current question" checkbox. Collect the context automatically: URL, course, chapter, lesson, question, app version, browser and device, and the last 10 frontend console errors from a small buffer. Never include quiz answers or secrets. Visitors are asked to sign in, and learners see "Thanks — we'll review it".

## 26. MCP course setup and Chapter 1 content
Goal: Create the MCP course folder, its readiness checklist, and Chapter 1.
Description: Create `courses/mcp-server/` with `course.yaml` (6 chapters, Chapter 1 as the free preview) and a readiness checklist page that lists the expected Python skills and links to CS50 Python. Write Chapter 1's six lessons from the plan as restricted MDX, using `Diagram` for the host/client/server and lifecycle figures, and add `quiz.yaml` with the plan's questions plus explanations and lesson links. Check that it passes the content build and appears in the app.

## 27. Chapter 2 content and course code CI
Goal: Write Chapter 2 and add the CI job that keeps course code correct.
Description: Write the five Chapter 2 lessons from the plan, with code steps for the `uv init` project and the `add` tool server in `code/step-N/`, `CodeSteps` in the lessons, and the plan's quiz. Add a CI job that runs `python -m py_compile` on every chapter's final code step and runs pytest wherever a final step contains tests, using a pinned `mcp` version. The job reads the course folder, so future courses get the same checks.

## 28. Chapter 3 code steps
Goal: Build the notes CRUD server code, step by step, for Chapter 3.
Description: Starting from Chapter 2's final step, create Chapter 3's `code/step-N/` folders: the SQLite storage module, then `create_note`, `list_notes`, `get_note`, `update_note`, and `delete_note`, then error handling and tool annotations (`readOnlyHint`, `destructiveHint`). Each step must be a complete, working project, and the final step must pass the course code CI job and be callable from the MCP Inspector.

## 29. Chapter 3 lessons and quiz
Goal: Write Chapter 3's lessons and quiz around the existing code steps.
Description: Write the six lessons from the plan (storage, CRUD tools, writing for an LLM reader, return values, errors, annotations) in `courses/mcp-server/chapters/03-tools/`, using `CodeSteps` to point at the steps that already exist. Add the plan's quiz with explanations and lesson links, and check that the chapter passes the content build.

## 30. Chapter 4 content: Resources and prompts
Goal: Write Chapter 4's lessons, code steps, and quiz.
Description: Write the five lessons on the static resource, the resource template, the `summarize_note` prompt, and the decision guide, with code steps that build on Chapter 3's final step. Add the plan's quiz, and check that the final step passes the course code CI job.

## 31. Chapter 5 content: Transports and real clients
Goal: Write Chapter 5's lessons, code steps, and quiz.
Description: Write the six lessons on stdio, the stdout rule, Claude Desktop config, Streamable HTTP, choosing a transport, and local HTTP safety, with code steps that build on Chapter 4. Add a sample `claude_desktop_config.json` as a code file, add the plan's quiz, and check that the final step passes the course code CI job.

## 32. Chapter 6 code steps and test suite
Goal: Build Chapter 6's finished, tested, shippable server code.
Description: Starting from Chapter 5's final step, create Chapter 6's code steps: `Context` logging and progress, a lifespan handler that shares the SQLite connection, configuration from environment variables, input validation and safe paths, and packaging (`pyproject.toml`, README with a client config). The final step includes a pytest suite that unit-tests storage and calls `list_tools()`/`call_tool()` on the server, and it must pass the course code CI job.

## 33. Chapter 6 lessons and quiz
Goal: Write Chapter 6's lessons and quiz around the existing code steps.
Description: Write the six lessons from the plan (`Context`, lifespan, testing, configuration and secrets, safe inputs, shipping) in `courses/mcp-server/chapters/06-shipping/`, using `CodeSteps` to point at the existing steps. Add the plan's quiz with explanations and lesson links, and check that the whole course is complete and passes the content build.

## 34. Production and staging Compose with TLS
Goal: Run production and staging stacks side by side on one VM.
Description: Add production and staging Compose projects with separate ports, databases, and env files. The reverse proxy serves TLS (Caddy automatic certificates or certbot) and sets security headers including the CSP. Both use the same images, and the courses and media origins come from config. Document the isolated deployment mode: a second project from the same image with its own domain and database on the shared Postgres server.

## 35. Deploy script and deploy history
Goal: Deploy with one script and record every deployment.
Description: Write a deploy script that builds and tags images, runs migrations, and restarts one named deployment and environment. It records the deployment name, environment, app version, commit SHA, each course's content commit SHA, time, and who in `ops.deployments`. Add the `ops` schema migration for that table, and keep `ops` tables separate from the app tables.

## 36. App metrics and structured logging
Goal: Expose Prometheus metrics and write structured JSON logs without secrets.
Description: Add `/metrics` to the backend (internal only, not routed by the public proxy) with request rate, latency histograms, 5xx counts, and quiz-submission errors, labeled with `deployment` and, for course-level series, `course`. Switch logging to JSON with timestamp, level, request ID, route, status, latency, `deployment`, and `course_id`, with a filter that masks passwords, session tokens, cookies, and quiz answers. Test the labels, and test that each kind of secret is masked.

## 37. Observability stack
Goal: Run Prometheus, Loki, Promtail, Grafana, and exporters alongside the app.
Description: Add a Compose project with Prometheus (scraping the backend, Postgres exporter, node exporter, and cAdvisor), Loki with Promtail for container logs, and Grafana provisioned with data sources and a basic app dashboard. One stack serves every deployment on the VM, using the `deployment` label.

## 38. Grafana alert rules as code
Goal: Provision the critical and warning alert rules from the repo.
Description: Write Grafana provisioning YAML for the plan's critical alerts (app down, sustained 5xx, slow p95, Postgres failures, CPU/memory/disk pressure) and a webhook contact point that points to the runner. Add a CI check that rejects rules missing `severity`, `service`, or `deployment`.

## 39. Ops schema for alerts, incidents, audit, and triage
Goal: Create the `ops` tables the on-call system needs.
Description: Add migrations for `ops.alerts` (keyed by fingerprint), `ops.incidents` (scoped to a deployment, with timeline and notes), `ops.audit_log`, and `ops.feedback_triage`. Add a read-only Postgres role for app tables and a writer role limited to `ops`, and a scheduled job that deletes audit log rows and incident evidence older than 30 days.

## 40. `oncall-mcp` skeleton with auth and audit log
Goal: Start the on-call MCP server with per-caller tokens and auditing.
Description: Create `oncall-mcp/` as a FastMCP server over Streamable HTTP, bound to the internal network. Each bearer token maps to a caller identity and an optional list of allowed deployments. Every tool or resource call writes caller, name, redacted arguments, result size, and outcome to `ops.audit_log`. Add a trivial `ping` tool and tests for missing, invalid, and out-of-scope tokens.

## 41. Redaction module
Goal: Remove sensitive data before anything leaves `oncall-mcp`.
Description: Build a redaction function in the `oncall-mcp` core that every tool and resource result passes through. It removes passwords, tokens, cookies, emails, usernames, and quiz answers from strings and nested JSON. Write thorough tests, including tricky cases (secrets inside URLs, log lines, and alert annotations).

## 42. Adapter interfaces and fake adapters
Goal: Separate the on-call core from its data sources.
Description: Define the `HealthAdapter`, `MetricsAdapter`, `LogsAdapter`, `DeploymentsAdapter`, `IssueTracker`, and feedback-reader interfaces in the core, and add fake implementations with fixture data for tests and local development. Configure the server to choose real or fake adapters through config.

## 43. Inspect capabilities
Goal: Let on-call engineers see alerts, health, and incidents.
Description: Implement `list_active_alerts`, `get_service_health`, `alert://{id}`, and `incident://{id}`, with optional `deployment` and `course` filters, through the adapters and `ops` tables. Enforce the token's deployment scope and redaction on every result, and test against the fake adapters.

## 44. Real metrics and logs adapters with Investigate tools
Goal: Query Prometheus and Loki safely.
Description: Implement the Prometheus and Loki adapters in `oncall-mcp/adapters/course_app/`, and the `query_allowed_metrics` (named queries from an allowlist only, never raw PromQL) and `search_redacted_logs` (capped time window and result count) tools, with deployment and course filters. Test that unknown query names are rejected and that caps are enforced.

## 45. `compare_deployments`
Goal: Show what changed between two deployments.
Description: Implement the deployments adapter (reading `ops.deployments` and git) and the `compare_deployments` tool. It returns app commits, per-course content commits, changed files, and key metric deltas between two deployments of the same deployment name. Test it with fixture deploy history.

## 46. Read-only feedback capabilities
Goal: Let on-call engineers review pending learner feedback.
Description: Implement `list_pending_feedback` (ID, category, deployment, course, chapter or lesson, age) and `feedback://{id}`. The resource returns the redacted message, context, and the referenced lesson source, code step, or quiz question. Read through the read-only role, wrap learner text in clear untrusted-data delimiters, and enforce the token's deployment scope.

## 47. Grafana alert receiver
Goal: Receive Grafana webhooks and turn them into incidents.
Description: Build `POST /alerts/grafana` in `oncall-mcp/runner/`. It checks the bearer token and payload shape, replies `202` right away, and processes in the background: redact, store by fingerprint, then open or update a deployment-scoped incident for critical alerts, record warnings only, and mark resolved alerts. Repeated notifications must not create duplicates, and every case needs a test with sample Grafana payloads.

## 48. Respond tools and rate limits
Goal: Let on-call engineers record findings and open GitHub issues.
Description: Implement `add_incident_note` and `open_github_issue` (redacted title, body, and evidence links, labeled `oncall`) through the GitHub `IssueTracker` adapter. Add per-caller rate limits for Respond tools, for example a cap on issues opened per hour, and test the limits and the redaction of issue bodies.

## 49. Feedback triage tools
Goal: Record triage decisions and find duplicate issues.
Description: Implement `search_github_issues` (with an optional `course:<id>` label filter) and `triage_feedback`. `triage_feedback` records exactly one decision per item (`valid`, `duplicate`, `invalid`, `needs_human`) with a reason and optional issue URL in `ops.feedback_triage`, and lets a human reopen a decision. Test that a second decision without a reopen is rejected.

## 50. Staging checks tool and on-call prompts
Goal: Let the on-call engineer try a branch on staging and write up incidents and fixes.
Description: Implement `run_staging_checks`, which deploys a git ref to the staging stack only (reusing the deploy script), runs the content build, test suites, and smoke tests, and returns a structured report. It must never touch production, is rate-limited per caller, and is tested with a fake deploy runner. Add the `incident_summary` and `fix_summary` MCP prompts (the latter takes an incident and a branch and covers cause, fix, staging result, and risk), with tests on fixture incidents.

## 51. LLM on-call runner for alerts
Goal: Wake an agent session when a critical alert fires.
Description: Build a runner in `oncall-mcp/runner/` that starts a Claude Agent SDK session connected to `oncall-mcp` when a critical incident opens. The session gets the redacted alert JSON plus `alert://` and `incident://` attached, and a token limited to that deployment. Allow at most one active session per incident, add a config switch to turn auto-wake on or off, and test with a fake agent.

## 52. Feedback triage runner
Goal: Triage new learner feedback automatically on a schedule.
Description: Add a scheduled job (every 15 minutes by default, configurable, or manual-only) that checks each deployment's `app.feedback` for new items and starts a triage session with only the Feedback tools and `open_github_issue`. Write tests with feedback messages that contain injected instructions, and check that they can't lead to any action other than a triage decision.
