# safetest-forge

## 1. Purpose

`safetest-forge` is a local-first tool for generating, running, repairing, and inspecting Python tests for an existing repository.

The project has two equally important parts:

- **SafeTest Forge core**: the agent workflow that creates and verifies `pytest` tests
- **Glassbox trace UI**: a minimal interface that exposes what the agent did, what tools it used, what files changed, and what can be rewound

This document is an implementation guide for **v1**.

## 2. V1 Product Definition

### 2.1 Supported input

V1 supports:

- a local Python repository path
- an optional target path inside that repository
- an optional single Python file inside that repository

V1 does not support:

- non-Python repositories as first-class targets
- direct execution against a remote repository URL

Remote repositories are a later feature and must work by cloning to a local temp workspace first.

### 2.2 Supported output

V1 produces:

- generated `pytest` test files
- local `pytest` execution results
- limited repair attempts for generated tests
- a structured final report
- an event trace for the run
- a rewind option for generated file changes

### 2.3 Hard constraints

- only write to test files and test directories
- do not modify production source files in v1
- use SDK file tools for writes so rewind remains valid
- run locally against the user's filesystem

### 2.4 Development rule: CLI first for every feature

Every feature in `safetest-forge` must be implemented and validated in the CLI before it is exposed in the UI.

This is a hard implementation rule for the project.

That means:

- every major feature must have a CLI entry point or CLI-visible behavior
- every feature must have a CLI acceptance path
- the UI must wrap existing working behavior, not define behavior first
- feature-complete in UI is not enough if the same feature is not testable from CLI

Examples:

- policy blocking must be visible in CLI output before it appears in the trace UI
- checkpoint and rewind must work from CLI before adding rewind buttons
- repair loop behavior must be runnable from CLI before adding UI controls
- final report generation must be inspectable from CLI before UI rendering

## 3. User Problem

Developers avoid writing tests because it is slow and tedious. Existing AI tools often generate poor tests and give no trustworthy execution trace.

This project solves two problems at once:

- **test generation**: produce useful `pytest` tests for real code
- **trust and control**: show exactly how the agent behaved and allow bad changes to be rewound

## 4. Implementation Goals

The implementation must:

- analyze a Python repository safely
- generate tests only in approved paths
- run tests locally
- surface failures clearly
- attempt a small, controlled repair loop
- emit structured run metadata
- stream internal execution events to a UI
- support checkpointing and rewind

## 5. Non-Goals

Do not implement these in v1:

- JavaScript, TypeScript, Go, Rust, or Java repositories
- code fixes in `src/`, `app/`, or production modules
- broad framework support beyond `pytest`
- CI/CD integrations
- PR creation
- cloud execution
- multi-user collaboration

## 6. Recommended Tech Stack

### 6.1 Orchestration backend

Use **TypeScript** with the Claude Agent SDK.

Reason:

- better SDK observability surface
- direct access to richer event types
- `modelUsage`, prompt suggestions, MCP session controls, and detailed system events are stronger in TypeScript
- easier to build the Glassbox-style trace around the V1 query stream

### 6.2 Target ecosystem

The tool targets **Python repositories** and `pytest`.

This means:

- backend language: TypeScript
- target code under test: Python
- test framework: `pytest`

### 6.3 UI

Use a small React UI or a simple local web UI with:

- run configuration panel
- live trace panel
- changed files panel
- structured report panel

### 6.4 Local execution

Use the local filesystem and local shell only.

The tool must run against the user's selected workspace on disk.

### 6.5 UI-backend transport contract

V1 should use:

- `REST` for command-style operations
- `SSE` for live run events

Do not start with WebSocket unless a later requirement clearly needs bidirectional push beyond cancellation.

Required endpoints:

- `POST /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/report`
- `GET /api/runs/:runId/events`
- `POST /api/runs/:runId/cancel`
- `POST /api/runs/:runId/rewind`

Transport rules:

- `POST /api/runs` creates a run and returns `runId`
- `GET /api/runs/:runId/events` is an SSE stream of normalized `TraceEvent` objects
- UI must not parse raw SDK events directly
- UI may fetch final report with REST after run completion

