import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST_MAX_BYTES, activityFileName, buildRecord } from "../../hooks/activity-hook.mjs";
import { readLstart, type MainProcess } from "../../server/case-proxy.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const CASE_ID = "11111111-2222-4333-8444-555555555555";
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_SID = "99999999-8888-4777-8666-555555555555";
const PATH = "/api/agent/case-activity";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

/** 件の本体の役の sh と、その子の sleep（hook の役）。本物のプロセスで親子の鎖を作る */
async function mainAndChild(): Promise<{ main: ChildProcess; child: number; lstart: string }> {
  const main = spawn("sh", ["-c", "sleep 60 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
  cleanups.push(() => void main.kill("SIGKILL"));
  const child = await new Promise<number>((resolve) => main.stdout?.once("data", (d: Buffer) => resolve(Number(d.toString().trim()))));
  cleanups.push(() => void process.kill(child, "SIGKILL"));
  return { main, child, lstart: (await readLstart(main.pid as number)) as string };
}

interface Rig {
  h: Harness;
  caseDir: string;
  activityDir: string;
  /** lookupPid が返す pid の一覧（試験で差し替える） */
  pids: { value: number[] };
  ports: number[];
}

async function rig(): Promise<Rig> {
  const pids = { value: [] as number[] };
  const ports: number[] = [];
  const h = await startHarness({ lookupPid: async (port) => (ports.push(port), pids.value) });
  cleanups.push(() => h.close());
  const caseDir = path.join(h.config.dataDir, "cases", CASE_ID);
  mkdirSync(caseDir, { recursive: true });
  return { h, caseDir, activityDir: path.join(h.config.dataDir, "activity"), pids, ports };
}

function post(h: Harness, body: string | Buffer, headers: Record<string, string> = {}, method = "POST"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: h.port, path: PATH, method, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const stop = (sid: string, message = "done"): string => JSON.stringify({ session_id: sid, hook_event_name: "Stop", last_assistant_message: message });
const eventLines = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l !== "")) : []);

