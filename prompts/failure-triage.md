# Failure Triage And Repair

A generated test run failed. Repair only generated tests and do not touch production files.

Repository: `{{repoPath}}`
Allowed write roots: `{{allowedWriteRoots}}`

Generated tests:
{{generatedTests}}

Failure output:
{{failureOutput}}

Rules:
- only edit the generated test files listed above
- stop if the failure looks like a missing environment dependency or broken production code
- prefer the narrowest change that fixes the generated test issue
