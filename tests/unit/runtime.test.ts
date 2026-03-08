import path from "node:path";

import {
  buildAllowedWriteRoots,
  resolveGeneratedTestPath,
  validateRepository
} from "../../src/runtime/python.js";

describe("runtime detection", () => {
  it("detects simple repositories and prefers top-level tests", async () => {
    const repoPath = path.resolve("tests/fixtures/simple-package");
    const result = await validateRepository(repoPath);
    expect(result.failure).toBeUndefined();
    expect(result.analysis?.preferredTestRoot).toBe(path.join(repoPath, "tests"));
    expect(result.analysis?.analyzedModules[0]?.path).toBe("src/calculator.py");
  });

  it("rejects ambiguous monorepos without a target", async () => {
    const repoPath = path.resolve("tests/fixtures/ambiguous-monorepo");
    const result = await validateRepository(repoPath);
    expect(result.analysis).toBeUndefined();
    expect(result.failure?.code).toBe("ambiguous_monorepo");
  });

  it("derives deterministic generated test paths", () => {
    const repoPath = path.resolve("tests/fixtures/existing-tests");
    const testPath = resolveGeneratedTestPath(repoPath, path.join(repoPath, "tests"), "src/formatter.py");
    expect(testPath.endsWith(path.join("tests", "test_formatter.py"))).toBe(true);
  });

  it("advertises only test write roots", () => {
    const repoPath = path.resolve("tests/fixtures/simple-package");
    expect(buildAllowedWriteRoots(repoPath)).toEqual([path.join(repoPath, "tests")]);
  });
});
