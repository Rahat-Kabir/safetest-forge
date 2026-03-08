import fs from "node:fs/promises";
import path from "node:path";

import { resolveProjectPath } from "./config.js";
import type { RepoAnalysis, RunContext } from "./types.js";

type PromptName =
  | "repository-analysis.md"
  | "test-generation.md"
  | "failure-triage.md"
  | "final-synthesis.md";

export async function loadPrompt(name: PromptName): Promise<string> {
  const promptPath = resolveProjectPath("prompts", name);
  return fs.readFile(promptPath, "utf8");
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => values[key] ?? "");
}

export async function buildGenerationPrompt(context: RunContext, analysis: RepoAnalysis): Promise<string> {
  const [analysisPrompt, generationPrompt] = await Promise.all([
    loadPrompt("repository-analysis.md"),
    loadPrompt("test-generation.md")
  ]);

  const baseValues = {
    repoPath: context.repoPath,
    targetPath: context.targetPath ?? "",
    allowedWriteRoots: context.allowedWriteRoots.join(", "),
    analyzedModules: analysis.analyzedModules.map((item) => `${item.path} (${item.reason_selected})`).join("\n"),
    preferredTestRoot: path.relative(context.repoPath, analysis.preferredTestRoot) || "tests"
  };

  return [
    interpolate(analysisPrompt, baseValues),
    interpolate(generationPrompt, baseValues)
  ].join("\n\n");
}

export async function buildRepairPrompt(
  context: RunContext,
  failingOutput: string,
  generatedTests: string[]
): Promise<string> {
  const template = await loadPrompt("failure-triage.md");
  return interpolate(template, {
    repoPath: context.repoPath,
    targetPath: context.targetPath ?? "",
    allowedWriteRoots: context.allowedWriteRoots.join(", "),
    generatedTests: generatedTests.join("\n"),
    failureOutput: failingOutput
  });
}
