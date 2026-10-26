# Handoff

Where the work stands, for anyone picking it up without access to the original Claude project (another Claude account, Codex, or a person). Last updated 2026-10-26.

Read [`AGENTS.md`](AGENTS.md) first. It has the layout, commands and rules. [`_docs/plan.md`](_docs/plan.md) is the scope, and [`_docs/process.md`](_docs/process.md) is how each task is run (PM grooms, engineer builds, QA passes or fails, then the issue is closed). This file only holds the state and decisions that the repo doesn't.

Then read the newest file in [`_docs/log/`](_docs/log/). Append an entry there after each finished piece of work, decision, or task switch, using the format described in `AGENTS.md`.

## Phase order

Agreed with the owner (David, `davbaster`):

1. Foundation (#1 onward) - done
2. Content build - done
3. Backend - done
4. Frontend - done
5. Course chapters (#26-#33, #61, #62)
6. Deploy (#34, #35), observability and alerts (#37, #38), ops database roles (#39)
7. On-call agent (#40-#52). David says this is mandatory.

On 2026-10-26 David cut the backlog to finish sooner. These issues are dropped for now but stay open: CI and integration tests (#70-#79, #85, #87, #89, #90, #95, #99), ops extras (#57, #64-#67, #80, #81, #83), course CI (#60), hardening (#96, #97, #102, #113, #114), Mermaid (#116-#118), UI follow-ups (#124-#130, #135) and Makefile targets (#98). Don't start them unless David asks.

## Where things are

- **Merged:** everything through the frontend phase, plus #107 (course loader edge cases, PR #136).
- **#111 (trailing newline in route paths):** passed QA, merged (PR #137).
- **Next:** #26, #27, #28 and #29 are in PR #138, waiting on David's merge. Then #30 and the other chapters.
- Work so far has gone through the branch `claude/project-thread-cwgogn`, one PR per one or two issues, each merged by David. Start new work on a fresh branch from `main`.

## Decisions to keep

- **No new tests for now (David, 2026-10-26).** New features ship without new tests. Existing tests stay, must keep passing, and must never be skipped or deleted. QA is a quick check: run the existing suites, linters and type checks, and try the feature by hand.
- **Course code pins `mcp[cli]==2.3.0`** (#27). In `mcp` 2.x, FastMCP was renamed `MCPServer` (`from mcp.server.mcpserver import MCPServer`); `mcp.server.fastmcp` no longer exists. Use `MCPServer` in all chapters and in `oncall-mcp/`. Tools report errors by raising `ToolError` (`mcp.server.mcpserver.exceptions`); a plain `ValueError` reaches the client as "Error executing tool <name>" with its message lost. Quiz questions allow only 2 or 3 options, so correct answers are spread across a, b and c.
- **Quiz answers (#108):** the build check is dropped. Chapter authors spread the correct answers across `a`, `b`, `c` and `d`, so always picking one letter doesn't pass. #108 stays open.
- **Packages need David's approval** before they're added (see `AGENTS.md`). Everything in the current `package.json` and `pyproject.toml` files is approved. Recent approvals, all pinned exactly and in `frontend/` only unless noted: react-router 7.18.4 and @testing-library/user-event 14.6.7 (#17); Shiki 4.5.0 with @shikijs/langs (#21); @google/model-viewer 4.4.0 and three.js 0.183.2 (#20); @mermaid-js/mermaid-cli 12.0.0 and puppeteer 25.16.0 in `content-build/` only (#55).
- **CSP:** `connect-src` allows `blob:` so textured 3D models load (approved by David for #20). Compressed models (Draco, KTX2, Meshopt) stay unsupported in v1; see #126.
- **The frontend may import exactly one file from `content-build/`:** `media-config.json`, the single list of media and embed origins. The CSP generator and the Video component both read it. `content-build/tests/component-schemas.test.ts` refuses every other import from `content-build/`.
- **Code highlighting (#21, #63):** one Shiki highlighter for CodeSteps, lesson fences and quiz snippets. A file over 100,000 characters, or with any line over 2,000 characters, stays plain text. Fence languages are matched case-insensitively against an alias table. That table is `python`/`py`, `toml`, `json`, `yaml`/`yml`, `markdown`/`md` and `shellscript`/`shell`/`sh`/`bash`, and any other language is shown as plain text. Lesson fences have a Copy button and quiz snippets don't.
- **Mermaid diagram goldens use Linux as the reference.** On Windows only the byte-for-byte diagram comparisons are skipped ("Linux is the reference"); every other diagram check still runs there. Windows text measurement differs by a fraction of a pixel, and rounding doesn't fix it.
- **CI runs on a self-hosted runner, `itias-vps`** (Linux). David installs system packages there by hand (for example `unzip`, and Chromium's libraries and fonts for the diagram renderer). If a job fails because something is missing on the runner, ask David to install it rather than changing the workflow.
- **The `content-build` CI job is not a required check** for now. Making `ci-ok` the required check is #90.
- **Windows:** David develops on Windows with PowerShell 5.1, so commands and Makefile recipes must work there (rules in `AGENTS.md`). Text files are kept at LF; a stale Windows checkout can need its files restored before tests pass.

## Backlog follow-ups

Filed during the build, all still open:

- #108 quiz option IDs can reveal the answer (handled by authoring for now, see above)
- #113 database pool under bursts, #114 trust the shared proxy for client addresses
- #116 render Mermaid in the backend image build, #117 Mermaid as a fenced code block, #118 content-build job on Windows
- #135 a content-build warning when a code fence or quiz snippet language won't be highlighted
- #124-#130, filed 2026-10-26 from the frontend work: heading anchors, pausing hidden videos, compressed 3D models, a CSP for `/api/docs`, caption language, a clipboard fallback for Copy, and an error when the ZIP download fails. These don't have the `backlog` label yet.

## Working with David

- Ask before anything that can't be undone, before adding a package, and before widening the CSP or other security rules.
- He merges PRs himself. Tell him when a PR is green.
- He sometimes writes in Spanish.
