// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import type { ConsoleState } from "../types";

const state: ConsoleState = {
  sessions: [{ id: "s1", name: "dead", roleId: "shell", branch: null, cwd: "/", state: "stopped", createdAt: 1, unread: 0, hasClaude: false, canInput: false, canChat: false }],
  agentsAvailable: true,
  restoreNotices: [],
  picksUnsent: 3,
  activityRev: 0,
  roles: [{ id: "shell", labelKey: "role.shell", needsWorktree: false }],
  saSource: "abcdef0123456789",
  claudeVersion: "1.0.0",
  appVersion: "0.3.6",
  commit: "abcdef0123456789abcdef0123456789abcdef01",
  terminalSmoothScrollMs: 125,
  uploadMaxBytes: 5 * 1024 * 1024,
  accountSwitchEnabled: false,
};

const removeSession = vi.fn();
const fetchState = vi.fn();
const logout = vi.fn();
const markRead = vi.fn();
const checkQuickPromptSend = vi.fn();
const pasteOnly = vi.fn();
const fetchQuickPrompts = vi.fn();
const renameSession = vi.fn();
const fetchResumeTargets = vi.fn();
const resumeSession = vi.fn();
const closeSession = vi.fn();
const fetchDiff = vi.fn();
const fetchPicks = vi.fn();
const moveSession = vi.fn();

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
  closeSession: (id: string) => closeSession(id),
  moveSession: (id: string, toIndex: number) => moveSession(id, toIndex),
  updateQuickPrompt: vi.fn(),
  fetchActivity: vi.fn(async () => ({ status: "noSession" })),
  fetchBoard: vi.fn(async () => ({ status: "none" })),
  fetchUsage: vi.fn(async () => ({ status: "none" })),
  fetchAccount: vi.fn(async () => ({ status: "error" })),
  startAccountLogin: vi.fn(),
  fetchChat: vi.fn(async () => ({ status: "noSession", queued: [] })),
  fetchFiles: vi.fn(async () => ({ status: "noSession" })),
  fetchFileContent: vi.fn(async () => ({ status: "noSession" })),
  checkChatSend: vi.fn(),
  fetchMemory: vi.fn(async () => ({ sessions: [], serverRssMb: 1, system: null })),
  fetchDiff: () => fetchDiff(),
  fetchDiffFile: vi.fn(async () => ({ lines: [] })),
  fetchDiffComments: vi.fn(async () => ({ items: [] })),
  createDiffComment: vi.fn(),
  updateDiffComment: vi.fn(),
  deleteDiffComment: vi.fn(),
  checkDiffCommentsSend: vi.fn(),
  markDiffCommentsSent: vi.fn(),
  fetchPicks: () => fetchPicks(),
  fetchPickImage: vi.fn(),
  updatePickNote: vi.fn(),
  deletePick: vi.fn(),
  checkPicksSend: vi.fn(),
  markPicksSent: vi.fn(),
  openSocket: () => new FakeWebSocket(),
}));

// xterm は jsdom で動かない（matchMedia が無い）。端末の描画は e2e で確認する
vi.mock("../components/TerminalPane/TerminalPane", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  const { Button } = await import("@sa/components/Button");
  return {
    TerminalPane: forwardRef(function TerminalStub(props: { sessionId: string; smoothScrollMs?: number; uploadMaxBytes?: number; onUploadNotice?: (n: string) => void }, ref) {
      // 本物と同じく、確認したセッションと表示中のセッションが同じときだけ入れる
      useImperativeHandle(
        ref,
        () => ({
          pasteOnly: (id: string, t: string) => {
            if (id !== props.sessionId) return false;
            pasteOnly(t);
            return true;
          },
          pasteSubmitAfter: async () => "notPasted" as const,
        }),
        [props.sessionId],
      );
      return (
        <div data-testid="terminal-stub" data-smooth={props.smoothScrollMs} data-max={props.uploadMaxBytes}>
          <Button onClick={() => props.onUploadNotice?.("tooLarge")}>stub-notice</Button>
        </div>
      );
    }),
  };
});

// 画面全体（SA の金型を含む）の読み込みは負荷時に数秒かかる。テストの 5 秒の制限に含めないよう、最初に 1 回だけ読む
const { ConsolePage } = await import("./ConsolePage");

