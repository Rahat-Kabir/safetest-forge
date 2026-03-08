import path from "node:path";

import type { BlockedOperation, TraceEvent } from "../types.js";
import { isInsidePath, nowIso, normalizePath } from "../utils.js";

const DANGEROUS_BASH_PATTERNS = [
  /rm\s+-rf/i,
  /git\s+reset\s+--hard/i,
  /npm\s+publish/i,
  /pnpm\s+publish/i,
  /docker\s+(push|system\s+prune)/i,
  /curl.+\|\s*(sh|bash)/i
];

const SAFE_BASH_PATTERNS = [
  /^(pytest|python\s+-m\s+pytest)\b/i,
  /^(pwd|ls|dir)\b/i,
  /^(python\s+--version|python\s+-V)\b/i,
  /^(which|where(\.exe)?)\s+python\b/i
];

export function isApprovedTestPath(repoPath: string, candidatePath: string): boolean {
  const repoRoot = normalizePath(repoPath);
  const absoluteCandidate = normalizePath(
    path.isAbsolute(candidatePath) ? candidatePath : path.join(repoRoot, candidatePath)
  );
  if (!isInsidePath(repoRoot, absoluteCandidate) || !absoluteCandidate.endsWith(".py")) {
    return false;
  }

  const relative = path.relative(repoRoot, absoluteCandidate);
  const parts = relative.split(path.sep);
  const filename = path.basename(absoluteCandidate);
  return parts.includes("tests") || filename.startsWith("test_");
}

export function evaluateWritePath(
  repoPath: string,
  candidatePath: string
): { allowed: boolean; reason?: string } {
  if (isApprovedTestPath(repoPath, candidatePath)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: "Write outside approved test path"
  };
}

export function evaluateBashCommand(command: string): { allowed: boolean; reason?: string } {
  if (DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command))) {
    return {
      allowed: false,
      reason: "Dangerous shell command blocked"
    };
  }

  if (SAFE_BASH_PATTERNS.some((pattern) => pattern.test(command.trim()))) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: "Shell command is outside the approved V1 allowlist"
  };
}

type HookEmitter = (event: TraceEvent) => Promise<void>;

export function createPolicyHooks(
  runId: string,
  repoPath: string,
  blockedOperations: BlockedOperation[],
  emit: HookEmitter
): {
  PreToolUse: Array<{
    matcher?: string;
    hooks: Array<(input: any, toolUseId: string | undefined) => Promise<Record<string, unknown>>>;
  }>;
} {
  const handler = async (input: any, toolUseId: string | undefined) => {
    const toolName = input.tool_name as string;
    let denial: { reason: string; input: unknown } | null = null;

    if (toolName === "Write" || toolName === "Edit") {
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const candidatePath = String(toolInput.file_path ?? toolInput.path ?? "");
      const decision = evaluateWritePath(repoPath, candidatePath);
      if (!decision.allowed) {
        denial = {
          reason: decision.reason ?? "Write blocked",
          input: toolInput
        };
      }
    }

    if (toolName === "Bash") {
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const decision = evaluateBashCommand(String(toolInput.command ?? ""));
      if (!decision.allowed) {
        denial = {
          reason: decision.reason ?? "Command blocked",
          input: toolInput
        };
      }
    }

    if (!denial) {
      return {};
    }

    const blocked: BlockedOperation = {
      tool: toolName,
      reason: denial.reason,
      input: denial.input
    };
    blockedOperations.push(blocked);

    const baseData = {
      tool: toolName,
      tool_use_id: toolUseId ?? null,
      reason: denial.reason,
      input: denial.input
    };
    await emit({
      runId,
      ts: nowIso(),
      type: "hook_event",
      data: {
        ...baseData,
        hook: "PreToolUse",
        decision: "deny"
      }
    });
    await emit({
      runId,
      ts: nowIso(),
      type: "permission_denied",
      data: baseData
    });

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denial.reason
      }
    };
  };

  return {
    PreToolUse: [
      {
        matcher: "Write",
        hooks: [handler]
      },
      {
        matcher: "Edit",
        hooks: [handler]
      },
      {
        matcher: "Bash",
        hooks: [handler]
      }
    ]
  };
}
