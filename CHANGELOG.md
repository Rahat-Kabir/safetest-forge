# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Per-test outcome capture: every `pytest` invocation now produces a `cases[]`
  array on the final report when `pytest-json-report` is installed. Each entry
  records the `nodeid`, outcome, duration in milliseconds, source file, and the
  failure message when applicable.
- Optional coverage capture: when `pytest-cov` is installed the report and
  trace include a `coverage` block with `overall_percent` and a per-file
  breakdown. The plugin is optional; absence is handled gracefully.
- New trace events: `test_case_result` (one per test case) and
  `coverage_summary` (one per run when coverage is available).
- CLI: `report --cases` prints just the per-test results, `report --coverage`
  prints just the coverage block.
- UI: the Report Panel now renders a per-test case list with color-coded
  outcomes plus a coverage bar and per-file coverage rows when available.

## [0.1.0] - 2026-03-08

### Added

- CLI commands: `run`, `cancel`, `report`, `trace`, `rewind`, and `server`
- Local backend bound to `127.0.0.1:4317`
- React UI for run control, trace inspection, generated files, and final report viewing
- Flat-file run persistence under `.safetest-forge/`
- Deterministic `fake` agent mode for local development and automated tests
- Claude Agent SDK integration for live runs with structured output and checkpoint capture
- Repository hygiene files including `LICENSE.md`, `.env.example`, `CONTRIBUTING.md`, and `SECURITY.md`

### Implemented

- Python repository validation and ambiguous monorepo detection
- Test-only write policy enforcement and restricted shell command policy
- Local `pytest` execution with stdout/stderr capture, timeout handling, and cancellation polling
- Single-round repair flow for generated-test failures
- Checkpoint capture and rewind support
- Normalized trace events for CLI and UI consumption
- Structured final reports persisted per run

### Testing

- Unit coverage for policy, runtime detection, and trace normalization
- Integration coverage for run lifecycle, policy denials, environment dependency classification, repair, cancellation, and rewind
- CLI smoke coverage
- Lightweight UI rendering and backend API coverage
