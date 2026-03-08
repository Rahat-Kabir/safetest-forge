import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const currentFile = fileURLToPath(import.meta.url);
const srcRoot = path.dirname(currentFile);

export const PROJECT_ROOT = path.resolve(srcRoot, "..");
export const STORAGE_ROOT = path.join(PROJECT_ROOT, ".safetest-forge");
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_REPAIR_ROUNDS = 2;
export const DEFAULT_REPAIR_ROUNDS = 1;
export const SERVER_HOST = "127.0.0.1";
export const SERVER_PORT = 4317;
export const SESSION_FILE = path.join(STORAGE_ROOT, "server.json");

export function resolveProjectPath(...segments: string[]): string {
  return path.join(PROJECT_ROOT, ...segments);
}

export function getAgentMode(defaultMode: "claude" | "fake" = "claude"): "claude" | "fake" {
  const configured = process.env.SAFETEST_FORGE_AGENT_MODE;
  if (configured === "claude" || configured === "fake") {
    return configured;
  }

  return defaultMode;
}
