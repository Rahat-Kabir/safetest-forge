import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_REPAIR_ROUNDS,
  DEFAULT_TIMEOUT_MS,
  MAX_REPAIR_ROUNDS,
  getAgentMode
} from "./config.js";
import { ClaudeAgentClient } from "./agent/claude-agent-client.js";
import { FakeAgentClient } from "./agent/fake-agent-client.js";
import type { AgentClient } from "./agent/types.js";
import {
  buildRunContext,
  classifyFailure,
  ensureTestRoot,
  runPytest,
  validateRepository
} from "./runtime/python.js";
import { RunStore } from "./storage/run-store.js";
import type {
  AnalyzedModule,
  FinalReport,
  GeneratedTest,
  RewindResult,
  RunContext,
  RunRecord,
  RunRequest,
  RunStatus,
  TestExecutionResult,
  TraceEvent
} from "./types.js";
import { mergeModelUsage, nowIso, shortId } from "./utils.js";

type RunStart = {
  runId: string;
  completion: Promise<FinalReport>;
};

export class RunService {
  private readonly store: RunStore;
  private readonly activeRuns = new Map<
    string,
    {
      context: RunContext;
      abort: AbortController;
      completion: Promise<FinalReport>;
    }
  >();

  constructor(store?: RunStore, private readonly agentFactory = defaultAgentFactory) {
    this.store = store ?? new RunStore();
  }

  getStore(): RunStore {
    return this.store;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async startRun(request: RunRequest): Promise<RunStart> {
    await this.initialize();
    await this.assertNoActiveRun();

    const runId = randomUUID();
    const maxRepairRounds = clampRepairRounds(request.maxRepairRounds ?? DEFAULT_REPAIR_ROUNDS);
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const agentMode = request.agentMode ?? getAgentMode();
    const context = buildRunContext({
      runId,
      repoPath: request.repoPath,
      targetPath: request.targetPath,
      timeoutMs,
      maxRepairRounds,
      agentMode,
      budgetLimitUsd: request.budgetLimitUsd
    });

    const record: RunRecord = {
      runId,
      repoPath: context.repoPath,
      targetPath: request.targetPath ?? null,
      status: "running",
      startedAt: context.startedAt,
      finishedAt: null,
      maxRepairRounds,
      budgetLimitUsd: request.budgetLimitUsd ?? null,
      timeoutMs,
      agentMode,
      reportPath: null,
      sessionId: null,
      restorePoints: [],
      generatedTests: [],
      failureCode: null,
      blockedOperations: []
    };
    await this.store.saveRun(record);
    await this.store.setActiveRun(runId, process.pid);
    await this.emit({
      runId,
      ts: nowIso(),
      type: "run_started",
      data: {
        repo_path: context.repoPath,
        target_path: context.targetPath ?? null,
        agent_mode: agentMode
      }
    });

    const abort = new AbortController();
    const completion = this.executeRun(context, record, abort);
    this.activeRuns.set(runId, { context, abort, completion });
    void completion.finally(async () => {
      this.activeRuns.delete(runId);
      await this.store.clearActiveRun(runId);
    });

    return { runId, completion };
  }

  async cancelRun(runId: string): Promise<boolean> {
    const run = await this.store.getRun(runId);
    if (!run) {
      return false;
    }

    await this.store.setCancelRequested(runId, true);
    const active = this.activeRuns.get(runId);
    if (active) {
      active.abort.abort();
      run.status = "cancelling";
      await this.store.saveRun(run);
      await this.emit({
        runId,
        ts: nowIso(),
        type: "task_progress",
        data: { phase: "cancel_requested" }
      });
    }

    return true;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    await this.initialize();
    return this.store.getRun(runId);
  }

  async getReport(runId: string): Promise<FinalReport | null> {
    await this.initialize();
    return this.store.getReport(runId);
  }

  async getTrace(runId: string): Promise<TraceEvent[]> {
    await this.initialize();
    return this.store.getEvents(runId);
  }

  async rewindRun(runId: string, checkpointId?: string): Promise<RewindResult> {
    await this.initialize();
    const run = await this.store.getRun(runId);
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }

    const context = buildRunContext({
      runId,
      repoPath: run.repoPath,
      targetPath: run.targetPath ?? undefined,
      timeoutMs: run.timeoutMs,
      maxRepairRounds: run.maxRepairRounds,
      agentMode: run.agentMode
    });

    const sink = {
      emit: (event: TraceEvent) => this.emit(event),
      isCancelled: async () => false
    };

    let rewindResult: RewindResult;
    if (run.agentMode === "fake") {
      const snapshot = await this.store.getRewindSnapshot(runId);
      if (!snapshot) {
        throw new Error("No rewind snapshot was recorded for this fake run");
      }
      const filesChanged: string[] = [];
      for (const [filePath, content] of Object.entries(snapshot)) {
        if (content === null) {
          await fs.rm(filePath, { force: true });
        } else {
          await fs.writeFile(filePath, content, "utf8");
        }
        filesChanged.push(path.relative(run.repoPath, filePath));
      }
      rewindResult = { canRewind: true, filesChanged };
    } else {
      const events = await this.store.getEvents(runId);
      const rewindPlan = deriveClaudeRewindPlan(events, checkpointId);
      try {
        if (rewindPlan.length === 0) {
          throw new Error("No checkpoint is available for this run");
        }
        const client = this.agentFactory("claude");
        const claudeClient = client as ClaudeAgentClient;
        const allFilesChanged = new Set<string>();
        let canRewind = true;

        for (const step of [...rewindPlan].reverse()) {
          const stepResult = await claudeClient.rewindWithSession(context, step.sessionId, step.checkpointId, sink);
          canRewind = canRewind && stepResult.canRewind;
          for (const filePath of stepResult.filesChanged ?? []) {
            allFilesChanged.add(filePath);
          }
        }

        rewindResult = {
          canRewind,
          filesChanged: Array.from(allFilesChanged)
        };
      } catch {
        rewindResult = await fallbackRestoreRunFiles(
          run,
          await this.store.getRewindSnapshot(runId),
          events
        );
      }

      if ((rewindResult.filesChanged ?? []).length === 0) {
        rewindResult = await fallbackRestoreRunFiles(
          run,
          await this.store.getRewindSnapshot(runId),
          events
        );
      }
    }

    await this.emit({
      runId,
      ts: nowIso(),
      type: "rewind_available",
      data: {
        checkpoint_id: checkpointId ?? null,
        files_changed: rewindResult.filesChanged ?? [],
        can_rewind: rewindResult.canRewind
      }
    });
    return rewindResult;
  }