### 6.6 Local security model

V1 is local-only, but the backend should still avoid being open to arbitrary local or network access.

Required rules:

- bind backend to `127.0.0.1` only by default
- do not expose the API on `0.0.0.0` in v1
- generate a per-process local session token for UI-to-backend requests
- require that token on mutating endpoints such as `create run`, `cancel`, and `rewind`

This is not full multi-user auth. It is minimal local process protection.

## 7. System Architecture

Build the system as 6 parts.

### 7.1 App shell

Responsibilities:

- accept user input
- start and stop runs
- subscribe to live run events
- render trace, changed files, and final report

### 7.2 Run controller

Responsibilities:

- create one run from user input
- assemble SDK options
- attach hooks and permission policy
- stream SDK messages
- normalize SDK events into app events
- persist run metadata

### 7.3 Agent workflow

Responsibilities:

- inspect repository structure
- choose files to analyze
- delegate test generation
- run tests
- interpret failures
- decide whether to repair
- emit structured final output

### 7.4 Policy layer

Responsibilities:

- block writes outside test paths
- block unsafe shell commands
- allow safe reads
- allow test execution commands
- surface denials into the trace and final report

### 7.5 Execution adapters

Responsibilities:

- detect Python project shape
- resolve test target locations
- run `pytest`
- collect stdout, stderr, exit code, and summary

### 7.6 Storage layer

Responsibilities:

- store run metadata
- store normalized events
- store final report
- store checkpoint IDs and rewind metadata

V1 can use flat files or a simple local JSON store. A full database is not required.

### 7.7 Concurrency model

V1 should support **one active run at a time per backend process**.

Rules:

- if a run is active, a second `run` request should be rejected with a clear error
- historical runs remain queryable for `report`, `trace`, and `rewind`
- parallel execution can be added later after cancellation, timeout, and storage behavior are stable

## 8. Recommended Repository Structure

One reasonable structure:

```text
safetest-forge/
  apps/
    desktop-or-web/
  packages/
    orchestrator/
    trace-contracts/
    ui/
    policy/
    python-runtime/
  docs/
    spec.md
```

If using a single package initially, keep the internal modules separate anyway:

```text
src/
  app/
  run/
  agent/
  policy/
  runtime/
  trace/
  report/
```

## 9. Main Run Flow

This is the required end-to-end flow for v1.

### 9.1 Step 1: Accept run input

Input fields:

- `repoPath`
- `targetPath?`
- `maxRepairRounds`
- `budgetLimitUsd?`
- `includePatterns?`
- `excludePatterns?`

### 9.2 Step 2: Validate local workspace

Required checks:

- path exists
- path is readable
- at least one `.py` file exists in the repo or target scope
- repo is not obviously unsupported

Failure output:

- human-readable message
- machine-readable failure code

### 9.3 Step 3: Build run context

Create a run context object:

```ts
type RunContext = {
  runId: string;
  repoPath: string;
  targetPath?: string;
  workspacePath: string;
  startedAt: string;
  maxRepairRounds: number;
  allowedWriteRoots: string[];
};
```

### 9.4 Step 4: Start SDK session

Use the Claude Agent SDK `query()` API in TypeScript V1.

Required SDK options:

- streaming mode
- `includePartialMessages: true` so live text and tool activity can be normalized in real time
- `enableFileCheckpointing: true`
- `agents` for programmatic subagent definitions
- model routing through subagents
- `maxTurns` for the main query and subagents
- `abortController` for cancellation
- hooks enabled
- structured output schema enabled
- available tools explicitly configured through `tools`
- approval behavior explicitly configured through `allowedTools`, `disallowedTools`, and `permissionMode`
- capture cancellation handle for the active run

### 9.5 Step 5: Analyze repository

The main agent must:

- identify package roots
- detect likely test layout
- detect important modules
- avoid generated files, virtualenv folders, build folders, and cache folders

### 9.6 Step 6: Generate tests

The main agent delegates module-level work to subagents.

Each subagent:

- reads target files
- identifies behaviors and edge cases
- writes tests only in approved locations

### 9.7 Step 7: Run tests

Use local shell execution to run `pytest`.

