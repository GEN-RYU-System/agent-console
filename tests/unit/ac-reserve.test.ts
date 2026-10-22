import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCommand } from "../../hooks/ac-reserve.mjs";
import { RESERVE_TOKEN, startHarness, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000 });

const CALLER = "88888888-8888-4888-8888-888888888888";
let h: Harness;
let dataDir: string;
const writeToken = (dir: string, value: unknown): void => writeFileSync(path.join(dir, "reserve-token"), typeof value === "string" ? value : JSON.stringify(value));
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), "ac-reserve-cmd-"));
const date = new Date(Date.now() + 3 * 24 * 60 * 60_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const entry = (over: Record<string, unknown> = {}): string => JSON.stringify({ name: "m", roleId: "echo", cwd: h.config.salesanchorRoot, date, time: "10:00", promptText: "hi", purpose: "measure", measureNote: "効果を測る", ...over });

beforeAll(async () => {
  h = await startHarness();
  dataDir = tmp();
  writeToken(dataDir, { port: h.port, token: RESERVE_TOKEN });
  // v0.44.0: 予約を作れる役割（echo）の会話を1つ登録し、コマンドの呼び出し元にする（入力だけの変更）
  const caller = await h.sessions.create({ name: "reserver", roleId: "echo" });
  h.sessions.setClaudeSessionId(caller.id, CALLER);
});
afterAll(async () => { await h.close(); });

describe("ac-reserve command", () => {
  it("R12 add, list and cancel go through the server and never print the token", async () => {
    const added = await runCommand({ argv: ["add"], stdinText: entry(), dataDir, callerSessionId: CALLER });
    expect(added.code).toBe(0);
    const id = (JSON.parse(added.stdout) as { id: string }).id;
    expect(h.reservations.list().some((r) => r.id === id && r.createdBy === "agent")).toBe(true);
    const listed = await runCommand({ argv: ["list"], dataDir, callerSessionId: CALLER });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(id);
    const cancelled = await runCommand({ argv: ["cancel", id], dataDir, callerSessionId: CALLER });
    expect(cancelled.code).toBe(0);
    expect(h.reservations.list().find((r) => r.id === id)?.status).toBe("cancelled");
    for (const r of [added, listed, cancelled]) { expect(r.stdout).not.toContain(RESERVE_TOKEN); expect(r.stderr).not.toContain(RESERVE_TOKEN); }
  });

  it("R12 failures exit with code 1 and a reason on stderr", async () => {
    const noPurpose = await runCommand({ argv: ["add"], stdinText: entry({ purpose: "other" }), dataDir, callerSessionId: CALLER });
    expect(noPurpose).toMatchObject({ code: 1, stdout: "" });
    expect(noPurpose.stderr).toContain("400");
    expect((await runCommand({ argv: ["add"], stdinText: "not json", dataDir, callerSessionId: CALLER })).code).toBe(1);
    expect((await runCommand({ argv: ["cancel", "missing-id"], dataDir, callerSessionId: CALLER })).code).toBe(1);
    expect((await runCommand({ argv: ["bogus"], dataDir, callerSessionId: CALLER })).code).toBe(1);
    expect((await runCommand({ argv: ["add"], stdinText: "x".repeat(70 * 1024), dataDir, callerSessionId: CALLER })).code).toBe(1);
    const wrong = tmp(); writeToken(wrong, { port: h.port, token: "0".repeat(64) });
    const denied = await runCommand({ argv: ["list"], dataDir: wrong });
    expect(denied.code).toBe(1);
    expect(denied.stderr).not.toContain("0".repeat(64));
  });

  it("R12 exits 1 when reserve-token is missing or broken", async () => {
    const missing = await runCommand({ argv: ["list"], dataDir: tmp() });
    expect(missing.code).toBe(1);
    for (const bad of ["not json", { port: h.port }, { port: "x", token: RESERVE_TOKEN }, { port: h.port, token: "short" }]) {
      const d = tmp(); writeToken(d, bad);
      expect((await runCommand({ argv: ["list"], dataDir: d })).code).toBe(1);
    }
  });

  it("R12 sends only to the port written in reserve-token", async () => {
    const hits: string[] = [];
    const other = http.createServer((req, res) => { hits.push(req.url ?? ""); res.statusCode = 200; res.end("{}"); });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherPort = (other.address() as { port: number }).port;
    const d = tmp(); writeToken(d, { port: otherPort, token: RESERVE_TOKEN });
    const before = h.reservations.list().length;
    const r = await runCommand({ argv: ["add"], stdinText: entry(), dataDir: d });
    await new Promise<void>((resolve) => other.close(() => resolve()));
    expect(r.code).toBe(0);
    expect(hits).toEqual(["/api/agent/reservations"]);
    expect(h.reservations.list()).toHaveLength(before);
  });

  const auditRows = (): Record<string, unknown>[] => {
    try { return readFileSync(path.join(h.config.dataDir, "routine-audit.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; }
  };

  it("R20 (v0.44.0) a caller that is not a reserve role session is 403: no caller, an unknown session, and a session of another role; add and cancel leave a denied row, list leaves none", async () => {
    const other = await h.sessions.create({ name: "other-role", roleId: "envcheck" });
    const OTHER = "99999999-9999-4999-8999-999999999999";
    h.sessions.setClaudeSessionId(other.id, OTHER);
    const before = auditRows().length;
    for (const callerSessionId of [undefined, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER]) {
      const r = await runCommand({ argv: ["add"], stdinText: entry(), dataDir, ...(callerSessionId !== undefined ? { callerSessionId } : {}) });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("403");
    }
    const list = await runCommand({ argv: ["list"], dataDir, callerSessionId: OTHER });
    expect(list.code).toBe(1);
    expect(list.stderr).toContain("403");
    const rows = auditRows().slice(before);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ action: "reserveCreate", outcome: "denied", error: "forbidden: caller is not a reserve role session" });
    expect(rows[2]).toMatchObject({ callerSessionId: OTHER, roleId: "envcheck" });
  });

  it("R21 (v0.44.0) an AI reservation within 60 minutes of another is a 400 with the other's name and free times; a role with reservable:false is a 400", async () => {
    const first = await runCommand({ argv: ["add"], stdinText: entry({ name: "gate-first", time: "14:00" }), dataDir, callerSessionId: CALLER });
    expect(first.code, first.stderr).toBe(0);
    const near = await runCommand({ argv: ["add"], stdinText: entry({ name: "gate-near", time: "14:30" }), dataDir, callerSessionId: CALLER });
    expect(near.code).toBe(1);
    expect(near.stderr).toContain("400");
    expect(near.stderr).toContain("schedule conflict: 「gate-first」");
    expect(near.stderr).toContain("空いている近い時刻");
    const last = auditRows().at(-1);
    expect(last).toMatchObject({ action: "reserveCreate", outcome: "denied", targetCreatedBy: "agent", callerSessionId: CALLER, roleId: "echo" });
    const id = (JSON.parse(first.stdout) as { id: string }).id;
    expect((await runCommand({ argv: ["cancel", id], dataDir, callerSessionId: CALLER })).code).toBe(0);
    expect(auditRows().at(-1)).toMatchObject({ action: "reserveCancel", outcome: "ok", reservationId: id, callerSessionId: CALLER });
  });
});
