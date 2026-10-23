# Testing guidelines

How we test in this repo. Read this before writing tests. Each issue's acceptance criteria say *what* to test; this page says *how*.

## Principles

- **Every acceptance criterion is proven.** Each one maps to an automated test, or, when it can only be seen (layout, a browser, a real device), to a manual check described in the PR.
- **Test behavior, not internals.** Call the API, render the component, or run the command, then check what a user or client would see. Avoid asserting on private functions or call counts.
- **Tests are deterministic.** No real clock, network, randomness, or external service in CI. Use a fake clock, fixture data, fake adapters, and recorded responses.
- **One reason to fail.** Each test checks one behavior and its name says which: `test_locked_chapter_returns_403`, `it("disables submit until every question is answered")`.
- **Edge cases are tests too.** If an issue lists an awkward case (empty list, duplicate, out-of-order data, expired session), it gets its own test.
- **Never make CI green by weakening tests.** Do not skip, `xfail`, or delete a failing test to finish a task. If a test is flaky, fix it, or remove it and file an issue in the same PR.

## Security and privacy tests (required patterns)

These rules come from `AGENTS.md` and apply in every project.

- **Absence checks use unique sentinels.** To prove that answer keys, explanations, or secrets never reach a response or log, put a unique string in the fixture (for example `CORRECT-SENTINEL-7f3a`) and assert it does not appear anywhere in the response body or captured log output. Checking one field is not enough.
- **Logs never contain secrets.** For any code path that touches a password, session token, cookie, or quiz answer, capture the logs (`caplog` in pytest) and assert none of those values appear.
- **Access rules are tested per role.** For every protected endpoint or tool, test each caller: visitor, learner, a learner who may not see this resource (locked chapter, other learner's data), and, in `oncall-mcp`, a token for another deployment.
- **Course scoping.** Tests for course data use at least one fixture where `course_id` matters (two courses, or an unknown course).

## Backend (`backend/`)

- **Tools:** pytest, run with `uv run pytest`. Lint with `uv run ruff check .`.
- **Layout:** `backend/tests/`, one file per area (`test_auth.py`, `test_quiz_attempts.py`). Shared fixtures in `conftest.py`.
- **Database:** tests use a real Postgres database whose name ends in `_test` (#3). Each test starts from empty tables (truncate, not transaction rollback). Never mock the database for endpoint tests.
- **Requests:** go through FastAPI's test client, so the app's routing, dependencies, and error handlers run.
- **Contract:** every test-client response is validated against `openapi.yaml` automatically (#56). If a test fails that check, fix the code or re-export the spec. Never silence the check.
- **Errors:** assert the status code *and* the shared error shape's `code`.
- **Time:** inject a clock for anything time-based (session expiry, rate limits, feedback limits). Do not use `sleep`.
- **Course data:** use the small fixture build in the tests folder, never the real `courses/` folder (#13).

## Frontend (`frontend/`)

- **Tools:** Vitest with React Testing Library and `@testing-library/user-event`, run with `npm test` (single run, no watch). Also run `npm run lint` and `npm run typecheck`. If #1 did not add the Testing Library packages, ask before adding them, like any dependency.
- **Location:** tests sit next to the component (`LoginForm.test.tsx`).
- **Queries:** find elements the way a user does: `getByRole`, `getByLabelText`, `getByText`. Use `data-testid` only when nothing else works.
- **Interaction:** use `@testing-library/user-event` for typing, clicking, and keyboard navigation, including Tab, arrow keys, and Escape where the component supports them.
- **Network:** mock at the network boundary that the generated API client uses (as set up in #5), and return real-shaped responses, including the shared error shape. Never mock the client's functions one by one, and never call `fetch` directly.
- **Cover the states:** loading, success, empty, each error code the page handles, and the visitor versus learner view.
- **No large snapshots.** Assert specific text and roles instead. A snapshot of a whole page breaks on every change and proves little.
- **Manual checks in the PR:** screenshots at 360, 768, and 1280px for any page change (see `_docs/design-system.md`), and a note on any browser-only behavior (CSP errors, lazy loading seen in the network panel).

## Content build (`content-build/`)

- **Tools:** Vitest, run with `npm test` in `content-build/`.
- **Fixtures:** one small valid course, plus one invalid fixture per rule under `content-build/fixtures/`. A rejection test checks the error message names the file, the line (where there is one), and the rule.
- **Golden output:** for compiled output (lesson trees, quiz JSON, step diffs), commit the expected output and compare exactly.
- **Determinism:** build the same input twice and assert byte-identical output (hashes for ZIPs).
- **Cross-platform:** fixtures include CRLF line endings and a UTF-8 BOM where the rules accept them.

## Course code (`courses/<id>/chapters/*/code/`)

- The course code CI job (#60) compiles every step and runs pytest in each chapter's final step that has tests.
- Course tests follow the same rules as the app: offline, temporary folders and databases, no real user files.

## On-call server (`oncall-mcp/`)

- **Tools:** pytest, run with `uv run pytest` in `oncall-mcp/`.
- **Adapters:** core tests use the fake adapters (#42). Real adapters run the same shared test suite against recorded responses. CI never calls Prometheus, Loki, GitHub, or a model API.
- **Every tool and resource has tests for:** its happy path, its input limits (caps, lengths, allowed values), deployment scope (a token for another deployment is denied), redaction (a planted secret does not come back), and the audit row written for the call.
- **Injection:** query parameters that end up in PromQL, LogQL, or git commands are tested with injection strings.
- **Untrusted input:** feedback tests include messages with injected instructions and delimiter strings (#46, #52).
- **Runners:** use a fake agent, fake clock, and fake deploy runner. A real-model check, when an issue asks for one, is run by hand and described in the PR, not run in CI.

## Before you say a task is done

Run everything that applies to the folders you changed, and list the commands and results in the PR:

| Folder | Commands |
|---|---|
| `backend/` | `uv run ruff check .`, `uv run pytest` |
| `frontend/` | `npm run lint`, `npm run typecheck`, `npm test` |
| `content-build/` | `npm test`, plus a build of every course |
| `oncall-mcp/` | `uv run ruff check .`, `uv run pytest` |
| `openapi.yaml` changed | re-export, regenerate the client (`npm run generate:api`), and run both suites |

Then read the issue's acceptance criteria again and tick each one, with the test name or manual check that proves it.