The test runner must capture:

- command
- cwd
- stdout
- stderr
- exit code
- duration if possible
- timeout outcome if execution is aborted

Default timeout rules:

- default per test run timeout: `120000 ms`
- allow user override later, but keep a sane upper bound
- if timeout is reached, kill the process and classify the run as `timed_out`

Timeout implementation rule:

- if `pytest` is run through the SDK `Bash` tool, require the command input to include a timeout
- if `pytest` is run by the backend execution adapter directly, enforce the timeout in the backend process layer instead of relying on the agent

### 9.7.1 Cancellation flow

Cancellation must work from both CLI and UI.

Rules:

- a running run has state `running`
- on cancel request, state becomes `cancelling`
- the backend aborts the active SDK query and active shell process if one exists
- final run state becomes `cancelled`
- a cancellation event must appear in the trace

Implementation rule:

- create one `AbortController` per active run and pass it in SDK options as `abortController`
- use `controller.abort()` as the normal cancellation path
- if forced cleanup is still required, call `query.close()` to terminate the underlying SDK process and release resources

Required interfaces:

- CLI: `safetest-forge cancel --run <run-id>`
- API: `POST /api/runs/:runId/cancel`

### 9.8 Step 8: Repair if appropriate

If failures are repairable and repair budget remains:

- classify failure
- repair generated test files only
- rerun the narrowest possible test scope

### 9.9 Step 9: Finish run

Emit:

- final human-readable summary
- structured report
- changed files list
- checkpoint metadata
- cost metrics

## 10. Agent Design

### 10.1 Main orchestrator

Model: `opus`

Responsibilities:

- repository-level planning
- target selection
- subagent delegation
- repair decision-making
- final synthesis

Tools:

- `Read`
- `Glob`
- `Grep`
- `Bash`
- `Write`
- `Edit`
- `Agent`
- `TodoWrite`

### 10.2 Test writer subagents

Model: `sonnet`

Responsibilities:

- inspect one module or a small file group
- design useful `pytest` cases
- generate tests

Recommended tools:

- `Read`
- `Glob`
- `Grep`
- `Write`
- `Edit`

Do not give subagents `Bash` in v1 unless there is a clear need.

### 10.3 Failure triage subagent

Model: `haiku`

Responsibilities:

- classify test failures cheaply
- distinguish environment issues from generated-test issues
- suggest whether repair should continue

Recommended tools:

- `Read`
- `Grep`

### 10.4 Programmatic subagent definition

The subagents above must be defined through the SDK `agents` option on the main `query()` call so model selection and tool restrictions are enforced by configuration, not only by prompting.

Representative shape:

```ts
agents: {
  "test-writer": {
    description: "Generates pytest tests for one module or small file group.",
    prompt: "...",
    model: "sonnet",
    tools: ["Read", "Glob", "Grep", "Write", "Edit"],
    maxTurns: 6
  },
  "failure-triage": {
    description: "Classifies generated-test failures and decides whether repair should continue.",
    prompt: "...",
    model: "haiku",
    tools: ["Read", "Grep"],
    maxTurns: 3
  }
}
```

Implementation notes:

- include the `Agent` tool in the main session `tools` and `allowedTools` so Claude can invoke subagents
- supplying the `Agent` tool alone is not enough when V1 depends on specific named subagents; the `agents` option must also be populated
- do not give subagents the `Agent` tool in v1

## 11. SDK Configuration Requirements

### 11.1 Core SDK options

Use the TypeScript package:

- `@anthropic-ai/claude-agent-sdk`

Versioning rule:

- pin an exact package version in `package.json`
- do not use caret ranges for the SDK
- record the chosen SDK version in project docs when bootstrapping the repo

V1 should use the stable TypeScript V1 `query()` API, not the preview V2 API.

The run controller should configure:

