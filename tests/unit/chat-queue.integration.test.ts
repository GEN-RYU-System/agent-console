import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { CHAT_QUEUE_MAX } from "../../server/hub.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// 便2: 作業中でも送れる（送信の予約）。サーバーのメモリの予約を、手が空いたときだけ 1 件ずつ端末へ書く。
// 偽の claude（`claude agents --json` のスタブ）の状態を切り替えながら、端末へ書かれたもの（SessionManager.write）を見る。
const SUBMIT_DELAY_MS = 150;
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

let h: Harness;
let rowsFile: string;
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  const stubDir = mkdtempSync(path.join(os.tmpdir(), "ac-chatq-stub-"));
  rowsFile = path.join(stubDir, "rows.json");
  writeFileSync(rowsFile, "[]");
  const stub = path.join(stubDir, "claude-stub.sh");
  writeFileSync(stub, `#!/bin/bash\ncase "$1" in agents) cat "${rowsFile}";; --version) echo stub;; esac\n`);
  chmodSync(stub, 0o755);
  h = await startHarness({ claudeBin: stub, pasteSubmitDelayMs: SUBMIT_DELAY_MS });
  write = vi.spyOn(h.sessions, "write");
});
afterAll(async () => {
  await h.close();
});

const made: string[] = [];
let write: MockInstance<typeof h.sessions.write>;
afterEach(async () => {
  write.mockClear();
  // 予約が残ったセッションを、次の試験の poll で書かれないように閉じて片づける
  for (const id of made.splice(0)) if (h.sessions.get(id)) await h.sessions.close(id);
});

async function call(method: string, p: string, body?: unknown, auth = true): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${h.base}${p}`, { method, headers: auth ? headers : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Json };
}
const dayFile = (ts: number): string => `events-${new Date(ts).toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`;
function writeEvents(records: object[]): void {
  const dir = path.join(h.config.dataDir, "activity");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, dayFile(Date.now())), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
let counter = 0;
/** 試験ごとに別の Claude の sessionId を持つセッションを作る */
function newSession(claudeSessionId = true): { id: string; pid: number; claudeId: string } {
  counter += 1;
  const claudeId = `eeeeeeee-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  const s = h.sessions.restore({ role: h.config.roles[0], name: `cq-${counter}`, cwd: h.config.salesanchorRoot, branch: null });
  if (claudeSessionId) h.sessions.setClaudeSessionId(s.id, claudeId);
  made.push(s.id);
  return { id: s.id, pid: s.term.pid, claudeId };
}
const setRows = (rows: unknown[]): void => writeFileSync(rowsFile, JSON.stringify(rows));
const row = (pid: number, status: string, claudeId: string, extra: Record<string, unknown> = {}) => ({ pid, status, name: "n", sessionId: claudeId, cwd: "/", startedAt: 1, ...extra });
const poll = async (): Promise<void> => h.hub.pollAgents();
const queue = (id: string, text: string) => call("POST", `/api/sessions/${id}/chat/queue`, { text });
const queued = async (id: string): Promise<Json[]> => (await call("GET", `/api/sessions/${id}/chat`)).json.queued as Json[];
/** そのセッションへ書かれたもの（古い順） */
const written = (id: string): string[] => write.mock.calls.filter(([s]) => s.id === id).map(([, data]) => data);
const pasted = (text: string): string => `${PASTE_START}${text}${PASTE_END}`;
async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("until: timeout");
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS * 3));

