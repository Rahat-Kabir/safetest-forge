import { query } from "@anthropic-ai/claude-agent-sdk";

import { createPolicyHooks } from "../policy/policy.js";
import { buildGenerationPrompt, buildRepairPrompt } from "../prompts.js";
import { normalizeSdkMessage } from "../trace/normalize.js";
import type {
  AgentGenerationResult,
  AgentRepairResult,
  BlockedOperation,
  RepoAnalysis,
  RewindResult,
  RunContext,
  RunEventSink
} from "../types.js";
import type { AgentClient } from "./types.js";

const generationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["run_summary", "analyzed_modules", "generated_tests"],
  properties: {
    run_summary: { type: "string" },
    analyzed_modules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "reason_selected"],
        properties: {
          path: { type: "string" },
          reason_selected: { type: "string" }
        }
      }
    },
    generated_tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "source_targets"],
        properties: {
          path: { type: "string" },
          source_targets: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    }
  }
} as const;

const repairSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "stopped_reason"],
  properties: {
    summary: { type: "string" },
    stopped_reason: { type: ["string", "null"] }
  }
} as const;

export class ClaudeAgentClient implements AgentClient {
  readonly mode = "claude" as const;

  async generateTests(
    context: RunContext,
    analysis: RepoAnalysis,
    sink: RunEventSink
  ): Promise<AgentGenerationResult> {
    const blockedOperations: BlockedOperation[] = [];
    const generationPrompt = await buildGenerationPrompt(context, analysis);
    const result = await this.runStructuredQuery(
      context,
      generationPrompt,
      generationSchema,
      blockedOperations,
      sink
    );

    const structuredOutput = result.structured_output as {
      analyzed_modules: AgentGenerationResult["analyzedModules"];
      generated_tests: AgentGenerationResult["generatedTests"];
    };

    return {
      analyzedModules: structuredOutput.analyzed_modules,
      generatedTests: structuredOutput.generated_tests,
      sessionId: result.session_id ?? null,
      restorePoints: result.restorePoints,
      totalCostUsd: result.total_cost_usd,
      modelUsage: result.modelUsage,
      blockedOperations
    };
  }

  async repairTests(
    context: RunContext,
    generatedTests: string[],
    failingOutput: string,
    sink: RunEventSink
  ): Promise<AgentRepairResult> {
    const blockedOperations: BlockedOperation[] = [];
    const prompt = await buildRepairPrompt(context, failingOutput, generatedTests);
    const result = await this.runStructuredQuery(context, prompt, repairSchema, blockedOperations, sink, 6);
    const structuredOutput = result.structured_output as { stopped_reason: string | null };
    return {
      totalCostUsd: result.total_cost_usd,
      modelUsage: result.modelUsage,
      stoppedReason: structuredOutput.stopped_reason
    };
  }

  async rewind(context: RunContext, checkpointId: string, sink: RunEventSink): Promise<RewindResult> {
    const rewindQuery = query({
      prompt: "",
      options: {
        cwd: context.repoPath,
        resume: checkpointId ? context.runId : undefined
      }
    });

    rewindQuery.close();
    await sink.emit({
      runId: context.runId,
      ts: new Date().toISOString(),
      type: "task_progress",
      data: { phase: "rewind_placeholder" }
    });

    return {
      canRewind: false,
      error: "Rewind requires the persisted Claude session ID"
    };
  }

  async rewindWithSession(
    context: RunContext,
    sessionId: string,
    checkpointId: string,
    sink: RunEventSink
  ): Promise<RewindResult> {
    const rewindQuery = query({
      prompt: "",
      options: {
        cwd: context.repoPath,
        enableFileCheckpointing: true,
        resume: sessionId
      }
    });

    let rewound = false;
    let rewindResult: RewindResult = {
      canRewind: false,
      error: "Unable to rewind files"
    };

    for await (const message of rewindQuery) {
      for (const event of normalizeSdkMessage(context.runId, message)) {
        await sink.emit(event);
      }
      if (!rewound) {
        rewindResult = (await rewindQuery.rewindFiles(checkpointId)) as RewindResult;
        rewound = true;
      }
    }

    return rewindResult;
  }

  private async runStructuredQuery(
    context: RunContext,
    prompt: string,
    schema: Record<string, unknown>,
    blockedOperations: BlockedOperation[],
    sink: RunEventSink,
    maxTurns = 12
  ): Promise<any> {
    const hooks = createPolicyHooks(context.runId, context.repoPath, blockedOperations, (event) =>
      sink.emit(event)
    );
    const restorePoints: Array<{ user_message_uuid: string; label: string | null }> = [];

    const sdkQuery = query({
      prompt,
      options: {
        cwd: context.repoPath,
        includePartialMessages: true,
        enableFileCheckpointing: true,
        agents: {
          "test-writer": {
            description: "Generates pytest tests for one module or small file group.",
            prompt:
              "Inspect the assigned module and write focused pytest coverage only in approved test paths.",
            model: "sonnet",
            tools: ["Read", "Glob", "Grep", "Write", "Edit"],
            maxTurns: 6
          },
          "failure-triage": {
            description: "Classifies generated-test failures and decides whether repair should continue.",
            prompt: "Read failure output and stop on environment or production-code failures.",
            model: "haiku",
            tools: ["Read", "Grep"],
            maxTurns: 3
          }
        },
        maxTurns,
        hooks,
        allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "Agent", "TodoWrite"],
        disallowedTools: [],
        permissionMode: "dontAsk",
        tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "Agent", "TodoWrite"],
        maxBudgetUsd: context.budgetLimitUsd,
        outputFormat: {
          type: "json_schema",
          schema
        },
        extraArgs: { "replay-user-messages": null },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "Only write tests. Never modify production source files."
        },
        settingSources: ["project"],
        abortController: sink.abortController ?? new AbortController()
      }
    });

    let resultMessage: any;
    for await (const message of sdkQuery) {
      if (await sink.isCancelled()) {
        sdkQuery.close();
        throw new Error("Run cancelled");
      }
      if (message.type === "user" && message.uuid) {
        restorePoints.push({ user_message_uuid: message.uuid, label: null });
      }
      for (const event of normalizeSdkMessage(context.runId, message)) {
        await sink.emit(event);
      }
      if (message.type === "result") {
        resultMessage = { ...message, restorePoints };
      }
    }

    if (!resultMessage) {
      throw new Error("Claude Agent SDK did not return a result message");
    }
    if (resultMessage.subtype !== "success") {
      throw new Error(
        `Claude Agent SDK failed with ${resultMessage.subtype}: ${(resultMessage.errors ?? []).join("; ")}`
      );
    }
    if (!("structured_output" in resultMessage)) {
      throw new Error("Structured output was not returned by the Claude Agent SDK");
    }

    return resultMessage;
  }
}
