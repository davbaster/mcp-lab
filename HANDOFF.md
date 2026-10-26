# Handoff

Where the work stands, for anyone picking it up without access to the original Claude project (another Claude account, Codex, or a person). Last updated 2026-10-26.

Read [`AGENTS.md`](AGENTS.md) first. It has the layout, commands and rules. [`_docs/plan.md`](_docs/plan.md) is the scope, and [`_docs/process.md`](_docs/process.md) is how each task is run (PM grooms, engineer builds, QA passes or fails, then the issue is closed). This file only holds the state and decisions that the repo doesn't.

## Phase order

Agreed with the owner (David, `davbaster`):

1. Foundation (#1 onward) - done
2. Content build - done
3. Backend - done
4. Frontend - in progress, almost finished
5. Course chapters (#26-#33, #60-#62)
6. Integration tests and CI (#70-#79, #85, #87, #89, #90)
7. Ops phases (#34-#52, #57, #64-#67, #80-#83), in the order of "Build phases" in the plan

## Where things are

- **Open PR [#132](https://github.com/davbaster/mcp-lab/pull/132):** #20 (Video and Model3D components plus the Content-Security-Policy) and #22 (code viewer step mode). Both passed QA. Waiting on CI and David's merge.
- **#63 (syntax-highlight fenced code in lessons):** groomed and built, in final browser checks. Not pushed yet. It goes in the next PR after #132 merges.
- **After #63** the frontend phase is done and the chapters start, but only after #108 (below).
- Work so far has gone through the branch `claude/project-thread-cwgogn`, one PR per one or two issues, each merged by David. Start new work on a fresh branch from `main`.

## Decisions to keep

- **Packages need David's approval** before they're added (see `AGENTS.md`). Everything in the current `package.json` and `pyproject.toml` files is approved. Recent approvals, all pinned exactly and in `frontend/` only unless noted: react-router 7.18.4 and @testing-library/user-event 14.6.7 (#17); Shiki 4.5.0 with @shikijs/langs (#21); @google/model-viewer 4.4.0 and three.js 0.183.2 (#20, arriving with PR #132); @mermaid-js/mermaid-cli 12.0.0 and puppeteer 25.16.0 in `content-build/` only (#55).
- **CSP (in PR #132):** `connect-src` allows `blob:` so textured 3D models load (approved by David for #20). Compressed models (Draco, KTX2, Meshopt) stay unsupported in v1; see #126.
- **Mermaid diagram goldens use Linux as the reference.** On Windows only the byte-for-byte diagram comparisons are skipped ("Linux is the reference"); every other diagram check still runs there. Windows text measurement differs by a fraction of a pixel, and rounding doesn't fix it.
- **CI runs on a self-hosted runner, `itias-vps`** (Linux). David installs system packages there by hand (for example `unzip`, and Chromium's libraries and fonts for the diagram renderer). If a job fails because something is missing on the runner, ask David to install it rather than changing the workflow.
- **The `content-build` CI job is not a required check** for now. Making `ci-ok` the required check is #90.
- **Windows:** David develops on Windows with PowerShell 5.1, so commands and Makefile recipes must work there (rules in `AGENTS.md`). Text files are kept at LF; a stale Windows checkout can need its files restored before tests pass.

## Backlog follow-ups

Filed during the build, all still open:

- **#108 Keep quiz option IDs from revealing the answer. Must be fixed before any real chapter content is written.**
- #107 course loader edge cases, #111 trailing newline in route paths, #113 database pool under bursts, #114 trust the shared proxy for client addresses
- #116 render Mermaid in the backend image build, #117 Mermaid as a fenced code block, #118 content-build job on Windows
- #124-#130, filed 2026-10-26 from the frontend work: heading anchors, pausing hidden videos, compressed 3D models, a CSP for `/api/docs`, caption language, a clipboard fallback for Copy, and an error when the ZIP download fails. These don't have the `backlog` label yet.

## Working with David

- Ask before anything that can't be undone, before adding a package, and before widening the CSP or other security rules.
- He merges PRs himself. Tell him when a PR is green.
- He sometimes writes in Spanish.