describe("POST /chat/queue と DELETE /chat/queue/:qid の入口", () => {
  it("認証が要る・存在しないセッションは 404・停止中は 409・本文の検査は send-check と同じ（400）", async () => {
    const s = newSession();
    expect((await call("POST", `/api/sessions/${s.id}/chat/queue`, { text: "x" }, false)).status).toBe(401);
    expect((await queue("missing", "x")).status).toBe(404);
    const post = (body: unknown) => call("POST", `/api/sessions/${s.id}/chat/queue`, body);
    expect((await post({})).status).toBe(400);
    expect((await post({ text: " \n " })).status).toBe(400);
    expect((await post({ text: "a".repeat(32 * 1024 + 1) })).status).toBe(400);
    expect((await post({ text: "a\u001bb" })).status).toBe(400);
    // 終了したが一覧に残っているセッション（役割 short は echo して終わる）
    const ended = h.sessions.restore({ role: h.config.roles[1], name: "cq-ended", cwd: h.config.salesanchorRoot, branch: null });
    made.push(ended.id);
    await until(() => ended.exited);
    expect((await queue(ended.id, "x")).status).toBe(409);
  });
});

describe("K2: busy・waiting・unknown の間は端末に何も書かない", () => {
  it("busy・waiting・待ち理由あり・状態が読めない（unknown）の間、予約を作っても poll しても書かれない。予約は queued のまま残る", async () => {
    const s = newSession();
    setRows([row(s.pid, "busy", s.claudeId)]);
    await poll();
    const made1 = await queue(s.id, "作業中に送る");
    expect(made1.status).toBe(201);
    expect(typeof made1.json.id).toBe("string");
    for (const rows of [
      [row(s.pid, "busy", s.claudeId)],
      [row(s.pid, "waiting", s.claudeId)],
      [row(s.pid, "idle", s.claudeId, { waitingFor: "permission prompt" })],
    ]) {
      setRows(rows);
      await poll();
      await settle();
    }
    writeFileSync(rowsFile, "not json");
    await poll();
    await settle();
    expect(written(s.id)).toEqual([]);
    const items = await queued(s.id);
    expect(items.map((i) => [i.text, i.state])).toEqual([["作業中に送る", "queued"]]);
  });

  it("定期取得では手すきでも、書く直前の取り直しで作業中なら書かない（L-a）", async () => {
    const s = newSession();
    setRows([row(s.pid, "idle", s.claudeId)]);
    await poll();
    setRows([row(s.pid, "busy", s.claudeId)]); // poll の値は idle のまま、実際は busy
    expect((await queue(s.id, "取り直しで止まる")).status).toBe(201);
    await settle();
    expect(written(s.id)).toEqual([]);
    expect((await queued(s.id))[0].state).toBe("queued");
  });
});

describe("K3: 送るのは idle かつ待ちなしのときだけ。1 件送ったら、受け取りを観測するまで次を送らない", () => {
  it("idle→1 件目を貼って Enter→idle のまま（2 件目は送らない）→busy を観測→idle→2 件目を送る", async () => {
    const s = newSession();
    setRows([row(s.pid, "idle", s.claudeId)]);
    await poll();
    await queue(s.id, "一件目");
    await queue(s.id, "二件目");
    await until(() => written(s.id).length >= 2);
    expect(written(s.id)).toEqual([pasted("一件目"), "\r"]);
    // idle のまま何度 poll しても、2 件目は書かれない
    await poll();
    await poll();
    await settle();
    expect(written(s.id)).toEqual([pasted("一件目"), "\r"]);
    expect((await queued(s.id)).map((i) => [i.text, i.state])).toEqual([
      ["一件目", "sent"],
      ["二件目", "queued"],
    ]);
    // busy を観測しても、その間は書かない
    setRows([row(s.pid, "busy", s.claudeId)]);
    await poll();
    await settle();
    expect(written(s.id)).toHaveLength(2);
    // 再び idle を観測したら、2 件目を送る
    setRows([row(s.pid, "idle", s.claudeId)]);
    await poll();
    expect(written(s.id)).toEqual([pasted("一件目"), "\r", pasted("二件目"), "\r"]);
  });

  it("busy を見逃しても、送った後の seq で user の記録が届けば、次を送ってよい", async () => {
    const s = newSession();
    setRows([row(s.pid, "idle", s.claudeId)]);
    await poll();
    await queue(s.id, "A");
    await queue(s.id, "B");
    await until(() => written(s.id).length >= 2);
    await poll();
    await settle();
    expect(written(s.id)).toHaveLength(2); // user の記録がまだ無い間は送らない
    writeEvents([{ ts: Date.now(), session_id: s.claudeId, event: "UserPromptSubmit", prompt: "A" }]);
    await h.activity.refresh();
    await poll();
    expect(written(s.id)).toEqual([pasted("A"), "\r", pasted("B"), "\r"]);
  });

  it("assistant の記録だけでは、次を送ってよい印にならない", async () => {
    const s = newSession();
    setRows([row(s.pid, "idle", s.claudeId)]);
    await poll();
    await queue(s.id, "A");
    await queue(s.id, "B");
    await until(() => written(s.id).length >= 2);
    writeEvents([{ ts: Date.now(), session_id: s.claudeId, event: "Stop", last_assistant_message: "返事" }]);
    await h.activity.refresh();
    await poll();
    await settle();
    expect(written(s.id)).toHaveLength(2);
  });
});

