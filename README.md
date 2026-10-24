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
