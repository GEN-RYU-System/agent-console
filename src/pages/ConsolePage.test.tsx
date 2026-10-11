// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import type { ConsoleState } from "../types";

const state: ConsoleState = {
  sessions: [{ id: "s1", name: "dead", roleId: "shell", branch: null, cwd: "/", state: "stopped", createdAt: 1, unread: 0, hasClaude: false, canInput: false }],
  agentsAvailable: true,
  roles: [{ id: "shell", labelKey: "role.shell", needsWorktree: false }],
  saSource: "abcdef0123456789",
  claudeVersion: "1.0.0",
  appVersion: "0.3.5",
  commit: "abcdef0123456789abcdef0123456789abcdef01",
};

const removeSession = vi.fn();
const fetchState = vi.fn();
const logout = vi.fn();
const markRead = vi.fn();
const checkQuickPromptSend = vi.fn();
const pasteAndEnter = vi.fn();
const fetchQuickPrompts = vi.fn();
const renameSession = vi.fn();
const fetchResumeTargets = vi.fn();
const resumeSession = vi.fn();

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
  checkQuickPromptSend: (id: string, promptId: string) => checkQuickPromptSend(id, promptId),
  fetchQuickPrompts: () => fetchQuickPrompts(),
  renameSession: (id: string, name: string) => renameSession(id, name),
  fetchResumeTargets: () => fetchResumeTargets(),
  resumeSession: (t: { kind: string; path: string }) => resumeSession(t),
  fetchMemory: vi.fn(async () => ({ sessions: [], serverRssMb: 1, system: null })),
  openSocket: () => new FakeWebSocket(),
}));

// xterm は jsdom で動かない（matchMedia が無い）。端末の描画は e2e で確認する
vi.mock("../components/TerminalPane/TerminalPane", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    TerminalPane: forwardRef(function TerminalStub(props: { sessionId: string }, ref) {
      // 本物と同じく、確認したセッションと表示中のセッションが同じときだけ入れる
      useImperativeHandle(
        ref,
        () => ({
          pasteAndEnter: (id: string, t: string) => {
            if (id !== props.sessionId) return false;
            pasteAndEnter(t);
            return true;
          },
        }),
        [props.sessionId],
      );
      return <div data-testid="terminal-stub" />;
    }),
  };
});