- `cwd` to the selected repo path
- `includePartialMessages: true` for live trace streaming
- `enableFileCheckpointing: true`
- `agents` with named V1 subagent definitions
- `maxTurns` on the main query
- `tools` with the exact built-in tools V1 makes available
- `allowedTools` only for auto-approval behavior
- `disallowedTools` for hard denials when needed
- `permissionMode: "dontAsk"` in TypeScript for a locked-down session
- `abortController` for cancellation
- `hooks`
- `maxBudgetUsd` if supplied
- `outputFormat` with a strict JSON schema
- `extraArgs: { "replay-user-messages": null }` so checkpoint user message UUIDs are available when needed
- `systemPrompt: { type: "preset", preset: "claude_code" }` and `settingSources: ["project"]` if the product must honor project `CLAUDE.md` instructions in the selected repo

### 11.2 Required tools

V1 should make these built-in tools available via `tools`:

- `Read`
- `Glob`
- `Grep`
- `Write`
- `Edit`
- `Bash`
- `Agent`
- `TodoWrite`

Approval rules:

- do not rely on `allowedTools` as a hard allowlist because it only auto-approves matching tools
- use `tools` to define tool availability
- in the default V1 autonomous run flow, pre-approve the V1 tool set through `allowedTools` and let hooks deny unsafe arguments
- use `disallowedTools` for unconditional denials
- pair `allowedTools` with `permissionMode: "dontAsk"` when V1 needs listed tools approved and everything else denied without prompting
- keep argument-level restrictions in hooks because tool names alone are not enough to enforce safe file paths or shell commands
- if `Agent` is included in `tools`, also provide explicit `agents` definitions when V1 expects named subagents with fixed models or tool sets

### 11.3 Structured output

Use `outputFormat` with JSON schema on the final run so the result is machine-readable.

Result access rule:

- read the validated JSON report from the SDK result message `structured_output`
- do not parse the plain text `result` field as the machine-readable report
- handle structured-output failure subtypes explicitly, including schema retry exhaustion

Required top-level fields:

- run summary
- analyzed modules
- generated test files
- test run summary
- repair summary
- blocked operations
- cost summary

Cost extraction rules:

- `total_usd` must come from the SDK `result` message `total_cost_usd`
- `by_model` must come from the SDK `result` message `modelUsage`
- do not estimate cost from token counts if `total_cost_usd` is available
- persist raw cost metadata alongside the normalized report for debugging

### 11.4 Checkpointing

Checkpointing must be enabled for every generation run.

Important implementation rule:

- all generated tests must be written via SDK `Write` or `Edit`
- never generate files through `Bash` redirection such as `echo > file.py`

Rewind mechanism for v1:

- rewind is **SDK checkpoint restore**, not git reset and not a custom snapshot system
- capture user message UUID restore points from the SDK stream
- persist the SDK `session_id` for any run that may be rewound later
- when rewind is requested after the stream has completed, create a new `query()` with `resume: sessionId` and an empty prompt
- call `rewindFiles(userMessageId)` on that new `Query` object
- drain the resumed stream cleanly and persist the rewind result
- record which files changed as part of rewind

Implementation note:

- use the TypeScript `query().rewindFiles(userMessageId)` flow described by the SDK docs
- keep session persistence enabled so the rewind flow can resume the original session
- do not use destructive git commands for rewind

## 12. Hook and Permission Design

### 12.1 PreToolUse hook rules

Implement a `PreToolUse` hook that:

- inspects `Write` and `Edit` destinations
- denies writes outside approved test paths
- inspects `Bash` commands
- denies destructive commands
- allows safe test execution commands

Implementation notes:

- `PreToolUse` matchers filter by tool name, not by file path or shell args
- path and command checks must inspect `tool_input` directly
- hook denials should be the primary enforcement point for write-path and bash-argument policy
- `canUseTool` exists in the SDK, but V1 should use hooks as the primary automatic policy mechanism because the run is headless and uses `permissionMode: "dontAsk"`

Required denial return shape:

```ts
{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Write outside approved test path"
  }
}
```

### 12.2 Approved write locations

Default approved patterns:

- `<repo>/tests/**`
- `<repo>/**/tests/**`
- `<repo>/test_*.py`
- `<repo>/**/*_test.py` only if explicitly enabled later

V1 default should prefer:

- `tests/`
- nested `tests/` directories

### 12.3 Approved shell commands

Allowed categories:

