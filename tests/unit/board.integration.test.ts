import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installBoardCommand } from "../../server/activity-setup.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const SID_A = "aaaaaaaa-2222-4333-8444-555555555555";
const SID_B = "bbbbbbbb-2222-4333-8444-555555555555";

let h: Harness;
let command: string;
const headers = { Authorization: `Bearer ${TOKEN}` };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(p: string, auth = true): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${h.base}${p}`, { headers: auth ? headers : {} });
  return { status: res.status, json: (await res.json()) as Json };
}
const board = (id: string) => get(`/api/sessions/${id}/board`);
/** 本物の命令を、Claude の Bash の子プロセスと同じ形（環境変数 CLAUDE_CODE_SESSION_ID）で動かす */
function writeBoard(claudeSessionId: string, body: unknown): { status: number | null; stderr: string } {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: claudeSessionId };
  const r = spawnSync(process.execPath, [command, "write"], { input: JSON.stringify(body), encoding: "utf8", env });
  return { status: r.status, stderr: r.stderr };
}
function sessionWith(name: string, claudeSessionId: string): { id: string } {
  const s = h.sessions.restore({ role: h.config.roles[0], name, cwd: h.config.salesanchorRoot, branch: null });
  h.sessions.setClaudeSessionId(s.id, claudeSessionId);
  return s;
}

const PLAN = {
  theme: "右の欄を作戦ボードにする",
  kgi: [{ text: "PO が画面で動いている担当と計画を見分けられる" }],
  kpis: [{ name: "試験の数", target: "100", current: "40", unit: "件" }],
  roadmap: [
    { title: "設計", status: "done" },
    { title: "実装", status: "doing" },
  ],
};

beforeAll(async () => {
  h = await startHarness();
  command = installBoardCommand(path.join(process.cwd(), "hooks"), h.config.dataDir);
});
afterAll(async () => {
  await h.close();
});

describe("K3 / §3-3: GET /api/sessions/:id/board", () => {
  it("claudeSessionId がまだ無いセッション・ボードがまだ無いセッションは {status:'none'}", async () => {
    const s = h.sessions.restore({ role: h.config.roles[0], name: "no-id", cwd: h.config.salesanchorRoot, branch: null });
    expect(await board(s.id)).toEqual({ status: 200, json: { status: "none" } });
    const fresh = sessionWith("fresh", SID_B);
    expect(await board(fresh.id)).toEqual({ status: 200, json: { status: "none" } });
  });

  it("命令で書いた内容が、そのセッションの GET に出る。書き直すと丸ごと入れ替わる。別のセッションには出ない", async () => {
    const a = sessionWith("a", SID_A);
    const b = sessionWith("b", SID_B);
    const w = writeBoard(SID_A, PLAN);
    expect(w).toEqual({ status: 0, stderr: "" });

    const ra = await board(a.id);
    expect(ra.status).toBe(200);
    expect(ra.json.status).toBe("ok");
    expect(ra.json.board).toMatchObject({ version: 1, ...PLAN });
    expect(typeof ra.json.board.updatedAt).toBe("number");
    expect((await board(b.id)).json).toEqual({ status: "none" });

    expect(writeBoard(SID_A, { theme: "書き直し", kgi: [], kpis: [], roadmap: [] }).status).toBe(0);
    const again = await board(a.id);
    expect(again.json.board).toMatchObject({ theme: "書き直し", kgi: [], kpis: [], roadmap: [] });
  });

  it("壊れたボードは {status:'invalid'}（ファイルは書き換えない）", async () => {
    const b = sessionWith("broken", "dddddddd-2222-4333-8444-555555555555");
    const file = path.join(h.config.dataDir, "boards", "dddddddd-2222-4333-8444-555555555555.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{broken");
    expect(await board(b.id)).toEqual({ status: 200, json: { status: "invalid" } });
    expect(readFileSync(file, "utf8")).toBe("{broken");
  });

  it("存在しないセッションは 404、認証が無ければ 401", async () => {
    expect((await get("/api/sessions/nope/board")).status).toBe(404);
    expect((await get("/api/sessions/nope/board", false)).status).toBe(401);
  });

  it("書き込みの口は無い（POST・PUT・DELETE は受け付けない。正本の書き手はそのセッションの Claude だけ）", async () => {
    const s = sessionWith("nowrite", "eeeeeeee-2222-4333-8444-555555555555");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await fetch(`${h.base}/api/sessions/${s.id}/board`, { method, headers: { ...headers, "Content-Type": "application/json" }, body: method === "DELETE" ? undefined : JSON.stringify(PLAN) });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(await board(s.id)).toEqual({ status: 200, json: { status: "none" } });
  });
});