// 画面全体（SA の金型を含む）の読み込みは負荷時に数秒かかる。テストの 5 秒の制限に含めないよう、最初に 1 回だけ読む
const { ConsolePage } = await import("./ConsolePage");

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
  checkQuickPromptSend.mockReset();
  checkQuickPromptSend.mockResolvedValue({ text: "run tests" });
  pasteAndEnter.mockReset();
  renameSession.mockReset();
  fetchResumeTargets.mockReset();
  fetchResumeTargets.mockResolvedValue({ items: [{ kind: "worktree", path: "/wt/release-a", branch: "release/a", roleId: "sonnet-impl" }] });
  resumeSession.mockReset();
  resumeSession.mockResolvedValue({ id: "s1" });
  fetchQuickPrompts.mockReset();
  fetchQuickPrompts.mockResolvedValue({ items: [{ id: "p1", label: "テスト実行", text: "run tests" }] });
  logout.mockResolvedValue(undefined);
  fetchState.mockResolvedValue(state);
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("ConsolePage removing a stopped session", () => {
  it("shows an error callout when removal fails (409 / 404 / network)", async () => {
    removeSession.mockRejectedValue(new Error("session is still running"));
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("一覧から外す"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("一覧から外せませんでした");
    expect(alert.textContent).toContain("session is still running");
  });

  it("clears the error after a later successful removal", async () => {
    removeSession.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ removed: true });
    render(<ConsolePage />);
    const button = await screen.findByText("一覧から外す");
    fireEvent.click(button);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("一覧から外す"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("ConsolePage resume picker (K1-K3 screen side)", () => {
  it("opens the picker, lists the worktree row and sends only kind and path when 再開 is pressed", async () => {
    render(<ConsolePage />);
    fireEvent.click(await screen.findByRole("button", { name: "過去の会話を再開" }));
    expect(await screen.findByText("Sonnet 実装役（release/a）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    await waitFor(() => expect(resumeSession).toHaveBeenCalledWith({ kind: "worktree", path: "/wt/release-a", branch: "release/a", roleId: "sonnet-impl" }));
  });
});

describe("ConsolePage footer and authorization", () => {
  it("shows the app version in the footer", async () => {
    render(<ConsolePage />);
    expect((await screen.findByTestId("app-version")).textContent).toContain("0.3.5");
  });

  it("shows a login-required callout on 401", async () => {
    const { ApiError } = await import("../api");
    fetchState.mockRejectedValue(new ApiError("unauthorized", 401));
    render(<ConsolePage />);
    expect((await screen.findByRole("alert")).textContent).toContain("ログインが必要です");
  });

  it("shows the generic load error for other failures", async () => {
    fetchState.mockRejectedValue(new Error("boom"));
    render(<ConsolePage />);
    expect(await screen.findByText("状態を取得できません")).toBeTruthy();
  });

  it("shows the short commit in the footer", async () => {
    render(<ConsolePage />);
    expect((await screen.findByTestId("commit")).textContent).toContain("abcdef0");
    expect(screen.getByTestId("commit").textContent).not.toContain("abcdef01234");
  });

  it("logs out: calls the server logout and then shows the login-required callout", async () => {
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("ログアウト"));
    expect((await screen.findByRole("alert")).textContent).toContain("ログインが必要です");
    expect(logout).toHaveBeenCalledOnce();
  });
});

describe("ConsolePage daily use", () => {
  const live = { ...state.sessions[0], state: "idle" as const, unread: 2, hasClaude: true, canInput: true };

  it("puts the total unread count in the window title", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [live, { ...live, id: "s2", unread: 1 }] });
    render(<ConsolePage />);
    await screen.findAllByTestId("session-row");
    await waitFor(() => expect(document.title).toBe("(3) Agent Console"));
  });

  it("marks a row as read when it is selected", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [live] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith("s1"));
  });

  it("asks the server first and pastes the returned text into the terminal only when a button is pressed", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...live, unread: 0 }] });
    render(<ConsolePage />);
    const button = await screen.findByRole("button", { name: "テスト実行" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(checkQuickPromptSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("dead"));
    await waitFor(() => expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "テスト実行" }));
    await waitFor(() => expect(checkQuickPromptSend).toHaveBeenCalledWith("s1", "p1"));
    await waitFor(() => expect(pasteAndEnter).toHaveBeenCalledWith("run tests"));
  });

  it("discards the text and says so when the selection changed while the server was checking", async () => {
    let release: (v: { text: string }) => void = () => {};
    checkQuickPromptSend.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const other = { ...live, id: "s2", name: "other", unread: 0 };
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...live, unread: 0 }, other] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await waitFor(() => expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "テスト実行" }));
    await waitFor(() => expect(checkQuickPromptSend).toHaveBeenCalledWith("s1", "p1"));
    fireEvent.click(screen.getByText("other"));
    release({ text: "run tests" });
    expect((await screen.findByRole("alert")).textContent).toContain("切り替わった");
    expect(pasteAndEnter).not.toHaveBeenCalled();
  });

  it("does not paste and shows the server's reason when the state check is refused (409)", async () => {
    checkQuickPromptSend.mockRejectedValue(new Error("claude is busy"));
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...live, unread: 0 }] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await waitFor(() => expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "テスト実行" }));
    expect((await screen.findByRole("alert")).textContent).toContain("claude is busy");
    expect(pasteAndEnter).not.toHaveBeenCalled();
  });

  it("disables the quick prompt buttons while input is not allowed", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...live, unread: 0, canInput: false }] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains that a break is the app's own definition", async () => {
    render(<ConsolePage />);
    expect((await screen.findByTestId("notify-help")).textContent).toContain("Claude 公式");
  });
});
