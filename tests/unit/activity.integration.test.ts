import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installHooks } from "../../server/activity-hooks.ts";
import { hookPathIn, installHookFile } from "../../server/activity-setup.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const SID_A = "aaaaaaaa-2222-4333-8444-555555555555";
const SID_B = "bbbbbbbb-2222-4333-8444-555555555555";
const SID_NONE = "cccccccc-2222-4333-8444-555555555555";

let h: Harness;
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const dayFile = (ts: number): string => `events-${new Date(ts).toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`;
function writeEvents(records: object[]): void {
  const dir = path.join(h.config.dataDir, "activity");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, dayFile(Date.now())), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
async function get(p: string, auth = true): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${h.base}${p}`, { headers: auth ? headers : {} });
  return { status: res.status, json: (await res.json()) as Json };
}
const activity = (id: string) => get(`/api/sessions/${id}/activity`);
/** Claude の sessionId が分かったセッション（本番では claude agents --json から hub が控える） */
function sessionWith(name: string, claudeSessionId: string): { id: string } {
  const s = h.sessions.restore({ role: h.config.roles[0], name, cwd: h.config.salesanchorRoot, branch: null });
  h.sessions.setClaudeSessionId(s.id, claudeSessionId);
  return s;
}

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe("K7 / §3-4: GET /api/sessions/:id/activity", () => {
  it("claudeSessionId がまだ無いセッションは {status:'noSession'}", async () => {
    const s = h.sessions.restore({ role: h.config.roles[0], name: "no-id", cwd: h.config.salesanchorRoot, branch: null });
    const r = await activity(s.id);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: "noSession" });
  });

  it("選んだセッションの session_id の記録だけを返す。アプリの外のセッション（どのセッションにも結びつかない id）の記録は入っても出ない", async () => {
    const a = sessionWith("a", SID_A);
    const b = sessionWith("b", SID_B);
    const now = Date.now();
    writeEvents([
      { ts: now - 5000, session_id: SID_A, event: "PreToolUse", tool: "Agent", tool_use_id: "t1", description: "Aの調べもの", subagent_type: "general-purpose", model: "sonnet" },
      { ts: now - 4000, session_id: SID_A, event: "PostToolUse", tool: "Agent", tool_use_id: "t1", status: "async_launched", agentId: "AG1", resolvedModel: "claude-sonnet-5-5" },
      { ts: now - 3000, session_id: SID_B, event: "TaskCreated", task_id: "1", task_subject: "Bのやること" },
      { ts: now - 2000, session_id: SID_NONE, event: "TaskCreated", task_id: "1", task_subject: "アプリの外のセッション" },
      { ts: now - 1000, session_id: SID_A, event: "UserPromptSubmit", prompt: "Aの入力" },
    ]);

    const ra = await activity(a.id);
    expect(ra.status).toBe(200);
    expect(ra.json.status).toBe("ok");
    expect(ra.json.running.map((x: Json) => x.description)).toEqual(["Aの調べもの"]);
    expect(ra.json.tasks).toEqual([]);
    expect(ra.json.inputs.map((x: Json) => x.text)).toEqual(["Aの入力"]);
    expect(typeof ra.json.now).toBe("number");

    const rb = await activity(b.id);
    expect(rb.json.running).toEqual([]);
    expect(rb.json.tasks).toEqual([{ id: "1", subject: "Bのやること", done: false }]);
    expect(JSON.stringify(ra.json)).not.toContain("アプリの外");
    expect(JSON.stringify(rb.json)).not.toContain("アプリの外");
  });

  it("新しい記録は、次の呼び出しで取り込まれる（読み足し）。rev が進み、snapshot の activityRev と SessionView.claudeSessionId に出る", async () => {
    const c = sessionWith("c", "dddddddd-2222-4333-8444-555555555555");
    const before = (await h.hub.snapshot()).activityRev;
    writeEvents([{ ts: Date.now(), session_id: "dddddddd-2222-4333-8444-555555555555", event: "TaskCreated", task_id: "9", task_subject: "あとから" }]);
    const r = await activity(c.id);
    expect(r.json.tasks.map((t: Json) => t.subject)).toEqual(["あとから"]);
    const snap = await h.hub.snapshot();
    expect(snap.activityRev).toBeGreaterThan(before);
    expect(snap.sessions.find((s) => s.id === c.id)?.claudeSessionId).toBe("dddddddd-2222-4333-8444-555555555555");
  });

  it("存在しないセッションは 404、認証が無ければ 401", async () => {
    expect((await get("/api/sessions/nope/activity")).status).toBe(404);
    expect((await get("/api/sessions/nope/activity", false)).status).toBe(401);
  });
});

describe("K2 / §3-1: 本物の hook に流して、担当の再開が「動いている担当」に戻る", () => {
  const SID_R = "ffffffff-2222-4333-8444-555555555555";
  const SID_ONLY = "99999999-2222-4333-8444-555555555555";
  let hook: string;
  /** 本物の hook（dataDir/hooks/activity-hook.mjs）に、Claude の入力の形の JSON を 1 件流す。ts は hook が付ける（実行順に増える） */
  function fire(sessionId: string, input: Record<string, unknown>): void {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ session_id: sessionId, ...input }), encoding: "utf8" });
    expect(r.status).toBe(0);
  }
  const runningOf = async (id: string): Promise<string[]> => ((await activity(id)).json.running as Json[]).map((a) => a.description as string);

  it("呼ぶ→終わる→再開（SubagentStart）→終わる、の順に流すと、動いている担当が 出る→消える→戻る→消える", async () => {
    installHookFile(path.join(process.cwd(), "hooks"), h.config.dataDir);
    hook = hookPathIn(h.config.dataDir);
    const s = sessionWith("restart", SID_R);
    fire(SID_R, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "toolu_r1", tool_input: { description: "再開する仕事", subagent_type: "general-purpose", model: "sonnet" } });
    fire(SID_R, { hook_event_name: "SubagentStart", agent_id: "ab4603515d5beee56", agent_type: "general-purpose" });
    fire(SID_R, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_r1", tool_response: { status: "async_launched", agentId: "ab4603515d5beee56" } });
    expect(await runningOf(s.id)).toEqual(["再開する仕事"]);

    fire(SID_R, { hook_event_name: "PreToolUse", tool_name: "SubagentHandback", agent_id: "ab4603515d5beee56", tool_input: { message: "1回目の報告" } });
    fire(SID_R, { hook_event_name: "SubagentStop", agent_id: "ab4603515d5beee56", agent_type: "general-purpose" });
    expect(await runningOf(s.id)).toEqual([]);

    // SendMessage での再開: PreToolUse(SendMessage) は記録しない。SubagentStart だけが来る（工程0 (a)）
    fire(SID_R, { hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to: "ab4603515d5beee56", summary: "s", message: "m" } });
    fire(SID_R, { hook_event_name: "SubagentStart", agent_id: "ab4603515d5beee56", agent_type: "general-purpose" });
    expect(await runningOf(s.id)).toEqual(["再開する仕事"]);

    fire(SID_R, { hook_event_name: "SubagentStop", agent_id: "ab4603515d5beee56", agent_type: "general-purpose" });
    expect(await runningOf(s.id)).toEqual([]);
  });

  it("SubagentStart だけ（Agent の呼び出しと結べない担当）は、動いている担当に出ない", async () => {
    const s = sessionWith("only-start", SID_ONLY);
    fire(SID_ONLY, { hook_event_name: "SubagentStart", agent_id: "aINTERNAL", agent_type: "" });
    fire(SID_ONLY, { hook_event_name: "SubagentStart", agent_id: "aGRAND", agent_type: "general-purpose" });
    expect(await runningOf(s.id)).toEqual([]);
  });
});

describe("K8: 記録の仕組みが外れているかを、呼ぶたびに点検して返す", () => {
  it("settings.json に handler が無ければ hooks.ok=false（reason）。足すと ok に変わる（API を呼ぶたびに点検）", async () => {
    const s = sessionWith("k8", "eeeeeeee-2222-4333-8444-555555555555");
    const settingsPath = h.config.claudeSettingsPath;
    const hookPath = path.join(h.config.dataDir, "hooks", "activity-hook.mjs");

    const missing = await activity(s.id);
    expect(missing.json.hooks).toMatchObject({ ok: false, reason: "noSettings" });

    writeFileSync(settingsPath, JSON.stringify({ permissions: {} }));
    expect((await activity(s.id)).json.hooks).toMatchObject({ ok: false, reason: "missingHandler" });

    mkdirSync(path.dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, "// hook\n");
    writeFileSync(path.join(path.dirname(hookPath), "ac-routine-guard.mjs"), "// guard\n");
    writeFileSync(path.join(path.dirname(hookPath), "board-guard.mjs"), "// board-guard\n");
    installHooks({ settingsPath, nodePath: process.execPath, hookPath });
    expect((await activity(s.id)).json.hooks).toEqual({ ok: true });
  });
});
