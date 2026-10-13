// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type { ActivityResponse, Board, BoardResponse } from "../../types";
import { agentLabel, formatDuration } from "./agentLabel";

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const fetchActivity = vi.fn();
const fetchBoard = vi.fn();
vi.mock("../../api", () => ({ ApiError: FakeApiError, fetchActivity: (id: string) => fetchActivity(id), fetchBoard: (id: string) => fetchBoard(id) }));

const { ActivityPane } = await import("./ActivityPane");

const NOW = Date.UTC(2026, 9, 12, 14, 0, 0);
const MIN = 60_000;
const models = i18n.t("ac.activity.models", { returnObjects: true }) as Record<string, string>;

const agent = (over: Partial<Extract<ActivityResponse, { status: "ok" }>["running"][number]> = {}) => ({
  key: "k1",
  subagentType: "general-purpose",
  model: "sonnet",
  resolvedModel: "claude-sonnet-5-5",
  description: "ログ画面の調べもの",
  startedAt: NOW - 3 * MIN,
  ...over,
});
const OK: ActivityResponse = {
  status: "ok",
  now: NOW,
  running: [agent()],
  tasks: [{ id: "1", subject: "調べる", done: true }],
  inputs: [
    { ts: NOW - MIN, text: "続けてください" },
    { ts: NOW - 5 * MIN, text: "最初の依頼" },
  ],
  lastEventAt: NOW - MIN,
  hooks: { ok: true },
};
const BOARD_BODY: Board = {
  version: 1,
  theme: "右の欄を作戦ボードにする",
  kgi: [{ text: "PO が画面で担当と計画を見分けられる" }, { text: "更新が 5 秒以内に出る" }],
  kpis: [
    { name: "試験の数", target: "100", current: "40", unit: "件" },
    { name: "画面の幅", target: "320", current: "", unit: "px" },
  ],
  roadmap: [
    { title: "設計", status: "done" },
    { title: "実装", status: "doing" },
    { title: "導入", status: "todo" },
  ],
  tasks: [
    { title: "試験を書く", status: "done" },
    { title: "実装する", status: "doing" },
    { title: "導入する", status: "todo" },
    { title: "確認する", status: "todo" },
    { title: "整理する", status: "doing" },
  ],
  updatedAt: NOW - 3 * MIN,
};
const BOARD: BoardResponse = { status: "ok", board: BOARD_BODY };
const boardWith = (over: Partial<Board>): BoardResponse => ({ status: "ok", board: { ...BOARD_BODY, ...over } });

