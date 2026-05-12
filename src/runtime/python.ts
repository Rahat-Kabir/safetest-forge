import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { DEFAULT_TIMEOUT_MS } from "../config.js";
import type {
  AnalyzedModule,
  CoverageFileSummary,
  CoverageSummary,
  GeneratedTest,
  RepoAnalysis,
  RunContext,
  TestCaseOutcome,
  TestCaseResult,
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

export interface PytestPluginAvailability {
  jsonReport: boolean;
  cov: boolean;
}

let cachedPluginAvailability: PytestPluginAvailability | null = null;

export function detectPytestPlugins(force = false): PytestPluginAvailability {
  if (!force && cachedPluginAvailability) {
    return cachedPluginAvailability;
  }

  const jsonReport = pythonImportAvailable("pytest_jsonreport");
  const cov = pythonImportAvailable("pytest_cov");
  cachedPluginAvailability = { jsonReport, cov };
  return cachedPluginAvailability;
}

function pythonImportAvailable(moduleName: string): boolean {
  const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ["-c", `import ${moduleName}`], {
        stdio: "ignore"
      });
      if (result.status === 0) {
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

export interface RunPytestOptions {
  coverageScope?: string[];
  reportArtifactsDir?: string;
  plugins?: PytestPluginAvailability;
}

export async function runPytest(
  context: RunContext,
  generatedTests: GeneratedTest[],
  isCancelled: () => Promise<boolean>,
  options: RunPytestOptions = {}
): Promise<TestExecutionResult> {
  const relativeTests = generatedTests.map((item) => item.path);
  const plugins = options.plugins ?? detectPytestPlugins();
  const artifactsDir =
    options.reportArtifactsDir ?? path.join(os.tmpdir(), `safetest-forge-${randomUUID()}`);
  await ensureDir(artifactsDir);

  const jsonReportPath = path.join(artifactsDir, "pytest-report.json");
  const coverageReportPath = path.join(artifactsDir, "coverage.json");
  const args: string[] = ["-q", ...relativeTests];
  if (plugins.jsonReport) {
    args.push("--json-report", `--json-report-file=${jsonReportPath}`);
  }
  if (plugins.cov) {
    const scope = (options.coverageScope ?? []).filter((entry) => entry.length > 0);
    for (const scopeEntry of scope.length > 0 ? scope : ["."]) {
      args.push(`--cov=${scopeEntry}`);
    }
    args.push(`--cov-report=json:${coverageReportPath}`);
  }

  const command = `pytest ${args.join(" ")}`;
  const startedAt = Date.now();

  const execution = await spawnPytest(context, args, isCancelled);

  const combined = `${execution.stdout}\n${execution.stderr}`;
  const textCounts = parsePytestCounts(combined);
  let cases: TestCaseResult[] = [];
  let counts = textCounts;
  if (plugins.jsonReport) {
    const parsed = await loadJsonReport(jsonReportPath);
    if (parsed) {
      cases = parsed.cases;
      counts = parsed.counts;
    }
  }

  let coverage: CoverageSummary | undefined;
  if (plugins.cov) {
    coverage = await loadCoverageReport(coverageReportPath, context.repoPath);
  }

  await fs.rm(artifactsDir, { recursive: true, force: true }).catch(() => {});

  return {
    command,
    cwd: context.repoPath,
    exit_code: execution.exitCode,
    passed: counts.passed,
    failed: counts.failed,
    errors: counts.errors,
    stdout: execution.stdout,
    stderr: execution.stderr,
    duration_ms: Date.now() - startedAt,
    timed_out: execution.timedOut,
    cancelled: execution.cancelled,
    cases,
    coverage
  };
}

interface PytestSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

async function spawnPytest(
  context: RunContext,
  args: string[],
  isCancelled: () => Promise<boolean>
): Promise<PytestSpawnResult> {
  return new Promise<PytestSpawnResult>((resolve, reject) => {
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
      resolve({ exitCode: code, stdout, stderr, timedOut, cancelled });
    });
  });
}