describe("POST /api/agent/case-activity", () => {
  it("403 when an Origin header is present (before anything else is looked at)", async () => {
    const r = await rig();
    const res = await post(r.h, stop(SID), { origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect(r.ports).toEqual([]);
  });

  it("421 for a wrong Host (the same check as the other agent entrances), 405 for a method other than POST", async () => {
    const r = await rig();
    expect((await post(r.h, stop(SID), { host: "evil.example" })).status).toBe(421);
    expect((await post(r.h, "", {}, "GET")).status).toBe(405);
  });

  it("401 when the sender cannot be tied to a case main process: no record, no pid, two pids, or no ancestor that is a main", async () => {
    const r = await rig();
    const { main, child, lstart } = await mainAndChild();
    // 記録が無い
    r.pids.value = [process.pid, child];
    expect((await post(r.h, stop(SID))).status).toBe(401);
    const record = (pid: number, ls: string): MainProcess => ({ pid, lstart: ls });
    vi.spyOn(r.h.sessions, "caseMainProcesses").mockReturnValue(new Map([[CASE_ID, record(main.pid as number, lstart)]]));
    // 引けない・自分だけ
    r.pids.value = [];
    expect((await post(r.h, stop(SID))).status).toBe(401);
    r.pids.value = [process.pid];
    expect((await post(r.h, stop(SID))).status).toBe(401);
    // 2 つ
    r.pids.value = [process.pid, child, (main.pid as number)];
    expect((await post(r.h, stop(SID))).status).toBe(401);
    // 行き着かない（このテストのプロセス自身は、本体の祖先ではあっても子孫ではない）
    r.pids.value = [process.pid, process.ppid];
    expect((await post(r.h, stop(SID))).status).toBe(401);
    // 開始時刻が違えば本体ではない
    vi.spyOn(r.h.sessions, "caseMainProcesses").mockReturnValue(new Map([[CASE_ID, record(main.pid as number, `${lstart} x`)]]));
    r.pids.value = [process.pid, child];
    expect((await post(r.h, stop(SID))).status).toBe(401);
    expect(eventLines(r.activityDir)).toEqual([]);
    expect(existsSync(path.join(r.caseDir, "session-id"))).toBe(false);
  });

  it("does not read the body before the case is known: invalid JSON from an unknown sender is 401, not 400", async () => {
    const r = await rig();
    r.pids.value = [];
    expect((await post(r.h, "{ not json".repeat(5000))).status).toBe(401);
  });

  it("204 and one line in today's events-YYYYMMDD.jsonl, the same shape the hook writes (found by walking up from the sender's pid)", async () => {
    const r = await rig();
    const { main, child, lstart } = await mainAndChild();
    vi.spyOn(r.h.sessions, "caseMainProcesses").mockReturnValue(new Map([[CASE_ID, { pid: main.pid as number, lstart }]]));
    r.pids.value = [process.pid, child];
    const body = stop(SID, "hello from the room");
    const before = Date.now();
    const res = await post(r.h, body);
    expect(res.status).toBe(204);
    const lines = eventLines(r.activityDir);
    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0]) as { ts: number };
    expect(readdirSync(r.activityDir)).toEqual([activityFileName(written.ts)]);
    expect(written.ts).toBeGreaterThanOrEqual(before);
    expect(written).toEqual(buildRecord(JSON.parse(body), written.ts));
    expect(written).toMatchObject({ event: "Stop", session_id: SID, last_assistant_message: "hello from the room" });
    // 出発の pid そのものが本体のときも、その件
    r.pids.value = [process.pid, main.pid as number];
    expect((await post(r.h, stop(SID))).status).toBe(204);
    expect(eventLines(r.activityDir)).toHaveLength(2);
  });

  it("pins the first session_id in D/cases/<id>/session-id (it survives a restart) and answers 409 to a different one", async () => {
    const r = await rig();
    const { main, child, lstart } = await mainAndChild();
    vi.spyOn(r.h.sessions, "caseMainProcesses").mockReturnValue(new Map([[CASE_ID, { pid: main.pid as number, lstart }]]));
    r.pids.value = [process.pid, child];
    // 同時に違う番号が来ても、最初に受けた 1 つだけが残る
    const [a, b] = await Promise.all([post(r.h, stop(SID)), post(r.h, stop(OTHER_SID))]);
    expect([a.status, b.status].sort()).toEqual([204, 409]);
    const pinned = JSON.parse(readFileSync(path.join(r.caseDir, "session-id"), "utf8")) as { sessionId: string };
    expect([SID, OTHER_SID]).toContain(pinned.sessionId);
    const other = pinned.sessionId === SID ? OTHER_SID : SID;
    expect((await post(r.h, stop(other))).status).toBe(409);
    expect((await post(r.h, stop(pinned.sessionId))).status).toBe(204);
    expect(eventLines(r.activityDir)).toHaveLength(2);
    for (const l of eventLines(r.activityDir)) expect((JSON.parse(l) as { session_id: string }).session_id).toBe(pinned.sessionId);
    // 起き直したサーバー（メモリに何も無い形）でも、ファイルの固定が効く
    const h2 = await startHarness({ dir: r.h.dir, lookupPid: async () => r.pids.value });
    cleanups.push(() => h2.close());
    vi.spyOn(h2.sessions, "caseMainProcesses").mockReturnValue(new Map([[CASE_ID, { pid: main.pid as number, lstart }]]));
    expect((await post(h2, stop(other))).status).toBe(409);
  });

  it("400 for a body that is not JSON (once the case is known) and for one over POST_MAX_BYTES; a session_id that is not a UUID is not written and not pinned", async () => {
    const r = await rig();
    const { main, child, lstart } = await mainAndChild();
    vi.spyOn(r.h.sessions, "caseMainProcesses").mockReturnValue(new Map([[CASE_ID, { pid: main.pid as number, lstart }]]));
    r.pids.value = [process.pid, child];
    expect((await post(r.h, "{ not json")).status).toBe(400);
    expect((await post(r.h, JSON.stringify({ filler: "x".repeat(POST_MAX_BYTES) }))).status).toBe(400);
    const res = await post(r.h, JSON.stringify({ session_id: "not-a-uuid", hook_event_name: "Stop" }));
    expect(res.status).toBe(204);
    expect(eventLines(r.activityDir)).toEqual([]);
    expect(existsSync(path.join(r.caseDir, "session-id"))).toBe(false);
  });

  it("a big input (a Stop with 100KiB) is cut into one line with the truncated mark, like the file form", async () => {
    const r = await rig();
    const { main, child, lstart } = await mainAndChild();
    vi.spyOn(r.h.sessions, "caseMainProcesses").mockReturnValue(new Map([[CASE_ID, { pid: main.pid as number, lstart }]]));
    r.pids.value = [process.pid, child];
    expect((await post(r.h, stop(SID, "y".repeat(100 * 1024)))).status).toBe(204);
    const lines = eventLines(r.activityDir);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: "Stop", truncated: true });
  });

  it("401 when the case directory is gone (nothing is created for a removed case)", async () => {
    const r = await rig();
    const { main, child, lstart } = await mainAndChild();
    vi.spyOn(r.h.sessions, "caseMainProcesses").mockReturnValue(new Map([[CASE_ID, { pid: main.pid as number, lstart }]]));
    r.pids.value = [process.pid, child];
    const { rmSync } = await import("node:fs");
    rmSync(r.caseDir, { recursive: true });
    expect((await post(r.h, stop(SID))).status).toBe(401);
    expect(existsSync(r.caseDir)).toBe(false);
  });
});
