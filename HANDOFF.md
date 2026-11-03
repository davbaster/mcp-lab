# Handoff

Where the work stands, for anyone picking it up without access to the original Claude project (another Claude account, Codex, or a person). Last updated 2026-11-02.

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
- **Chapters (#26-#33, #61, #62):** merged (PR #138).
- **#116 (Mermaid in the backend image):** merged (PR #140). The content stage of `backend/Dockerfile` is `node:24-bookworm` with the pinned chrome-headless-shell and its apt libraries (content stage only). The backend image now builds with the real `courses/`.
- **#34 (production and staging Compose with TLS):** merged (PR #141) but the issue stays open until the checks below are done. Files: `deploy/` (compose, `*.env.example`, `gateway.Caddyfile`), `caddy/mcp-lab.caddy`, `make check-caddy` and the `caddy` CI job, and the README section "Production and staging".
- **#77 (publish images to GHCR):** reactivated by David on 2026-11-02 (the backlog cut is lifted for #77 only); in PR #143, waiting on David's merge. `.github/workflows/images.yml` builds both images for every push on the self-hosted runner, checks them (`make check-image-contents`), scans them with Trivy (critical/high with a fix fail the job, SARIF to the Security tab) and pushes `ghcr.io/davbaster/mcp-lab-{backend,frontend}:<full sha>` only if everything passed. Fork PRs are not built (David's decision). Trivy cannot scan Compose files, so only Dockerfiles are scanned (README says so). The frontend base is `nginx:1.30-alpine` plus `apk upgrade --no-cache`, so two builds of the same commit can differ in Alpine package versions; `.trivyignore` is empty.
- **Next:** after PR #143 merges, check its first Actions run on `itias-vps` (the GHA cache, trivy-action's database download, the SARIF upload which needs code scanning on, the first GHCR push, and the warm-cache build time for the PR notes). Then David switches both packages to public in GitHub (they are created private). Then deploy the stack on the VM and finish #34 (below), then #35 (deploy script).
- **#41 (redaction module):** implemented on branch `feat/41-redaction` (`oncall-mcp/oncall_mcp/redaction.py`, README section "Redaction"), QA pending. No test files in the repo, by David's decision (2026-10-26, confirmed for #41 on 2026-11-03), so the issue's "and tests" is met by a throwaway script run for QA. Open questions for David: `session` as a dict key is a `token` but `session=...` in text is a `cookie`; `user` matches a key only exactly (`user_agent` survives); a value under a sensitive key becomes the marker whatever its type.
- Work so far has gone through the branch `claude/project-thread-cwgogn`, one PR per one or two issues, each merged by David. Start new work on a fresh branch from `main`.

## #34 still open

- **Gateway (accepted by David, 2026-10-31):** each project runs a small Caddy `gateway` that is the only service on the `proxy` network. It routes `/api/*` to the backend and the rest to the frontend, so the backend's metrics port (9000) never joins `proxy`. So routing lives in `deploy/gateway.Caddyfile`, not only in `caddy/mcp-lab.caddy`.
- **Media origin:** `content-build/media-config.json` still has the placeholder `https://media.mcp-lab.example` (many tests use it). YouTube and Vimeo embeds already work. Replace the placeholder only when David picks a media CDN.
- **Memory limits:** production 880 MB, staging 608 MB; with 1024 MB reserved for #37 (an assumption, #37 sets the real figure) and 128 MB for the shared Caddy, 2640 MB of 4096 MB.
- **Domains** are in `deploy/proxy.env.example` (the shared Caddy's env), so changing them needs the Caddy container recreated, not reloaded.
- **Not done (needs the VM):** the checks from outside the VM (README, "Production and staging", the `curl.exe` lines), the isolated deployment on a VM, and Let's Encrypt issuance and renewal.
- **Outside checks (2026-11-01):** from David's PC, 5432, 9000 and 2019 on `157.180.78.25` time out (blocked by the Hetzner firewall `firewall-cust-1`, which allows only 443, 80, 53 from anywhere and 22, 4222 and 8083 from David's static home IP). The first attempt ran the lines on the VM with `curl.exe`, which proves nothing about outside access. Still open: `/metrics`, `/api/metrics` and the response headers, which need the stack deployed, so they wait on #77. On Linux use `-o /dev/null`, not `-o NUL`. Port 80 was opened so HTTP redirects to HTTPS; certificates would also come through port 443 alone.
- **CI Postgres port (not part of #34):** `docker ps` on the VM showed a `postgres:16` container publishing `0.0.0.0:32928->5432`, most likely a CI service container on the self-hosted runner. The firewall blocks that port from outside, so it is not reachable from the internet (not tested directly). Port 53 is open to everyone; if that DNS server resolves for anyone, it can be abused, outside this repo.
- **Shared Caddy on the VM (checked 2026-11-01, ready):** container `caddy` (v2.11.7, image tag `caddy:2-alpine`) from `/opt/proxy/compose.yaml`, on the `proxy` network, publishing 80 and 443 only, `mem_limit: 256m`. `/data` is the volume `caddy_data`. `/opt/proxy/Caddyfile` has the ACME email, the global `metrics` option, the `:9180` metrics site (answers inside the container) and `import sites/*.caddy`; `/opt/proxy/sites` is mounted at `/etc/caddy/sites`, which is where a deploy copies `mcp-lab.caddy`. `/opt/proxy/mcp-lab.env` (the Compose `env_file`) holds the domains (`mcp-prod.itias.net`, `mcp-staggin.itias.net`, spelled like that in the DNS) and the staging login; both domains resolve to the VM. Trap: `Caddyfile` is mounted as a single file, and editors replace the file, so after editing it run `docker compose up -d --force-recreate` (a reload keeps the old file). The `sites/` folder is a directory mount and does not have this problem. Changing `mcp-lab.env` also needs the container recreated.
- **Windows test failures that predate these PRs:** six backend tests (asset loading, golden quiz text, long build path, metrics x2, observability) fail on David's Windows machine with or without these changes.

## Decisions to keep

- **No new tests for now (David, 2026-10-26).** New features ship without new tests. Existing tests stay, must keep passing, and must never be skipped or deleted. QA is a quick check: run the existing suites, linters and type checks, and try the feature by hand.
- **Course code pins `mcp[cli]==2.3.0`** (#27). In `mcp` 2.x, FastMCP was renamed `MCPServer` (`from mcp.server.mcpserver import MCPServer`); `mcp.server.fastmcp` no longer exists. Use `MCPServer` in all chapters and in `oncall-mcp/`. Tools report errors by raising `ToolError` (`mcp.server.mcpserver.exceptions`); a plain `ValueError` reaches the client as "Error executing tool <name>" with its message lost. Quiz questions allow only 2 or 3 options, so correct answers are spread across a, b and c. Course code uses `typing_extensions.TypedDict` (not `typing.TypedDict`) so it runs on Python 3.10 and 3.11. The learner project's tests use `pytest==9.1.1` with the `anyio` plugin that comes with `mcp`.
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
