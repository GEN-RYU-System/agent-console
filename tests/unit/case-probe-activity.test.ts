import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLstart } from "../../server/case-proxy.ts";
import { CaseVersionProbe } from "../../server/case-say-probe.ts";
import { CaseSayVersionStore } from "../../server/case-say-versions.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const PROBE_ID = "11111111-2222-4333-8444-555555555555";
const PO_ID = "99999999-8888-4777-8666-555555555555";
const PATH = "/api/agent/case-probe-activity";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

async function mainAndChild(): Promise<{ main: ChildProcess; child: number; lstart: string }> {
  const main = spawn("sh", ["-c", "sleep 60 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
  cleanups.push(() => void main.kill("SIGKILL"));
  const child = await new Promise<number>((resolve) => main.stdout?.once("data", (d: Buffer) => resolve(Number(d.toString().trim()))));
  cleanups.push(() => void process.kill(child, "SIGKILL"));
  return { main, child, lstart: (await readLstart(main.pid as number)) as string };
}

function post(h: Harness, body: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: h.port, path: PATH, method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** 動いている probe のふりをする: runningCaseId が id を返す probe（recordTool は本物） */
function fakeRunningProbe(dir: string, caseId: string | undefined): CaseVersionProbe {
  const probe = new CaseVersionProbe(new CaseSayVersionStore(dir), {} as never);
  (probe as unknown as { runningCase: string | undefined }).runningCase = caseId;
  return probe;
}

const input = JSON.stringify({ session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "t1", permission_mode: "plan", tool_input: { file_path: "/x" } });

const pids = { value: [] as number[] };

describe("POST /api/agent/case-probe-activity", () => {

  it("is 403 for an Origin header, and 403 when the sender is not the running probe case (a PO's case cannot post)", async () => {
    const h = await startHarness({ lookupPid: async () => pids.value });
    cleanups.push(() => h.close());
    const { main, child, lstart } = await mainAndChild();
    vi.spyOn(h.sessions, "caseMainProcesses").mockReturnValue(new Map([[PO_ID, { pid: main.pid as number, lstart }]]));
    pids.value = [process.pid, child];
    expect((await post(h, input, { origin: "http://evil.example" })).status).toBe(403);
    // versionProbe が付いていない（省略）ときは、件からの送信を 403 にする
    expect((await post(h, input)).status).toBe(403);
  });

  it("204 and the record is kept in memory only for the running probe case; 403 for another case; nothing is added to the activity record", async () => {
    const probe = fakeRunningProbe("/tmp", PROBE_ID);
    const h = await startHarness({ lookupPid: async () => pids.value, versionProbe: probe });
    cleanups.push(() => h.close());
    mkdirSync(path.join(h.config.dataDir, "cases", PROBE_ID), { recursive: true });
    const { main, child, lstart } = await mainAndChild();
    vi.spyOn(h.sessions, "caseMainProcesses").mockReturnValue(new Map([[PROBE_ID, { pid: main.pid as number, lstart }]]));
    pids.value = [process.pid, child];
    const seen: unknown[] = [];
    const spy = vi.spyOn(probe, "recordTool").mockImplementation((b) => (seen.push(b), true));
    expect((await post(h, input)).status).toBe(204);
    expect(seen).toHaveLength(1);
    // 活動の記録（dataDir/activity）に 1 行も足さない
    const activityDir = path.join(h.config.dataDir, "activity");
    expect(existsSync(activityDir) ? readdirSync(activityDir) : []).toEqual([]);
    // 別の件（PO の件）からは 403
    (probe as unknown as { runningCase: string }).runningCase = PO_ID;
    expect((await post(h, input)).status).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1);
    // 送り元が件に結べないときは 401
    pids.value = [];
    expect((await post(h, input)).status).toBe(401);
  });
});
