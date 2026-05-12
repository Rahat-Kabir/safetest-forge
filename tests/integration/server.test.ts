import path from "node:path";
import { randomUUID } from "node:crypto";

import request from "supertest";

import { createApp } from "../../src/server/app.js";
import { RunService } from "../../src/run-service.js";

describe("server api", () => {
  it("creates runs and serves reports", async () => {
    const runService = new RunService();
    await runService.initialize();
    const token = randomUUID();
    const app = createApp(runService, token);

    const createResponse = await request(app)
      .post("/api/runs")
      .set("x-session-token", token)
      .send({
        repoPath: path.resolve("tests/fixtures/simple-package"),
        agentMode: "fake"
      });

    expect(createResponse.status).toBe(201);
    const runId = createResponse.body.runId as string;
    const report = await (await runService.getRun(runId) && runService.getReport(runId));
    expect(runId).toBeTruthy();

    const reportResponse = await request(app).get(`/api/runs/${runId}/report`);
    if (report) {
      expect(reportResponse.status).toBe(200);
    } else {
      expect([200, 404]).toContain(reportResponse.status);
    }
  });

  it("rejects preflight without session token", async () => {
    const runService = new RunService();
    await runService.initialize();
    const token = randomUUID();
    const app = createApp(runService, token);

    const res = await request(app).get("/api/preflight").query({ repoPath: path.resolve("tests/fixtures/simple-package") });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_session_token");
  });

  it("returns preflight for a valid fixture repo", async () => {
    const runService = new RunService();
    await runService.initialize();
    const token = randomUUID();
    const app = createApp(runService, token);
    const repoPath = path.resolve("tests/fixtures/simple-package");

    const res = await request(app)
      .get("/api/preflight")
      .set("x-session-token", token)
      .query({ repoPath, agentMode: "fake" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentMode: "fake" });
    expect(typeof res.body.ok).toBe("boolean");
    const ids = (res.body.checks as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain("repo_path");
    expect(ids).toContain("pytest");
    expect(ids).toContain("pytest_json_report");
    expect(ids).toContain("pytest_cov");
  });

  it("preflight marks missing repo as failed", async () => {
    const runService = new RunService();
    await runService.initialize();
    const token = randomUUID();
    const app = createApp(runService, token);
    const badPath = path.resolve("tests/fixtures/does-not-exist-repo-xyz");

    const res = await request(app)
      .get("/api/preflight")
      .set("x-session-token", token)
      .query({ repoPath: badPath });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    const repoCheck = (res.body.checks as Array<{ id: string; status: string }>).find((c) => c.id === "repo_path");
    expect(repoCheck?.status).toBe("fail");
  });

  it("preflight fails invalid target path", async () => {
    const runService = new RunService();
    await runService.initialize();
    const token = randomUUID();
    const app = createApp(runService, token);
    const repoPath = path.resolve("tests/fixtures/simple-package");

    const res = await request(app)
      .get("/api/preflight")
      .set("x-session-token", token)
      .query({ repoPath, targetPath: "not-a-real-target-file-xyz.py" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    const targetCheck = (res.body.checks as Array<{ id: string; status: string }>).find((c) => c.id === "target_path");
    expect(targetCheck?.status).toBe("fail");
  });

  it("preflight fails Claude mode without API key", async () => {
    const runService = new RunService();
    await runService.initialize();
    const token = randomUUID();
    const app = createApp(runService, token);
    const repoPath = path.resolve("tests/fixtures/simple-package");
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await request(app)
        .get("/api/preflight")
        .set("x-session-token", token)
        .query({ repoPath, agentMode: "claude" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      const keyCheck = (res.body.checks as Array<{ id: string; status: string }>).find(
        (c) => c.id === "anthropic_api_key"
      );
      expect(keyCheck?.status).toBe("fail");
    } finally {
      if (prev !== undefined) {
        process.env.ANTHROPIC_API_KEY = prev;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("preflight fails invalid agent mode query", async () => {
    const runService = new RunService();
    await runService.initialize();
    const token = randomUUID();
    const app = createApp(runService, token);
    const repoPath = path.resolve("tests/fixtures/simple-package");

    const res = await request(app)
      .get("/api/preflight")
      .set("x-session-token", token)
      .query({ repoPath, agentMode: "bogus" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    const modeCheck = (res.body.checks as Array<{ id: string; status: string }>).find((c) => c.id === "agent_mode");
    expect(modeCheck?.status).toBe("fail");
  });
});
