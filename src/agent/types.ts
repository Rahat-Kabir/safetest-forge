import type {
  AgentGenerationResult,
  AgentRepairResult,
  RepoAnalysis,
  RewindResult,
  RunContext,
  RunEventSink
} from "../types.js";

export interface AgentClient {
  readonly mode: "claude" | "fake";
  generateTests(
    context: RunContext,
    analysis: RepoAnalysis,
    sink: RunEventSink
  ): Promise<AgentGenerationResult>;
  repairTests(
    context: RunContext,
    generatedTests: string[],
    failingOutput: string,
    sink: RunEventSink
  ): Promise<AgentRepairResult>;
  rewind(context: RunContext, checkpointId: string, sink: RunEventSink): Promise<RewindResult>;
}
