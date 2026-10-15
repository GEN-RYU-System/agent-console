import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCommand } from "../../hooks/ac-routine.mjs";
import { judge } from "../../hooks/ac-routine-guard.mjs";
import { SUBAGENT_RUNNING_MESSAGE } from "../../server/http.ts";
import { APPROVAL_TTL_MS, RoutineApprovals } from "../../server/routine-approvals.ts";
import { RESERVE_TOKEN, TOKEN, startHarness, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000 });

const OPUS_SID = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_SONNET_SID = "bbbbbbbb-1111-4111-8111-111111111111";
const MIN = 60_000;

let h: Harness;
let dataDir: string;
let auditFile: string;
let opusAppId: string;
let toolSeq = 0;

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const auditLines = (): Record<string, unknown>[] => {
  try { return readFileSync(auditFile, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; }
};
const entry = (over: Record<string, unknown> = {}): string => JSON.stringify({ name: "r", roleId: "echo", cwd: h.config.salesanchorRoot, weekdays: [1], timeHHmm: "09:00", promptText: "hi", enabled: false, reason: "測定のため", ...over });
const run = (argv: string[], stdinText?: string, callerSessionId: string | null = OPUS_SID) => runCommand({ argv, ...(stdinText !== undefined ? { stdinText } : {}), dataDir, callerSessionId: callerSessionId ?? undefined });
const dayFile = (): string => `events-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`;
function writeEvents(records: object[]): void {
  const dir = path.join(h.config.dataDir, "activity");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, dayFile()), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
/** その claudeSessionId に「動いている担当」を 1 つ作る（PreToolUse(Agent) だけ。終わりの記録は無い） */
function startSubagent(sid: string): string {
  const id = `tool-${++toolSeq}`;
  writeEvents([{ ts: Date.now(), session_id: sid, event: "PreToolUse", tool: "Agent", tool_use_id: id, description: `担当 ${id}`, subagent_type: "general-purpose", model: "sonnet" }]);
  return id;
}
function stopSubagent(sid: string, toolUseId: string, agentId: string): void {
  writeEvents([
    { ts: Date.now(), session_id: sid, event: "PostToolUse", tool: "Agent", tool_use_id: toolUseId, status: "async_launched", agentId },
    { ts: Date.now() + 1, session_id: sid, event: "SubagentStop", agent_id: agentId, agent_type: "general-purpose" },
  ]);
}
async function post(url: string, body: unknown, auth: Record<string, string> = { Authorization: `Bearer ${RESERVE_TOKEN}` }): Promise<{ status: number; json: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${h.base}${url}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeAll(async () => {
  h = await startHarness();
  dataDir = mkdtempSync(path.join(os.tmpdir(), "ac-hardening-"));
  writeFileSync(path.join(dataDir, "reserve-token"), JSON.stringify({ port: h.port, token: RESERVE_TOKEN }));
  auditFile = path.join(h.config.dataDir, "routine-audit.jsonl");
  const opus = await h.sessions.create({ name: "opus", roleId: "echo" });
  h.sessions.setClaudeSessionId(opus.id, OPUS_SID);
  opusAppId = opus.id;
  const sonnet = await h.sessions.create({ name: "sonnet", roleId: "envcheck" });
  h.sessions.setClaudeSessionId(sonnet.id, OTHER_SONNET_SID);
});
afterAll(async () => { await h.close(); });

describe("S1 S2 first layer: a write is refused while a subagent of the caller is running", () => {
  it("S2 with no running subagent every write and list still succeeds", async () => {
    const added = await run(["add"], entry({ name: "free" }));
    expect(added.code, added.stderr).toBe(0);
    const id = (JSON.parse(added.stdout) as { id: string }).id;
    expect((await run(["list"])).code).toBe(0);
    expect((await run(["update", id], entry({ name: "free", promptText: "u" }))).code).toBe(0);
    expect((await run(["enable", id], JSON.stringify({ reason: "r" }))).code).toBe(0);
    expect((await run(["disable", id], JSON.stringify({ reason: "r" }))).code).toBe(0);
  });

  it("S1 S3 add / update / enable / disable return 403 with the guidance message while a subagent runs; list stays open and leaves no audit row", async () => {
    const added = await run(["add"], entry({ name: "target" }));
    const id = (JSON.parse(added.stdout) as { id: string }).id;
    const toolUseId = startSubagent(OPUS_SID);
    const before = h.routines.list().map((r) => ({ id: r.id, promptText: r.promptText, enabled: r.enabled }));
    const auditBefore = auditLines().length;
    for (const [argv, stdin] of [[["add"], entry({ name: "nope" })], [["update", id], entry({ promptText: "changed" })], [["enable", id], JSON.stringify({ reason: "r" })], [["disable", id], JSON.stringify({ reason: "r" })]] as [string[], string][]) {
      const r = await run(argv, stdin);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.stderr).toContain("403");
      expect(r.stderr).toContain("ac-routine approve --reason");
      expect(r.stderr).toContain("NEEDS_DECISION:");
      expect(r.stderr).not.toContain(RESERVE_TOKEN);
    }
    expect(h.routines.list().map((r) => ({ id: r.id, promptText: r.promptText, enabled: r.enabled }))).toEqual(before);
    const rows = auditLines().slice(auditBefore);
    expect(rows.map((l) => l.action)).toEqual(["add", "update", "enable", "disable"]);
    expect(rows.every((l) => l.outcome === "denied" && l.runningCount === 1 && l.callerSessionId === OPUS_SID && l.roleId === "echo")).toBe(true);
    expect(rows[1]).toMatchObject({ routineId: id, targetCreatedBy: "agent" });
    // list は読み取りなので対象外（監査にも残さない）
    expect((await run(["list"])).code).toBe(0);
    expect(auditLines()).toHaveLength(auditBefore + 4);
    expect(SUBAGENT_RUNNING_MESSAGE).toContain("ac-routine approve --reason");
    // 担当が終わればまた通る
    stopSubagent(OPUS_SID, toolUseId, "AG-target");
    expect((await run(["disable", id], JSON.stringify({ reason: "r" }))).code).toBe(0);
  });

  it("S1 a running subagent of another session does not stop this session", async () => {
    const toolUseId = startSubagent(OTHER_SONNET_SID);
    expect((await run(["add"], entry({ name: "unaffected" }))).code).toBe(0);
    stopSubagent(OTHER_SONNET_SID, toolUseId, "AG-other");
  });
});

describe("S4b Opus approval (approve --reason)", () => {
  it("issue, use once, then the second write is 403 again; the audit has approvalIssued(opus) and approvedBy:opus", async () => {
    const toolUseId = startSubagent(OPUS_SID);
    const auditBefore = auditLines().length;
    const issued = await run(["approve", "--reason", "CI 待ちの間の登録"]);
    expect(issued.code, issued.stderr).toBe(0);
    expect(issued.stdout).not.toContain(RESERVE_TOKEN);
    const first = await run(["add"], entry({ name: "approved-1" }));
    expect(first.code, first.stderr).toBe(0);
    const second = await run(["add"], entry({ name: "approved-2" }));
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("403");
    const rows = auditLines().slice(auditBefore);
    expect(rows.map((l) => [l.action, l.outcome])).toEqual([["approvalIssued", "ok"], ["add", "ok"], ["add", "denied"]]);
    expect(rows[0]).toMatchObject({ by: "opus", reason: "CI 待ちの間の登録", callerSessionId: OPUS_SID, roleId: "echo" });
    expect(rows[0].runningAgents).toEqual([expect.objectContaining({ key: toolUseId, subagentType: "general-purpose" })]);
    expect(typeof rows[0].expiresAt).toBe("string");
    expect(rows[1]).toMatchObject({ approvedBy: "opus" });
    expect("approvedBy" in rows[2]).toBe(false);
    stopSubagent(OPUS_SID, toolUseId, "AG-s4b-1");
  });

  it("the approval expires after 10 minutes (time is injected)", async () => {
    const toolUseId = startSubagent(OPUS_SID);
    expect((await run(["approve", "--reason", "期限の試験"])).code).toBe(0);
    h.clock.advance(10 * MIN + 1000);
    const r = await run(["add"], entry({ name: "late" }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("403");
    stopSubagent(OPUS_SID, toolUseId, "AG-s4b-2");
  });

  it("the approval is burned by the next write even when no subagent is running (not kept for a later one)", async () => {
    expect((await run(["approve", "--reason", "先に承認"])).code).toBe(0);
    expect((await run(["add"], entry({ name: "plain" }))).code).toBe(0);
    const toolUseId = startSubagent(OPUS_SID);
    expect((await run(["add"], entry({ name: "after-burn" }))).code).toBe(1);
    stopSubagent(OPUS_SID, toolUseId, "AG-s4b-3");
  });

  it("without --reason the command refuses; an empty or 201-char reason is a 400 from the server", async () => {
    expect((await run(["approve"])).code).toBe(1);
    expect((await run(["approve", "--reason"])).code).toBe(1);
    expect((await run(["approve", "--why", "x"])).code).toBe(1);
    for (const reason of ["", "   ", "x".repeat(201), 5]) {
      const r = await post("/api/agent/routines/approval", { reason, callerSessionId: OPUS_SID });
      expect(r.status, String(reason)).toBe(400);
    }
    const ok = await post("/api/agent/routines/approval", { reason: "x".repeat(200), callerSessionId: OPUS_SID });
    expect(ok.status).toBe(200);
    h.routineApprovals.consume(OPUS_SID);
  });

  it("a caller of the wrong role, an unknown caller and a missing caller get 403 and no approval is issued", async () => {
    for (const sid of [OTHER_SONNET_SID, "99999999-9999-4999-8999-999999999999", undefined]) {
      const r = await post("/api/agent/routines/approval", { reason: "x", ...(sid !== undefined ? { callerSessionId: sid } : {}) });
      expect(r.status).toBe(403);
      expect(h.routineApprovals.peek(sid ?? "none")).toBeNull();
    }
    const denied = auditLines().filter((l) => l.action === "approvalIssued" && l.outcome === "denied");
    expect(denied.length).toBeGreaterThanOrEqual(3);
  });

  it("the entry only takes POST on exactly /approval; token rules are the same as for routines", async () => {
    const authz = { Authorization: `Bearer ${RESERVE_TOKEN}` };
    expect((await fetch(`${h.base}/api/agent/routines/approval`, { headers: authz })).status).toBe(404);
    expect((await fetch(`${h.base}/api/agent/routines/approval`, { method: "PUT", headers: { ...authz, "Content-Type": "application/json" }, body: "{}" })).status).toBe(404);
    expect((await post("/api/agent/routines/approval/enabled", { reason: "x", callerSessionId: OPUS_SID })).status).toBe(404);
    expect((await post("/api/agent/routines/approval", { reason: "x", callerSessionId: OPUS_SID }, { Authorization: `Bearer ${"0".repeat(64)}` })).status).toBe(401);
    expect((await post("/api/agent/routines/approval", { reason: "x", callerSessionId: OPUS_SID }, { ...authz, Origin: "http://evil.example" })).status).toBe(403);
  });

  it("a subagent running the command with approve is refused by the guard (the judge function)", () => {
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `node "${dataDir}/bin/ac-routine.mjs" approve --reason x` }, agent_id: "ab452e2dcf964c0a3", agent_type: "general-purpose" };
    expect(judge(input).code).toBe(2);
    expect(judge({ ...input, agent_id: undefined })).toEqual({ code: 0, stderr: "" });
  });

  it("a later approval overwrites the earlier one, and the write is approved by the later one (one approval per session)", async () => {
    const toolUseId = startSubagent(OPUS_SID);
    expect(h.sessions.get(opusAppId)?.claudeSessionId).toBe(OPUS_SID);
    expect((await run(["approve", "--reason", "先"])).code).toBe(0);
    const ui = await fetch(`${h.base}/api/sessions/${opusAppId}/routine-approval`, { method: "POST", headers: { ...headers, Origin: `http://127.0.0.1:${h.port}` } });
    // サーバーの秘密（bearer）では画面の承認は出せない。session 認証で出し直す
    expect(ui.status).toBe(403);
    h.routineApprovals.issue(OPUS_SID, "ui");
    expect(h.routineApprovals.peek(OPUS_SID)?.by).toBe("ui");
    const auditBefore = auditLines().length;
    expect((await run(["add"], entry({ name: "by-ui" }))).code).toBe(0);
    expect((await run(["add"], entry({ name: "by-ui-2" }))).code).toBe(1);
    expect(auditLines().slice(auditBefore)[0]).toMatchObject({ action: "add", outcome: "ok", approvedBy: "ui" });
    stopSubagent(OPUS_SID, toolUseId, "AG-overwrite");
  });
});

describe("S4 S5 screen approval (POST /api/sessions/:id/routine-approval)", () => {
  const url = (): string => `${h.base}/api/sessions/${opusAppId}/routine-approval`;
  const originHeader = (): Record<string, string> => ({ Origin: `http://127.0.0.1:${h.port}` });
  async function sessionToken(): Promise<string> {
    const pairing = h.auth.issuePairingCode(60_000);
    const redeem = await fetch(`${h.base}/api/pair/redeem`, { method: "POST", headers: { "Content-Type": "application/json", ...originHeader() }, body: JSON.stringify({ code: pairing }) });
    return ((await redeem.json()) as { token: string }).token;
  }

  it("S5 only the session authentication is accepted: a session token with Origin works; the server secret (bearer) is 403, the reserve token is 401", async () => {
    const session = await sessionToken();
    const ok = await fetch(url(), { method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json", ...originHeader() } });
    expect(ok.status).toBe(200);
    expect(h.routineApprovals.peek(OPUS_SID)).not.toBeNull();
    h.routineApprovals.consume(OPUS_SID);
    const bearer = await fetch(url(), { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
    expect(bearer.status).toBe(403);
    expect(h.routineApprovals.peek(OPUS_SID)).toBeNull();
    const reserve = await fetch(url(), { method: "POST", headers: { Authorization: `Bearer ${RESERVE_TOKEN}`, "Content-Type": "application/json" } });
    expect(reserve.status).toBe(401);
    const noOrigin = await fetch(url(), { method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" } });
    expect(noOrigin.status).toBe(403);
    expect(h.routineApprovals.peek(OPUS_SID)).toBeNull();
  });

  it("S4 the approval lets exactly one write through, expires after 30 minutes, and leaves two audit rows (approvalIssued by ui, then approvedBy ui)", async () => {
    const session = await sessionToken();
    const toolUseId = startSubagent(OPUS_SID);
    const auditBefore = auditLines().length;
    expect((await run(["add"], entry({ name: "blocked" }))).code).toBe(1);
    const res = await fetch(url(), { method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json", ...originHeader() } });
    const body = (await res.json()) as { approved: boolean; expiresAt: string };
    expect(body.approved).toBe(true);
    expect(Date.parse(body.expiresAt) - h.clock.t).toBe(APPROVAL_TTL_MS.ui);
    const status = await fetch(url(), { headers: { Authorization: `Bearer ${session}` } });
    expect(((await status.json()) as { approval: { by: string } }).approval.by).toBe("ui");
    expect((await run(["add"], entry({ name: "passed" }))).code).toBe(0);
    expect((await run(["add"], entry({ name: "blocked-again" }))).code).toBe(1);
    const rows = auditLines().slice(auditBefore);
    expect(rows.map((l) => [l.action, l.outcome])).toEqual([["add", "denied"], ["approvalIssued", "ok"], ["add", "ok"], ["add", "denied"]]);
    expect(rows[1]).toMatchObject({ by: "ui", callerSessionId: OPUS_SID });
    expect(rows[2]).toMatchObject({ approvedBy: "ui" });
    // 30 分で切れる
    await fetch(url(), { method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json", ...originHeader() } });
    h.clock.advance(30 * MIN - 1000);
    expect(h.routineApprovals.peek(OPUS_SID)).not.toBeNull();
    h.clock.advance(2000);
    expect(h.routineApprovals.peek(OPUS_SID)).toBeNull();
    expect((await run(["add"], entry({ name: "expired" }))).code).toBe(1);
    stopSubagent(OPUS_SID, toolUseId, "AG-ui");
  });

  it("a session whose Claude session id is not known yet is a 400; an unknown session is 404", async () => {
    const session = await sessionToken();
    const fresh = await h.sessions.create({ name: "fresh", roleId: "echo" });
    const r = await fetch(`${h.base}/api/sessions/${fresh.id}/routine-approval`, { method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json", ...originHeader() } });
    expect(r.status).toBe(400);
    const missing = await fetch(`${h.base}/api/sessions/nope/routine-approval`, { method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json", ...originHeader() } });
    expect(missing.status).toBe(404);
  });
});

describe("A a failed write gives the approval back", () => {
  it("A1 a 400 from the routine service (bad time) does not burn the approval: the same approval lets a valid update through once, then 403", async () => {
    const added = await run(["add"], entry({ name: "a1" }));
    const id = (JSON.parse(added.stdout) as { id: string }).id;
    const toolUseId = startSubagent(OPUS_SID);
    expect((await run(["approve", "--reason", "A1 の承認"])).code).toBe(0);
    const bad = await run(["update", id], entry({ name: "a1", timeHHmm: "25:99" }));
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("400");
    expect(h.routineApprovals.peek(OPUS_SID)?.by).toBe("opus");
    const auditBefore = auditLines().length;
    expect((await run(["update", id], entry({ name: "a1", promptText: "ok" }))).code).toBe(0);
    expect(auditLines().slice(auditBefore)).toMatchObject([{ action: "update", outcome: "ok", approvedBy: "opus" }]);
    const third = await run(["update", id], entry({ name: "a1", promptText: "again" }));
    expect(third.code).toBe(1);
    expect(third.stderr).toContain("403");
    stopSubagent(OPUS_SID, toolUseId, "AG-a1");
  });

  it("A2 hitting the limit of 10 gives the approval back and records approvalRestored:true; the same approval then disables one", async () => {
    for (const r of h.routines.list()) if (r.enabled) await h.routines.setEnabled(r.id, false);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await run(["add"], entry({ name: `a2-${i}`, enabled: true }));
      expect(r.code, r.stderr).toBe(0);
      ids.push((JSON.parse(r.stdout) as { id: string }).id);
    }
    const toolUseId = startSubagent(OPUS_SID);
    expect((await run(["approve", "--reason", "A2 の承認"])).code).toBe(0);
    const auditBefore = auditLines().length;
    const over = await run(["add"], entry({ name: "a2-over", enabled: true }));
    expect(over.code).toBe(1);
    const denied = auditLines().slice(auditBefore);
    expect(denied).toMatchObject([{ action: "add", outcome: "denied", approvalRestored: true }]);
    expect("approvedBy" in denied[0]).toBe(false);
    expect(h.routineApprovals.peek(OPUS_SID)?.by).toBe("opus");
    const ok = await run(["disable", ids[0]], JSON.stringify({ reason: "A2 の整理" }));
    expect(ok.code, ok.stderr).toBe(0);
    expect(auditLines().at(-1)).toMatchObject({ action: "disable", outcome: "ok", approvedBy: "opus" });
    stopSubagent(OPUS_SID, toolUseId, "AG-a2");
    for (const id of ids) await h.routines.setEnabled(id, false);
  });

  it("A3 an older approval is not restored after a newer one was issued and used", () => {
    const a = new RoutineApprovals(() => 1_000);
    const first = a.issue("s", "opus");
    expect(a.consume("s")).toBe(first);
    const second = a.issue("s", "ui");
    expect(a.consume("s")).toBe(second);
    expect(a.restore("s", first)).toBe(false);
    expect(a.peek("s")).toBeNull();
  });

  it("A4 an expired approval is not restored (the expiry is not extended)", () => {
    let now = 1_000;
    const a = new RoutineApprovals(() => now);
    const first = a.issue("s", "opus");
    expect(a.consume("s")).toBe(first);
    now += APPROVAL_TTL_MS.opus;
    expect(a.restore("s", first)).toBe(false);
    expect(a.peek("s")).toBeNull();
    // 期限内なら同じ参照が戻り、期限はそのまま
    const second = a.issue("s", "opus");
    expect(a.consume("s")).toBe(second);
    expect(a.restore("s", second)).toBe(true);
    expect(a.peek("s")).toBe(second);
  });

  it("A5 does not overwrite an approval that is already in the map", () => {
    const a = new RoutineApprovals(() => 1_000);
    const first = a.issue("s", "opus");
    expect(a.consume("s")).toBe(first);
    const second = a.issue("s", "ui");
    expect(a.restore("s", first)).toBe(false);
    expect(a.restore("s", second)).toBe(false);
    expect(a.peek("s")).toBe(second);
  });
});

describe("RoutineApprovals (time injected)", () => {
  it("issue, peek, consume once; one per session; expiry by the injected clock", () => {
    let now = 1_000;
    const a = new RoutineApprovals(() => now);
    expect(a.consume("s")).toBeNull();
    const first = a.issue("s", "opus");
    expect(first.expiresAt).toBe(1_000 + APPROVAL_TTL_MS.opus);
    expect(a.issue("s", "ui").by).toBe("ui");
    expect(a.peek("s")?.by).toBe("ui");
    expect(a.consume("s")?.by).toBe("ui");
    expect(a.consume("s")).toBeNull();
    a.issue("t", "opus");
    now += APPROVAL_TTL_MS.opus;
    expect(a.peek("t")).toBeNull();
    expect(APPROVAL_TTL_MS).toEqual({ opus: 10 * MIN, ui: 30 * MIN });
  });
});