- `pytest`
- read-only inspection such as `pwd`, `ls`, `python --version`
- safe environment discovery such as `which python` or equivalent

Denied categories:

- `rm -rf`
- `git reset --hard`
- package publish commands
- unrelated network or deployment commands

### 12.4 Permission denials

Every denial must be:

- visible in the live trace
- recorded in the final report
- attached to the tool name and reason

## 13. Python Runtime Detection

The runtime layer should implement minimal but useful project detection.

### 13.1 Detect Python project shape

Look for:

- `pyproject.toml`
- `requirements.txt`
- `setup.py`
- `tox.ini`
- existing `tests/`

### 13.2 Detect likely package roots

Look for:

- `src/`
- top-level import packages
- modules referenced by the target path

Monorepo rule:

- if multiple distinct Python package roots are detected and the user did not provide `targetPath`, mark the repo as ambiguous
- in that case, fail with a clear message telling the user to pass `--target`
- do not silently scan every Python package in a large monorepo in v1

### 13.3 Detect execution approach

V1 should not over-engineer environment setup.

Preferred order:

1. run `pytest` directly if it works in the repo environment
2. if target path is narrow, run a narrow `pytest` invocation

Do not attempt complex package manager inference in v1 unless necessary.

Environment dependency rule:

- if test execution clearly requires missing env vars, services, or external infrastructure, classify the run as `environment_dependency`
- surface the missing requirement in CLI, trace, and final report
- do not try to provision databases, queues, or remote services in v1

## 14. Test File Placement Rules

The runtime or agent prompt must define deterministic file placement.

### 14.1 If repo already has `tests/`

Write tests under existing `tests/` structure.

### 14.2 If repo uses package-local tests

V1 may still prefer top-level `tests/` unless there is a clear existing convention that should be preserved.

### 14.2.1 If no test convention exists

If the repository has no `tests/` directory and no clear package-local convention:

- create a top-level `tests/` directory at repo root
- record that decision in the final report

### 14.3 Naming convention

Default naming:

- source `foo/bar.py`
- generated test `tests/test_bar.py`

For collisions:

- include package path in the test filename or nested folder

## 15. Repair Loop Rules

The repair loop must be small and deterministic.

### 15.1 Maximum retries

Default: `1`

Allow configuration up to `2`.

### 15.2 Repairable cases

Attempt repair when failures are likely due to generated test issues:

- import errors caused by bad test paths
- syntax errors in generated tests
- obvious fixture mistakes
- assertion mistakes caused by wrong function usage

### 15.3 Non-repairable cases

Stop repair when failures indicate:

- broken repo environment
- missing dependencies
- failing production code
- ambiguous expected behavior

### 15.4 Repair scope

Repair may only edit files created or changed by the current run in approved test locations.

## 16. Trace Event Model

The UI should not depend directly on raw SDK messages. Normalize them first.

### 16.1 Normalized event shape

```ts
type TraceEvent = {
  runId: string;
  sessionId?: string;
  parentToolUseId?: string | null;
  ts: string;
  type:
    | "run_started"
    | "assistant_text"
    | "tool_use"
    | "tool_result"
    | "tool_progress"
    | "hook_event"
    | "permission_denied"
    | "subagent_started"
    | "subagent_finished"
    | "task_progress"
    | "file_changed"
    | "checkpoint_created"
    | "rewind_available"
    | "run_finished"
    | "run_failed";
  data: Record<string, unknown>;
};
```

### 16.2 Minimum UI-visible events

The user must be able to see:

- start of run
- assistant progress text
- tool calls
- blocked tool calls
- subagent start and stop
- changed files
- test command execution
- final result

Normalization notes:

- detect subagent invocation from `tool_use` blocks named `Agent` and also accept `Task` for compatibility
- preserve `parent_tool_use_id` when present so UI can attribute messages to subagent execution
- derive token-by-token text and streaming tool activity from SDK partial messages rather than waiting for complete assistant messages

## 17. Final Report Schema

The final report must be structured and persisted.

Minimum schema:

