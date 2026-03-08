# Technical Spec

## 2026-03-09

- Added a repository `LICENSE.md` using standard MIT license text as the initial open-source license document.
- Added `CHANGELOG.md` with an initial `0.1.0` entry summarizing the current CLI, backend, UI, persistence, and testing scope.
- Updated `README.md` open-source notes to point contributors to the license and changelog files.

## 2026-03-08

- Implemented the project as a single TypeScript package under `src/` with separate internal modules for agent, runtime, policy, storage, server, trace normalization, and UI.
- Pinned `@anthropic-ai/claude-agent-sdk` to `0.2.71` in `package.json` with no caret ranges.
- Added `dotenv` loading at process startup so CLI and server read `ANTHROPIC_API_KEY` from `.env`.
- Used flat-file persistence under `.safetest-forge/`:
  - `runs/<runId>/run.json`
  - `runs/<runId>/events.ndjson`
  - `runs/<runId>/report.json`
  - `runs/<runId>/control.json`
  - `runs/<runId>/rewind-snapshot.json` for deterministic fake-agent rewind tests
- Implemented CLI-first orchestration in `RunService` and reused the same service from the Express backend.
- Bound the backend server to `127.0.0.1:4317` only.
- Secured mutating REST endpoints with a per-process session token written to `.safetest-forge/server.json`.
- Implemented policy enforcement with SDK `PreToolUse` hooks for:
  - `Write` and `Edit` path restrictions
  - `Bash` command allowlist / denylist checks
- Normalized SDK stream data into app `TraceEvent` records instead of exposing raw SDK messages to the UI.
- Used SDK features required by the V1 spec:
  - `includePartialMessages: true`
  - `enableFileCheckpointing: true`
  - `extraArgs: { "replay-user-messages": null }`
  - `outputFormat` JSON schema
  - `permissionMode: "dontAsk"`
  - programmatic subagent definitions for `test-writer` and `failure-triage`
- Added a deterministic `fake` agent mode for tests so the orchestration layer is fully covered without depending on a paid live model run.
- Verified a live Claude SDK smoke run against `tests/fixtures/simple-package` after the local implementation was complete.
- Bundled the React UI with `esbuild`.
- Added `@rollup/rollup-win32-x64-msvc` explicitly because Windows optional native package installation was not reliable enough for Vitest/Rollup in this environment.
- Added open-source repository hygiene files:
  - `.gitignore`
  - `.npmignore`
  - `.env.example`
  - `CONTRIBUTING.md`
  - `SECURITY.md`
- Updated onboarding docs so contributors can use `fake` mode without `ANTHROPIC_API_KEY` and only need a key for live `claude` runs.
- Ignored local runtime state, editor-local config, build output, and Python bytecode to reduce first-push risk.
- Expanded `.gitignore` with Python-local `pytest` cache and virtualenv directories so repo-scoped development noise stays untracked.
- Wired live Claude runs to the run-level `AbortController` so explicit cancellation propagates into the SDK query.
- Tightened prompt-visible write roots to test directories only so model instructions match hook-enforced policy.
- Fixed the Windows repository-path placeholder in the React UI by escaping backslashes correctly.
- Redesigned the React UI from a 4-column flat grid to a 2-column sidebar + content layout:
  - Sidebar: Run Panel, Files Panel, Report Panel (sticky)
  - Content: Trace Panel as full-width main area
  - Typography: DM Sans (display) + JetBrains Mono (data/code)
  - Trace events use 8 color-coded badge categories: run, tool, text, file, denied, checkpoint, agent, progress
  - Added live phase progress bar with spinner during active runs
  - Added auto-scroll to latest trace event
  - Run ID shown in full with click-to-copy
  - Report panel uses a 2x2 stat grid with large color-coded numbers instead of plain text
  - Files panel shows file icons and "generated" badges
  - Dot-grid background texture, card entrance animations, custom scrollbar
  - Responsive: collapses to single column below 900px