describe("K4: 取り消しと、セッションを閉じたときの破棄", () => {
  it("queued の予約は DELETE で消える。もう一度は 404。別のセッションの予約 id でも 404", async () => {
    const s = newSession();
    const other = newSession();
    setRows([row(s.pid, "busy", s.claudeId), row(other.pid, "busy", other.claudeId)]);
    await poll();
    const a = (await queue(s.id, "消す")).json.id as string;
    const b = (await queue(other.id, "別のセッション")).json.id as string;
    expect((await call("DELETE", `/api/sessions/${s.id}/chat/queue/${b}`)).status).toBe(404);
    expect((await call("DELETE", `/api/sessions/${s.id}/chat/queue/${a}`, undefined, false)).status).toBe(401);
    expect((await call("DELETE", `/api/sessions/${s.id}/chat/queue/${a}`)).status).toBe(200);
    expect(await queued(s.id)).toEqual([]);
    expect((await call("DELETE", `/api/sessions/${s.id}/chat/queue/${a}`)).status).toBe(404);
    expect((await queued(other.id)).length).toBe(1);
  });

  it("セッションを閉じたら、そのセッションの予約は捨てる", async () => {
    const s = newSession();
    setRows([row(s.pid, "busy", s.claudeId)]);
    await poll();
    await queue(s.id, "捨てられる");
    expect(h.hub.chatQueueOf(s.id)).toHaveLength(1);
    await h.sessions.close(s.id);
    expect(h.hub.chatQueueOf(s.id)).toEqual([]);
  });

  it("貼った後、Enter を送る前に取り消された予約には、Enter を送らない", async () => {
    const s = newSession();
    setRows([row(s.pid, "idle", s.claudeId)]);
    await poll();
    const id = (await queue(s.id, "途中で取り消す")).json.id as string;
    await until(() => written(s.id).length >= 1);
    expect((await call("DELETE", `/api/sessions/${s.id}/chat/queue/${id}`)).status).toBe(200);
    await settle();
    expect(written(s.id)).toEqual([pasted("途中で取り消す")]);
  });

  it("貼った後、Enter を送る前にセッションが終了したら、Enter を送らない", async () => {
    const s = newSession();
    setRows([row(s.pid, "idle", s.claudeId)]);
    await poll();
    await queue(s.id, "終了する");
    await until(() => written(s.id).length >= 1);
    await h.sessions.close(s.id);
    await settle();
    expect(written(s.id)).toEqual([pasted("終了する")]);
  });
});

describe("K6: 1 セッションの予約は最大 CHAT_QUEUE_MAX 件", () => {
  it("上限まで作れて、超えたら 409。取り消すと、また作れる", async () => {
    expect(CHAT_QUEUE_MAX).toBe(10);
    const s = newSession();
    setRows([row(s.pid, "busy", s.claudeId)]);
    await poll();
    let firstId = "";
    for (let i = 0; i < CHAT_QUEUE_MAX; i++) {
      const r = await queue(s.id, `予約 ${i}`);
      expect(r.status).toBe(201);
      if (i === 0) firstId = r.json.id as string;
    }
    const over = await queue(s.id, "あふれる");
    expect(over.status).toBe(409);
    expect(String(over.json.error)).toMatch(/full/);
    expect((await queued(s.id)).length).toBe(CHAT_QUEUE_MAX);
    await call("DELETE", `/api/sessions/${s.id}/chat/queue/${firstId}`);
    expect((await queue(s.id, "空いた")).status).toBe(201);
  });
});