let lastSocket: FakeWebSocket | null = null;
class FakeWebSocket {
  constructor() {
    lastSocket = this;
  }
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
  pasteOnly.mockReset();
  renameSession.mockReset();
  fetchResumeTargets.mockReset();
  fetchResumeTargets.mockResolvedValue({ items: [{ kind: "worktree", path: "/wt/release-a", branch: "release/a", roleId: "sonnet-impl" }] });
  resumeSession.mockReset();
  closeSession.mockReset();
  moveSession.mockReset();
  moveSession.mockResolvedValue({ moved: true });
  fetchDiff.mockReset();
  fetchDiff.mockResolvedValue({ baseRef: "origin/main", files: [{ path: "a.ts", added: 1, removed: 0, binary: false, untracked: false }] });
  closeSession.mockResolvedValue({ closed: true });
  resumeSession.mockResolvedValue({ id: "s1" });
  fetchQuickPrompts.mockReset();
  fetchQuickPrompts.mockResolvedValue({ items: [{ id: "p1", label: "テスト実行", text: "run tests", pinned: true }] });
  logout.mockResolvedValue(undefined);
  fetchState.mockResolvedValue(state);
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

/** v0.11.0: 最初に開くタブはチャット。端末を見る試験は、端末タブを押してから見る */
const openTerminalTab = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole("tab", { name: /端末/ }));
};

