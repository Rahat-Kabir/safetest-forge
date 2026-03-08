export type AgentMode = "claude" | "fake";

export type RunStatus =
  | "running"
  | "cancelling"
  | "passed"
  | "failed"
  | "partial"
  | "blocked"
  | "cancelled"
  | "timed_out"
  | "environment_dependency"
  | "invalid_input";

export interface RunRequest {
  repoPath: string;
  targetPath?: string;
  maxRepairRounds?: number;
  budgetLimitUsd?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  timeoutMs?: number;
  agentMode?: AgentMode;
}

export interface RunContext {
  runId: string;
  repoPath: string;
  targetPath?: string;
  workspacePath: string;
  startedAt: string;
  maxRepairRounds: number;
  allowedWriteRoots: string[];
  budgetLimitUsd?: number;
  timeoutMs: number;
  agentMode: AgentMode;
}

export interface BlockedOperation {
  tool: string;
  reason: string;
  input?: unknown;
}

export interface AnalyzedModule {
  path: string;
  reason_selected: string;
}

export interface GeneratedTest {
  path: string;
  source_targets: string[];
}

export interface RestorePoint {
  user_message_uuid: string;
  label: string | null;
}

export interface CheckpointSummary {
  enabled: boolean;
  session_id: string | null;
  restore_points: RestorePoint[];
}

export interface CostSummary {
  total_usd: number;
  by_model: Record<string, unknown>;
}

export interface TestRunSummary {
  command: string;
  exit_code: number | null;
  passed: number;
  failed: number;
  errors: number;
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
  timed_out?: boolean;
}

export interface RepairSummary {
  attempted: boolean;
  rounds_used: number;
  stopped_reason: string | null;
}

export interface FinalReport {
  run_id: string;
  repo_path: string;
  target_path: string | null;
  framework: "pytest";
  status: RunStatus;
  failure_code: string | null;
  analyzed_modules: AnalyzedModule[];
  generated_tests: GeneratedTest[];
  test_run: TestRunSummary;
  repair: RepairSummary;
  blocked_operations: BlockedOperation[];
  checkpoints: CheckpointSummary;
  cost: CostSummary;
}

export interface RunRecord {
  runId: string;
  repoPath: string;
  targetPath: string | null;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  maxRepairRounds: number;
  budgetLimitUsd: number | null;
  timeoutMs: number;
  agentMode: AgentMode;
  reportPath: string | null;
  sessionId: string | null;
  restorePoints: RestorePoint[];
  generatedTests: string[];
  failureCode: string | null;
  blockedOperations: BlockedOperation[];
}

export interface TraceEvent {
  runId: string;
  sessionId?: string;
  parentToolUseId?: string | null;
  ts: string;
  type:
    | "run_started"
    | "assistant_text"
    | "tool_use"
    | "tool_result"
    | "tool_progress"
    | "hook_event"
    | "permission_denied"
    | "subagent_started"
    | "subagent_finished"
    | "task_progress"
    | "file_changed"
    | "checkpoint_created"
    | "rewind_available"
    | "run_finished"
    | "run_failed";
  data: Record<string, unknown>;
}

export interface RepoAnalysis {
  framework: "pytest";
  analyzedModules: AnalyzedModule[];
  existingTestRoots: string[];
  preferredTestRoot: string;
  packageRoots: string[];
  pythonFiles: string[];
  targetScope: string;
}

export interface ValidationFailure {
  code: string;
  message: string;
}

export interface AgentGenerationResult {
  analyzedModules: AnalyzedModule[];
  generatedTests: GeneratedTest[];
  sessionId: string | null;
  restorePoints: RestorePoint[];
  totalCostUsd: number;
  modelUsage: Record<string, unknown>;
  blockedOperations: BlockedOperation[];
  rewindSnapshot?: Record<string, string | null>;
}

export interface AgentRepairResult {
  totalCostUsd: number;
  modelUsage: Record<string, unknown>;
  stoppedReason: string | null;
}

export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

export interface TestExecutionResult extends TestRunSummary {
  cwd: string;
  cancelled: boolean;
}

export interface RunEventSink {
  emit(event: TraceEvent): Promise<void>;
  isCancelled(): Promise<boolean>;
  abortController?: AbortController;
}
