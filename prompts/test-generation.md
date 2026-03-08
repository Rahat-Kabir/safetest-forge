# Test Generation

Generate meaningful `pytest` tests for the selected modules.

Rules:
- write tests only under `{{preferredTestRoot}}`
- do not modify production source files
- prefer a small number of useful tests over boilerplate
- cover clear behavior and at least one edge case when the module supports it
- use the `test-writer` subagent for module-level work when helpful
- keep the resulting suite runnable with `pytest`

When complete, return structured output summarizing:
- what was analyzed
- which test files were created or updated
- any placement decisions
