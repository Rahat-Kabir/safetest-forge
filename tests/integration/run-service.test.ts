import fs from "node:fs/promises";
import path from "node:path";

import { RunStore } from "../../src/storage/run-store.js";
import { RunService } from "../../src/run-service.js";

describe("RunService integration", () => {
  it("runs a simple repository end to end", async () => {
    const runService = new RunService();
    const started = await runService.startRun({
      repoPath: path.resolve("tests/fixtures/simple-package"),
      agentMode: "fake"
    });
    const report = await started.completion;
    expect(report.status).toBe("passed");
    expect(report.generated_tests[0]?.path).toBe("tests/test_calculator.py");
  });

  it("preserves an existing tests directory", async () => {
    const runService = new RunService();
    const started = await runService.startRun({
      repoPath: path.resolve("tests/fixtures/existing-tests"),
      agentMode: "fake"
    });
    const report = await started.completion;
    expect(report.status).toBe("passed");
    expect(report.generated_tests[0]?.path.startsWith("tests/")).toBe(true);
  });

  it("classifies missing environment dependencies", async () => {
    const runService = new RunService();
    const started = await runService.startRun({
      repoPath: path.resolve("tests/fixtures/env-dependency"),
      agentMode: "fake"
    });
    const report = await started.completion;
    expect(report.status).toBe("environment_dependency");
    expect(report.failure_code).toBe("environment_dependency");
  });

  it("repairs a generated test failure once", async () => {
    const runService = new RunService();
    const started = await runService.startRun({
      repoPath: path.resolve("tests/fixtures/repairable-package"),
      agentMode: "fake",
      maxRepairRounds: 1
    });
    const report = await started.completion;
    expect(report.status).toBe("passed");
    expect(report.repair.attempted).toBe(true);
    expect(report.repair.rounds_used).toBe(1);
  });

  it("records blocked operations from policy denials", async () => {
    const runService = new RunService();
    const started = await runService.startRun({
      repoPath: path.resolve("tests/fixtures/policy-denial"),
      agentMode: "fake"
    });
    const report = await started.completion;
    expect(report.blocked_operations).toHaveLength(1);
    expect(report.blocked_operations[0]?.tool).toBe("Write");
  });

  it("times out slow pytest runs", async () => {
    const runService = new RunService();
    const started = await runService.startRun({
      repoPath: path.resolve("tests/fixtures/slow-package"),
      agentMode: "fake",
      timeoutMs: 150
    });
    const report = await started.completion;
    expect(report.status).toBe("timed_out");
    expect(report.failure_code).toBe("pytest_timed_out");
  });

  it("supports cancellation through the run service", async () => {
    const runService = new RunService();
    const started = await runService.startRun({
      repoPath: path.resolve("tests/fixtures/slow-package"),
      agentMode: "fake",
      timeoutMs: 3_000
    });
    await runService.cancelRun(started.runId);
    const report = await started.completion;
    expect(report.status).toBe("cancelled");
  });

  it("classifies cross-process cancellation during generation as cancelled", async () => {
    const store = new RunStore();
    const runner = new RunService(store, () => ({
      mode: "claude",
      async generateTests(_context, _analysis, sink) {
        while (!(await sink.isCancelled())) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Run cancelled");
      },
      async repairTests() {
        return {
          totalCostUsd: 0,
          modelUsage: {},
          stoppedReason: null
        };
      },
      async rewind() {
        return {
          canRewind: false,
          error: "not implemented"
        };
      }
    }));
    const controller = new RunService(store);
    const started = await runner.startRun({
      repoPath: path.resolve("tests/fixtures/simple-package"),
      agentMode: "claude"
    });

    await controller.cancelRun(started.runId);

    const report = await started.completion;
    expect(report.status).toBe("cancelled");
    expect(report.failure_code).toBe("cancelled");
  });

  it("captures per-test cases in the final report and trace", async () => {
    const runService = new RunService();
    const started = await runService.startRun({
      repoPath: path.resolve("tests/fixtures/simple-package"),
      agentMode: "fake"
    });
    const report = await started.completion;
    expect(report.status).toBe("passed");
    expect(report.test_run.cases.length).toBeGreaterThan(0);
    expect(
      report.test_run.cases.every((testCase) => typeof testCase.nodeid === "string" && testCase.nodeid.length > 0)
    ).toBe(true);
    expect(
      report.test_run.cases.every((testCase) => testCase.outcome === "passed")
    ).toBe(true);
    expect(
      report.test_run.cases.every((testCase) => typeof testCase.duration_ms === "number")
    ).toBe(true);

    const events = await runService.getTrace(started.runId);
    const caseEvents = events.filter((event) => event.type === "test_case_result");
    expect(caseEvents.length).toBe(report.test_run.cases.length);
    expect(caseEvents[0]?.data.outcome).toBe("passed");
  });

  it("rewinds generated fake-agent files", async () => {
    const runService = new RunService();
    const repoPath = path.resolve("tests/fixtures/simple-package");
    const started = await runService.startRun({
      repoPath,
      agentMode: "fake"
    });
    const report = await started.completion;
    const generated = path.join(repoPath, report.generated_tests[0]!.path);
    const rewind = await runService.rewindRun(started.runId);
    expect(rewind.canRewind).toBe(true);
    await expect(fs.readFile(generated, "utf8")).rejects.toThrow();
  });
});
