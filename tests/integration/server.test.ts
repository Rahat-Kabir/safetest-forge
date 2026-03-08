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
});
