// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type { ActivityResponse } from "../../types";
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
vi.mock("../../api", () => ({ ApiError: FakeApiError, fetchActivity: (id: string) => fetchActivity(id) }));

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
  endedAt: null,
  durationMs: null,
  summary: "",
  ...over,
});
const OK: ActivityResponse = {
  status: "ok",
  now: NOW,
  running: [agent()],
  finished: [agent({ key: "k2", model: "fable", resolvedModel: "", description: "設計の審査", startedAt: NOW - 20 * MIN, endedAt: NOW - 18 * MIN, durationMs: 2 * MIN, summary: "指摘は 2 件でした" })],
  tasks: [
    { id: "1", subject: "調べる", done: true },
    { id: "2", subject: "直す", done: false },
  ],
  inputs: [
    { ts: NOW - MIN, text: "続けてください" },
    { ts: NOW - 5 * MIN, text: "最初の依頼" },
  ],
  lastEventAt: NOW - MIN,
  hooks: { ok: true },
};

beforeEach(() => {
  fetchActivity.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

describe("K2: ActivityPane", () => {
  it("上から 5 つの区切り: 今の状態・動いている担当・終わった担当・やること・最近の入力", async () => {
    fetchActivity.mockResolvedValue(OK);
    render(<ActivityPane sessionId="s1" rev={0} state="working" />);
    await screen.findByTestId("activity-running");
    const order = screen.getAllByTestId(/^activity-(state|running|finished|tasks|inputs)$/).map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["activity-state", "activity-running", "activity-finished", "activity-tasks", "activity-inputs"]);
    expect(within(screen.getByTestId("activity-state")).getByText("作業中")).toBeTruthy();
  });

  it("動いている担当: 呼び名・仕事の説明・動き始めてからの時間", async () => {
    fetchActivity.mockResolvedValue(OK);
    render(<ActivityPane sessionId="s1" rev={0} state="working" />);
    const running = await screen.findByTestId("activity-running");
    const item = within(running).getByTestId("activity-agent");
    expect(item.textContent).toContain("Sonnet（調査・実装）");
    expect(item.textContent).toContain("ログ画面の調べもの");
    expect(item.textContent).toContain("動き始めて3分");
  });

  it("終わった担当: 呼び名・仕事の説明・結果のひとこと・かかった時間", async () => {
    fetchActivity.mockResolvedValue(OK);
    render(<ActivityPane sessionId="s1" rev={0} state="idle" />);
    const finished = await screen.findByTestId("activity-finished");
    const item = within(finished).getByTestId("activity-agent");
    expect(item.textContent).toContain("Fable（審査）");
    expect(item.textContent).toContain("設計の審査");
    expect(item.textContent).toContain("指摘は 2 件でした");
    expect(item.textContent).toContain("2分かかった");
  });

  it("やること: 作った順に並び、終わったものに印（data-done）が付く", async () => {
    fetchActivity.mockResolvedValue(OK);
    render(<ActivityPane sessionId="s1" rev={0} state="idle" />);
    const tasks = within(await screen.findByTestId("activity-tasks")).getAllByTestId("activity-task");
    expect(tasks.map((t) => [t.textContent, t.getAttribute("data-done")])).toEqual([
      ["調べる", "true"],
      ["直す", "false"],
    ]);
  });

  it("最近の入力: 新しい順。「しんごさんの指示」とは書かない（人の入力を見分けられないため）", async () => {
    fetchActivity.mockResolvedValue(OK);
    render(<ActivityPane sessionId="s1" rev={0} state="idle" />);
    const inputs = within(await screen.findByTestId("activity-inputs"));
    expect(inputs.getAllByTestId("activity-input").map((i) => i.textContent)).toEqual(["続けてください1分前", "最初の依頼5分前"]);
    expect(screen.getByTestId("activity-inputs").textContent).not.toContain("しんごさんの指示");
    expect(screen.getByTestId("activity-inputs").textContent).toContain("最近の入力");
  });

  it("空の区切りには、空であることを書く", async () => {
    fetchActivity.mockResolvedValue({ ...OK, running: [], finished: [], tasks: [], inputs: [] });
    render(<ActivityPane sessionId="s1" rev={0} state="idle" />);
    await screen.findByTestId("activity-running");
    expect(screen.getByTestId("activity-running").textContent).toContain("動いている担当はいません");
    expect(screen.getByTestId("activity-finished").textContent).toContain("終わった担当はまだありません");
    expect(screen.getByTestId("activity-tasks").textContent).toContain("やることはありません");
    expect(screen.getByTestId("activity-inputs").textContent).toContain("入力はまだありません");
  });

  it("noSession: 会話がまだ始まっていない案内を出す", async () => {
    fetchActivity.mockResolvedValue({ status: "noSession" });
    render(<ActivityPane sessionId="s1" rev={0} state="no-claude" />);
    expect((await screen.findByTestId("activity-no-session")).textContent).toContain("まだ会話が始まっていません");
  });

  it("K8: 記録の仕組みが外れているときは、その旨と直し方（README の手順）を出す。ok のときは出さない", async () => {
    fetchActivity.mockResolvedValue({ ...OK, hooks: { ok: false, reason: "missingHandler", missingEvents: ["TaskCreated"] } });
    const { unmount } = render(<ActivityPane sessionId="s1" rev={0} state="idle" />);
    const warn = await screen.findByTestId("activity-hooks-warning");
    expect(warn.textContent).toContain("記録の仕組みが外れています");
    expect(warn.textContent).toContain("README");
    expect(warn.textContent).toContain("scripts/ac-hooks.mjs install");
    // v0.11.0: 記録するイベントが増えた（Stop・StopFailure）ので、更新のあとは install をもう一度
    expect(warn.textContent).toContain("install をもう一度");
    unmount();
    fetchActivity.mockResolvedValue(OK);
    render(<ActivityPane sessionId="s1" rev={0} state="idle" />);
    await screen.findByTestId("activity-running");
    expect(screen.queryByTestId("activity-hooks-warning")).toBeNull();
  });

  it("取得に失敗したら案内を出す", async () => {
    fetchActivity.mockRejectedValue(new FakeApiError("boom", 500));
    render(<ActivityPane sessionId="s1" rev={0} state="idle" />);
    expect((await screen.findByTestId("activity-error")).textContent).toContain("取得できません");
  });

  it("rev が変わったら取り直す。別のセッションに替わったら、前のセッションの内容は出さない", async () => {
    fetchActivity.mockResolvedValue(OK);
    const { rerender } = render(<ActivityPane sessionId="s1" rev={0} state="idle" />);
    await screen.findByTestId("activity-running");
    expect(fetchActivity).toHaveBeenCalledTimes(1);
    rerender(<ActivityPane sessionId="s1" rev={1} state="idle" />);
    await waitFor(() => expect(fetchActivity).toHaveBeenCalledTimes(2));

    let release: (v: ActivityResponse) => void = () => undefined;
    fetchActivity.mockReturnValueOnce(new Promise<ActivityResponse>((r) => (release = r)));
    rerender(<ActivityPane sessionId="s2" rev={1} state="idle" />);
    await waitFor(() => expect(fetchActivity).toHaveBeenLastCalledWith("s2"));
    expect(screen.queryByTestId("activity-running")).toBeNull();
    release({ ...OK, running: [agent({ description: "s2の仕事" })] });
    expect((await screen.findByTestId("activity-running")).textContent).toContain("s2の仕事");
  });

  it("古い応答が後から返っても、今のセッションの表示を上書きしない", async () => {
    let releaseOld: (v: ActivityResponse) => void = () => undefined;
    fetchActivity.mockReturnValueOnce(new Promise<ActivityResponse>((r) => (releaseOld = r)));
    const { rerender } = render(<ActivityPane sessionId="s1" rev={0} state="idle" />);
    fetchActivity.mockResolvedValueOnce({ ...OK, running: [agent({ description: "新しいセッションの仕事" })] });
    rerender(<ActivityPane sessionId="s2" rev={0} state="idle" />);
    await screen.findByText("新しいセッションの仕事", { exact: false });
    releaseOld({ ...OK, running: [agent({ description: "古いセッションの仕事" })] });
    await Promise.resolve();
    expect(screen.queryByText("古いセッションの仕事", { exact: false })).toBeNull();
  });
});