```json
{
  "run_id": "string",
  "repo_path": "string",
  "target_path": "string or null",
  "framework": "pytest",
  "status": "passed | failed | partial | blocked | cancelled | timed_out | environment_dependency | invalid_input",
  "failure_code": "string or null",
  "analyzed_modules": [
    {
      "path": "string",
      "reason_selected": "string"
    }
  ],
  "generated_tests": [
    {
      "path": "string",
      "source_targets": ["string"]
    }
  ],
  "test_run": {
    "command": "string",
    "exit_code": 0,
    "passed": 0,
    "failed": 0,
    "errors": 0
  },
  "repair": {
    "attempted": true,
    "rounds_used": 0,
    "stopped_reason": "string or null"
  },
  "blocked_operations": [
    {
      "tool": "string",
      "reason": "string"
    }
  ],
  "checkpoints": {
    "enabled": true,
    "session_id": "string or null",
    "restore_points": [
      {
        "user_message_uuid": "string",
        "label": "string or null"
      }
    ]
  },
  "cost": {
    "total_usd": 0,
    "by_model": {}
  }
}
```

## 18. UI Requirements

V1 UI should be minimal, not polished.

### 18.1 Run panel

Fields:

- repo path
- target path
- max repair rounds
- start run button

### 18.2 Trace panel

Show:

- live event stream
- tool names
- blocked operations
- subagent labels
- test command execution

### 18.3 Files panel

Show:

- files created or modified
- diff preview if available
- rewind action if checkpoint exists

### 18.4 Report panel

Show:

- structured summary
- pass/fail counts
- repair summary
- blocked operations
- cost by model

## 19. CLI Requirements

Implement a CLI before the UI for every major feature. The CLI is the primary validation surface for the project.

Suggested command shape:

```bash
safetest-forge run --repo /path/to/repo --target src/foo.py
```

The CLI must remain a first-class interface, not a temporary developer tool.

### 19.1 Core CLI commands

Minimum command set for v1:

```bash
safetest-forge run --repo /path/to/repo [--target path]
safetest-forge cancel --run <run-id>
safetest-forge report --run <run-id>
safetest-forge trace --run <run-id>
safetest-forge rewind --run <run-id> --checkpoint <user-message-uuid>
```

If a command is not fully built yet, the feature tied to it is not done.

### 19.2 CLI-first acceptance rule

Before a feature is considered complete:

- it must be executable from CLI
- it must emit clear success or failure output in CLI
- it must persist enough data for inspection from CLI
- only then may the UI add controls or views for it

Minimum CLI output:

- run start
- selected targets
- generated files
- test execution result
- path to saved report

### 19.3 Feature-to-CLI mapping

Each major feature must have a CLI validation path:

- repository validation: `safetest-forge run ...`
- policy denials: visible during `run` and in `trace`
- generated tests listing: visible during `run` and `report`
- test execution results: visible during `run` and `report`
- repair attempts: visible during `run`, `trace`, and `report`
- checkpoints: visible during `run` and `report`
- rewind: executable through `rewind`
- cancellation: executable through `cancel`
- trace inspection: accessible through `trace`

## 20. Persistence Requirements

Persist each run locally.

Store:

- run config
- normalized trace events
- final report
- session ID
- restore-point user message UUIDs

Suggested location:

- project-local `.safetest-forge/`
or
- user-local app data directory

## 21. Error Handling Requirements

Handle these cases explicitly:

- invalid repo path
- repo contains no Python files
- `pytest` is unavailable
- test command fails to start
- policy blocks file writes
- checkpoint creation missing
- structured output validation fails
- SDK run exceeds budget
- run is cancelled
- pytest execution times out
- repo is an ambiguous monorepo without `--target`
- repo requires missing environment dependencies

Every failure must produce:

- a user-visible message
- a normalized failure event
- a final report with failure status when possible

## 22. Testing Strategy For safetest-forge

The project must test its own behavior from the start.

### 22.1 Unit tests

Test:

- path policy matching
- shell command policy matching
- trace normalization
- report normalization
- runtime detection helpers
- prompt rendering helpers

### 22.2 Integration tests

Create fixture repositories under a test fixtures directory.

Required fixture types:

- simple Python package
- repo with existing `tests/`
- repo with no `tests/`
- ambiguous monorepo with two Python package roots
- repo with failing environment dependency

