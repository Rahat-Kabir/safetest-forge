// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { App } from "../../src/ui/App.js";

describe("App", () => {
  it("renders the major panels", () => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: "ignored" })
    }));
    (globalThis as any).EventSource = class {
      close(): void {}
    };
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
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: "ignored" })
    }));
    (globalThis as any).EventSource = class {
      close(): void {}
    };
    render(<App apiBase="/api" sessionToken="token" />);
    const toggle = screen.getByRole("button", { name: "Show all" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Compact" })).toBeTruthy();
  });
});
