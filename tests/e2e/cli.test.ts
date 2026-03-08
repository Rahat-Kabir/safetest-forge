import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("cli smoke", () => {
  it("runs the CLI end to end and persists report + trace", async () => {
    const repoPath = path.resolve("tests/fixtures/simple-package");
    const command = process.execPath;
    const { stdout } = await execFileAsync(
      command,
      [path.resolve("node_modules/tsx/dist/cli.mjs"), "src/cli.ts", "run", "--repo", repoPath, "--agent-mode", "fake"],
      { cwd: path.resolve(".") }
    );

    expect(stdout).toContain("status=passed");
    const runIdMatch = stdout.match(/run_id=([a-f0-9-]+)/i);
    expect(runIdMatch?.[1]).toBeTruthy();
  });
});
