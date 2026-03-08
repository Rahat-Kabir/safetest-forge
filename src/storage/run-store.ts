import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import { STORAGE_ROOT } from "../config.js";
import type { FinalReport, RunRecord, TraceEvent } from "../types.js";
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from "../utils.js";

type ControlState = {
  cancelRequested: boolean;
};

const DEFAULT_CONTROL_STATE: ControlState = {
  cancelRequested: false
};

const ACTIVE_RUN_FILE = path.join(STORAGE_ROOT, "active-run.json");

export class RunStore {
  private readonly bus = new EventEmitter();

  constructor(private readonly rootPath = STORAGE_ROOT) {}

  async initialize(): Promise<void> {
    await ensureDir(this.rootPath);
  }

  getRootPath(): string {
    return this.rootPath;
  }

  getRunDir(runId: string): string {
    return path.join(this.rootPath, "runs", runId);
  }

  getRecordPath(runId: string): string {
    return path.join(this.getRunDir(runId), "run.json");
  }

  getEventsPath(runId: string): string {
    return path.join(this.getRunDir(runId), "events.ndjson");
  }

  getReportPath(runId: string): string {
    return path.join(this.getRunDir(runId), "report.json");
  }

  getControlPath(runId: string): string {
    return path.join(this.getRunDir(runId), "control.json");
  }

  getSnapshotPath(runId: string): string {
    return path.join(this.getRunDir(runId), "rewind-snapshot.json");
  }

  async saveRun(record: RunRecord): Promise<void> {
    await ensureDir(this.getRunDir(record.runId));
    await writeJsonFile(this.getRecordPath(record.runId), record);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    if (!(await pathExists(this.getRecordPath(runId)))) {
      return null;
    }

    return readJsonFile<RunRecord>(this.getRecordPath(runId));
  }

  async appendEvent(runId: string, event: TraceEvent): Promise<void> {
    await ensureDir(this.getRunDir(runId));
    await fs.appendFile(this.getEventsPath(runId), `${JSON.stringify(event)}\n`, "utf8");
    this.bus.emit(runId, event);
  }

  async getEvents(runId: string): Promise<TraceEvent[]> {
    if (!(await pathExists(this.getEventsPath(runId)))) {
      return [];
    }

    const raw = await fs.readFile(this.getEventsPath(runId), "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEvent);
  }

  async saveReport(runId: string, report: FinalReport): Promise<string> {
    const reportPath = this.getReportPath(runId);
    await writeJsonFile(reportPath, report);
    return reportPath;
  }

  async getReport(runId: string): Promise<FinalReport | null> {
    if (!(await pathExists(this.getReportPath(runId)))) {
      return null;
    }

    return readJsonFile<FinalReport>(this.getReportPath(runId));
  }

  async setCancelRequested(runId: string, cancelRequested: boolean): Promise<void> {
    const existing = await this.getControl(runId);
    await writeJsonFile(this.getControlPath(runId), { ...existing, cancelRequested });
  }

  async getControl(runId: string): Promise<ControlState> {
    if (!(await pathExists(this.getControlPath(runId)))) {
      return DEFAULT_CONTROL_STATE;
    }

    return readJsonFile<ControlState>(this.getControlPath(runId), DEFAULT_CONTROL_STATE);
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    const control = await this.getControl(runId);
    return control.cancelRequested;
  }

  async saveRewindSnapshot(runId: string, snapshot: Record<string, string | null>): Promise<void> {
    await writeJsonFile(this.getSnapshotPath(runId), snapshot);
  }

  async getRewindSnapshot(runId: string): Promise<Record<string, string | null> | null> {
    if (!(await pathExists(this.getSnapshotPath(runId)))) {
      return null;
    }

    return readJsonFile<Record<string, string | null>>(this.getSnapshotPath(runId));
  }

  subscribe(runId: string, listener: (event: TraceEvent) => void): () => void {
    this.bus.on(runId, listener);
    return () => {
      this.bus.off(runId, listener);
    };
  }

  async setActiveRun(runId: string, pid: number): Promise<void> {
    await writeJsonFile(ACTIVE_RUN_FILE, { runId, pid });
  }

  async clearActiveRun(runId: string): Promise<void> {
    if (!(await pathExists(ACTIVE_RUN_FILE))) {
      return;
    }

    const active = await readJsonFile<{ runId: string; pid: number } | null>(ACTIVE_RUN_FILE, null);
    if (active?.runId === runId) {
      await fs.rm(ACTIVE_RUN_FILE, { force: true });
    }
  }

  async getActiveRun(): Promise<{ runId: string; pid: number } | null> {
    if (!(await pathExists(ACTIVE_RUN_FILE))) {
      return null;
    }

    return readJsonFile<{ runId: string; pid: number } | null>(ACTIVE_RUN_FILE, null);
  }
}
