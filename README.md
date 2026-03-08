# safetest-forge

`safetest-forge` is a local-first TypeScript tool for generating, running, repairing, inspecting, and rewinding Python `pytest` tests.

The repository is open source. Live `claude` runs require your own Anthropic API key, but local development, tests, and smoke evaluation work in `fake` mode without one.

## Setup

Requirements:
- Node.js 22+
- Python 3.12+
- `pytest` available on `PATH`

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

For local development without an API key, keep:

```bash
SAFETEST_FORGE_AGENT_MODE=fake
```

For live Anthropic runs, set:

```bash
ANTHROPIC_API_KEY=your_api_key_here
SAFETEST_FORGE_AGENT_MODE=claude
```

Build the project:

```bash
npm run build
```

Run the test suite:

```bash
npm test
```

## CLI Usage

Run against a local Python repo in API-free `fake` mode:

```bash
npm run cli -- run --repo tests/fixtures/simple-package --agent-mode fake
```

Run the live Claude path with your own Anthropic API key:

```bash
npm run cli -- run --repo tests/fixtures/simple-package --agent-mode claude
```

Other commands:

```bash
npm run cli -- cancel --run <run-id>
npm run cli -- report --run <run-id>
npm run cli -- trace --run <run-id>
npm run cli -- rewind --run <run-id> [--checkpoint <user-message-uuid>]
```

If `npm run cli -- ...` does not forward flags correctly in your shell, use the direct form instead:

```bash
npx tsx src/cli.ts run --repo D:\path\to\repo --agent-mode claude
npx tsx src/cli.ts rewind --run <run-id>
```

## UI / Local Backend

Start the local backend on `127.0.0.1:4317`:

```bash
npm run server
```

The server writes a local session token file to `.safetest-forge/server.json` and serves:
- `POST /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/report`
- `GET /api/runs/:runId/events`
- `POST /api/runs/:runId/cancel`
- `POST /api/runs/:runId/rewind`

## Current Capabilities

- CLI-first V1 flow with `run`, `cancel`, `report`, `trace`, and `rewind`
- Python repo validation, package-shape detection, and ambiguous-monorepo rejection without `--target`
- Policy enforcement for test-only writes and a restricted shell allowlist
- Claude Agent SDK integration with streaming events, structured output, checkpoint capture, and subagent definitions
- Deterministic fake-agent path for unit, integration, and CLI smoke tests
- Local `pytest` execution with stdout/stderr capture, timeout classification, cancellation polling, and one repair round
- Live-run cancellation propagation through the run-level abort controller, including persisted cancel requests observed across processes
- Flat-file persistence under `.safetest-forge/` for runs, traces, reports, checkpoints, and fake rewind snapshots
- React UI with 2-column layout, color-coded trace badges, phase progress bar, click-to-copy run ID, stat grid report panel, and REST + SSE wiring

## Open Source Notes

- `.env` is local-only and should never be committed.
- Python local-dev artifacts such as `.venv/`, `venv/`, and `.pytest_cache/` are ignored.
- `fake` mode is the default contributor path and does not require paid API access.
- The repo is not npm-published in its current form; use the source checkout commands above.
