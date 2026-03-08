import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { evaluateWritePath } from "../policy/policy.js";
import { resolveGeneratedTestPath } from "../runtime/python.js";
import type {
  AgentGenerationResult,
  AgentRepairResult,
  BlockedOperation,
  RepoAnalysis,
  RewindResult,
  RunContext,
  RunEventSink
} from "../types.js";
import { ensureDir, nowIso, toPosix } from "../utils.js";
import type { AgentClient } from "./types.js";

export class FakeAgentClient implements AgentClient {
  readonly mode = "fake" as const;

  async generateTests(
    context: RunContext,
    analysis: RepoAnalysis,
    sink: RunEventSink
  ): Promise<AgentGenerationResult> {
    const sessionId = `fake-session-${context.runId}`;
    const checkpointId = `fake-checkpoint-${randomUUID()}`;
    const blockedOperations: BlockedOperation[] = [];
    const rewindSnapshot: Record<string, string | null> = {};

    await sink.emit({
      runId: context.runId,
      sessionId,
      ts: nowIso(),
      type: "checkpoint_created",
      data: { user_message_uuid: checkpointId, replay: false }
    });

    const generatedTests = [];
    for (const module of analysis.analyzedModules) {
      const testPath = resolveGeneratedTestPath(context.repoPath, analysis.preferredTestRoot, module.path);
      await ensureDir(path.dirname(testPath));

      if (path.basename(context.repoPath) === "policy-denial" && blockedOperations.length === 0) {
        const deniedPath = path.join(context.repoPath, "src", "unsafe_write.py");
        const decision = evaluateWritePath(context.repoPath, deniedPath);
        if (!decision.allowed) {
          const blocked = {
            tool: "Write",
            reason: decision.reason ?? "Write blocked",
            input: { file_path: deniedPath }
          };
          blockedOperations.push(blocked);
          await sink.emit({
            runId: context.runId,
            sessionId,
            ts: nowIso(),
            type: "permission_denied",
            data: blocked as Record<string, unknown>
          });
        }
      }

      const currentContent = await readOptionalFile(testPath);
      rewindSnapshot[testPath] = currentContent;

      const sourcePath = path.join(context.repoPath, module.path);
      const sourceContent = await fs.readFile(sourcePath, "utf8");
      const testContent = buildFixtureAwareTest(context.repoPath, module.path, sourceContent, false);

      await sink.emit({
        runId: context.runId,
        sessionId,
        ts: nowIso(),
        type: "tool_use",
        data: { tool: "Write", path: toPosix(path.relative(context.repoPath, testPath)) }
      });
      await fs.writeFile(testPath, testContent, "utf8");
      await sink.emit({
        runId: context.runId,
        sessionId,
        ts: nowIso(),
        type: "file_changed",
        data: { path: toPosix(path.relative(context.repoPath, testPath)) }
      });

      generatedTests.push({
        path: toPosix(path.relative(context.repoPath, testPath)),
        source_targets: [module.path]
      });
    }

    return {
      analyzedModules: analysis.analyzedModules,
      generatedTests,
      sessionId,
      restorePoints: [{ user_message_uuid: checkpointId, label: "initial" }],
      totalCostUsd: 0,
      modelUsage: {},
      blockedOperations,
      rewindSnapshot
    };
  }

  async repairTests(
    context: RunContext,
    generatedTests: string[],
    _failingOutput: string,
    sink: RunEventSink
  ): Promise<AgentRepairResult> {
    for (const generatedTest of generatedTests) {
      const absolutePath = path.join(context.repoPath, generatedTest);
      const current = await fs.readFile(absolutePath, "utf8");
      const repaired = current.replace("from src.greeters import greet", "from src.greeter import greet");
      if (repaired !== current) {
        await fs.writeFile(absolutePath, repaired, "utf8");
        await sink.emit({
          runId: context.runId,
          ts: nowIso(),
          type: "file_changed",
          data: { path: generatedTest, repair: true }
        });
      }
    }

    return {
      totalCostUsd: 0,
      modelUsage: {},
      stoppedReason: null
    };
  }

  async rewind(): Promise<RewindResult> {
    return {
      canRewind: false,
      error: "Fake agent rewinding is handled by the run service"
    };
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function buildFixtureAwareTest(
  repoPath: string,
  modulePath: string,
  sourceContent: string,
  repaired: boolean
): string {
  const relativeModule = toPosix(modulePath);
  const importPath = relativeModule.replace(/^src\//, "").replace(/\.py$/, "").replace(/\//g, ".");
  const importPrelude = `from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

`;

  if (sourceContent.includes("def add(") && sourceContent.includes("def divide(")) {
    return `${importPrelude}from src.calculator import add, divide


def test_add_returns_sum():
    assert add(2, 3) == 5


def test_divide_handles_even_values():
    assert divide(8, 2) == 4
`;
  }

  if (sourceContent.includes("def slugify(")) {
    return `${importPrelude}from src.formatter import slugify


def test_slugify_normalizes_text():
    assert slugify("Hello Forge") == "hello-forge"
`;
  }

  if (sourceContent.includes("def greet(")) {
    const importLine = repaired ? "from src.greeter import greet" : "from src.greeters import greet";
    return `${importPrelude}${importLine}


def test_greet_uses_name():
    assert greet("Ada") == "Hello, Ada"
`;
  }

  if (sourceContent.includes("def require_token(")) {
    return `${importPrelude}from src.config_reader import require_token


def test_require_token_reads_environment():
    assert require_token() == "expected-token"
`;
  }

  if (path.basename(repoPath) === "slow-package") {
    return `${importPrelude}import time
from src.slow_math import add


def test_add_times_out():
    time.sleep(2)
    assert add(1, 2) == 3
`;
  }

  return `${importPrelude}from ${importPath} import *


def test_module_imports():
    assert True
`;
}