Integration tests should validate:

- CLI run lifecycle
- policy denials
- test placement
- timeout handling
- cancellation handling
- rewind metadata persistence

### 22.3 End-to-end smoke tests

At minimum, add a small set of CLI-driven smoke tests that:

- run against a fixture repo
- verify report output exists
- verify trace output exists
- verify generated tests stay inside approved paths

### 22.4 UI tests

UI tests may remain lightweight in v1.

Focus on:

- rendering persisted trace data
- rendering final report data
- invoking backend endpoints correctly

## 23. Build Order

Implement in this order.

Global rule for every phase:

- phase implementation starts in CLI
- phase acceptance is done in CLI first
- UI support is added only after CLI acceptance passes

### Phase 1: CLI skeleton

Build:

- CLI command
- input validation
- run context creation

Acceptance:

- user can run the tool against a local repo path
- CLI prints validation errors and run context clearly

### Phase 2: SDK orchestration

Build:

- main `query()` integration
- event stream capture
- structured output collection

Acceptance:

- run produces streamed events and a final structured result
- CLI can display the streamed events without the UI

### Phase 3: policy layer

Build:

- write-path hook
- shell command hook
- denial reporting

Acceptance:

- writes outside test paths are blocked
- destructive shell commands are blocked
- CLI shows which tool call was denied and why

### Phase 4: Python test generation

Build:

- repository analysis prompts
- subagent delegation
- deterministic test placement

Acceptance:

- tool generates test files in approved locations
- CLI shows generated file paths and source targets

### Phase 5: local pytest execution

Build:

- local test runner adapter
- stdout/stderr capture
- narrow rerun support

Acceptance:

- tool runs generated tests and records results
- CLI prints command, exit code, and test summary

### Phase 6: repair loop

Build:

- failure triage
- one repair attempt
- rerun after repair

Acceptance:

- obvious generated-test failures can be repaired once
- CLI shows repair round start, repair reason, and rerun result

### Phase 7: checkpoint and rewind

Build:

- checkpoint capture
- changed file tracking
- rewind action

Acceptance:

- generated file changes can be rewound when written through SDK file tools
- CLI can list checkpoint IDs and perform rewind without UI

### Phase 8: trace UI

Build:

- run page
- trace list
- files list
- final report view

Acceptance:

- a user can inspect one full run visually
- every UI-visible trace item already exists in CLI output or CLI-backed persisted data

## 24. Prompting Rules

Define prompts as source-controlled assets, not inline strings scattered across the codebase.

Prompt asset format:

- store prompts under `prompts/`
- use Markdown files for readability
- use simple placeholder interpolation such as `{{repoPath}}`, `{{targetPath}}`, and `{{allowedWriteRoots}}`
- optionally allow YAML frontmatter for metadata like `id`, `purpose`, and `expected_inputs`

Recommended structure:

```text
prompts/
  repository-analysis.md
  test-generation.md
  failure-triage.md
  final-synthesis.md
```

Create separate prompts for:

- repository analysis
- per-module test generation
- failure triage
- final synthesis

Each prompt must state:

- only generate tests
- do not modify source files
- prefer meaningful edge-case coverage over boilerplate
- respect test path policy

## 25. Acceptance Criteria For V1

V1 is complete when all of the following are true:

- user can point the tool at a local Python repository
- tool identifies reasonable test targets
- tool writes only in approved test paths
- tool generates at least one valid `pytest` test file for a suitable repo
- tool runs `pytest`
- tool records pass/fail results
- tool emits a structured final report
- tool exposes a live trace
- tool supports rewind for generated file edits
- every completed feature is usable and verifiable from CLI
- UI consumes the documented REST and SSE contract rather than hidden in-process state
- cancellation works from CLI and API
- timed-out test runs are classified correctly
- ambiguous monorepos require explicit `--target`

## 26. V2 Extensions

After v1 is stable, add:

- remote Git repo input via clone-to-temp workspace
- better Python environment detection
- `pytest-cov` integration
- MCP-based repository services
- custom test runner tools
- richer diff viewer
- multiple runs comparison