describe("K7: 予約の 3 段（予約中→送信済み→消える）", () => {
  it("送ったら sent（sentAtSeq つき）になり、その後の seq で user の記録が届いたら消える（本文は見ない）。前からあった user の記録では消えない", async () => {
    const s = newSession();
    writeEvents([{ ts: Date.now(), session_id: s.claudeId, event: "UserPromptSubmit", prompt: "前からある入力" }]);
    await h.activity.refresh();
    setRows([row(s.pid, "busy", s.claudeId)]);
    await poll();
    await queue(s.id, "予約する文");
    expect((await queued(s.id)).map((i) => i.state)).toEqual(["queued"]);
    setRows([row(s.pid, "idle", s.claudeId)]);
    await poll();
    const [sent] = await queued(s.id);
    expect(sent.state).toBe("sent");
    expect(sent.sentAtSeq).toBe(1);
    await h.activity.refresh();
    expect((await queued(s.id)).length).toBe(1);
    // 本文が違っていても、後の seq の user の記録が来たら外れる
    writeEvents([{ ts: Date.now(), session_id: s.claudeId, event: "UserPromptSubmit", prompt: "まったく別の文" }]);
    await h.activity.refresh();
    expect(await queued(s.id)).toEqual([]);
  });

  it("GET /chat は、claudeSessionId がまだ無いセッションでも queued を返す", async () => {
    const s = newSession(false);
    writeFileSync(rowsFile, "not json"); // 状態が読めない間は送られない（行を返すと poll が claudeSessionId を覚えてしまう）
    await poll();
    await queue(s.id, "ID が分かる前の予約");
    const r = await call("GET", `/api/sessions/${s.id}/chat`);
    expect(r.json.status).toBe("noSession");
    expect(r.json.queued.map((i: Json) => i.text)).toEqual(["ID が分かる前の予約"]);
  });
});

describe("K8: 状態ごとの扱い", () => {
  it("素のシェル（Claude なし）は、予約してすぐ書く。括弧付きにせず、本文のあとに Enter。送ったら予約から外れる", async () => {
    const s = newSession();
    setRows([]);
    await poll();
    expect((await queue(s.id, "echo hello")).status).toBe(201);
    await until(() => written(s.id).length >= 2);
    expect(written(s.id)).toEqual(["echo hello", "\r"]);
    await until(async () => (await queued(s.id)).length === 0);
  });

  it("unknown（状態が読めない）は予約だけして、送らない", async () => {
    const s = newSession();
    writeFileSync(rowsFile, "not json");
    await poll();
    expect((await queue(s.id, "読めない間")).status).toBe(201);
    await settle();
    expect(written(s.id)).toEqual([]);
    expect((await queued(s.id))[0].state).toBe("queued");
  });
});

describe("M-c: 送信済みの予約も取り消せる", () => {
  it("取り消すと予約から外れ、見張りも消えるので、次の予約は次の idle で送られる。端末には何も書かない", async () => {
    const s = newSession();
    setRows([row(s.pid, "idle", s.claudeId)]);
    await poll();
    const first = (await queue(s.id, "届かなかった")).json.id as string;
    await queue(s.id, "次の文");
    await until(() => written(s.id).length >= 2);
    expect((await queued(s.id))[0].state).toBe("sent");
    expect((await call("DELETE", `/api/sessions/${s.id}/chat/queue/${first}`)).status).toBe(200);
    expect(written(s.id)).toHaveLength(2); // 取り消しでは何も書かない
    await poll();
    expect(written(s.id)).toEqual([pasted("届かなかった"), "\r", pasted("次の文"), "\r"]);
  });
});