  private async executeRun(
    context: RunContext,
    record: RunRecord,
    abort: AbortController
  ): Promise<FinalReport> {
    const sink = {
      emit: (event: TraceEvent) => this.emit(event),
      isCancelled: async () => abort.signal.aborted || (await this.store.isCancelRequested(context.runId)),
      abortController: abort
    };
    const agent = this.agentFactory(context.agentMode);
    let totalCostUsd = 0;
    let modelUsage: Record<string, unknown> = {};
    let testRun: TestExecutionResult = {
      command: "pytest",
      cwd: context.repoPath,
      exit_code: null,
      passed: 0,
      failed: 0,
      errors: 0,
      cancelled: false
    };
    let status: RunStatus = "running";
    let failureCode: string | null = null;
    let repairAttempted = false;
    let repairRoundsUsed = 0;
    let repairStoppedReason: string | null = null;
    let analyzedModules: AnalyzedModule[] = [];
    let generatedTests: GeneratedTest[] = [];

    try {
      const validation = await validateRepository(context.repoPath, context.targetPath);
      if (!validation.analysis) {
        status = "invalid_input";
        failureCode = validation.failure?.code ?? "invalid_input";
        return await this.finishRun(record, {
          run_id: context.runId,
          repo_path: context.repoPath,
          target_path: context.targetPath ?? null,
          framework: "pytest",
          status,
          failure_code: failureCode,
          analyzed_modules: [],
          generated_tests: [],
          test_run: testRun,
          repair: { attempted: false, rounds_used: 0, stopped_reason: validation.failure?.message ?? null },
          blocked_operations: [],
          checkpoints: { enabled: false, session_id: null, restore_points: [] },
          cost: { total_usd: 0, by_model: {} }
        });
      }

      if (context.agentMode === "claude") {
        await this.store.saveRewindSnapshot(context.runId, await captureTestTreeSnapshot(context.repoPath));
      }

      analyzedModules = validation.analysis.analyzedModules;
      await ensureTestRoot(validation.analysis.preferredTestRoot);
      const generation = await agent.generateTests(context, validation.analysis, sink);
      analyzedModules = generation.analyzedModules;
      generatedTests = generation.generatedTests;
      totalCostUsd += generation.totalCostUsd;
      modelUsage = mergeModelUsage(modelUsage, generation.modelUsage);

      record.sessionId = generation.sessionId;
      record.restorePoints = generation.restorePoints;
      record.generatedTests = generation.generatedTests.map((item) => item.path);
      record.blockedOperations = generation.blockedOperations;
      await this.store.saveRun(record);

      if (generation.rewindSnapshot) {
        await this.store.saveRewindSnapshot(context.runId, generation.rewindSnapshot);
      }

      if (await sink.isCancelled()) {
        status = "cancelled";
        failureCode = "cancelled";
        return await this.finishRun(record, buildFinalReport(context, status, failureCode, analyzedModules, generatedTests, testRun, repairAttempted, repairRoundsUsed, repairStoppedReason, record));
      }

      testRun = await runPytest(context, generatedTests, sink.isCancelled);
      if (testRun.cancelled) {
        status = "cancelled";
        failureCode = "cancelled";
      } else if (testRun.timed_out) {
        status = "timed_out";
        failureCode = "pytest_timed_out";
      } else if (testRun.exit_code === 0) {
        status = "passed";
      } else {
        const classification = classifyFailure(context.repoPath, generatedTests, testRun);
        status = classification.status;
        repairAttempted = classification.repairable && context.maxRepairRounds > 0;
        repairStoppedReason = classification.reason;

        if (classification.repairable && context.maxRepairRounds > 0) {
          await this.emit({
            runId: context.runId,
            ts: nowIso(),
            type: "task_progress",
            data: { phase: "repair_started", reason: classification.reason }
          });
          const repair = await agent.repairTests(
            context,
            generatedTests.map((item) => item.path),
            `${testRun.stdout ?? ""}\n${testRun.stderr ?? ""}`,
            sink
          );
          totalCostUsd += repair.totalCostUsd;
          modelUsage = mergeModelUsage(modelUsage, repair.modelUsage);
          repairRoundsUsed = 1;
          repairStoppedReason = repair.stoppedReason;
          testRun = await runPytest(context, generatedTests, sink.isCancelled);
          if (testRun.exit_code === 0) {
            status = "passed";
          } else if (testRun.cancelled) {
            status = "cancelled";
            failureCode = "cancelled";
          } else if (testRun.timed_out) {
            status = "timed_out";
            failureCode = "pytest_timed_out";
          } else {
            status = "failed";
            failureCode = "pytest_failed";
          }
        } else {
          failureCode =
            classification.status === "environment_dependency"
              ? "environment_dependency"
              : "pytest_failed";
        }
      }

      const report = buildFinalReport(
        context,
        status,
        failureCode,
        analyzedModules,
        generatedTests,
        testRun,
        repairAttempted,
        repairRoundsUsed,
        repairStoppedReason,
        record,
        totalCostUsd,
        modelUsage
      );
      return await this.finishRun(record, report);
    } catch (error) {
      const wasCancelled =
        abort.signal.aborted ||
        (await this.store.isCancelRequested(context.runId)) ||
        (error instanceof Error && error.message === "Run cancelled");
      status = wasCancelled ? "cancelled" : "failed";
      failureCode = wasCancelled ? "cancelled" : "internal_error";
      const report = buildFinalReport(
        context,
        status,
        failureCode,
        analyzedModules,
        generatedTests,
        {
          ...testRun,
          stderr: `${testRun.stderr ?? ""}\n${error instanceof Error ? error.stack ?? error.message : String(error)}`
        },
        repairAttempted,
        repairRoundsUsed,
        repairStoppedReason,
        record,
        totalCostUsd,
        modelUsage
      );
      return await this.finishRun(record, report);
    }
  }

