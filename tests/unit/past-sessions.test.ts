import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgentsOutput } from "../../server/agents.ts";
import { assertResumableCwd, SESSION_ID_PATTERN, toPastSessions } from "../../server/past-sessions.ts";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

describe("toPastSessions", () => {
  const rows = parseAgentsOutput(
    JSON.stringify([
      { pid: 1, status: "idle", name: "old", sessionId: ID_A, cwd: "/x", startedAt: 100 },
      { pid: 2, status: "busy", name: "new", sessionId: ID_B, cwd: "/y", startedAt: 200 },
      { pid: 3, status: "idle", name: "bad id", sessionId: "../../etc", cwd: "/z", startedAt: 300 },
      { pid: 4, status: "idle", name: "no cwd", sessionId: ID_A },
    ]),
  ) as NonNullable<ReturnType<typeof parseAgentsOutput>>;

  it("keeps only rows with a valid sessionId and cwd, newest first, and marks live ones", () => {
    const out = toPastSessions(rows, new Set([2]));
    expect(out.map((p) => [p.sessionId, p.live])).toEqual([
      [ID_B, true],
      [ID_A, false],
    ]);
  });
  it("only accepts UUID-shaped ids", () => {
    expect(SESSION_ID_PATTERN.test(ID_A)).toBe(true);
    for (const bad of ["", "x", `${ID_A};id`, `${ID_A}\n`, "$(id)", "AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]) expect(SESSION_ID_PATTERN.test(bad)).toBe(false);
  });
});

describe("assertResumableCwd", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-past-")));
  const root = path.join(base, "root");
  mkdirSync(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const wt = path.join(base, "wt");
  mkdirSync(wt);
  const other = path.join(base, "other");
  mkdirSync(other);
  const list = async (): Promise<string[]> => [root, wt];

  it("accepts the main checkout and a listed worktree", async () => {
    await expect(assertResumableCwd(root, root, list)).resolves.toBe(root);
    await expect(assertResumableCwd(wt, root, list)).resolves.toBe(wt);
  });
  it("rejects a directory that is neither, and one that does not exist", async () => {
    await expect(assertResumableCwd(other, root, list)).rejects.toThrow(/worktree/);
    await expect(assertResumableCwd(path.join(base, "gone"), root, list)).rejects.toThrow(/does not exist/);
  });
  it("rejects when the worktree list cannot be read and the directory is not the main checkout", async () => {
    await expect(assertResumableCwd(wt, root, async () => Promise.reject(new Error("git failed")))).rejects.toThrow(/worktree/);
  });
});
