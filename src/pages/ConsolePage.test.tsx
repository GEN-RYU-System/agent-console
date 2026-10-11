// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import type { ConsoleState } from "../types";

const state: ConsoleState = {
  sessions: [{ id: "s1", name: "dead", roleId: "shell", branch: null, cwd: "/", state: "stopped", createdAt: 1 }],
  agentsAvailable: true,
  roles: [{ id: "shell", labelKey: "role.shell", needsWorktree: false }],
  saSource: "abcdef0123456789",
  claudeVersion: "1.0.0",
  appVersion: "0.2.0",
};

const removeSession = vi.fn();
const fetchState = vi.fn();

vi.mock("../api", () => ({
  ApiError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  fetchState: () => fetchState(),
  fetchLedger: vi.fn(async () => ({ groups: { IN_PROGRESS: [], REVIEW: [], DONE: [], OTHER: [], UNREGISTERED: [] }, errors: [] })),
  refreshLedger: vi.fn(),
  createSession: vi.fn(),
  removeSession: (id: string) => removeSession(id),
  wsUrl: () => "ws://test",
}));

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onmessage: unknown = null;
  onclose: unknown = null;
  close = vi.fn();
}

beforeEach(() => {
  removeSession.mockReset();
  fetchState.mockReset();
  fetchState.mockResolvedValue(state);
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("ConsolePage removing a stopped session", () => {
  it("shows an error callout when removal fails (409 / 404 / network)", async () => {
    removeSession.mockRejectedValue(new Error("session is still running"));
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("一覧から外す"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("一覧から外せませんでした");
    expect(alert.textContent).toContain("session is still running");
  });

  it("clears the error after a later successful removal", async () => {
    removeSession.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ removed: true });
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    const button = await screen.findByText("一覧から外す");
    fireEvent.click(button);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("一覧から外す"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("ConsolePage footer and authorization", () => {
  it("shows the app version in the footer", async () => {
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    expect((await screen.findByTestId("app-version")).textContent).toContain("0.2.0");
  });

  it("shows a login-required callout on 401", async () => {
    const { ApiError } = await import("../api");
    fetchState.mockRejectedValue(new ApiError("unauthorized", 401));
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    expect((await screen.findByRole("alert")).textContent).toContain("ログインが必要です");
  });

  it("shows the generic load error for other failures", async () => {
    fetchState.mockRejectedValue(new Error("boom"));
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    expect(await screen.findByText("状態を取得できません")).toBeTruthy();
  });
});