describe("ConsolePage removing a stopped session", () => {
  it("shows an error callout when removal fails (409 / 404 / network)", async () => {
    removeSession.mockRejectedValue(new Error("session is still running"));
    render(<ConsolePage />);
    fireEvent.click(await screen.findByRole("button", { name: "一覧から外す" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("一覧から外せませんでした");
    expect(alert.textContent).toContain("session is still running");
  });

  it("clears the error after a later successful removal", async () => {
    removeSession.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ removed: true });
    render(<ConsolePage />);
    const button = await screen.findByRole("button", { name: "一覧から外す" });
    fireEvent.click(button);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "一覧から外す" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

// 確認画面の「閉じる」（danger）。Modal 自身の右上の × も同じ名前なので、danger の方を選ぶ
const confirmButton = async (): Promise<HTMLElement> => {
  const buttons = within(await screen.findByRole("dialog")).getAllByRole("button", { name: "閉じる" });
  return buttons.find((b) => b.className.includes("comp-btn--danger")) as HTMLElement;
};

describe("ConsolePage closing a running session (K1 screen side)", () => {
  const running = { ...state.sessions[0], name: "busy-one", state: "working" as const, hasClaude: true };

  it("asks for confirmation first and does nothing when やめる is chosen", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [running] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByRole("button", { name: "セッションを閉じる" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("busy-one を閉じますか？");
    expect(dialog.textContent).toContain("会話は「過去の会話を再開」から戻せます");
    expect(closeSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("closes the session when 閉じる is confirmed", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [running] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByRole("button", { name: "セッションを閉じる" }));
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(closeSession).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows an error callout when closing fails", async () => {
    closeSession.mockRejectedValue(new Error("session did not stop"));
    fetchState.mockResolvedValue({ ...state, sessions: [running] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByRole("button", { name: "セッションを閉じる" }));
    fireEvent.click(await confirmButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("閉じられませんでした");
    expect(alert.textContent).toContain("session did not stop");
  });
});

describe("ConsolePage restore notices (K5, K8 screen side)", () => {
  it("shows what could not be reopened once, and hides it after it is dismissed", async () => {
    fetchState.mockResolvedValue({
      ...state,
      restoreNotices: [
        { reason: "missingCwd", name: "old-work" },
        { reason: "unreadable" },
      ],
    });
    render(<ConsolePage />);
    const box = await screen.findByTestId("restore-notices");
    expect(box.textContent).toContain("開き直せなかったセッション：old-work（作業場所がありません）");
    expect(box.textContent).toContain("復元リストを読めませんでした");
    fireEvent.click(screen.getByRole("button", { name: "案内を閉じる" }));
    await waitFor(() => expect(screen.queryByTestId("restore-notices")).toBeNull());
  });

  it("shows nothing when everything was reopened", async () => {
    render(<ConsolePage />);
    await screen.findAllByTestId("session-row");
    expect(screen.queryByTestId("restore-notices")).toBeNull();
  });
});

describe("ConsolePage terminal notices (K15 screen side)", () => {
  it("shows the tmux-missing notice and the cannot-attach notice, and hides them after dismissing", async () => {
    fetchState.mockResolvedValue({ ...state, terminalNotices: [{ reason: "tmuxMissing" }, { reason: "cannotAttach", name: "work-1" }] });
    render(<ConsolePage />);
    const box = await screen.findByTestId("terminal-notices");
    expect(box.textContent).toContain("tmux が見つからないため、今までどおりの方式で動いています");
    expect(box.textContent).toContain("端末につなげません：work-1");
    fireEvent.click(within(box).getByRole("button", { name: "案内を閉じる" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-notices")).toBeNull());
  });

  it("shows nothing when the field is absent", async () => {
    render(<ConsolePage />);
    await screen.findAllByTestId("session-row");
    expect(screen.queryByTestId("terminal-notices")).toBeNull();
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
    expect((await screen.findByTestId("app-version")).textContent).toContain("0.3.6");
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
  const live = { ...state.sessions[0], state: "idle" as const, unread: 2, hasClaude: true, canInput: true, canChat: true };

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
    await openTerminalTab();
    const button = await screen.findByRole("button", { name: "テスト実行" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(checkQuickPromptSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("dead"));
    await waitFor(() => expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "テスト実行" }));
    await waitFor(() => expect(checkQuickPromptSend).toHaveBeenCalledWith("s1", "p1"));
    await waitFor(() => expect(pasteOnly).toHaveBeenCalledWith("run tests"));
  });

  it("discards the text and says so when the selection changed while the server was checking", async () => {
    let release: (v: { text: string }) => void = () => {};
    checkQuickPromptSend.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const other = { ...live, id: "s2", name: "other", unread: 0 };
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...live, unread: 0 }, other] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await openTerminalTab();
    await waitFor(() => expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "テスト実行" }));
    await waitFor(() => expect(checkQuickPromptSend).toHaveBeenCalledWith("s1", "p1"));
    fireEvent.click(screen.getByText("other"));
    release({ text: "run tests" });
    expect((await screen.findByRole("alert")).textContent).toContain("切り替わった");
    expect(pasteOnly).not.toHaveBeenCalled();
  });

  it("does not paste and shows the server's reason when the state check is refused (409)", async () => {
    checkQuickPromptSend.mockRejectedValue(new Error("claude is busy"));
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...live, unread: 0 }] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await openTerminalTab();
    await waitFor(() => expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "テスト実行" }));
    expect((await screen.findByRole("alert")).textContent).toContain("claude is busy");
    expect(pasteOnly).not.toHaveBeenCalled();
  });

  it("clears the send warning when another session is selected", async () => {
    checkQuickPromptSend.mockRejectedValue(new Error("claude is busy"));
    const other = { ...live, id: "s2", name: "other", unread: 0 };
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...live, unread: 0 }, other] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await openTerminalTab();
    await waitFor(() => expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "テスト実行" }));
    expect((await screen.findByRole("alert")).textContent).toContain("claude is busy");
    fireEvent.click(screen.getByText("other"));
    await waitFor(() => expect(screen.queryByText("claude is busy")).toBeNull());
  });

  it("disables the quick prompt buttons and shows the reason while Claude waits for an answer", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...live, unread: 0, canInput: false, canChat: false, state: "waiting" as const }] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await openTerminalTab();
    expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/許可・質問への返事を待っている/)).toBeTruthy();
  });

  it("enables the quick prompt buttons while Claude is busy (canChat true, canInput false)", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...live, unread: 0, canInput: false, canChat: true, state: "working" as const }] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await openTerminalTab();
    await waitFor(() => expect((screen.getByRole("button", { name: "テスト実行" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("explains that a break is the app's own definition", async () => {
    render(<ConsolePage />);
    expect((await screen.findByTestId("notify-help")).textContent).toContain("Claude 公式");
  });
});

describe("ConsolePage center tabs (v0.10.0 K1)", () => {
  it("puts ac-center-tabs on the center tablist only (all 8 tabs share it), not on the right pane", async () => {
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    const tab = await screen.findByRole("tab", { name: /変更/ });
    const list = tab.closest('[role="tablist"]') as HTMLElement;
    expect(list.className).toContain("ac-center-tabs");
    expect(list.className).toContain("comp-tabs");
    const labels = within(list).getAllByRole("tab").map((n) => n.textContent);
    expect(labels).toHaveLength(8);
    const others = screen.getAllByRole("tablist").filter((n) => n !== list);
    for (const other of others) expect(other.className).not.toContain("ac-center-tabs");
  });

  it("reads the tab height from the token only: ConsolePage.css has no px/rem literal for it", () => {
    const css = readFileSync("src/pages/ConsolePage.css", "utf8");
    const rule = /\.ac-center-tabs\.comp-tabs\s+\.comp-tabs__tab\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain("height: var(--ac-tab-h)");
    expect(rule?.[1]).toContain("font-size: var(--font-2xl)");
    expect(rule?.[1]).not.toMatch(/\d(px|rem)/);
  });
});

describe("ConsolePage チャット tab (v0.11.0 K1, K6, K7)", () => {
  it("K1 中央のタブの先頭に「チャット」が加わり、最初に開くタブになる。ほかのタブは今の順のまま", async () => {
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    const tab = await screen.findByRole("tab", { name: /変更/ });
    const list = tab.closest('[role="tablist"]') as HTMLElement;
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((n) => (n.textContent ?? "").replace(/\d+$/, ""))).toEqual(["チャット", "端末", "変更", "ファイル", "PR", "部品", "定期実行", "予約"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("chat-pane").hasAttribute("hidden")).toBe(false);
    expect(screen.getByTestId("terminal-stub").parentElement?.hasAttribute("hidden")).toBe(true);
  });

  it("端末タブを押すとチャットが隠れ（外さない）、端末が見える。チャットに戻れる", async () => {
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    const chat = screen.getByTestId("chat-pane");
    await openTerminalTab();
    expect(screen.getByTestId("chat-pane")).toBe(chat);
    expect(chat.hasAttribute("hidden")).toBe(true);
    expect(screen.getByTestId("terminal-stub").parentElement?.hasAttribute("hidden")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: /チャット/ }));
    expect(chat.hasAttribute("hidden")).toBe(false);
  });

  it("K7 チャットのよく使う指示は、押すと本文が入力欄に入り、送らない（端末へも貼らない）", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...state.sessions[0], state: "idle", hasClaude: true, canInput: true }] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    const bar = await screen.findByTestId("quick-prompt-bar");
    fireEvent.click(within(bar).getByRole("button", { name: "テスト実行" }));
    expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).value).toBe("run tests");
    expect(checkQuickPromptSend).not.toHaveBeenCalled();
    expect(pasteOnly).not.toHaveBeenCalled();
  });

  it("K6 確認の待ち（waiting）のとき、「端末を開く」で端末タブへ移る", async () => {
    fetchState.mockResolvedValue({ ...state, sessions: [{ ...state.sessions[0], state: "waiting", hasClaude: true, canInput: false }] });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    fireEvent.click(await screen.findByRole("button", { name: "端末を開く" }));
    expect(screen.getByTestId("chat-pane").hasAttribute("hidden")).toBe(true);
    expect(screen.getByTestId("terminal-stub").parentElement?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("tab", { name: /端末/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("端末のタブにいる間（チャットが隠れている間）は、端末の上のよく使う指示のバーだけが見える（バーは 2 本並ばない）", async () => {
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await openTerminalTab();
    // 見えているバー（hidden の中は数えない）は 1 本
    expect(screen.getAllByRole("toolbar")).toHaveLength(1);
  });
});

describe("ConsolePage terminal / changes tabs (K1, K12)", () => {
  it("shows the 端末 and 変更 tabs with the changed-file count, and hides (not removes) the terminal when 変更 is chosen", async () => {
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    const changes = await screen.findByRole("tab", { name: /変更/ });
    expect(screen.getByRole("tab", { name: /端末/ })).toBeTruthy();
    await waitFor(() => expect(changes.textContent).toContain("1"));
    const terminal = screen.getByTestId("terminal-stub");
    const wrapper = terminal.parentElement as HTMLElement;
    // 最初に開くのはチャット。端末は隠れた状態で開いている（外さない）
    expect(wrapper.hasAttribute("hidden")).toBe(true);
    await openTerminalTab();
    expect(wrapper.hasAttribute("hidden")).toBe(false);
    fireEvent.click(changes);
    // 端末の部品は DOM に残り（xterm の接続を保つ）、包みが hidden 属性で隠れる
    expect(screen.getByTestId("terminal-stub").parentElement).toBe(wrapper);
    expect(wrapper.hasAttribute("hidden")).toBe(true);
    expect(screen.getByTestId("diff-pane").hasAttribute("hidden")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: /端末/ }));
    expect(wrapper.hasAttribute("hidden")).toBe(false);
    expect(screen.getByTestId("diff-pane").hasAttribute("hidden")).toBe(true);
  });

  it("hides the terminal only with the hidden attribute: the stylesheet pins [hidden] to display:none and never uses visibility or zero height", () => {
    const css = readFileSync("src/pages/ConsolePage.css", "utf8");
    expect(css).toMatch(/\.ac-page__terminal\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
    expect(css).not.toMatch(/visibility\s*:/);
  });

  it("drops the count from the 変更 tab when the selected session disappears", async () => {
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /変更/ }).textContent).toContain("1"));
    const onmessage = lastSocket?.onmessage as (e: { data: string }) => void;
    act(() => onmessage({ data: JSON.stringify({ sessions: [], agentsAvailable: true }) }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /変更/ }).textContent).toBe("変更"));
  });
});