beforeEach(() => {
  fetchActivity.mockReset();
  fetchBoard.mockReset();
  fetchActivity.mockResolvedValue(OK);
  fetchBoard.mockResolvedValue(BOARD);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const sectionIds = (): (string | null)[] => screen.getAllByTestId(/^(activity|board)-(running|kgi|kpi|roadmap|tasks|none|invalid|inputs)$/).map((el) => el.getAttribute("data-testid"));

describe("K3: 担当の呼び名", () => {
  it("model を小文字にして、表のキーを部分一致で探す。見つかれば表の名前", () => {
    expect(agentLabel({ subagentType: "general-purpose", model: "sonnet", resolvedModel: "" }, models)).toBe("Sonnet（調査・実装）");
    expect(agentLabel({ subagentType: "general-purpose", model: "FABLE", resolvedModel: "" }, models)).toBe("Fable（審査）");
    expect(agentLabel({ subagentType: "x", model: "claude-opus-4-1", resolvedModel: "" }, models)).toBe("Opus（設計・判断）");
    expect(agentLabel({ subagentType: "x", model: "haiku", resolvedModel: "" }, models)).toBe("Haiku（軽い作業）");
  });

  it("model が空か表に無いときは resolvedModel を見る。どちらも見つからなければ subagent_type をそのまま出す", () => {
    expect(agentLabel({ subagentType: "general-purpose", model: "", resolvedModel: "claude-sonnet-5-5" }, models)).toBe("Sonnet（調査・実装）");
    expect(agentLabel({ subagentType: "general-purpose", model: "inherit", resolvedModel: "claude-opus-5" }, models)).toBe("Opus（設計・判断）");
    expect(agentLabel({ subagentType: "reviewer", model: "inherit", resolvedModel: "" }, models)).toBe("reviewer");
    expect(agentLabel({ subagentType: "", model: "", resolvedModel: "" }, models)).toBe("");
  });

  it("表の名前は、技術の用語（worktree・ブランチ・台帳）を含まない", () => {
    for (const name of Object.values(models)) expect(name).not.toMatch(/worktree|ブランチ|台帳/i);
    expect(Object.keys(models).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
  });
});

describe("時間の表示", () => {
  it("秒・分・時間・日に直す（1 分未満は秒）", () => {
    expect(formatDuration(45_000)).toEqual({ unit: "second", count: 45 });
    expect(formatDuration(3 * MIN + 10_000)).toEqual({ unit: "minute", count: 3 });
    expect(formatDuration(2 * 60 * MIN + MIN)).toEqual({ unit: "hour", count: 2 });
    expect(formatDuration(49 * 60 * MIN)).toEqual({ unit: "day", count: 2 });
    expect(formatDuration(-5)).toEqual({ unit: "second", count: 0 });
  });
});

describe("K1: 作戦ボードの区切りと順番", () => {
  it("上から 動いている担当・KGI・KPI・ロードマップ・タスク・最近の入力 の 6 つ。「今の状態」は出さない。終わった担当とやることは出さない", async () => {
    render(<ActivityPane sessionId="s1" rev={0} />);
    await screen.findByTestId("board-roadmap");
    expect(sectionIds()).toEqual(["activity-running", "board-kgi", "board-kpi", "board-roadmap", "board-tasks", "activity-inputs"]);
    expect(screen.queryByTestId("activity-state")).toBeNull();
    expect(screen.getByTestId("activity-pane").textContent).not.toContain("今の状態");
    expect(screen.queryByTestId("activity-finished")).toBeNull();
    expect(screen.queryByTestId("activity-tasks")).toBeNull();
    expect(screen.queryByTestId("activity-task")).toBeNull();
    const text = screen.getByTestId("activity-pane").textContent ?? "";
    expect(text).not.toContain("終わった担当");
    expect(text).not.toContain("やること");
    expect(text).not.toContain("調べる");
  });
});

describe("K2: 動いている担当", () => {
  it("呼び名・仕事の説明・動き始めてからの時間を出す", async () => {
    render(<ActivityPane sessionId="s1" rev={0} />);
    const running = await screen.findByTestId("activity-running");
    const item = within(running).getByTestId("activity-agent");
    expect(item.textContent).toContain("Sonnet（調査・実装）");
    expect(item.textContent).toContain("ログ画面の調べもの");
    expect(item.textContent).toContain("動き始めて3分");
  });

  it("担当がいないときは、いないと書く", async () => {
    fetchActivity.mockResolvedValue({ ...OK, running: [] });
    render(<ActivityPane sessionId="s1" rev={0} />);
    await screen.findByTestId("activity-running");
    expect(screen.getByTestId("activity-running").textContent).toContain("動いている担当はいません");
  });
});

describe("K3 / K4 / K5 / K6 / K8: タスク", () => {
  const groupRows = (g: string): string[] => within(screen.getByTestId(`board-tasks-group-${g}`)).getAllByTestId("board-task-item").map((r) => r.textContent ?? "");

  it("K3 3 つの組（進行中・これから・完了）を、この順で出す。各組の見出しに件数。組の中は書き込まれた順", async () => {
    render(<ActivityPane sessionId="s1" rev={0} />);
    const tasks = await screen.findByTestId("board-tasks");
    const groups = within(tasks).getAllByTestId(/^board-tasks-group-(doing|todo|done)$/).map((el) => el.getAttribute("data-testid"));
    expect(groups).toEqual(["board-tasks-group-doing", "board-tasks-group-todo", "board-tasks-group-done"]);
    expect(groupRows("doing")).toEqual(["実装する", "整理する"]);
    expect(groupRows("todo")).toEqual(["導入する", "確認する"]);
    expect(groupRows("done")).toEqual(["試験を書く"]);
    expect(screen.getByTestId("board-tasks-group-doing").textContent).toContain("進行中");
    expect(screen.getByTestId("board-tasks-group-doing").textContent).toContain("2");
    expect(screen.getByTestId("board-tasks-group-todo").textContent).toContain("これから");
    expect(screen.getByTestId("board-tasks-group-done").textContent).toContain("完了");
  });

  it("K3 0 件の組は出さない", async () => {
    fetchBoard.mockResolvedValue(boardWith({ tasks: [{ title: "a", status: "todo" }] }));
    render(<ActivityPane sessionId="s1" rev={0} />);
    await screen.findByTestId("board-tasks");
    expect(screen.queryByTestId("board-tasks-group-doing")).toBeNull();
    expect(screen.queryByTestId("board-tasks-group-done")).toBeNull();
    expect(screen.getByTestId("board-tasks-group-todo")).toBeTruthy();
  });

  it("K4 ProgressBar（label なし）と「完了 N / M」。M はタスクの全件", async () => {
    render(<ActivityPane sessionId="s1" rev={0} />);
    const bar = await screen.findByTestId("board-tasks-progress");
    expect(within(bar).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("20");
    expect(screen.getByTestId("board-tasks-progress-text").textContent).toBe("完了 1 / 5");
    expect(screen.getByTestId("board-tasks").textContent).not.toContain("Done");
  });

  it("K5 完了の組は <details> で、最初は閉じている。押すと開く", async () => {
    render(<ActivityPane sessionId="s1" rev={0} />);
    const done = await screen.findByTestId("board-tasks-group-done");
    expect(done.tagName).toBe("DETAILS");
    expect((done as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId("board-tasks-group-doing").tagName).not.toBe("DETAILS");
    (done as HTMLDetailsElement).open = true;
    expect((done as HTMLDetailsElement).open).toBe(true);
  });

  it("K6 タスクが 0 件なら「タスクはまだ書き込まれていません」。棒は出さない", async () => {
    fetchBoard.mockResolvedValue(boardWith({ tasks: [] }));
    render(<ActivityPane sessionId="s1" rev={0} />);
    const empty = await screen.findByTestId("board-tasks-empty");
    expect(empty.textContent).toBe("タスクはまだ書き込まれていません");
    expect(within(screen.getByTestId("board-tasks")).queryByRole("progressbar")).toBeNull();
  });

  it("K6 ボードが none のときは、タスクの欄も「0 件」の文も出さない", async () => {
    fetchBoard.mockResolvedValue({ status: "none" });
    render(<ActivityPane sessionId="s1" rev={0} />);
    await screen.findByTestId("board-none");
    expect(screen.queryByTestId("board-tasks")).toBeNull();
    expect(screen.queryByTestId("board-tasks-empty")).toBeNull();
  });

  it("K8 古い形のボード（tasks なし）が来ても落ちず、0 件の文を出す", async () => {
    const { tasks: _t, ...legacy } = BOARD_BODY;
    fetchBoard.mockResolvedValue({ status: "ok", board: legacy });
    render(<ActivityPane sessionId="s1" rev={0} />);
    expect((await screen.findByTestId("board-tasks-empty")).textContent).toContain("タスクはまだ");
  });
});

describe("K3 / K6 / K7: 計画（KGI・KPI・ロードマップ）の表示", () => {
  it("テーマと KGI を箇条書きで出す。最後に更新した時刻（3分前）を出す", async () => {
    render(<ActivityPane sessionId="s1" rev={0} />);
    const kgi = await screen.findByTestId("board-kgi");
    expect(within(kgi).getByTestId("board-theme").textContent).toContain("右の欄を作戦ボードにする");
    expect(within(kgi).getAllByTestId("board-kgi-item").map((li) => li.textContent)).toEqual(["PO が画面で担当と計画を見分けられる", "更新が 5 秒以内に出る"]);
    expect(within(kgi).getByTestId("board-updated").textContent).toContain("3分前");
  });

  it("K6 KPI は名前・今の値・目標・単位を、1 件 1 組で出す（工程0 (d): 右の欄の幅で 4 列の表は読めないため、「名前 ／ 今の値 → 目標 単位」の一覧にした）", async () => {
    render(<ActivityPane sessionId="s1" rev={0} />);
    const kpi = await screen.findByTestId("board-kpi");
    const rows = within(kpi).getAllByTestId("board-kpi-item");
    expect(rows.map((r) => [within(r).getByTestId("board-kpi-name").textContent, within(r).getByTestId("board-kpi-value").textContent])).toEqual([
      ["試験の数", "40 → 100 件"],
      ["画面の幅", "— → 320 px"],
    ]);
    expect(within(kpi).queryByRole("table")).toBeNull();
  });

  it("K6 KPI の単位が空なら、単位の分の空白は付けない。今の値も目標も空なら「—」", async () => {
    fetchBoard.mockResolvedValue(boardWith({ kpis: [{ name: "n", target: "", current: "", unit: "" }, { name: "m", target: "3", current: "1", unit: "" }] }));
    render(<ActivityPane sessionId="s1" rev={0} />);
    const kpi = await screen.findByTestId("board-kpi");
    expect(within(kpi).getAllByTestId("board-kpi-value").map((v) => v.textContent)).toEqual(["— → —", "1 → 3"]);
  });

  it("K6 進み具合は「完了の数 / ロードマップの数」。ProgressBar（label なし）と「完了 1 / 3」の文。各行に状態の Badge", async () => {
    render(<ActivityPane sessionId="s1" rev={0} />);
    const road = await screen.findByTestId("board-roadmap");
    const bar = within(road).getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("33");
    expect(within(road).getByTestId("board-progress-text").textContent).toBe("完了 1 / 3");
    // label を渡さないので、棒の上に % や Done の文字は出ない
    expect(road.textContent).not.toContain("%");
    expect(road.textContent).not.toContain("Done");
    const rows = within(road).getAllByTestId("board-roadmap-item");
    expect(rows.map((r) => [r.getAttribute("data-status"), r.textContent])).toEqual([
      ["done", "完了設計"],
      ["doing", "進行中実装"],
      ["todo", "未着手導入"],
    ]);
  });

  it("K6 全部が完了なら 100%。棒は成功の色になるが、Done の文字は出さない（i18n できないため label を渡さない）", async () => {
    fetchBoard.mockResolvedValue(boardWith({ roadmap: [{ title: "a", status: "done" }, { title: "b", status: "done" }] }));
    render(<ActivityPane sessionId="s1" rev={0} />);
    const road = await screen.findByTestId("board-roadmap");
    expect(within(road).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(within(road).getByTestId("board-progress-text").textContent).toBe("完了 2 / 2");
    expect(road.textContent).not.toContain("Done");
  });

  it("ロードマップが空なら、棒は出さずに空であることを書く。KGI・KPI が空でも同じ", async () => {
    fetchBoard.mockResolvedValue({ status: "ok", board: { version: 1, theme: "t", kgi: [], kpis: [], roadmap: [], tasks: [], updatedAt: NOW } });
    render(<ActivityPane sessionId="s1" rev={0} />);
    const road = await screen.findByTestId("board-roadmap");
    expect(within(road).queryByRole("progressbar")).toBeNull();
    expect(road.textContent).toContain("ロードマップはまだありません");
    expect(screen.getByTestId("board-kgi").textContent).toContain("KGI はまだありません");
    expect(screen.getByTestId("board-kpi").textContent).toContain("KPI はまだありません");
    expect(within(screen.getByTestId("board-kgi")).getByTestId("board-updated").textContent).toContain("たった今");
  });

  it("K7 ボードがまだ無いセッション（役割が違う・/clear のあと）には「まだ計画が書き込まれていません」を出す。KGI・KPI・ロードマップの区切りは出さない", async () => {
    fetchBoard.mockResolvedValue({ status: "none" });
    render(<ActivityPane sessionId="s1" rev={0} />);
    const none = await screen.findByTestId("board-none");
    expect(none.textContent).toContain("まだ計画が書き込まれていません");
    expect(sectionIds()).toEqual(["activity-running", "board-none", "activity-inputs"]);
  });

  it("ボードのファイルが壊れているときは、直し方の案内を出す", async () => {
    fetchBoard.mockResolvedValue({ status: "invalid" });
    render(<ActivityPane sessionId="s1" rev={0} />);
    const invalid = await screen.findByTestId("board-invalid");
    expect(invalid.textContent).toContain("計画のファイルを読めません");
    expect(invalid.textContent).toContain("ac-board");
  });

  it("ボードの取得に失敗しても、動いている担当などは出す。ボードの場所に案内を出す", async () => {
    fetchBoard.mockRejectedValue(new FakeApiError("boom", 500));
    render(<ActivityPane sessionId="s1" rev={0} />);
    expect((await screen.findByTestId("board-error")).textContent).toContain("計画を取得できません");
    expect(screen.getByTestId("activity-running").textContent).toContain("ログ画面の調べもの");
  });

  it("K3 ボードは 5 秒ごとに取り直す。書き込まれた内容が次の取り直しで出る", async () => {
    fetchBoard.mockResolvedValue({ status: "none" });
    render(<ActivityPane sessionId="s1" rev={0} />);
    await screen.findByTestId("board-none");
    expect(fetchBoard).toHaveBeenCalledTimes(1);
    fetchBoard.mockResolvedValue(BOARD);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect((await screen.findByTestId("board-kgi")).textContent).toContain("右の欄を作戦ボードにする");
    expect(fetchBoard).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("board-none")).toBeNull();
  });
});

describe("最近の入力（残す機能）", () => {
  it("新しい順。「しんごさんの指示」とは書かない（人の入力を見分けられないため）", async () => {
    render(<ActivityPane sessionId="s1" rev={0} />);
    const inputs = within(await screen.findByTestId("activity-inputs"));
    expect(inputs.getAllByTestId("activity-input").map((i) => i.textContent)).toEqual(["続けてください1分前", "最初の依頼5分前"]);
    expect(screen.getByTestId("activity-inputs").textContent).not.toContain("しんごさんの指示");
    expect(screen.getByTestId("activity-inputs").textContent).toContain("最近の入力");
  });

  it("空のときは、空であることを書く", async () => {
    fetchActivity.mockResolvedValue({ ...OK, inputs: [] });
    render(<ActivityPane sessionId="s1" rev={0} />);
    await screen.findByTestId("activity-inputs");
    expect(screen.getByTestId("activity-inputs").textContent).toContain("入力はまだありません");
  });
});

describe("K2/K8: 取得の状態", () => {
  it("noSession: 会話がまだ始まっていない案内を出す", async () => {
    fetchActivity.mockResolvedValue({ status: "noSession" });
    render(<ActivityPane sessionId="s1" rev={0} />);
    expect((await screen.findByTestId("activity-no-session")).textContent).toContain("まだ会話が始まっていません");
  });

  it("K8: 記録の仕組みが外れているときは、その旨と直し方（README の手順）を出す。ok のときは出さない", async () => {
    fetchActivity.mockResolvedValue({ ...OK, hooks: { ok: false, reason: "missingHandler", missingEvents: ["SubagentStart"] } });
    const { unmount } = render(<ActivityPane sessionId="s1" rev={0} />);
    const warn = await screen.findByTestId("activity-hooks-warning");
    expect(warn.textContent).toContain("記録の仕組みが外れています");
    expect(warn.textContent).toContain("README");
    expect(warn.textContent).toContain("scripts/ac-hooks.mjs install");
    // 記録するイベントが増えたとき（v0.11.0 の Stop、v0.12.0 の SubagentStart）は、更新のあとに install をもう一度
    expect(warn.textContent).toContain("install をもう一度");
    unmount();
    fetchActivity.mockResolvedValue(OK);
    render(<ActivityPane sessionId="s1" rev={0} />);
    await screen.findByTestId("activity-running");
    expect(screen.queryByTestId("activity-hooks-warning")).toBeNull();
  });

  it("取得に失敗したら案内を出す", async () => {
    fetchActivity.mockRejectedValue(new FakeApiError("boom", 500));
    render(<ActivityPane sessionId="s1" rev={0} />);
    expect((await screen.findByTestId("activity-error")).textContent).toContain("取得できません");
  });

  it("rev が変わったら取り直す。別のセッションに替わったら、前のセッションの内容（ボードも）は出さない", async () => {
    const { rerender } = render(<ActivityPane sessionId="s1" rev={0} />);
    await screen.findByTestId("board-kgi");
    expect(fetchActivity).toHaveBeenCalledTimes(1);
    expect(fetchBoard).toHaveBeenCalledTimes(1);
    rerender(<ActivityPane sessionId="s1" rev={1} />);
    await waitFor(() => expect(fetchActivity).toHaveBeenCalledTimes(2));

    let release: (v: ActivityResponse) => void = () => undefined;
    let releaseBoard: (v: BoardResponse) => void = () => undefined;
    fetchActivity.mockReturnValueOnce(new Promise<ActivityResponse>((r) => (release = r)));
    fetchBoard.mockReturnValueOnce(new Promise<BoardResponse>((r) => (releaseBoard = r)));
    rerender(<ActivityPane sessionId="s2" rev={1} />);
    await waitFor(() => expect(fetchActivity).toHaveBeenLastCalledWith("s2"));
    expect(fetchBoard).toHaveBeenLastCalledWith("s2");
    expect(screen.queryByTestId("activity-running")).toBeNull();
    expect(screen.queryByTestId("board-kgi")).toBeNull();
    release({ ...OK, running: [agent({ description: "s2の仕事" })] });
    releaseBoard({ status: "none" });
    expect((await screen.findByTestId("activity-running")).textContent).toContain("s2の仕事");
    expect((await screen.findByTestId("board-none")).textContent).toContain("まだ計画が書き込まれていません");
  });

  it("古い応答が後から返っても、今のセッションの表示を上書きしない", async () => {
    let releaseOld: (v: ActivityResponse) => void = () => undefined;
    let releaseOldBoard: (v: BoardResponse) => void = () => undefined;
    fetchActivity.mockReturnValueOnce(new Promise<ActivityResponse>((r) => (releaseOld = r)));
    fetchBoard.mockReturnValueOnce(new Promise<BoardResponse>((r) => (releaseOldBoard = r)));
    const { rerender } = render(<ActivityPane sessionId="s1" rev={0} />);
    fetchActivity.mockResolvedValueOnce({ ...OK, running: [agent({ description: "新しいセッションの仕事" })] });
    fetchBoard.mockResolvedValueOnce({ status: "ok", board: { version: 1, theme: "新しいテーマ", kgi: [], kpis: [], roadmap: [], tasks: [], updatedAt: NOW } });
    rerender(<ActivityPane sessionId="s2" rev={0} />);
    await screen.findByText("新しいセッションの仕事", { exact: false });
    await screen.findByText("新しいテーマ", { exact: false });
    releaseOld({ ...OK, running: [agent({ description: "古いセッションの仕事" })] });
    releaseOldBoard({ status: "ok", board: { version: 1, theme: "古いテーマ", kgi: [], kpis: [], roadmap: [], tasks: [], updatedAt: NOW } });
    await Promise.resolve();
    expect(screen.queryByText("古いセッションの仕事", { exact: false })).toBeNull();
    expect(screen.queryByText("古いテーマ", { exact: false })).toBeNull();
  });
});
