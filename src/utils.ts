import fs from "node:fs/promises";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export function normalizePath(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

export function toPosix(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

export function isInsidePath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(normalizePath(rootPath), normalizePath(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string, fallback?: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }

    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function mergeModelUsage(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [modelName, usage] of Object.entries(right)) {
    if (!(modelName in merged)) {
      merged[modelName] = usage;
      continue;
    }

    const previous = merged[modelName];
    if (typeof previous === "object" && previous && typeof usage === "object" && usage) {
      const next: Record<string, number> = {};
      const previousEntries = previous as Record<string, number>;
      const usageEntries = usage as Record<string, number>;
      for (const key of new Set([...Object.keys(previousEntries), ...Object.keys(usageEntries)])) {
        next[key] = (previousEntries[key] ?? 0) + (usageEntries[key] ?? 0);
      }
      merged[modelName] = next;
    } else {
      merged[modelName] = usage;
    }
  }

  return merged;
}

export function shortId(value: string): string {
  return value.slice(0, 8);
}
