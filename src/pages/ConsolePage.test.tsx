// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import type { ConsoleState } from "../types";

const state: ConsoleState = {
  sessions: [{ id: "s1", name: "dead", roleId: "shell", branch: null, cwd: "/", state: "stopped", createdAt: 1, unread: 0, hasClaude: false }],
  agentsAvailable: true,
  roles: [{ id: "shell", labelKey: "role.shell", needsWorktree: false, canResume: false }],
  saSource: "abcdef0123456789",
  claudeVersion: "1.0.0",
  appVersion: "0.3.0",
  commit: "abcdef0123456789abcdef0123456789abcdef01",
};

const removeSession = vi.fn();
const fetchState = vi.fn();
const logout = vi.fn();
const markRead = vi.fn();
const sendQuickPrompt = vi.fn();
const fetchQuickPrompts = vi.fn();
const renameSession = vi.fn();

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
  getSessionToken: () => "session-token",
  logout: () => logout(),
  markRead: (id: string) => markRead(id),
  sendQuickPrompt: (id: string, promptId: string) => sendQuickPrompt(id, promptId),
  fetchQuickPrompts: () => fetchQuickPrompts(),
  renameSession: (id: string, name: string) => renameSession(id, name),
  fetchPastSessions: vi.fn(async () => ({ available: true, items: [] })),
  resumeSession: vi.fn(),
  fetchMemory: vi.fn(async () => ({ sessions: [], serverRssMb: 1, system: null })),
  openSocket: () => new FakeWebSocket(),
}));

// xterm は jsdom で動かない（matchMedia が無い）。端末の描画は e2e で確認する
vi.mock("../components/TerminalPane/TerminalPane", () => ({ TerminalPane: () => <div data-testid="terminal-stub" /> }));

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
  logout.mockReset();
  markRead.mockReset();
  markRead.mockResolvedValue({ read: true });
  sendQuickPrompt.mockReset();
  sendQuickPrompt.mockResolvedValue({ sent: true });
  renameSession.mockReset();
  fetchQuickPrompts.mockReset();
  fetchQuickPrompts.mockResolvedValue({ items: [{ id: "p1", label: "テスト実行", text: "run tests" }] });
  logout.mockResolvedValue(undefined);
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
    expect((await screen.findByTestId("app-version")).textContent).toContain("0.3.0");
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

  it("shows the short commit in the footer", async () => {
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    expect((await screen.findByTestId("commit")).textContent).toContain("abcdef0");
    expect(screen.getByTestId("commit").textContent).not.toContain("abcdef01234");
  });

  it("logs out: calls the server logout and then shows the login-required callout", async () => {
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("ログアウト"));
    expect((await screen.findByRole("alert")).textContent).toContain("ログインが必要です");
    expect(logout).toHaveBeenCalledOnce();
  });
});

describe("ConsolePage daily use", () => {
  const live = { ...state.sessions[0], state: "idle" as const, unread: 2, hasClaude: true };

  it("puts the total unread count in the window title", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [live, { ...live, id: "s2", unread: 1 }] });
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    await screen.findAllByTestId("session-row");
    await waitFor(() => expect(document.title).toBe("(3) Agent Console"));
  });

  it("marks a row as read when it is selected", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [live] });
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith("s1"));
  });

  it("sends a quick prompt to the selected session only when a button is pressed", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...live, unread: 0 }] });
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    const button = await screen.findByRole("button", { name: "テスト実行" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(sendQuickPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("dead"));
    await waitFor(() => expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "テスト実行" }));
    await waitFor(() => expect(sendQuickPrompt).toHaveBeenCalledWith("s1", "p1"));
  });

  it("explains that a break is the app's own definition", async () => {
    const { ConsolePage } = await import("./ConsolePage");
    render(<ConsolePage />);
    expect((await screen.findByTestId("notify-help")).textContent).toContain("Claude 公式");
  });
});
