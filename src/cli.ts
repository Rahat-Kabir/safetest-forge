#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_REPAIR_ROUNDS,
  DEFAULT_TIMEOUT_MS,
  SERVER_PORT,
  SESSION_FILE
} from "./config.js";
import { startServer } from "./server/app.js";
import { RunService } from "./run-service.js";
import { writeJsonFile } from "./utils.js";

const program = new Command();

program.name("safetest-forge").description("Generate, run, repair, inspect, and rewind Python tests.");

program
  .command("run")
  .requiredOption("--repo <path>", "Local Python repository path")
  .option("--target <path>", "Optional target path inside the repository")
  .option("--max-repair-rounds <count>", "Repair attempts to allow", `${DEFAULT_REPAIR_ROUNDS}`)
  .option("--budget-limit-usd <usd>", "Optional budget ceiling in USD")
  .option("--timeout-ms <ms>", "Per-pytest timeout in milliseconds", `${DEFAULT_TIMEOUT_MS}`)
  .option("--agent-mode <mode>", "Agent mode: claude or fake")
  .action(async (options) => {
    const runService = new RunService();
    const started = await runService.startRun({
      repoPath: options.repo,
      targetPath: options.target,
      maxRepairRounds: Number.parseInt(options.maxRepairRounds, 10),
      budgetLimitUsd: options.budgetLimitUsd ? Number.parseFloat(options.budgetLimitUsd) : undefined,
      timeoutMs: Number.parseInt(options.timeoutMs, 10),
      agentMode: options.agentMode
    });

    console.log(`run_id=${started.runId}`);
    const unsubscribe = runService.getStore().subscribe(started.runId, (event) => {
      console.log(`[${event.type}] ${JSON.stringify(event.data)}`);
    });

    try {
      const report = await started.completion;
      console.log(`status=${report.status}`);
      console.log(`report_path=${runService.getStore().getReportPath(started.runId)}`);
      process.exitCode = report.status === "passed" ? 0 : 1;
    } finally {
      unsubscribe();
    }
  });

program
  .command("cancel")
  .requiredOption("--run <runId>", "Run ID to cancel")
  .action(async (options) => {
    const runService = new RunService();
    const cancelled = await runService.cancelRun(options.run);
    if (!cancelled) {
      console.error("Run not found");
      process.exitCode = 1;
      return;
    }
    console.log(`cancel_requested=${options.run}`);
  });

program
  .command("report")
  .requiredOption("--run <runId>", "Run ID")
  .action(async (options) => {
    const runService = new RunService();
    const report = await runService.getReport(options.run);
    if (!report) {
      console.error("Report not found");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(report, null, 2));
  });

program
  .command("trace")
  .requiredOption("--run <runId>", "Run ID")
  .action(async (options) => {
    const runService = new RunService();
    const events = await runService.getTrace(options.run);
    if (events.length === 0) {
      console.error("Trace not found");
      process.exitCode = 1;
      return;
    }
    for (const event of events) {
      console.log(JSON.stringify(event));
    }
  });

program
  .command("rewind")
  .requiredOption("--run <runId>", "Run ID")
  .option("--checkpoint <checkpoint>", "Checkpoint UUID")
  .action(async (options) => {
    const runService = new RunService();
    const result = await runService.rewindRun(options.run, options.checkpoint);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.canRewind ? 0 : 1;
  });

program.command("server").action(async () => {
  const runService = new RunService();
  await runService.initialize();
  const sessionToken = randomUUID();
  await writeJsonFile(SESSION_FILE, {
    sessionToken,
    baseUrl: `http://127.0.0.1:${SERVER_PORT}`
  });
  const server = await startServer(runService, sessionToken);
  console.log(`server_url=${server.url}`);
  console.log(`session_file=${SESSION_FILE}`);
});

await program.parseAsync(process.argv);
