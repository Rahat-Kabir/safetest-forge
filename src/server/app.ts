import express from "express";
import fs from "node:fs/promises";
import path from "node:path";

import { SERVER_HOST, SERVER_PORT, resolveProjectPath } from "../config.js";
import { RunService } from "../run-service.js";

function requireSessionToken(sessionToken: string): express.RequestHandler {
  return (request, response, next) => {
    if (request.header("x-session-token") !== sessionToken) {
      response.status(401).json({ error: "invalid_session_token" });
      return;
    }
    next();
  };
}

export function createApp(runService: RunService, sessionToken: string): express.Express {
  const app = express();
  const uiDir = resolveProjectPath("dist", "ui");
  const requireToken = requireSessionToken(sessionToken);

  app.use(express.json());

  app.get("/api/runs/:runId", async (request, response) => {
    const run = await runService.getRun(request.params.runId);
    if (!run) {
      response.status(404).json({ error: "run_not_found" });
      return;
    }
    response.json(run);
  });

  app.get("/api/runs/:runId/report", async (request, response) => {
    const report = await runService.getReport(request.params.runId);
    if (!report) {
      response.status(404).json({ error: "report_not_found" });
      return;
    }
    response.json(report);
  });

  app.get("/api/runs/:runId/events", async (request, response) => {
    const runId = request.params.runId;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const existing = await runService.getTrace(runId);
    for (const event of existing) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = runService.getStore().subscribe(runId, (event) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    request.on("close", () => {
      unsubscribe();
      response.end();
    });
  });

  app.post("/api/runs", requireToken, async (request, response) => {
    try {
      const started = await runService.startRun(request.body);
      response.status(201).json({ runId: started.runId });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/runs/:runId/cancel", requireToken, async (request, response) => {
    const runId = String(request.params.runId);
    const cancelled = await runService.cancelRun(runId);
    if (!cancelled) {
      response.status(404).json({ error: "run_not_found" });
      return;
    }
    response.json({ status: "cancelling" });
  });

  app.post("/api/runs/:runId/rewind", requireToken, async (request, response) => {
    try {
      const result = await runService.rewindRun(String(request.params.runId), request.body?.checkpoint);
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/", async (_request, response) => {
    try {
      const template = await fs.readFile(path.join(uiDir, "index.html"), "utf8");
      response.type("html").send(template.replace(/%SESSION_TOKEN%/g, sessionToken));
    } catch {
      response.type("html").send("<h1>UI build missing</h1><p>Run npm run build:ui.</p>");
    }
  });

  app.use(express.static(uiDir));

  return app;
}

export async function startServer(runService: RunService, sessionToken: string): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const app = createApp(runService, sessionToken);
  const server = app.listen(SERVER_PORT, SERVER_HOST);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  return {
    url: `http://${SERVER_HOST}:${SERVER_PORT}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}