describe("ConsolePage 部品 tab (K3, §3-8)", () => {
  it("shows 部品 with the unsent count from the state and hides the other panes (not removing the terminal) when chosen", async () => {
    fetchPicks.mockResolvedValue({ items: [], extensionDir: "/data/chrome-extension" });
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    const picks = await screen.findByRole("tab", { name: /部品/ });
    expect(picks.textContent).toContain("3");
    const wrapper = screen.getByTestId("terminal-stub").parentElement as HTMLElement;
    expect(screen.getByTestId("picks-pane").hasAttribute("hidden")).toBe(true);
    expect(fetchPicks).not.toHaveBeenCalled();
    fireEvent.click(picks);
    expect(screen.getByTestId("picks-pane").hasAttribute("hidden")).toBe(false);
    expect(screen.getByTestId("terminal-stub").parentElement).toBe(wrapper);
    expect(wrapper.hasAttribute("hidden")).toBe(true);
    expect(screen.getByTestId("diff-pane").hasAttribute("hidden")).toBe(true);
    expect(await screen.findByText("/data/chrome-extension")).toBeTruthy();
  });

  it("drops the count when nothing is unsent, and follows the count the server pushes", async () => {
    render(<ConsolePage />);
    await screen.findByText("dead");
    const onmessage = lastSocket?.onmessage as (e: { data: string }) => void;
    act(() => onmessage({ data: JSON.stringify({ sessions: state.sessions, agentsAvailable: true, picksUnsent: 0 }) }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /部品/ }).textContent).toBe("部品"));
    act(() => onmessage({ data: JSON.stringify({ sessions: state.sessions, agentsAvailable: true, picksUnsent: 7 }) }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /部品/ }).textContent).toContain("7"));
  });

  it("hands the terminal the scroll time and the image limit from the state, and shows an upload notice from the terminal", async () => {
    render(<ConsolePage />);
    fireEvent.click(await screen.findByText("dead"));
    const stub = await screen.findByTestId("terminal-stub");
    expect(stub.getAttribute("data-smooth")).toBe("125");
    expect(stub.getAttribute("data-max")).toBe(String(5 * 1024 * 1024));
    fireEvent.click(within(stub).getByText("stub-notice"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ファイルを貼れませんでした");
    expect(alert.textContent).toContain("ファイルが大きすぎます（1つ 5 MB まで）");
  });
});
