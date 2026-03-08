# Changelog

All notable changes to this project will be documented in this file.

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