  private async finishRun(record: RunRecord, report: FinalReport): Promise<FinalReport> {
    record.status = report.status;
    record.finishedAt = nowIso();
    record.reportPath = await this.store.saveReport(record.runId, report);
    record.failureCode = report.failure_code;
    await this.store.saveRun(record);
    await this.emit({
      runId: record.runId,
      ts: nowIso(),
      type: report.status === "passed" ? "run_finished" : "run_failed",
      data: {
        status: report.status,
        report_path: record.reportPath
      }
    });
    return report;
  }

  private async emit(event: TraceEvent): Promise<void> {
    await this.store.appendEvent(event.runId, event);
  }

  private async assertNoActiveRun(): Promise<void> {
    const active = await this.store.getActiveRun();
    if (!active) {
      return;
    }

    try {
      process.kill(active.pid, 0);
    } catch {
      await this.store.clearActiveRun(active.runId);
      return;
    }

    throw new Error(`Another run is already active: ${shortId(active.runId)}`);
  }
}

function clampRepairRounds(value: number): number {
  return Math.min(Math.max(value, 0), MAX_REPAIR_ROUNDS);
}

function defaultAgentFactory(mode: "claude" | "fake"): AgentClient {
  return mode === "claude" ? new ClaudeAgentClient() : new FakeAgentClient();
}

