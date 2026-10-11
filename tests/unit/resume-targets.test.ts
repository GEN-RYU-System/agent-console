import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RoleConfig } from "../../server/config.ts";
import { listResumeTargets, resolveResumeTarget, roleForScope } from "../../server/resume-targets.ts";
import type { WorktreeEntry } from "../../server/worktree.ts";

const roleOf = (id: string, resumeScope?: "main" | "worktree"): RoleConfig => ({
  id,
  labelKey: `role.${id}`,
  command: ["/bin/sh"],
  needsWorktree: false,
  ...(resumeScope ? { resumeCommand: ["/bin/sh"], resumeScope } : {}),
});
const ROLES = [roleOf("shell"), roleOf("opus", "main"), roleOf("sonnet", "worktree")];

const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-resume-")));
const root = path.join(base, "root");
mkdirSync(root);
execFileSync("git", ["init", "-q"], { cwd: root });
const wt = path.join(base, "wt");
mkdirSync(wt);
const other = path.join(base, "other");
mkdirSync(other);
const link = path.join(base, "link-to-other");
symlinkSync(other, link);
const linkToWt = path.join(base, "link-to-wt");
symlinkSync(wt, linkToWt);
const entries: WorktreeEntry[] = [
  { path: root, branch: "refs/heads/main" },
  { path: wt, branch: "refs/heads/release/one" },
  { path: path.join(base, "gone"), branch: "refs/heads/release/gone" },
];
const list = async (): Promise<WorktreeEntry[]> => entries;

describe("listResumeTargets (K1)", () => {
  it("returns the main checkout once (Opus) and each existing worktree except the main one (Sonnet), with the branch name", async () => {
    expect(await listResumeTargets(root, ROLES, list)).toEqual([
      { kind: "main", path: root, branch: "main", roleId: "opus" },
      { kind: "worktree", path: wt, branch: "release/one", roleId: "sonnet" },
    ]);
  });
  it("omits a kind that has no role, and falls back to the main row only when git fails", async () => {
    expect((await listResumeTargets(root, [roleOf("sonnet", "worktree")], list)).map((t) => t.kind)).toEqual(["worktree"]);
    expect((await listResumeTargets(root, ROLES, async () => Promise.reject(new Error("git failed")))).map((t) => t.kind)).toEqual(["main"]);
  });
});

describe("resolveResumeTarget (K4)", () => {
  it("accepts the main checkout as kind main and a listed worktree as kind worktree", async () => {
    expect((await resolveResumeTarget("main", root, root, ROLES, list)).role.id).toBe("opus");
    expect((await resolveResumeTarget("worktree", wt, root, ROLES, list)).role.id).toBe("sonnet");
  });
  it("rejects paths outside the list, missing, relative, and wrong kind", async () => {
    for (const [kind, p] of [
      ["worktree", other],
      ["worktree", "/"],
      ["worktree", path.join(base, "gone")],
      ["worktree", path.join(base, "nope")],
      ["worktree", "wt"],
      ["worktree", "../other"],
      ["main", wt],
      ["worktree", root],
      ["other", wt],
      ["worktree", ""],
      ["worktree", 1],
      [undefined, wt],
    ] as const) {
      await expect(resolveResumeTarget(kind, p, root, ROLES, list)).rejects.toThrow();
    }
  });
  it("rejects a symlink that leads outside the list, and spawns in the real path for a symlink to a listed worktree", async () => {
    await expect(resolveResumeTarget("worktree", link, root, ROLES, list)).rejects.toThrow();
    expect((await resolveResumeTarget("worktree", linkToWt, root, ROLES, list)).real).toBe(wt);
  });
  it("treats everything but the main checkout as outside when the worktree list cannot be read", async () => {
    await expect(resolveResumeTarget("worktree", wt, root, ROLES, async () => Promise.reject(new Error("git failed")))).rejects.toThrow();
    expect((await resolveResumeTarget("main", root, root, ROLES, async () => Promise.reject(new Error("git failed")))).real).toBe(root);
  });
  it("rejects when the kind has no role", async () => {
    await expect(resolveResumeTarget("main", root, root, [roleOf("sonnet", "worktree")], list)).rejects.toThrow();
  });
});

describe("roleForScope", () => {
  it("picks the role by resumeScope (not by order)", () => {
    expect(roleForScope([roleOf("sonnet", "worktree"), roleOf("opus", "main")], "main")?.id).toBe("opus");
    expect(roleForScope([roleOf("shell")], "main")).toBeUndefined();
  });
});
