import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const CLAUDE_ID = "aaaaaaaa-2222-4333-8444-555555555555";
const OTHER_ID = "bbbbbbbb-2222-4333-8444-555555555555";

let h: Harness;
/** `claude agents --json`（今動いている一覧）の中身 */
let rowsFile: string;
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  const stubDir = mkdtempSync(path.join(os.tmpdir(), "ac-chat-stub-"));
  rowsFile = path.join(stubDir, "rows.json");
  writeFileSync(rowsFile, "[]");
  const stub = path.join(stubDir, "claude-stub.sh");
  writeFileSync(stub, `#!/bin/bash\ncase "$1" in agents) cat "${rowsFile}";; --version) echo stub;; esac\n`);
  chmodSync(stub, 0o755);
  h = await startHarness({ claudeBin: stub });
});
afterAll(async () => {
  await h.close();
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
function sessionWith(name: string, claudeSessionId?: string): { id: string; pid: number } {
  const s = h.sessions.restore({ role: h.config.roles[0], name, cwd: h.config.salesanchorRoot, branch: null });
  if (claudeSessionId !== undefined) h.sessions.setClaudeSessionId(s.id, claudeSessionId);
  return { id: s.id, pid: s.term.pid };
}
const setAgents = (rows: unknown[]): void => writeFileSync(rowsFile, JSON.stringify(rows));
const agentRow = (pid: number, status: string, extra: Record<string, unknown> = {}) => ({ pid, status, name: "n", sessionId: CLAUDE_ID, cwd: "/", startedAt: 1, ...extra });

describe("K2/K3: GET /api/sessions/:id/chat", () => {
  it("認証が要る。存在しないセッションは 404。claudeSessionId がまだ無いセッションは {status:'noSession'}", async () => {
    const s = sessionWith("no-id");
    expect((await call("GET", `/api/sessions/${s.id}/chat`, undefined, false)).status).toBe(401);
    expect((await call("GET", "/api/sessions/missing/chat")).status).toBe(404);
    const r = await call("GET", `/api/sessions/${s.id}/chat`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: "noSession", queued: [] });
  });

  it("選んだセッションの会話だけを古い順に返す（user・assistant・error）。別のセッションの会話・担当の報告の戻りは出ない", async () => {
    const a = sessionWith("chat-a", CLAUDE_ID);
    const now = Date.now();
    writeEvents([
      { ts: now - 5000, session_id: CLAUDE_ID, event: "UserPromptSubmit", prompt: "質問です" },
      { ts: now - 4000, session_id: CLAUDE_ID, event: "UserPromptSubmit", prompt: '<agent-message from="x">報告', source: "agent" },
      { ts: now - 3000, session_id: CLAUDE_ID, event: "Stop", stop_hook_active: false, last_assistant_message: "## 返事\n\n- はい" },
      { ts: now - 2000, session_id: OTHER_ID, event: "UserPromptSubmit", prompt: "他人の入力" },
      { ts: now - 1000, session_id: CLAUDE_ID, event: "StopFailure", error: "rate_limit" },
    ]);
    const r = await call("GET", `/api/sessions/${a.id}/chat`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("ok");
    expect(r.json.items.map((i: Json) => [i.role, i.text])).toEqual([
      ["user", "質問です"],
      ["assistant", "## 返事\n\n- はい"],
      ["error", ""],
    ]);
    expect(r.json.items[2].error).toBe("rate_limit");
    expect(r.json.lastSeq).toBe(3);
    expect(typeof r.json.epoch).toBe("string");
    expect(r.json.reset).toBe(false);
  });

  it("M-c since=<seq> より後の分だけを返す。since が整数でなければ 400", async () => {
    const a = sessionWith("chat-since", "cccccccc-2222-4333-8444-555555555555");
    const id = "cccccccc-2222-4333-8444-555555555555";
    const now = Date.now();
    writeEvents([
      { ts: now, session_id: id, event: "UserPromptSubmit", prompt: "一" },
      { ts: now, session_id: id, event: "Stop", last_assistant_message: "二" },
    ]);
    const first = await call("GET", `/api/sessions/${a.id}/chat`);
    expect(first.json.items.map((i: Json) => i.text)).toEqual(["一", "二"]);
    writeEvents([{ ts: now, session_id: id, event: "Stop", last_assistant_message: "三" }]);
    const next = await call("GET", `/api/sessions/${a.id}/chat?since=${first.json.lastSeq}&epoch=${first.json.epoch as string}`);
    expect(next.json.items.map((i: Json) => i.text)).toEqual(["三"]);
    expect(next.json.reset).toBe(false);
    expect((await call("GET", `/api/sessions/${a.id}/chat?since=abc`)).status).toBe(400);
    expect((await call("GET", `/api/sessions/${a.id}/chat?since=-1`)).status).toBe(400);
  });

  it("サーバーが作り直された（epoch が違う）ときは、since を使わず全件を返し、reset: true を付ける", async () => {
    const a = sessionWith("chat-epoch", "dddddddd-2222-4333-8444-555555555555");
    writeEvents([{ ts: Date.now(), session_id: "dddddddd-2222-4333-8444-555555555555", event: "Stop", last_assistant_message: "返事" }]);
    const r = await call("GET", `/api/sessions/${a.id}/chat?since=99&epoch=older-server`);
    expect(r.json.reset).toBe(true);
    expect(r.json.items.map((i: Json) => i.text)).toEqual(["返事"]);
  });
});

describe("K6: POST /api/sessions/:id/chat/send-check", () => {
  it("認証が要る・存在しないセッションは 404", async () => {
    const s = sessionWith("sc-auth", CLAUDE_ID);
    expect((await call("POST", `/api/sessions/${s.id}/chat/send-check`, { text: "x" }, false)).status).toBe(401);
    expect((await call("POST", "/api/sessions/missing/chat/send-check", { text: "x" })).status).toBe(404);
  });

  it("手すき（idle・待ちなし）のときだけ 200 で本文と待ち時間を返す。端末へは書かない", async () => {
    const s = sessionWith("sc-idle", CLAUDE_ID);
    const write = vi.spyOn(h.sessions, "write");
    setAgents([agentRow(s.pid, "idle")]);
    const r = await call("POST", `/api/sessions/${s.id}/chat/send-check`, { text: "こんにちは\n\t二行目" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ text: "こんにちは\n\t二行目", submitDelayMs: h.config.pasteSubmitDelayMs });
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("作業中・確認待ち・待ち理由あり・状態が読めない・停止中は 409（理由つき）", async () => {
    const s = sessionWith("sc-busy", CLAUDE_ID);
    for (const [row, reason] of [
      [agentRow(s.pid, "busy"), /busy/],
      [agentRow(s.pid, "waiting"), /waiting/],
      [agentRow(s.pid, "idle", { waitingFor: "permission prompt" }), /waiting for input/],
    ] as const) {
      setAgents([row]);
      const r = await call("POST", `/api/sessions/${s.id}/chat/send-check`, { text: "x" });
      expect(r.status).toBe(409);
      expect(String(r.json.error)).toMatch(reason);
    }
    writeFileSync(rowsFile, "not json");
    expect((await call("POST", `/api/sessions/${s.id}/chat/send-check`, { text: "x" })).status).toBe(409);
    setAgents([agentRow(s.pid, "idle")]);
    expect((await call("POST", `/api/sessions/${s.id}/chat/send-check`, { text: "x" })).status).toBe(200);
  });

  it("本文の検査: 文字列でない・空・空白だけ・32KiB 超・改行とタブ以外の制御文字は 400（状態の判定より先）", async () => {
    const s = sessionWith("sc-validate", CLAUDE_ID);
    setAgents([agentRow(s.pid, "busy")]);
    const post = (body: unknown) => call("POST", `/api/sessions/${s.id}/chat/send-check`, body);
    expect((await post({})).status).toBe(400);
    expect((await post({ text: 1 })).status).toBe(400);
    expect((await post({ text: "" })).status).toBe(400);
    expect((await post({ text: " \n\t " })).status).toBe(400);
    expect((await post({ text: "a".repeat(32 * 1024 + 1) })).status).toBe(400);
    expect((await post({ text: "あ".repeat(11000) })).status).toBe(400); // 33000 バイト
    expect((await post({ text: "a\u001bb" })).status).toBe(400);
    expect((await post({ text: "a\rb" })).status).toBe(400);
    expect((await post({ text: "a\u0000b" })).status).toBe(400);
    // 検査を通る本文は、状態の判定（busy → 409）まで進む
    expect((await post({ text: "a".repeat(32 * 1024) })).status).toBe(409);
    expect((await post({ text: "改行\nとタブ\tはよい" })).status).toBe(409);
  });
});