function buildFinalReport(
  context: RunContext,
  status: RunStatus,
  failureCode: string | null,
  analyzedModules: FinalReport["analyzed_modules"],
  generatedTests: FinalReport["generated_tests"],
  testRun: TestExecutionResult,
  repairAttempted: boolean,
  repairRoundsUsed: number,
  repairStoppedReason: string | null,
  record: RunRecord,
  totalCostUsd = 0,
  modelUsage: Record<string, unknown> = {}
): FinalReport {
  return {
    run_id: context.runId,
    repo_path: context.repoPath,
    target_path: context.targetPath ?? null,
    framework: "pytest",
    status,
    failure_code: failureCode,
    analyzed_modules: analyzedModules,
    generated_tests: generatedTests,
    test_run: testRun,
    repair: {
      attempted: repairAttempted,
      rounds_used: repairRoundsUsed,
      stopped_reason: repairStoppedReason
    },
    blocked_operations: record.blockedOperations,
    checkpoints: {
      enabled: true,
      session_id: record.sessionId,
      restore_points: record.restorePoints
    },
    cost: {
      total_usd: totalCostUsd,
      by_model: modelUsage
    }
  };
}

function deriveClaudeRewindPlan(
  events: TraceEvent[],
  requestedCheckpointId?: string
): Array<{ sessionId: string; checkpointId: string }> {
  const plan: Array<{ sessionId: string; checkpointId: string }> = [];
  const seenSessions = new Set<string>();

  for (const event of events) {
    if (event.type !== "checkpoint_created" || typeof event.sessionId !== "string") {
      continue;
    }

    const checkpointId = typeof event.data.user_message_uuid === "string" ? event.data.user_message_uuid : null;
    if (!checkpointId) {
      continue;
    }

    if (requestedCheckpointId && checkpointId !== requestedCheckpointId) {
      continue;
    }

    if (seenSessions.has(event.sessionId)) {
      continue;
    }

    seenSessions.add(event.sessionId);
    plan.push({ sessionId: event.sessionId, checkpointId });
  }

  return plan;
}

async function captureTestTreeSnapshot(repoPath: string): Promise<Record<string, string | null>> {
  const snapshot: Record<string, string | null> = {};
  for (const filePath of await listSnapshotCandidateFiles(repoPath)) {
    snapshot[filePath] = await fs.readFile(filePath, "utf8");
  }
  return snapshot;
}

async function listSnapshotCandidateFiles(repoPath: string): Promise<string[]> {
  const results: string[] = [];
  await collectFiles(repoPath, results);
  return results.filter((filePath) => {
    const relative = path.relative(repoPath, filePath);
    const filename = path.basename(filePath);
    return relative.split(path.sep).includes("tests") || filename.startsWith("test_");
  });
}

async function collectFiles(rootPath: string, results: string[]): Promise<void> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") {
        continue;
      }
      await collectFiles(entryPath, results);
      continue;
    }

    if (entry.isFile()) {
      results.push(entryPath);
    }
  }
}

async function fallbackRestoreRunFiles(
  run: RunRecord,
  snapshot: Record<string, string | null> | null,
  events: TraceEvent[]
): Promise<RewindResult> {
  const filesChanged = new Set<string>();
  const changedPaths = new Set<string>();

  for (const event of events) {
    if (event.type !== "file_changed") {
      continue;
    }

    const rawPath = typeof event.data.path === "string" ? event.data.path : null;
    if (!rawPath) {
      continue;
    }

    changedPaths.add(path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(run.repoPath, rawPath)));
  }

  if (snapshot) {
    for (const [filePath, content] of Object.entries(snapshot)) {
      if (content === null) {
        await fs.rm(filePath, { force: true });
      } else {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
      }
      filesChanged.add(path.relative(run.repoPath, filePath));
    }
  }

  const generatedAbsolute = new Set(
    run.generatedTests.map((filePath) => path.resolve(path.join(run.repoPath, filePath)))
  );
  for (const filePath of changedPaths) {
    if (snapshot && filePath in snapshot) {
      continue;
    }

    if (generatedAbsolute.has(filePath)) {
      await fs.rm(filePath, { force: true });
      filesChanged.add(path.relative(run.repoPath, filePath));
    }
  }

  return {
    canRewind: true,
    filesChanged: Array.from(filesChanged)
  };
}
