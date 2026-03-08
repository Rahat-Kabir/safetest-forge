import React, { useEffect, useMemo, useRef, useState } from "react";

type TraceEvent = {
  ts: string;
  type: string;
  data: Record<string, unknown>;
};

type FinalReport = {
  status: string;
  generated_tests: Array<{ path: string }>;
  blocked_operations: Array<{ tool: string; reason: string }>;
  cost: { total_usd: number };
  repair: { attempted: boolean; rounds_used: number; stopped_reason: string | null };
  test_run: { passed: number; failed: number; errors: number };
};

type AppProps = {
  apiBase?: string;
  sessionToken?: string;
};

/* ─── SVG Icons (inline, no deps) ─── */

function IconPlay(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5,3 13,8 5,13" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconRewind(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3L3 8l5 5" />
      <path d="M13 3L8 8l5 5" />
    </svg>
  );
}

function IconFile(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1Z" />
      <path d="M9 1v4h4" />
    </svg>
  );
}

function IconSpinner(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 1a7 7 0 0 1 7 7" strokeLinecap="round" />
    </svg>
  );
}

function IconTerminal(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5l3 3-3 3" />
      <path d="M9 11h3" />
    </svg>
  );
}

/* ─── Trace event categorization ─── */

type TraceBadgeCategory = "run" | "tool" | "text" | "file" | "denied" | "checkpoint" | "agent" | "progress";

function categorizeEvent(type: string): TraceBadgeCategory {
  switch (type) {
    case "run_started":
    case "run_finished":
    case "run_failed":
      return "run";
    case "tool_use":
    case "tool_result":
      return "tool";
    case "tool_progress":
      return "progress";
    case "assistant_text":
      return "text";
    case "file_changed":
      return "file";
    case "permission_denied":
    case "hook_event":
      return "denied";
    case "checkpoint_created":
    case "rewind_available":
      return "checkpoint";
    case "subagent_started":
    case "subagent_finished":
      return "agent";
    case "task_progress":
    default:
      return "progress";
  }
}

function badgeLabel(type: string): string {
  const map: Record<string, string> = {
    run_started: "run",
    run_finished: "done",
    run_failed: "fail",
    tool_use: "tool",
    tool_result: "result",
    tool_progress: "progress",
    assistant_text: "text",
    file_changed: "file",
    permission_denied: "denied",
    hook_event: "hook",
    checkpoint_created: "checkpoint",
    rewind_available: "rewind",
    subagent_started: "agent",
    subagent_finished: "agent",
    task_progress: "progress"
  };
  return map[type] ?? type;
}

function formatTimestamp(ts: string): string {
  try {
    const date = new Date(ts);
    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return "";
  }
}

function currentPhase(events: TraceEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "run_finished" || event.type === "run_failed") return null;
    if (event.type === "task_progress" && typeof event.data.phase === "string") {
      return event.data.phase.replace(/_/g, " ");
    }
    if (event.type === "subagent_started") return "subagent running";
    if (event.type === "tool_use" && typeof event.data.tool === "string") {
      return `using ${event.data.tool}`;
    }
  }
  return null;
}

function statusClass(status: string): string {
  if (status === "passed") return "status-badge--passed";
  if (status === "running" || status === "starting") return "status-badge--running";
  if (status === "idle") return "status-badge--idle";
  return "status-badge--failed";
}

/* ─── Main App ─── */

