import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { DEFAULT_TIMEOUT_MS } from "../config.js";
import type {
  AnalyzedModule,
  GeneratedTest,
  RepoAnalysis,
  RunContext,
  TestExecutionResult,
  ValidationFailure
} from "../types.js";
import { ensureDir, isInsidePath, normalizePath, nowIso, pathExists, toPosix } from "../utils.js";

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  ".idea",
  ".vscode",
  "build",
  "dist",
  "node_modules",
  "__pycache__",
  "venv"
]);

export async function validateRepository(
  repoPath: string,
  targetPath?: string
): Promise<{ analysis?: RepoAnalysis; failure?: ValidationFailure }> {
  const repoRoot = normalizePath(repoPath);
  if (!(await pathExists(repoRoot))) {
    return {
      failure: {
        code: "invalid_repo_path",
        message: `Repository path does not exist: ${repoRoot}`
      }
    };
  }

  const repoStat = await fs.stat(repoRoot);
  if (!repoStat.isDirectory()) {
    return {
      failure: {
        code: "invalid_repo_path",
        message: `Repository path is not a directory: ${repoRoot}`
      }
    };
  }

  let scopeRoot = repoRoot;
  if (targetPath) {
    scopeRoot = normalizePath(path.isAbsolute(targetPath) ? targetPath : path.join(repoRoot, targetPath));
    if (!(await pathExists(scopeRoot)) || !isInsidePath(repoRoot, scopeRoot)) {
      return {
        failure: {
          code: "invalid_target_path",
          message: `Target path is invalid or outside the repository: ${targetPath}`
        }
      };
    }
  }

  const pythonFiles = (await collectPythonFiles(scopeRoot)).filter(
    (filePath) => !isTestLikePath(path.relative(repoRoot, filePath))
  );
  if (pythonFiles.length === 0) {
    return {
      failure: {
        code: "no_python_files",
        message: `No Python files were found in ${targetPath ?? repoRoot}`
      }
    };
  }

  const packageRoots = await detectPackageRoots(repoRoot);
  if (packageRoots.length > 1 && !targetPath) {
    return {
      failure: {
        code: "ambiguous_monorepo",
        message: "Multiple Python package roots detected. Pass --target to narrow the run."
      }
    };
  }

  const existingTestRoots = await detectTestRoots(repoRoot);
  const preferredTestRoot = choosePreferredTestRoot(repoRoot, existingTestRoots);
  const analyzedModules = selectAnalyzedModules(repoRoot, pythonFiles, targetPath);

  return {
    analysis: {
      framework: "pytest",
      analyzedModules,
      existingTestRoots,
      preferredTestRoot,
      packageRoots,
      pythonFiles,
      targetScope: scopeRoot
    }
  };
}

async function collectPythonFiles(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      results.push(...(await collectPythonFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".py")) {
      results.push(entryPath);
    }
  }

  return results.sort();
}

async function detectPackageRoots(repoRoot: string): Promise<string[]> {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });
  const roots = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name) || entry.name === "tests") {
      continue;
    }

    const childPath = path.join(repoRoot, entry.name);
    if (entry.name === "src") {
      const srcEntries = await fs.readdir(childPath, { withFileTypes: true });
      for (const srcEntry of srcEntries) {
        if (!srcEntry.isDirectory() || EXCLUDED_DIRS.has(srcEntry.name)) {
          continue;
        }
        const packagePath = path.join(childPath, srcEntry.name);
        if (await packageLikeDirectory(packagePath)) {
          roots.add(packagePath);
        }
      }
      continue;
    }

    if (await packageLikeDirectory(childPath)) {
      roots.add(childPath);
    }
  }

  return Array.from(roots).sort();
}

async function packageLikeDirectory(dirPath: string): Promise<boolean> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.some((entry) => entry.name === "__init__.py" || entry.name.endsWith(".py"));
}

async function detectTestRoots(repoRoot: string): Promise<string[]> {
  const roots: string[] = [];
  await walkDirectories(repoRoot, async (dirPath, entryName) => {
    if (entryName === "tests") {
      roots.push(dirPath);
      return false;
    }
    return true;
  });
  return roots.sort();
}

async function walkDirectories(
  rootPath: string,
  visitor: (dirPath: string, entryName: string) => Promise<boolean>
): Promise<void> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(rootPath, entry.name);
    const shouldDescend = await visitor(entryPath, entry.name);
    if (shouldDescend) {
      await walkDirectories(entryPath, visitor);
    }
  }
}

function choosePreferredTestRoot(repoRoot: string, existingTestRoots: string[]): string {
  const topLevel = path.join(repoRoot, "tests");
  if (existingTestRoots.includes(topLevel)) {
    return topLevel;
  }

  return existingTestRoots[0] ?? topLevel;
}

