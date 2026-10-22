import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCommand } from "../../hooks/ac-routine.mjs";
import { RESERVE_TOKEN, TOKEN, startHarness, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000 });

const OPUS_SID = "11111111-1111-4111-8111-111111111111";
const SONNET_SID = "22222222-2222-4222-8222-222222222222";
const MIXED_SID = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_SID = "44444444-4444-4444-8444-444444444444";

let h: Harness;
let dataDir: string;
let auditFile: string;
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), "ac-routine-cmd-"));
const auditLines = (): Record<string, unknown>[] => {
  try { return readFileSync(auditFile, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; }
};
const entry = (over: Record<string, unknown> = {}): string => JSON.stringify({ name: "r", roleId: "echo", cwd: h.config.salesanchorRoot, weekdays: [1], timeHHmm: "09:00", promptText: "hi", enabled: true, reason: "測定のため", ...over });
const run = (argv: string[], stdinText?: string, callerSessionId: string | null = OPUS_SID) => runCommand({ argv, ...(stdinText !== undefined ? { stdinText } : {}), dataDir, callerSessionId: callerSessionId ?? undefined });
const routineIds = (): string[] => h.routines.list().map((r) => r.id);

beforeAll(async () => {
  h = await startHarness();
  dataDir = tmp();
  writeFileSync(path.join(dataDir, "reserve-token"), JSON.stringify({ port: h.port, token: RESERVE_TOKEN }));
  auditFile = path.join(h.config.dataDir, "routine-audit.jsonl");
  const opus = await h.sessions.create({ name: "opus", roleId: "echo" });
  h.sessions.setClaudeSessionId(opus.id, OPUS_SID);
  const sonnet = await h.sessions.create({ name: "sonnet", roleId: "envcheck" });
  h.sessions.setClaudeSessionId(sonnet.id, SONNET_SID);
  // 同じ会話番号に、許可された役割と許可されていない役割の両方が当たる場合
  const mixedA = await h.sessions.create({ name: "mixed-a", roleId: "echo" });
  h.sessions.setClaudeSessionId(mixedA.id, MIXED_SID);
  const mixedB = await h.sessions.create({ name: "mixed-b", roleId: "langcheck" });
  h.sessions.setClaudeSessionId(mixedB.id, MIXED_SID);
});
afterAll(async () => { await h.close(); });

describe("ac-routine command and server", () => {
  it("S1 S2 S8 the manager role can add, list, update, disable and enable; the token never appears", async () => {
    const added = await run(["add"], entry());
    expect(added.code).toBe(0);
    const id = (JSON.parse(added.stdout) as { id: string }).id;
    const created = h.routines.list().find((r) => r.id === id);
    expect(created).toMatchObject({ name: "r", createdBy: "agent", enabled: true });
    expect("reason" in (created as object)).toBe(false);
    expect("callerSessionId" in (created as object)).toBe(false);
    const listed = await run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(id);
    const updated = await run(["update", id], entry({ promptText: "changed" }));
    expect(updated.code).toBe(0);
    expect(h.routines.list().find((r) => r.id === id)?.promptText).toBe("changed");
    const disabled = await run(["disable", id], JSON.stringify({ reason: "止める" }));
    expect(disabled.code).toBe(0);
    expect(h.routines.list().find((r) => r.id === id)?.enabled).toBe(false);
    const enabled = await run(["enable", id], JSON.stringify({ reason: "再開" }));
    expect(enabled.code).toBe(0);
    expect(h.routines.list().find((r) => r.id === id)?.enabled).toBe(true);
    for (const r of [added, listed, updated, disabled, enabled]) { expect(r.stdout).not.toContain(RESERVE_TOKEN); expect(r.stderr).not.toContain(RESERVE_TOKEN); }
    const lines = auditLines().filter((l) => l.routineId === id);
    expect(lines.map((l) => l.action)).toEqual(["add", "update", "disable", "enable"]);
    expect(lines.every((l) => l.outcome === "ok" && l.callerSessionId === OPUS_SID && l.roleId === "echo" && l.targetCreatedBy === "agent")).toBe(true);
    expect(lines[0].reason).toBe("測定のため");
    expect(statSync(auditFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(auditFile, "utf8")).not.toContain(RESERVE_TOKEN);
  });

  it("S3 S5 S6 S8 a non-manager role, a missing, malformed or unknown caller and a mixed-role caller are all refused with 403 and nothing changes", async () => {
    const before = routineIds();
    const auditBefore = auditLines().length;
    const cases: [string, string | null][] = [["sonnet role", SONNET_SID], ["no caller (terminal outside the app)", null], ["not a uuid", "not-a-uuid"], ["unknown uuid", UNKNOWN_SID], ["mixed roles", MIXED_SID]];
    for (const [label, sid] of cases) {
      const r = await run(["add"], entry(), sid);
      expect(r.code, label).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr, label).toContain("403");
      expect(r.stderr).toContain("起動直後は数秒〜数十秒待って再試行");
      expect(r.stderr).not.toContain(RESERVE_TOKEN);
    }
    expect(routineIds()).toEqual(before);
    const added = auditLines().slice(auditBefore);
    expect(added).toHaveLength(cases.length);
    expect(added.every((l) => l.action === "add" && l.outcome === "denied" && !("routineId" in l))).toBe(true);
    expect(added[0]).toMatchObject({ callerSessionId: SONNET_SID, roleId: "envcheck" });
    expect(added[1].callerSessionId).toBeNull();
    expect(added[2].callerSessionId).toBeNull();
    expect(added[3]).toMatchObject({ callerSessionId: UNKNOWN_SID });
    expect("roleId" in added[3]).toBe(false);
    expect(readFileSync(auditFile, "utf8")).not.toContain(RESERVE_TOKEN);
    // list も同じ照合を通る
    expect((await run(["list"], undefined, SONNET_SID)).code).toBe(1);
    // 手空きの sonnet から update/enable/disable も拒否
    const id = routineIds()[0];
    for (const argv of [["update", id], ["enable", id], ["disable", id]]) expect((await run(argv, entry(), SONNET_SID)).stderr).toContain("403");
  });

  it("S3 a closed (exited) manager session is no longer recognised", async () => {
    const gone = await h.sessions.create({ name: "gone", roleId: "echo" });
    const sid = "55555555-5555-4555-8555-555555555555";
    h.sessions.setClaudeSessionId(gone.id, sid);
    expect((await run(["list"], undefined, sid)).code).toBe(0);
    await h.sessions.close(gone.id);
    expect((await run(["list"], undefined, sid)).stderr).toContain("403");
  });

  it("the agent path goes through the same validation as the screen: omitting cwd for a main-checkout role means the main checkout, and a worktree role without branch is a 400 on both", async () => {
    const screen = async (body: Record<string, unknown>) => fetch(`${h.base}/api/routines`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "s", weekdays: [3], timeHHmm: "11:00", promptText: "p", enabled: false, ...body }) });
    const viaScreen = await screen({ roleId: "echo" });
    expect(viaScreen.status).toBe(201);
    const screenCwd = ((await viaScreen.json()) as { cwd: string }).cwd;
    const added = await run(["add"], entry({ cwd: undefined, enabled: false }));
    expect(added.code, added.stderr).toBe(0);
    const id = (JSON.parse(added.stdout) as { id: string }).id;
    expect(h.routines.list().find((r) => r.id === id)?.cwd).toBe(screenCwd);
    const noBranchAgent = await run(["add"], entry({ roleId: "wt", enabled: false }));
    expect(noBranchAgent.code).toBe(1);
    expect(noBranchAgent.stderr).toContain("400");
    expect((await screen({ roleId: "wt", cwd: h.config.salesanchorRoot })).status).toBe(400);
  });

  it("S6 input mistakes (400) leave no audit row, but a change to a routine made on the screen records targetCreatedBy ui", async () => {
    const auditBefore = auditLines().length;
    for (const [argv, stdin] of [[["add"], entry({ reason: undefined })], [["add"], entry({ reason: "" })], [["add"], entry({ reason: "x".repeat(201) })], [["add"], entry({ reason: "a\u0007b" })], [["disable", "missing-id"], JSON.stringify({ reason: "r" })], [["update", "missing-id"], entry()], [["enable", "missing-id"], JSON.stringify({ reason: "r" })], [["add"], entry({ cwd: "/nonexistent-dir-zzz" })]] as [string[], string][]) {
      const r = await run(argv, stdin);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("400");
    }
    expect(auditLines()).toHaveLength(auditBefore);
    const res = await fetch(`${h.base}/api/routines`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "po", roleId: "echo", cwd: h.config.salesanchorRoot, weekdays: [2], timeHHmm: "10:00", promptText: "po", enabled: true, createdBy: "agent" }) });
    expect(res.status).toBe(201);
    const poId = ((await res.json()) as { id: string }).id;
    // 画面から送られた createdBy は無視される（AI 分に数えられない）
    expect("createdBy" in (h.routines.list().find((r) => r.id === poId) as object)).toBe(false);
    expect((await run(["disable", poId], JSON.stringify({ reason: "PO の分を止める" }))).code).toBe(0);
    expect(h.routines.list().find((r) => r.id === poId)?.enabled).toBe(false);
    const last = auditLines().at(-1);
    expect(last).toMatchObject({ action: "disable", outcome: "ok", routineId: poId, targetCreatedBy: "ui" });
  });

  it("S2 the limit is 10 enabled agent routines: update and enabling a routine made on the screen still work, the 11th add is a 400", async () => {
    for (const id of routineIds()) await run(["disable", id], JSON.stringify({ reason: "掃除" }));
    expect(h.routines.list().filter((r) => r.enabled)).toHaveLength(0);
    // 入力だけ直す（v0.44.0 の1時間の関門）: 10 件が互いに60分以上離れるよう時刻をずらす。ids[0] は 09:00 のまま
    const slots = ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00", "23:00", "01:00", "03:00"];
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await run(["add"], entry({ name: `lim-${i}`, timeHHmm: slots[i] }));
      expect(r.code, r.stderr).toBe(0);
      ids.push((JSON.parse(r.stdout) as { id: string }).id);
    }
    expect(h.routines.list().filter((r) => r.enabled && r.createdBy === "agent")).toHaveLength(10);
    // (a) 10 件ちょうどでも、そのうち 1 件の update は成功
    expect((await run(["update", ids[0]], entry({ name: "lim-0", promptText: "u" }))).code).toBe(0);
    // (b) 画面で作った分の enable は上限を見ない
    const poDisabled = h.routines.list().find((r) => r.createdBy === undefined && !r.enabled);
    expect(poDisabled).toBeDefined();
    expect((await run(["enable", (poDisabled as { id: string }).id], JSON.stringify({ reason: "PO の分を再開" }))).code).toBe(0);
    // (c) 11 件目の add は 400
    const auditBefore = auditLines().length;
    const over = await run(["add"], entry({ name: "lim-over", timeHHmm: "05:00" }));
    expect(over.code).toBe(1);
    expect(over.stderr).toContain("400");
    expect(over.stderr).toContain("too many enabled agent routines");
    const overRow = auditLines().slice(auditBefore).at(-1) as Record<string, unknown>;
    expect(overRow).toMatchObject({ action: "add", outcome: "denied", error: "too many enabled agent routines" });
    expect("routineId" in overRow).toBe(false);
    // AI 分の enable は上限を見る: 1 件止めて新しく足し（10 件に戻す）、止めた分を戻そうとすると 400
    expect((await run(["disable", ids[1]], JSON.stringify({ reason: "一時停止" }))).code).toBe(0);
    expect((await run(["add"], entry({ name: "lim-new", timeHHmm: "05:00" }))).code).toBe(0);
    const re = await run(["enable", ids[1]], JSON.stringify({ reason: "戻す" }));
    expect(re.code).toBe(1);
    expect(re.stderr).toContain("too many enabled agent routines");
    expect(auditLines().at(-1)).toMatchObject({ action: "enable", outcome: "denied", routineId: ids[1], targetCreatedBy: "agent" });
    // update で enabled:true にする場合も同じ
    expect((await run(["update", ids[1]], entry({ name: "lim-1", enabled: true, timeHHmm: "11:00" }))).stderr).toContain("too many enabled agent routines");
    expect((await run(["update", ids[1]], entry({ name: "lim-1", enabled: false, timeHHmm: "11:00" }))).code).toBe(0);
  });

  it("S8 (v0.44.0) an AI routine within 60 minutes of another enabled routine is a 400 with the other's name and free times, and leaves a denied audit row without routineId", async () => {
    for (const id of routineIds()) await run(["disable", id], JSON.stringify({ reason: "掃除" }));
    const first = await run(["add"], entry({ name: "gate-first", weekdays: [3], timeHHmm: "15:00" }));
    expect(first.code, first.stderr).toBe(0);
    const auditBefore = auditLines().length;
    const near = await run(["add"], entry({ name: "gate-near", weekdays: [3], timeHHmm: "15:40" }));
    expect(near.code).toBe(1);
    expect(near.stderr).toContain("400");
    expect(near.stderr).toContain("schedule conflict: 「gate-first」（定期実行");
    expect(near.stderr).toContain("空いている近い時刻");
    const row = auditLines().slice(auditBefore).at(-1) as Record<string, unknown>;
    expect(row).toMatchObject({ action: "add", outcome: "denied" });
    expect(String(row.error)).toContain("schedule conflict");
    expect("routineId" in row).toBe(false);
    const ok = await run(["add"], entry({ name: "gate-ok", weekdays: [3], timeHHmm: "16:00" }));
    expect(ok.code, ok.stderr).toBe(0);
  });

  it("the entry point refuses requests with an Origin header (403) or a wrong token (401), and unknown paths and bad shapes", async () => {
    const withOrigin = await fetch(`${h.base}/api/agent/routines`, { headers: { Authorization: `Bearer ${RESERVE_TOKEN}`, Origin: "http://evil.example" } });
    expect(withOrigin.status).toBe(403);
    const bad = await fetch(`${h.base}/api/agent/routines`, { headers: { Authorization: `Bearer ${"0".repeat(64)}` } });
    expect(bad.status).toBe(401);
    expect(JSON.stringify(await bad.json())).not.toContain(RESERVE_TOKEN);
    const del = await fetch(`${h.base}/api/agent/routines/abc`, { method: "DELETE", headers: { Authorization: `Bearer ${RESERVE_TOKEN}` } });
    expect(del.status).toBe(404);
    const noEnabled = await run(["enable", "abc"], JSON.stringify({ reason: "r" }));
    expect(noEnabled.code).toBe(1);
  });

  it("command line mistakes exit 1 without contacting the server", async () => {
    for (const argv of [[], ["bogus"], ["add", "x"], ["update"], ["enable", "bad id!"], ["list", "x"]]) expect((await run(argv, "{}")).code).toBe(1);
    expect((await run(["add"], "not json")).code).toBe(1);
    expect((await run(["add"], "[]")).code).toBe(1);
    expect((await run(["add"], "x".repeat(70 * 1024))).code).toBe(1);
    expect((await runCommand({ argv: ["list"], dataDir: tmp(), callerSessionId: OPUS_SID })).code).toBe(1);
  });

  it("a callerSessionId written in the stdin JSON is ignored (only the environment value is used)", async () => {
    const r = await run(["add"], JSON.stringify({ ...JSON.parse(entry()), callerSessionId: OPUS_SID }), SONNET_SID);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("403");
  });
});

describe("routineManagerRoles is empty (no opus-designer in roles and nothing written in the config)", () => {
  it("the app can start and every caller is refused with 403", async () => {
    const h2 = await startHarness({ routineManagerRoles: [] });
    try {
      const dir = tmp();
      writeFileSync(path.join(dir, "reserve-token"), JSON.stringify({ port: h2.port, token: RESERVE_TOKEN }));
      const s = await h2.sessions.create({ name: "any", roleId: "echo" });
      h2.sessions.setClaudeSessionId(s.id, OPUS_SID);
      const r = await runCommand({ argv: ["list"], dataDir: dir, callerSessionId: OPUS_SID });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("403");
      expect(h2.routines.list()).toEqual([]);
    } finally {
      await h2.close();
    }
  });
});