export function App({ apiBase = "/api", sessionToken = "" }: AppProps): React.JSX.Element {
  const [repoPath, setRepoPath] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [maxRepairRounds, setMaxRepairRounds] = useState(1);
  const [runId, setRunId] = useState("");
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [report, setReport] = useState<FinalReport | null>(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [traceMode, setTraceMode] = useState<"compact" | "all">("compact");
  const [rewoundFiles, setRewoundFiles] = useState<string[]>([]);
  const traceEndRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`${apiBase}/runs/${runId}/events`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as TraceEvent;
      setEvents((current) => [...current, event]);
    };
    source.onerror = () => {
      source.close();
    };
    return () => { source.close(); };
  }, [apiBase, runId]);

  useEffect(() => {
    if (!runId) return;
    const interval = window.setInterval(async () => {
      const response = await fetch(`${apiBase}/runs/${runId}/report`);
      if (response.ok) {
        const nextReport = (await response.json()) as FinalReport;
        setReport(nextReport);
        setStatus(nextReport.status);
      }
    }, 700);
    return () => { window.clearInterval(interval); };
  }, [apiBase, runId]);

  // Auto-scroll trace
  useEffect(() => {
    traceEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events]);

  const generatedFiles = useMemo(() => report?.generated_tests ?? [], [report]);
  const visibleGeneratedFiles = useMemo(
    () => generatedFiles.filter((item) => !rewoundFiles.includes(item.path)),
    [generatedFiles, rewoundFiles]
  );

  const visibleEvents = useMemo(() => {
    const filtered =
      traceMode === "compact"
        ? events.filter((event) => {
            if (event.type === "tool_progress" && event.data.phase === "input") return false;
            if (event.type === "assistant_text" && event.data.partial === true) return false;
            return true;
          })
        : events;
    return filtered.slice(-120);
  }, [events, traceMode]);

  const phase = useMemo(() => currentPhase(events), [events]);
  const isRunning = status === "running" || status === "starting";

  async function startRun(): Promise<void> {
    setError("");
    setEvents([]);
    setReport(null);
    setRewoundFiles([]);
    setStatus("starting");
    const response = await fetch(`${apiBase}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": sessionToken
      },
      body: JSON.stringify({
        repoPath,
        targetPath: targetPath || undefined,
        maxRepairRounds
      })
    });
    if (!response.ok) {
      setStatus("error");
      setError((await response.json()).error);
      return;
    }
    const data = (await response.json()) as { runId: string };
    setRunId(data.runId);
    setStatus("running");
  }

  async function rewind(): Promise<void> {
    if (!runId) return;
    const response = await fetch(`${apiBase}/runs/${runId}/rewind`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": sessionToken
      }
    });
    if (!response.ok) {
      setError((await response.json()).error);
      return;
    }
    const result = (await response.json()) as { filesChanged?: string[] };
    const normalized = (result.filesChanged ?? []).map((filePath) => filePath.replaceAll("\\", "/"));
    setRewoundFiles(normalized);
  }

  return (
    <div className="shell">
      {/* ─── Top Bar ─── */}
      <header className="topbar">
        <div className="topbar-brand">
          <div className="topbar-logo">SF</div>
          <span className="topbar-name">SafeTest Forge</span>
        </div>
        <div className="topbar-right">
          {runId && (
            <span
              className={`run-id-badge${copied ? " run-id-badge--copied" : ""}`}
              title="Click to copy"
              onClick={() => {
                void navigator.clipboard.writeText(runId).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied!" : runId}
            </span>
          )}
          <span className={`status-badge ${statusClass(status)}`}>
            <span className="status-dot" />
            {status}
          </span>
        </div>
      </header>

      {/* ─── Main 2-column ─── */}
      <div className="main-grid">
        {/* ─── Sidebar ─── */}
        <aside className="sidebar">
          {/* Run Panel */}
          <article className="card">
            <div className="card-header">
              <h2 className="card-title">Run Panel</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label className="form-label" htmlFor="repo-path">Repository path</label>
                <input
                  id="repo-path"
                  className="form-input"
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  placeholder={"D:\\path\\to\\python\\repo"}
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="target-path">Target path</label>
                <input
                  id="target-path"
                  className="form-input"
                  value={targetPath}
                  onChange={(e) => setTargetPath(e.target.value)}
                  placeholder="src/module.py"
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="repair-rounds">Max repair rounds</label>
                <input
                  id="repair-rounds"
                  className="form-input"
                  type="number"
                  min={0}
                  max={2}
                  value={maxRepairRounds}
                  onChange={(e) => setMaxRepairRounds(Number.parseInt(e.target.value, 10) || 0)}
                />
              </div>
              <div className="form-actions">
                <button
                  className="btn btn--primary"
                  onClick={() => void startRun()}
                  disabled={!repoPath || isRunning}
                >
                  <IconPlay /> Start run
                </button>
                <button
                  className="btn btn--secondary"
                  onClick={() => void rewind()}
                  disabled={!runId || isRunning}
                >
                  <IconRewind /> Rewind
                </button>
              </div>
              {error && <div className="error-msg">{error}</div>}
            </div>
          </article>

          {/* Files Panel */}
          <article className="card">
            <div className="card-header">
              <h2 className="card-title">Files Panel</h2>
              <span className="card-count">{visibleGeneratedFiles.length}</span>
            </div>
            <div className="card-body--flush">
              {visibleGeneratedFiles.length > 0 ? (
                <ul className="files-list">
                  {visibleGeneratedFiles.map((item) => (
                    <li key={item.path} className="file-item">
                      <span className="file-icon"><IconFile /></span>
                      <span className="file-path">{item.path}</span>
                      <span className="file-badge">generated</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="files-empty">No generated files yet.</p>
              )}
            </div>
          </article>

          {/* Report Panel */}
          <article className="card">
            <div className="card-header">
              <h2 className="card-title">Report Panel</h2>
            </div>
            {report ? (
              <>
                <div className="report-grid">
                  <div className="report-stat">
                    <span className="report-stat-label">Passed</span>
                    <span className="report-stat-value report-stat-value--passed">
                      {report.test_run.passed}
                    </span>
                  </div>
                  <div className="report-stat">
                    <span className="report-stat-label">Failed</span>
                    <span className="report-stat-value report-stat-value--failed">
                      {report.test_run.failed}
                    </span>
                  </div>
                  <div className="report-stat">
                    <span className="report-stat-label">Errors</span>
                    <span className="report-stat-value report-stat-value--neutral">
                      {report.test_run.errors}
                    </span>
                  </div>
                  <div className="report-stat">
                    <span className="report-stat-label">Status</span>
                    <span className={`report-stat-value ${report.status === "passed" ? "report-stat-value--passed" : report.status === "failed" ? "report-stat-value--failed" : "report-stat-value--neutral"}`}>
                      {report.status}
                    </span>
                  </div>
                </div>
                <div className="report-detail-row">
                  <span className="report-detail-label">Repair</span>
                  <span className="report-detail-value">
                    {report.repair.attempted ? `yes (${report.repair.rounds_used} rounds)` : "no"}
                  </span>
                </div>
                <div className="report-detail-row">
                  <span className="report-detail-label">Blocked ops</span>
                  <span className="report-detail-value">{report.blocked_operations.length}</span>
                </div>
                <div className="report-detail-row">
                  <span className="report-detail-label">Cost</span>
                  <span className="report-detail-value">${report.cost.total_usd.toFixed(4)}</span>
                </div>
              </>
            ) : (
              <div className="card-body">
                <p className="report-empty">No report yet.</p>
              </div>
            )}
          </article>
        </aside>

        {/* ─── Content: Trace ─── */}
        <main className="content">
          <article className="card" style={{ flex: 1 }}>
            <div className="card-header">
              <h2 className="card-title">Trace Panel</h2>
              <div className="trace-controls">
                <span className="trace-meta">
                  {visibleEvents.length} / {events.length}
                </span>
                <button
                  className={`btn btn--ghost ${traceMode === "compact" ? "active" : ""}`}
                  type="button"
                  onClick={() => setTraceMode("compact")}
                >
                  Compact
                </button>
                <button
                  className={`btn btn--ghost ${traceMode === "all" ? "active" : ""}`}
                  type="button"
                  onClick={() => setTraceMode("all")}
                >
                  Show all
                </button>
              </div>
            </div>

            {isRunning && phase && (
              <div className="phase-bar">
                <IconSpinner />
                {phase}
              </div>
            )}

            <div className="card-body--flush">
              {visibleEvents.length > 0 ? (
                <ul className="trace-list">
                  {visibleEvents.map((event, index) => {
                    const category = categorizeEvent(event.type);
                    return (
                      <li key={`${event.ts}-${index}`} className="trace-item">
                        <details>
                          <summary className="trace-summary">
                            <span className={`trace-badge trace-badge--${category}`}>
                              {badgeLabel(event.type)}
                            </span>
                            <span className="trace-preview">{formatTracePreview(event)}</span>
                            <span className="trace-ts">{formatTimestamp(event.ts)}</span>
                          </summary>
                          <div className="trace-detail">
                            <code className="trace-detail-code">{JSON.stringify(event.data, null, 2)}</code>
                          </div>
                        </details>
                      </li>
                    );
                  })}
                  <div ref={traceEndRef} />
                </ul>
              ) : (
                <div className="trace-empty">
                  <div className="trace-empty-icon">
                    <IconTerminal />
                  </div>
                  Start a run to see the live event trace.
                </div>
              )}
            </div>
          </article>
        </main>
      </div>
    </div>
  );
}

function formatTracePreview(event: TraceEvent): string {
  if (event.type === "tool_use") {
    return `${String(event.data.tool ?? "tool")} ${truncate(JSON.stringify(event.data.input ?? {}), 80)}`;
  }
  if (event.type === "tool_progress") {
    return `${String(event.data.phase ?? "progress")}${event.data.tool ? ` ${String(event.data.tool)}` : ""}`;
  }
  if (event.type === "assistant_text") {
    return truncate(String(event.data.text ?? ""), 80);
  }
  if (event.type === "file_changed") {
    return String(event.data.path ?? "file updated");
  }
  if (event.type === "permission_denied") {
    return `${String(event.data.tool ?? "tool")} denied`;
  }
  if (event.type === "run_started") {
    return `${String(event.data.repo_path ?? "")}`;
  }
  if (event.type === "run_finished") {
    return `status: ${String(event.data.status ?? "done")}`;
  }
  if (event.type === "run_failed") {
    return `status: ${String(event.data.status ?? "failed")}`;
  }
  if (event.type === "checkpoint_created") {
    return String(event.data.user_message_uuid ?? "checkpoint");
  }
  if (event.type === "subagent_started" || event.type === "subagent_finished") {
    return String(event.data.tool ?? "subagent");
  }
  if (event.type === "task_progress") {
    return String(event.data.phase ?? event.data.status ?? "progress");
  }
  return truncate(JSON.stringify(event.data), 80);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}\u2026` : value;
}
