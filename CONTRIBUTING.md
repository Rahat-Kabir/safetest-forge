# Contributing

## Development

- Use Node.js 22+ and Python 3.12+.
- Install dependencies with `npm install`.
- Run the test suite with `npm test`.
- Build the UI bundle and typecheck with `npm run build`.

## Local Modes

- `fake` mode is the default path for local development, tests, and review.
- `claude` mode requires your own `ANTHROPIC_API_KEY` in `.env`.

## Project Rules

- Follow [docs/spec.md](docs/spec.md).
- Keep the workflow CLI-first before adding or changing UI behavior.
- Do not modify production source files in target repositories. The tool may only write under test paths.
- Update [docs/tech_spec.md](docs/tech_spec.md), [docs/progress.md](docs/progress.md), and [README.md](README.md) when behavior or setup changes.

## Pull Requests

- Keep changes surgical.
- Add or update tests when behavior changes.
- Prefer failing fast over silent fallback behavior.
