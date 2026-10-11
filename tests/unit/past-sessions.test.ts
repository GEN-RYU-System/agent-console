import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgentsOutput } from "../../server/agents.ts";
import { classifyCwd, SESSION_ID_PATTERN, toPastSessions, withResumability } from "../../server/past-sessions.ts";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

describe("toPastSessions", () => {
  const rows = parseAgentsOutput(
    JSON.stringify([
      { pid: 1, status: "idle", name: "old", sessionId: ID_A, cwd: "/x", startedAt: 100 },
      { pid: 2, status: "busy", name: "new", sessionId: ID_B, cwd: "/y", startedAt: 200 },
      { pid: 3, status: "idle", name: "bad id", sessionId: "../../etc", cwd: "/z", startedAt: 300 },
      { pid: 4, status: "idle", name: "no cwd", sessionId: ID_A },
      { pid: 5, status: "idle", name: "elsewhere", sessionId: ID_C, cwd: "/w", startedAt: 50 },
    ]),
  ) as NonNullable<ReturnType<typeof parseAgentsOutput>>;

  it("keeps only rows with a valid sessionId and cwd, newest first", () => {
    expect(toPastSessions(rows, new Set()).map((p) => p.sessionId)).toEqual([ID_B, ID_A, ID_C]);
  });
  it("blocks rows running in this app (by pid) and rows running anywhere (by sessionId in the current list)", () => {
    const out = toPastSessions(rows, new Set([2]), new Set([ID_C]));
    expect(out.map((p) => [p.sessionId, p.blocked])).toEqual([
      [ID_B, "running"],
      [ID_A, null],
      [ID_C, "running"],
    ]);
  });
  it("only accepts UUID-shaped ids", () => {
    expect(SESSION_ID_PATTERN.test(ID_A)).toBe(true);
    for (const bad of ["", "x", `${ID_A};id`, `${ID_A}\n`, "$(id)", "AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]) expect(SESSION_ID_PATTERN.test(bad)).toBe(false);
  });
});

describe("classifyCwd / withResumability", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-past-")));
  const root = path.join(base, "root");
  mkdirSync(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const wt = path.join(base, "wt");
  mkdirSync(wt);
  const other = path.join(base, "other");
  mkdirSync(other);
  const worktrees = [root, wt];

  it("allows only a worktree of the main checkout", async () => {
    expect(await classifyCwd(wt, root, worktrees)).toEqual({ block: null, real: wt });
  });
  it("rejects the main checkout itself (Opus designer sessions run there; resuming them is out of scope)", async () => {
    expect((await classifyCwd(root, root, worktrees)).block).toBe("main");
  });
  it("rejects a directory outside the worktree list and one that does not exist", async () => {
    expect((await classifyCwd(other, root, worktrees)).block).toBe("outside");
    expect((await classifyCwd(path.join(base, "gone"), root, worktrees)).block).toBe("missing");
  });
  it("treats everything but the main checkout as outside when the worktree list cannot be read", async () => {
    const items = toPastSessions(
      parseAgentsOutput(JSON.stringify([{ pid: 1, status: "idle", sessionId: ID_A, cwd: wt, startedAt: 1 }])) as NonNullable<ReturnType<typeof parseAgentsOutput>>,
      new Set(),
    );
    const out = await withResumability(items, root, async () => Promise.reject(new Error("git failed")));
    expect(out[0].blocked).toBe("outside");
  });
  it("labels each row with its reason and keeps 'running' first", async () => {
    const rows = parseAgentsOutput(
      JSON.stringify([
        { pid: 1, status: "idle", sessionId: ID_A, cwd: wt, startedAt: 4 },
        { pid: 2, status: "idle", sessionId: ID_B, cwd: root, startedAt: 3 },
        { pid: 3, status: "idle", sessionId: ID_C, cwd: wt, startedAt: 2 },
      ]),
    ) as NonNullable<ReturnType<typeof parseAgentsOutput>>;
    const out = await withResumability(toPastSessions(rows, new Set(), new Set([ID_C])), root, async () => worktrees);
    expect(out.map((p) => [p.sessionId, p.blocked])).toEqual([
      [ID_A, null],
      [ID_B, "main"],
      [ID_C, "running"],
    ]);
  });
});