interface PytestJsonCounts {
  passed: number;
  failed: number;
  errors: number;
}

interface PytestJsonOutcome {
  cases: TestCaseResult[];
  counts: PytestJsonCounts;
}

async function loadJsonReport(reportPath: string): Promise<PytestJsonOutcome | null> {
  if (!(await pathExists(reportPath))) {
    return null;
  }

  let raw: string;
  try {
    raw = await fs.readFile(reportPath, "utf8");
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const rawTests: any[] = Array.isArray(parsed?.tests) ? parsed.tests : [];
  const cases: TestCaseResult[] = rawTests.map((entry) => normalizeJsonTest(entry));

  const summary = parsed?.summary ?? {};
  const summaryPassed = numberOrZero(summary.passed);
  const summaryFailed = numberOrZero(summary.failed);
  const summaryErrors = numberOrZero(summary.error) + numberOrZero(summary.errors);

  const counts: PytestJsonCounts = {
    passed: summaryPassed || cases.filter((item) => item.outcome === "passed").length,
    failed: summaryFailed || cases.filter((item) => item.outcome === "failed").length,
    errors: summaryErrors || cases.filter((item) => item.outcome === "error").length
  };

  return { cases, counts };
}

function normalizeJsonTest(entry: any): TestCaseResult {
  const nodeid = typeof entry?.nodeid === "string" ? entry.nodeid : "";
  const outcome = normalizeOutcome(entry?.outcome);
  const setupDuration = numberOrZero(entry?.setup?.duration);
  const callDuration = numberOrZero(entry?.call?.duration);
  const teardownDuration = numberOrZero(entry?.teardown?.duration);
  const durationSeconds = setupDuration + callDuration + teardownDuration;

  const callCrash =
    typeof entry?.call?.crash?.message === "string" ? entry.call.crash.message : null;
  const setupCrash =
    typeof entry?.setup?.crash?.message === "string" ? entry.setup.crash.message : null;
  const message = callCrash ?? setupCrash;

  const file = nodeid.includes("::") ? nodeid.split("::")[0] ?? null : nodeid || null;

  return {
    nodeid,
    outcome,
    duration_ms: Math.round(durationSeconds * 1000),
    file,
    message
  };
}

function normalizeOutcome(value: unknown): TestCaseOutcome {
  if (value === "passed" || value === "failed" || value === "skipped" || value === "error") {
    return value;
  }
  if (value === "xfailed" || value === "xpassed") {
    return value;
  }
  return "error";
}

async function loadCoverageReport(
  reportPath: string,
  repoPath: string
): Promise<CoverageSummary | undefined> {
  if (!(await pathExists(reportPath))) {
    return undefined;
  }

  let raw: string;
  try {
    raw = await fs.readFile(reportPath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const filesObject = parsed?.files && typeof parsed.files === "object" ? parsed.files : {};
  const files: CoverageFileSummary[] = [];
  for (const [filePath, fileEntry] of Object.entries(filesObject)) {
    const summary = (fileEntry as any)?.summary ?? {};
    const linesCovered = numberOrZero(summary.covered_lines);
    const linesTotal = numberOrZero(summary.num_statements);
    const percent = roundPercent(numberOrZero(summary.percent_covered));
    files.push({
      file: toPosix(path.isAbsolute(filePath) ? path.relative(repoPath, filePath) : filePath),
      lines_covered: linesCovered,
      lines_total: linesTotal,
      percent
    });
  }

  files.sort((left, right) => left.file.localeCompare(right.file));
  const totals = parsed?.totals ?? {};
  const overallPercent = roundPercent(numberOrZero(totals.percent_covered));

  return {
    source: "pytest-cov",
    overall_percent: overallPercent,
    files
  };
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function numberOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
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
