// @vitest-environment jsdom

import React, { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { App } from "../../src/ui/App.js";

function installFetchMock(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<any>): void {
  (globalThis as any).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(input, init)
  );
}

function installEventSourceStub(): void {
  (globalThis as any).EventSource = class {
    close(): void {}
  };
}

function preflightOkResponse(agentMode = "fake", checks: unknown[] = []) {
  return { ok: true, json: async () => ({ ok: true, agentMode, checks }) };
}

describe("App", () => {
  it("renders the major panels", () => {
    installFetchMock(async (input) => {
      if (String(input).includes("/preflight")) {
        return preflightOkResponse();
      }
      return { ok: false, json: async () => ({ error: "ignored" }) };
    });
    installEventSourceStub();
    render(<App apiBase="/api" sessionToken="token" />);
    expect(screen.getByText("Run Panel")).toBeTruthy();
    expect(screen.getByText("Trace Panel")).toBeTruthy();
    expect(screen.getByText("Files Panel")).toBeTruthy();
    expect(screen.getByText("Report Panel")).toBeTruthy();
    expect(screen.getByLabelText("Repository path").getAttribute("placeholder")).toBe(
      "D:\\path\\to\\python\\repo"
    );
  });

  it("toggles trace mode", () => {
    installFetchMock(async (input) => {
      if (String(input).includes("/preflight")) {
        return preflightOkResponse();
      }
      return { ok: false, json: async () => ({ error: "ignored" }) };
    });
    installEventSourceStub();
    render(<App apiBase="/api" sessionToken="token" />);
    const toggle = screen.getByRole("button", { name: "Show all" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Compact" })).toBeTruthy();
  });

  it("sends the selected agent mode when starting a run", async () => {
    let runInit: RequestInit | undefined;
    installFetchMock(async (input, init) => {
      if (String(input).includes("/preflight")) {
        return preflightOkResponse("claude");
      }
      if (String(input).endsWith("/runs")) {
        runInit = init;
        return { ok: true, json: async () => ({ runId: "run-123" }) };
      }
      return { ok: false, json: async () => ({ error: "ignored" }) };
    });
    installEventSourceStub();

    render(<App apiBase="/api" sessionToken="token" />);
    fireEvent.change(screen.getByLabelText("Repository path"), {
      target: { value: "/repo" }
    });
    fireEvent.change(screen.getByLabelText("Agent mode"), {
      target: { value: "claude" }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start run/i }));
    });

    expect(JSON.parse(String(runInit?.body))).toMatchObject({
      repoPath: "/repo",
      maxRepairRounds: 1,
      agentMode: "claude"
    });
  });

  it("renders test cases and coverage when present in the report", async () => {
    const report = {
      status: "passed",
      generated_tests: [{ path: "tests/test_calculator.py" }],
      blocked_operations: [],
      cost: { total_usd: 0 },
      repair: { attempted: false, rounds_used: 0, stopped_reason: null },
      test_run: {
        passed: 1,
        failed: 1,
        errors: 0,
        cases: [
          {
            nodeid: "tests/test_calculator.py::test_add",
            outcome: "passed",
            duration_ms: 3,
            file: "tests/test_calculator.py",
            message: null
          },
          {
            nodeid: "tests/test_calculator.py::test_divide",
            outcome: "failed",
            duration_ms: 5,
            file: "tests/test_calculator.py",
            message: "AssertionError"
          }
        ],
        coverage: {
          source: "pytest-cov",
          overall_percent: 87.5,
          files: [
            { file: "src/calculator.py", lines_covered: 7, lines_total: 8, percent: 87.5 }
          ]
        }
      }
    };

    installFetchMock(async (input) => {
      const url = String(input);
      if (url.includes("/preflight")) {
        return preflightOkResponse();
      }
      if (url.endsWith("/runs")) {
        return { ok: true, json: async () => ({ runId: "run-123" }) };
      }
      if (url.includes("/report")) {
        return { ok: true, json: async () => report };
      }
      return { ok: false, json: async () => ({ error: "ignored" }) };
    });
    installEventSourceStub();

    render(<App apiBase="/api" sessionToken="token" />);
    fireEvent.change(screen.getByLabelText("Repository path"), {
      target: { value: "/repo" }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start run/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("Test cases")).toBeTruthy();
    });
    expect(screen.getByText("Coverage")).toBeTruthy();
    expect(screen.getAllByText("87.5%").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("tests/test_calculator.py::test_add")).toBeTruthy();
    expect(screen.getByText("tests/test_calculator.py::test_divide")).toBeTruthy();
    expect(screen.getByText("src/calculator.py")).toBeTruthy();
  });

  it("does not POST /api/runs when preflight returns ok false", async () => {
    let postRuns = 0;
    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url.includes("/preflight")) {
        return {
          ok: true,
          json: async () => ({
            ok: false,
            agentMode: "fake",
            checks: [{ id: "pytest", name: "pytest", status: "fail", message: "not on PATH" }]
          })
        };
      }
      if (url.endsWith("/runs") && init?.method === "POST") {
        postRuns += 1;
        return { ok: true, json: async () => ({ runId: "run-123" }) };
      }
      return { ok: false, json: async () => ({ error: "ignored" }) };
    });
    installEventSourceStub();

    render(<App apiBase="/api" sessionToken="token" />);
    fireEvent.change(screen.getByLabelText("Repository path"), {
      target: { value: "/repo" }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start run/i }));
    });

    expect(postRuns).toBe(0);
    expect(screen.getByText("Preflight failed. Fix the issues below before starting.")).toBeTruthy();
  });

  it("sends session token and query params to preflight after debounce", async () => {
    const calls: Array<{ url: string; headers?: HeadersInit }> = [];
    installFetchMock(async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers as HeadersInit });
      if (String(input).includes("/preflight")) {
        return preflightOkResponse("fake", [
          { id: "pytest_cov", name: "pytest-cov", status: "warn", message: "optional" }
        ]);
      }
      return { ok: false, json: async () => ({ error: "ignored" }) };
    });
    installEventSourceStub();

    render(<App apiBase="/api" sessionToken="secret-token" />);
    fireEvent.change(screen.getByLabelText("Repository path"), {
      target: { value: "C:\\my\\repo" }
    });
    fireEvent.change(screen.getByLabelText("Target path"), {
      target: { value: "src/a.py" }
    });

    await waitFor(
      () => {
        expect(calls.some((c) => c.url.includes("/preflight"))).toBe(true);
      },
      { timeout: 3000, interval: 50 }
    );

    const preflightCall = calls.find((c) => c.url.includes("/preflight"));
    expect(preflightCall?.url).toContain("repoPath=");
    expect(preflightCall?.url).toContain("targetPath=");
    expect(preflightCall?.url).toContain("agentMode=fake");
    const headers = preflightCall?.headers as Record<string, string> | undefined;
    const token =
      headers?.["x-session-token"] ??
      (typeof Headers !== "undefined" && preflightCall?.headers instanceof Headers
        ? preflightCall.headers.get("x-session-token")
        : undefined);
    expect(token).toBe("secret-token");
    expect(screen.getByText("pytest-cov")).toBeTruthy();
  });
});