function selectAnalyzedModules(
  repoRoot: string,
  pythonFiles: string[],
  targetPath?: string
): AnalyzedModule[] {
  const preferredFiles = pythonFiles.filter((filePath) => path.basename(filePath) !== "__init__.py");
  const candidateFiles = preferredFiles.length > 0 ? preferredFiles : pythonFiles;

  if (targetPath) {
    return candidateFiles.map((filePath) => ({
      path: toPosix(path.relative(repoRoot, filePath)),
      reason_selected: "Selected by target path"
    }));
  }

  return candidateFiles.slice(0, 3).map((filePath) => ({
    path: toPosix(path.relative(repoRoot, filePath)),
    reason_selected: "Selected from repository scan"
  }));
}

function isTestLikePath(filePath: string): boolean {
  const filename = path.basename(filePath);
  return filename.startsWith("test_") || filePath.split(/[\\/]/).includes("tests");
}

export function buildAllowedWriteRoots(repoPath: string): string[] {
  return [path.join(repoPath, "tests")];
}

export function resolveGeneratedTestPath(repoPath: string, testRoot: string, sourceRelativePath: string): string {
  const sourceBaseName = path.basename(sourceRelativePath, ".py");
  const parentParts = path.dirname(sourceRelativePath).split(/[\\/]/).filter(Boolean);
  const parentPrefix =
    parentParts.length > 0 && parentParts[parentParts.length - 1] !== "src"
      ? `${parentParts[parentParts.length - 1]}_`
      : "";
  return path.join(testRoot, `test_${parentPrefix}${sourceBaseName}.py`);
}

export async function ensureTestRoot(testRoot: string): Promise<void> {
  await ensureDir(testRoot);
}

export async function runPytest(
  context: RunContext,
  generatedTests: GeneratedTest[],
  isCancelled: () => Promise<boolean>
): Promise<TestExecutionResult> {
  const relativeTests = generatedTests.map((item) => item.path);
  const args = ["-q", ...relativeTests];
  const command = `pytest ${args.join(" ")}`;
  const startedAt = Date.now();

  return new Promise<TestExecutionResult>((resolve, reject) => {
    const child = spawn("pytest", args, {
      cwd: context.repoPath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, context.timeoutMs || DEFAULT_TIMEOUT_MS);

    const cancelInterval = setInterval(async () => {
      if (await isCancelled()) {
        cancelled = true;
        child.kill();
      }
    }, 150);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancelInterval);
      reject(error);
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancelInterval);
      const combined = `${stdout}\n${stderr}`;
      const { passed, failed, errors } = parsePytestCounts(combined);
      resolve({
        command,
        cwd: context.repoPath,
        exit_code: code,
        passed,
        failed,
        errors,
        stdout,
        stderr,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        cancelled
      });
    });
  });
}

function parsePytestCounts(output: string): { passed: number; failed: number; errors: number } {
  const passed = captureSummaryCount(output, /(\d+)\s+passed/);
  const failed = captureSummaryCount(output, /(\d+)\s+failed/);
  const errors = captureSummaryCount(output, /(\d+)\s+error/);
  return { passed, failed, errors };
}

function captureSummaryCount(output: string, pattern: RegExp): number {
  const match = output.match(pattern);
  if (!match) {
    return 0;
  }
  return Number.parseInt(match[1] ?? "0", 10);
}

export function classifyFailure(
  repoPath: string,
  generatedTests: GeneratedTest[],
  result: TestExecutionResult
): {
  status: "failed" | "environment_dependency";
  repairable: boolean;
  reason: string;
} {
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/Missing required environment variable|environment variable/i.test(combined)) {
    return {
      status: "environment_dependency",
      repairable: false,
      reason: "Missing environment dependency"
    };
  }

  const generatedRelativePaths = generatedTests.map((item) => toPosix(item.path));
  const mentionsGeneratedTest = generatedRelativePaths.some((filePath) =>
    combined.includes(filePath) || combined.includes(path.basename(filePath))
  );
  const repairablePattern = /ImportError|ModuleNotFoundError|SyntaxError|NameError|AttributeError|AssertionError/;

  return {
    status: "failed",
    repairable: mentionsGeneratedTest && repairablePattern.test(combined),
    reason: mentionsGeneratedTest ? "Generated test failure" : "Non-repairable failure"
  };
}

export function buildRunContext(request: {
  runId: string;
  repoPath: string;
  targetPath?: string;
  timeoutMs: number;
  maxRepairRounds: number;
  agentMode: "claude" | "fake";
  budgetLimitUsd?: number;
}): RunContext {
  return {
    runId: request.runId,
    repoPath: normalizePath(request.repoPath),
    targetPath: request.targetPath,
    workspacePath: normalizePath(request.repoPath),
    startedAt: nowIso(),
    maxRepairRounds: request.maxRepairRounds,
    allowedWriteRoots: buildAllowedWriteRoots(request.repoPath),
    timeoutMs: request.timeoutMs,
    agentMode: request.agentMode,
    budgetLimitUsd: request.budgetLimitUsd
  };
}
