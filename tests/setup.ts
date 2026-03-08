import fs from "node:fs/promises";
import path from "node:path";

import { STORAGE_ROOT } from "../src/config.js";

beforeEach(async () => {
  await safeRemove(STORAGE_ROOT);
  await cleanupFixtureTests();
});

async function cleanupFixtureTests(): Promise<void> {
  const fixturesRoot = path.resolve("tests/fixtures");
  const fixtureNames = await fs.readdir(fixturesRoot);
  for (const fixtureName of fixtureNames) {
    const testsDir = path.join(fixturesRoot, fixtureName, "tests");
    await safeRemove(path.join(fixturesRoot, fixtureName, ".pytest_cache"));
    try {
      const entries = await fs.readdir(testsDir);
      for (const entry of entries) {
        if (fixtureName === "existing-tests" && entry === "test_existing.py") {
          continue;
        }
        await safeRemove(path.join(testsDir, entry));
      }
    } catch {
      // Some fixtures intentionally have no tests directory before generation.
    }
  }
}

async function safeRemove(targetPath: string): Promise<void> {
  await fs.rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 75
  });
}
