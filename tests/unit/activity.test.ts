import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityStore, RUNNING_MAX_AGE_MS } from "../../server/activity.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const T0 = Date.UTC(2026, 9, 12, 14, 0, 0);
const MIN = 60_000;

let dataDir: string;
let actDir: string;
let nowMs: number;
let store: ActivityStore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "ac-act-"));
  actDir = path.join(dataDir, "activity");
  mkdirSync(actDir, { recursive: true });
  nowMs = T0 + 30 * MIN;
  store = new ActivityStore(dataDir, { keepDays: 7, now: () => nowMs });
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const dayName = (ts: number): string => `events-${new Date(ts).toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`;
type Rec = Record<string, unknown>;
const rec = (over: Rec): Rec => ({ ts: T0, session_id: SID, ...over });
function write(records: Rec[], file = dayName(T0)): void {
  appendFileSync(path.join(actDir, file), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const pre = (id: string, over: Rec = {}): Rec => rec({ event: "PreToolUse", tool: "Agent", tool_use_id: id, description: `仕事 ${id}`, subagent_type: "general-purpose", model: "sonnet", ...over });
const post = (id: string, agentId: string, over: Rec = {}): Rec => rec({ event: "PostToolUse", tool: "Agent", tool_use_id: id, status: "async_launched", agentId, resolvedModel: "claude-sonnet-5-5", ...over });
const handback = (agentId: string, message: string, over: Rec = {}): Rec => rec({ event: "PreToolUse", tool: "SubagentHandback", agent_id: agentId, message, ...over });
const stop = (agentId: string, over: Rec = {}): Rec => rec({ event: "SubagentStop", agent_id: agentId, agent_type: "general-purpose", ...over });

describe("K2 / §3-4: 担当の結び方", () => {
  it("動いている担当 → 報告が戻ると終わった担当に移る。結果は SubagentHandback の message、かかった時間は SubagentStop の ts − PreToolUse の ts", async () => {
    write([pre("t1", { ts: T0 }), post("t1", "A", { ts: T0 + 1000 })]);
    await store.refresh();
    let v = store.view(SID);
    expect(v.running).toHaveLength(1);
    expect(v.finished).toHaveLength(0);
    expect(v.running[0]).toMatchObject({ description: "仕事 t1", subagentType: "general-purpose", model: "sonnet", resolvedModel: "claude-sonnet-5-5", startedAt: T0 });

    write([handback("A", "調査OK", { ts: T0 + 90_000 }), stop("A", { ts: T0 + 91_000, last_assistant_message: "別の文" })]);
    await store.refresh();
    v = store.view(SID);
    expect(v.running).toHaveLength(0);
    expect(v.finished).toHaveLength(1);
    expect(v.finished[0]).toMatchObject({ description: "仕事 t1", summary: "調査OK", durationMs: 91_000, endedAt: T0 + 91_000 });
  });

  it("handback が無いときだけ、SubagentStop の last_assistant_message を結果にする", async () => {
    write([pre("t1"), post("t1", "A"), stop("A", { ts: T0 + 5000, last_assistant_message: "停止時の文" })]);
    await store.refresh();
    expect(store.view(SID).finished[0].summary).toBe("停止時の文");
  });

  it("イベントの順番が入れ替わっても（Stop が Post より先）同じ結果になる", async () => {
    write([stop("A", { ts: T0 + 5000 }), handback("A", "先に来た報告", { ts: T0 + 4000 }), post("t1", "A", { ts: T0 + 1000 }), pre("t1", { ts: T0 })]);
    await store.refresh();
    const v = store.view(SID);
    expect(v.running).toHaveLength(0);
    expect(v.finished).toHaveLength(1);
    expect(v.finished[0]).toMatchObject({ description: "仕事 t1", summary: "先に来た報告", durationMs: 5000 });
  });

  it("並列に呼んだ 2 つの担当を、tool_use_id と agent_id で取り違えない", async () => {
    write([
      pre("t1", { description: "調べもの" }),
      pre("t2", { description: "審査", model: "fable" }),
      post("t2", "B"),
      post("t1", "A"),
      handback("B", "審査OK", { ts: T0 + 2000 }),
      stop("B", { ts: T0 + 3000 }),
    ]);
    await store.refresh();
    const v = store.view(SID);
    expect(v.running.map((a) => a.description)).toEqual(["調べもの"]);
    expect(v.finished.map((a) => [a.description, a.summary, a.model])).toEqual([["審査", "審査OK", "fable"]]);
  });

  it("run_in_background なし（status=completed）は SubagentStop が無くても終わり。時間は totalDurationMs", async () => {
    write([pre("t1"), post("t1", "A", { status: "completed", totalDurationMs: 4200, ts: T0 + 5000 })]);
    await store.refresh();
    const v = store.view(SID);
    expect(v.running).toHaveLength(0);
    expect(v.finished[0]).toMatchObject({ description: "仕事 t1", durationMs: 4200 });
  });

  it("孫の担当（agent_id 付きの PreToolUse(Agent)）は出さない。その Stop・報告も出さない", async () => {
    write([
      pre("t1"),
      post("t1", "A"),
      pre("g1", { agent_id: "A", description: "孫の仕事" }),
      post("g1", "G", { agent_id: "A" }),
      handback("G", "孫の報告", { agent_id: "G" }),
      stop("G", { ts: T0 + 100 }),
    ]);
    await store.refresh();
    const v = store.view(SID);
    expect(v.running.map((a) => a.description)).toEqual(["仕事 t1"]);
    expect(v.finished).toHaveLength(0);
  });

  it("結べない SubagentStop は出せる項目だけ出す。agent_type が空で報告も無いもの（内部の担当）は出さない", async () => {
    write([stop("X", { agent_type: "Explore", ts: T0 + 1000, last_assistant_message: "単独の結果" }), stop("INTERNAL", { agent_type: "", ts: T0 + 2000 })]);
    await store.refresh();
    const v = store.view(SID);
    expect(v.finished).toHaveLength(1);
    expect(v.finished[0]).toMatchObject({ subagentType: "Explore", summary: "単独の結果", description: "", durationMs: null });
  });

  it("開始から 24 時間を過ぎた「終わりが記録されない担当」は、動いている担当から外れる（L-a）", async () => {
    write([pre("old", { ts: T0 }), pre("fresh", { ts: T0 + 23 * 60 * MIN })]);
    nowMs = T0 + RUNNING_MAX_AGE_MS + MIN;
    await store.refresh();
    expect(store.view(SID).running.map((a) => a.description)).toEqual(["仕事 fresh"]);
    expect(store.view(SID).finished).toHaveLength(0);
  });

  it("終わった担当は新しい順に 10 件まで", async () => {
    const rows: Rec[] = [];
    for (let i = 0; i < 12; i++) rows.push(pre(`t${i}`, { ts: T0 + i * 1000 }), post(`t${i}`, `A${i}`), stop(`A${i}`, { ts: T0 + i * 1000 + 500 }));
    write(rows);
    await store.refresh();
    const v = store.view(SID);
    expect(v.finished).toHaveLength(10);
    expect(v.finished.map((a) => a.description)).toEqual(Array.from({ length: 10 }, (_, k) => `仕事 t${11 - k}`));
  });
});

describe("K2: やること・入力", () => {
  it("やること: 作った順。TaskCompleted で終わりの印。作成が見つからない完了も 1 件出す。50 件まで（新しい作成を残す）", async () => {
    write([
      rec({ event: "TaskCreated", task_id: "1", task_subject: "最初", ts: T0 }),
      rec({ event: "TaskCreated", task_id: "2", task_subject: "二つ目", ts: T0 + 1 }),
      rec({ event: "TaskCompleted", task_id: "1", task_subject: "最初", ts: T0 + 2 }),
      rec({ event: "TaskCompleted", task_id: "77", task_subject: "作成を見ていない", ts: T0 + 3 }),
    ]);
    await store.refresh();
    expect(store.view(SID).tasks).toEqual([
      { id: "1", subject: "最初", done: true },
      { id: "2", subject: "二つ目", done: false },
      { id: "77", subject: "作成を見ていない", done: true },
    ]);
    const many: Rec[] = [];
    for (let i = 0; i < 60; i++) many.push(rec({ event: "TaskCreated", task_id: `m${i}`, task_subject: `m${i}`, ts: T0 + 100 + i }));
    write(many);
    await store.refresh();
    const tasks = store.view(SID).tasks;
    expect(tasks).toHaveLength(50);
    expect(tasks[tasks.length - 1].id).toBe("m59");
    expect(tasks[0].id).toBe("m10");
  });

  it("最近の入力: 新しい順に 3 件。担当の報告の戻り（source=agent）は入れない", async () => {
    write([
      rec({ event: "UserPromptSubmit", prompt: "一つ目", ts: T0 }),
      rec({ event: "UserPromptSubmit", prompt: "二つ目", ts: T0 + 1 }),
      rec({ event: "UserPromptSubmit", prompt: '<agent-message from="A">', source: "agent", ts: T0 + 2 }),
      rec({ event: "UserPromptSubmit", prompt: "三つ目", ts: T0 + 3 }),
      rec({ event: "UserPromptSubmit", prompt: "四つ目", ts: T0 + 4 }),
    ]);
    await store.refresh();
    expect(store.view(SID).inputs.map((i) => i.text)).toEqual(["四つ目", "三つ目", "二つ目"]);
  });
});

const userRec = (prompt: string, ts: number, over: Rec = {}): Rec => rec({ event: "UserPromptSubmit", prompt, ts, ...over });
const stopRec = (text: string, ts: number, over: Rec = {}): Rec => rec({ event: "Stop", last_assistant_message: text, ts, ...over });
const wrapPaste = (body: string, id = "0995"): string => `\n\n<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">\n`;

describe("K9: 右の欄の「最近の入力」は、表示のときに先頭 80 字にする（同じ記録から作る）", () => {
  it("全文の入力でも、inputs は 80 字・連続する空白は 1 つ・改行は空白に直して出す", async () => {
    write([userRec(`最初の行\n\n次の行 ${"あ".repeat(200)}`, T0)]);
    await store.refresh();
    const [only] = store.view(SID).inputs;
    expect(only.text).toBe(`最初の行 次の行 ${"あ".repeat(80 - "最初の行 次の行 ".length)}`);
    expect(Array.from(only.text)).toHaveLength(80);
  });

  it("貼り付けの包みで届いた入力は、包みを外した本文の先頭 80 字を出す", async () => {
    write([userRec(wrapPaste("調べてください\n二行目"), T0)]);
    await store.refresh();
    expect(store.view(SID).inputs.map((i) => i.text)).toEqual(["調べてください 二行目"]);
  });
});

describe("K2/K3: チャットの会話の一覧", () => {
  it("user・assistant・error の3種類を ts の順に並べ、seq を 1 から振る。本文は全文（改行も残す）", async () => {
    write([
      userRec("質問です\n二行目", T0 + 1000),
      stopRec("# 見出し\n\n- 箇条書き\n```ts\nconst a = 1;\n```", T0 + 2000),
      rec({ event: "StopFailure", error: "rate_limit", ts: T0 + 3000 }),
    ]);
    await store.refresh();
    const { items, lastSeq } = store.chat(SID);
    expect(items.map((i) => [i.role, i.text, i.error])).toEqual([
      ["user", "質問です\n二行目", undefined],
      ["assistant", "# 見出し\n\n- 箇条書き\n```ts\nconst a = 1;\n```", undefined],
      ["error", "", "rate_limit"],
    ]);
    expect(items.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.ts)).toEqual([T0 + 1000, T0 + 2000, T0 + 3000]);
    expect(lastSeq).toBe(3);
  });

  it("K3 担当の報告の戻り（source=agent）は出さない（記録は残る）", async () => {
    write([userRec('<agent-message from="A">報告</agent-message>', T0, { source: "agent" }), userRec("人の入力", T0 + 1)]);
    await store.refresh();
    expect(store.chat(SID).items.map((i) => i.text)).toEqual(["人の入力"]);
  });

  it("K3 <pasted_content> の包みの行は外して出す（先頭・末尾の空行も）。本文の途中の空行は残す。包みのない入力はそのまま", async () => {
    write([
      userRec(wrapPaste("行1\n\n行3\n行4"), T0),
      userRec("包みなし\n二行目", T0 + 1),
      userRec(`前置き\n${wrapPaste("貼った本文", "d46c").trimStart()}`, T0 + 2),
    ]);
    await store.refresh();
    expect(store.chat(SID).items.map((i) => i.text)).toEqual(["行1\n\n行3\n行4", "包みなし\n二行目", "前置き\n貼った本文"]);
  });

  it("K3 包みを外すと空になる入力は出さない", async () => {
    write([userRec(wrapPaste(""), T0)]);
    await store.refresh();
    expect(store.chat(SID).items).toEqual([]);
  });

  it("K3 1 回の入力に Stop が何回か来たら、その数だけ返事を出す（消さない）", async () => {
    write([userRec("やって", T0), stopRec("1回目の返事", T0 + 1000, { stop_hook_active: false }), stopRec("2回目の返事", T0 + 2000, { stop_hook_active: true })]);
    await store.refresh();
    expect(store.chat(SID).items.map((i) => [i.role, i.text])).toEqual([
      ["user", "やって"],
      ["assistant", "1回目の返事"],
      ["assistant", "2回目の返事"],
    ]);
  });

  it("K8 truncated の記録は truncated を付けて返す。本文が空の Stop（返事なし）は出さない", async () => {
    write([stopRec("長い返事の先頭", T0, { truncated: true }), rec({ event: "Stop", ts: T0 + 1 })]);
    await store.refresh();
    expect(store.chat(SID).items).toMatchObject([{ role: "assistant", text: "長い返事の先頭", truncated: true }]);
    expect(store.chat(SID).items).toHaveLength(1);
  });

  it("別のセッションの記録は混ざらない。記録の無いセッションは空", async () => {
    write([userRec("自分", T0), userRec("他人", T0 + 1, { session_id: OTHER })]);
    await store.refresh();
    expect(store.chat(SID).items.map((i) => i.text)).toEqual(["自分"]);
    expect(store.chat(OTHER).items.map((i) => i.text)).toEqual(["他人"]);
    expect(store.chat("00000000-0000-4000-8000-000000000000")).toEqual({ items: [], lastSeq: 0 });
  });

  it("M-c since=<seq> より後の分だけを返す。同じ ms の記録も取りこぼさない（読み足した分は seq が進む）", async () => {
    write([userRec("A", T0), stopRec("B", T0)]);
    await store.refresh();
    const first = store.chat(SID);
    expect(first.items.map((i) => i.text)).toEqual(["A", "B"]);
    expect(store.chat(SID, first.lastSeq)).toEqual({ items: [], lastSeq: first.lastSeq });
    // 同じ ts の記録が、前回の読み取りの後に追記された
    write([stopRec("C", T0)]);
    await store.refresh();
    const next = store.chat(SID, first.lastSeq);
    expect(next.items.map((i) => i.text)).toEqual(["C"]);
    expect(next.lastSeq).toBe(first.lastSeq + 1);
    expect(store.chat(SID, 1).items.map((i) => i.text)).toEqual(["B", "C"]);
  });

  it("上限は 1 セッション 200 件（古いものから落ちる）。seq は落ちても進み続ける", async () => {
    const rows: Rec[] = [];
    for (let i = 0; i < 230; i++) rows.push(i % 2 === 0 ? userRec(`u${i}`, T0 + i) : stopRec(`a${i}`, T0 + i));
    write(rows);
    await store.refresh();
    const { items, lastSeq } = store.chat(SID);
    expect(items).toHaveLength(200);
    expect(items[0].text).toBe("u30");
    expect(items[199].text).toBe("a229");
    expect(lastSeq).toBe(230);
  });

  it("同じ記録を読み直しても（ファイルが作り直された）、同じ会話は二重に出ない", async () => {
    const file = path.join(actDir, dayName(T0));
    write([userRec("一つ", T0), stopRec("返事", T0 + 1)]);
    await store.refresh();
    truncateSync(file, 0);
    write([userRec("一つ", T0), stopRec("返事", T0 + 1)]);
    await store.refresh();
    expect(store.chat(SID).items.map((i) => i.text)).toEqual(["一つ", "返事"]);
  });

  it("書いた順と ts の順が違っても、返す順は ts の順（同じ ts は seq の順）", async () => {
    write([stopRec("後", T0 + 5000), userRec("先", T0 + 1000)]);
    await store.refresh();
    expect(store.chat(SID).items.map((i) => i.text)).toEqual(["先", "後"]);
  });

  it("今日と昨日の記録だけ。再起動（新しい ActivityStore）では一昨日より古い会話は出ない", async () => {
    const DAY = 24 * 60 * MIN;
    write([userRec("今日", T0)]);
    write([userRec("昨日", T0 - DAY)], dayName(T0 - DAY));
    write([userRec("一昨日", T0 - 2 * DAY)], dayName(T0 - 2 * DAY));
    const fresh = new ActivityStore(dataDir, { keepDays: 7, now: () => nowMs });
    await fresh.refresh();
    expect(fresh.chat(SID).items.map((i) => i.text)).toEqual(["昨日", "今日"]);
  });
});

describe("メモリの上限", () => {
  it("stops・handbacks（400）、tasks（200）、孫の呼び出し（400）は、上限を超えると古い ts から落ちる", async () => {
    const rows: Rec[] = [];
    for (let i = 0; i < 450; i++) {
      const ts = T0 + i * 1000;
      rows.push(stop(`S${i}`, { ts, agent_type: "Explore" }), handback(`H${i}`, `報告${i}`, { ts }), pre(`n${i}`, { ts, agent_id: "P" }));
    }
    for (let i = 0; i < 250; i++) rows.push(rec({ event: "TaskCreated", task_id: `t${i}`, task_subject: `t${i}`, ts: T0 + i }));
    write(rows);
    await store.refresh();
    expect(store.sizes(SID)).toEqual({ starts: 0, stops: 400, handbacks: 400, tasks: 200, nested: 400 });
    const v = store.view(SID);
    // 新しいものは残り（古い順に落ちる）、一番古い 50 件の終わりは出ない
    expect(v.finished.map((a) => a.summary)).toContain("報告449");
    expect(v.finished.map((a) => a.key)).not.toContain("agent-S0");
    expect(v.finished.map((a) => a.key)).not.toContain("agent-H0");
    expect(v.tasks[v.tasks.length - 1].id).toBe("t249");
    expect(v.tasks).toHaveLength(50);
  });
});

describe("K7: セッションごとに分ける", () => {
  it("別の session_id の記録は、選んだセッションの view に混ざらない", async () => {
    write([pre("t1"), rec({ session_id: OTHER, event: "TaskCreated", task_id: "1", task_subject: "他人の" }), rec({ session_id: OTHER, event: "UserPromptSubmit", prompt: "他の入力" })]);
    await store.refresh();
    expect(store.view(SID).tasks).toEqual([]);
    expect(store.view(SID).inputs).toEqual([]);
    expect(store.view(OTHER).running).toEqual([]);
    expect(store.view(OTHER).tasks.map((t) => t.subject)).toEqual(["他人の"]);
    expect(store.view("00000000-0000-4000-8000-000000000000")).toEqual({ running: [], finished: [], tasks: [], inputs: [], lastEventAt: null });
  });
});

describe("K4 / §3-4: 読み方", () => {
  it("前回の読み終わりの位置から読み足す。書きかけの末尾の行は、行が完成してから取り込む", async () => {
    const file = path.join(actDir, dayName(T0));
    writeFileSync(file, JSON.stringify(rec({ event: "TaskCreated", task_id: "1", task_subject: "一" })) + "\n");
    expect((await store.refresh()).applied).toBe(1);
    expect((await store.refresh()).applied).toBe(0);
    const second = JSON.stringify(rec({ event: "TaskCreated", task_id: "2", task_subject: "二" }));
    appendFileSync(file, second.slice(0, 20));
    expect((await store.refresh()).applied).toBe(0);
    expect(store.invalidLines).toBe(0);
    appendFileSync(file, second.slice(20) + "\n");
    expect((await store.refresh()).applied).toBe(1);
    expect(store.view(SID).tasks.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("JSON として読めない行・形の合わない行は捨てて、数える", async () => {
    const file = path.join(actDir, dayName(T0));
    writeFileSync(
      file,
      [
        "{broken",
        JSON.stringify({ ts: T0, event: "TaskCreated", session_id: "not-a-uuid", task_id: "1" }),
        JSON.stringify({ ts: "x", event: "TaskCreated", session_id: SID }),
        JSON.stringify({ ts: T0, event: "Unknown", session_id: SID }),
        "[]",
        JSON.stringify(rec({ event: "TaskCreated", task_id: "ok", task_subject: "有効" })),
      ].join("\n") + "\n",
    );
    const r = await store.refresh();
    expect(r.applied).toBe(1);
    expect(store.invalidLines).toBe(5);
    expect(store.view(SID).tasks.map((t) => t.id)).toEqual(["ok"]);
  });

  it("今日と昨日の events ファイルを読む。一昨日のものは読まない", async () => {
    const DAY = 24 * 60 * MIN;
    write([rec({ event: "TaskCreated", task_id: "today", task_subject: "t", ts: T0 })]);
    write([rec({ event: "TaskCreated", task_id: "yesterday", task_subject: "y", ts: T0 - DAY })], dayName(T0 - DAY));
    write([rec({ event: "TaskCreated", task_id: "twodays", task_subject: "d", ts: T0 - 2 * DAY })], dayName(T0 - 2 * DAY));
    await store.refresh();
    expect(store.view(SID).tasks.map((t) => t.id).sort()).toEqual(["today", "yesterday"]);
  });

  it("ファイルが小さくなったら（作り直し）先頭から読み直す", async () => {
    const file = path.join(actDir, dayName(T0));
    write([rec({ event: "TaskCreated", task_id: "1", task_subject: "a" }), rec({ event: "TaskCreated", task_id: "2", task_subject: "b" })]);
    await store.refresh();
    truncateSync(file, 0);
    write([rec({ event: "TaskCreated", task_id: "3", task_subject: "c" })]);
    await store.refresh();
    expect(store.view(SID).tasks.map((t) => t.id)).toContain("3");
  });

  it("まだ events ファイルが無くても、エラーにならない", async () => {
    rmSync(actDir, { recursive: true });
    await expect(store.refresh()).resolves.toEqual({ applied: 0 });
  });

  it("変化があったときだけ rev が進み、onChange が呼ばれる", async () => {
    const listener = vi.fn();
    store.onChange(listener);
    const rev0 = store.rev;
    await store.refresh();
    expect(store.rev).toBe(rev0);
    expect(listener).not.toHaveBeenCalled();
    write([rec({ event: "TaskCreated", task_id: "1", task_subject: "a" })]);
    await store.refresh();
    expect(store.rev).toBe(rev0 + 1);
    expect(listener).toHaveBeenCalledWith(rev0 + 1);
    await store.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("K4: 古いファイルの掃除", () => {
  it("activityKeepDays（7）より古い events-YYYYMMDD.jsonl だけを消す。ほかの名前・新しいものは残す", async () => {
    const DAY = 24 * 60 * MIN;
    const old = dayName(T0 - 8 * DAY);
    const edge = dayName(T0 - 7 * DAY);
    const keep = [edge, dayName(T0), "notes.txt", "events-2026.jsonl", "events-20260101.jsonl.bak", "settings.json.ac-backup-20260101T000000000Z"];
    for (const name of [old, ...keep]) writeFileSync(path.join(actDir, name), "x\n");
    const removed = await store.pruneOldFiles();
    expect(removed).toEqual([old]);
    expect(readdirSync(actDir).sort()).toEqual([...keep].sort());
    expect(existsSync(path.join(actDir, old))).toBe(false);
  });

  it("2026-01-01 のような古い日付の events も消える（日付の形に合うものだけ）", async () => {
    writeFileSync(path.join(actDir, "events-20260101.jsonl"), "x\n");
    writeFileSync(path.join(actDir, "events-20260101.jsonl.bak"), "x\n");
    await store.pruneOldFiles();
    expect(readdirSync(actDir)).toEqual(["events-20260101.jsonl.bak"]);
  });
});
