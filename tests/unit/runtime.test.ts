import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildAllowedWriteRoots,
  detectPythonTooling,
  detectPytestPlugins,
  resolveGeneratedTestPath,
  runPytest,
  validateRepository
} from "../../src/runtime/python.js";
import type { RunContext } from "../../src/types.js";

describe("runtime detection", () => {
  it("detects simple repositories and prefers top-level tests", async () => {
    const repoPath = path.resolve("tests/fixtures/simple-package");
    const result = await validateRepository(repoPath);
    expect(result.failure).toBeUndefined();
    expect(result.analysis?.preferredTestRoot).toBe(path.join(repoPath, "tests"));
    expect(result.analysis?.analyzedModules[0]?.path).toBe("src/calculator.py");
  });

  it("rejects ambiguous monorepos without a target", async () => {
    const repoPath = path.resolve("tests/fixtures/ambiguous-monorepo");
    const result = await validateRepository(repoPath);
    expect(result.analysis).toBeUndefined();
    expect(result.failure?.code).toBe("ambiguous_monorepo");
  });

  it("derives deterministic generated test paths", () => {
    const repoPath = path.resolve("tests/fixtures/existing-tests");
    const testPath = resolveGeneratedTestPath(repoPath, path.join(repoPath, "tests"), "src/formatter.py");
    expect(testPath.endsWith(path.join("tests", "test_formatter.py"))).toBe(true);
  });

  it("advertises only test write roots", () => {
    const repoPath = path.resolve("tests/fixtures/simple-package");
    expect(buildAllowedWriteRoots(repoPath)).toEqual([path.join(repoPath, "tests")]);
  });

  it("detectPythonTooling returns a stable shape", () => {
    const tooling = detectPythonTooling(true);
    expect(tooling).toMatchObject({
      pythonAvailable: expect.any(Boolean),
      pytestAvailable: expect.any(Boolean),
      pythonCommand: expect.anything()
    });
  });
});

describe("pytest plugin integration", () => {
  it("populates per-test cases and counts when pytest-json-report is available", async () => {
    const plugins = detectPytestPlugins(true);
    if (!plugins.jsonReport) {
      console.warn("Skipping json-report runtime assertion: plugin not installed");
      return;
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "safetest-forge-rt-"));
    try {
      const testPath = path.join(tmpDir, "test_demo.py");
      await fs.writeFile(
        testPath,
        [
          "def test_one():",
          "    assert 1 + 1 == 2",
          "",
          "def test_two():",
          "    assert 2 + 2 == 4",
          "",
          "def test_three():",
          "    assert 1 + 1 == 3",
          ""
        ].join("\n"),
        "utf8"
      );

      const context: RunContext = {
        runId: "runtime-test",
        repoPath: tmpDir,
        workspacePath: tmpDir,
        startedAt: new Date().toISOString(),
        maxRepairRounds: 0,
        allowedWriteRoots: [tmpDir],
        timeoutMs: 30_000,
        agentMode: "fake"
      };

      const result = await runPytest(
        context,
        [{ path: "test_demo.py", source_targets: [] }],
        async () => false,
        { plugins }
      );

      expect(result.cases.length).toBe(3);
      const outcomes = result.cases.map((entry) => entry.outcome).sort();
      expect(outcomes).toEqual(["failed", "passed", "passed"]);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(1);
      for (const testCase of result.cases) {
        expect(testCase.nodeid).toContain("test_demo.py::");
        expect(testCase.duration_ms).toBeGreaterThanOrEqual(0);
      }
      const failed = result.cases.find((entry) => entry.outcome === "failed");
      expect(failed?.message).toMatch(/assert/i);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns no coverage when pytest-cov is not installed", async () => {
    const plugins = detectPytestPlugins(true);
    if (plugins.cov) {
      console.warn("Skipping graceful-degradation check: pytest-cov is installed");
      return;
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "safetest-forge-cov-"));
    try {
      await fs.writeFile(path.join(tmpDir, "test_noop.py"), "def test_noop():\n    assert True\n", "utf8");

      const context: RunContext = {
        runId: "coverage-test",
        repoPath: tmpDir,
        workspacePath: tmpDir,
        startedAt: new Date().toISOString(),
        maxRepairRounds: 0,
        allowedWriteRoots: [tmpDir],
        timeoutMs: 30_000,
        agentMode: "fake"
      };

      const result = await runPytest(
        context,
        [{ path: "test_noop.py", source_targets: [] }],
        async () => false,
        { plugins }
      );

      expect(result.coverage).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
