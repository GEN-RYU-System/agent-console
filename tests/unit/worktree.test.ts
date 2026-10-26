import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorktree, isValidBranch, parseWorktreePorcelain, findWorktreePath, WorktreeError } from "../../server/worktree.ts";

describe("isValidBranch", () => {
  it.each(["release/abc", "release/a1-b2-c3", "release/9x"])("accepts %s", (b) => {
    expect(isValidBranch(b)).toBe(true);
  });
  it.each([
    "main",
    "release/",
    "release/A",
    "release/-ab",
    "release/a",
    "release/a b",
    "release/a;rm",
    "release/a$(x)",
    "release/../x",
    "release/" + "a".repeat(62),
    "feat/abc",
  ])("rejects %s", (b) => {
    expect(isValidBranch(b)).toBe(false);
  });
});

const porcelain = [
  "worktree /repo",
  "HEAD aaaa",
  "branch refs/heads/main",
  "",
  "worktree /wt/release-abc",
  "HEAD bbbb",
  "branch refs/heads/release/abc",
  "",
  "worktree /wt/detached",
  "HEAD cccc",
  "detached",
  "",
].join("\n");

describe("parseWorktreePorcelain", () => {
  it("parses entries with and without branches", () => {
    const entries = parseWorktreePorcelain(porcelain);
    expect(entries).toEqual([
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/wt/release-abc", branch: "refs/heads/release/abc" },
      { path: "/wt/detached", branch: null },
    ]);
  });
  it("finds a path by short branch name", () => {
    expect(findWorktreePath(parseWorktreePorcelain(porcelain), "release/abc")).toBe("/wt/release-abc");
    expect(findWorktreePath(parseWorktreePorcelain(porcelain), "release/none")).toBeNull();
  });
});

describe("createWorktree script root and main link check (ADR-1039 2b-2)", () => {
  let tmp: string;
  let root: string;
  let tools: string;
  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-createwt-")));
    root = path.join(tmp, "root");
    tools = path.join(tmp, "tools");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(path.join(tools, "scripts"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "seed"], { cwd: root });
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const scriptBody = (mark: string, wtBase: string): string =>
    `#!/bin/bash\nprintf '%s\\n%s\\n' "$PWD" "$0" > ${mark}\ngit -C "$PWD" worktree add -q -b "$1" ${wtBase}-$$\n`;

  it("runs the script from scriptRoot with cwd root, not the same-named script under root", async () => {
    const mark = path.join(tmp, "mark-tools");
    const decoy = path.join(tmp, "mark-decoy");
    writeFileSync(path.join(tools, "scripts", "nwt.sh"), scriptBody(mark, path.join(tmp, "wt")));
    writeFileSync(path.join(root, "scripts", "nwt.sh"), `#!/bin/bash\ntouch ${decoy}\n`);
    const found = await createWorktree(root, tools, "scripts/nwt.sh", "release/cw-ok");
    expect(found.startsWith(path.join(tmp, "wt-"))).toBe(true);
    const [pwd, zero] = readFileSync(mark, "utf8").trim().split("\n");
    expect(realpathSync(pwd)).toBe(root);
    expect(zero).toBe(path.join(tools, "scripts", "nwt.sh"));
    expect(existsSync(decoy)).toBe(false);
  });

  it("fails with new-worktree script missing when scriptRoot has no script, and runs nothing", async () => {
    const decoy = path.join(tmp, "mark-decoy2");
    writeFileSync(path.join(root, "scripts", "only-root.sh"), `#!/bin/bash\ntouch ${decoy}\n`);
    await expect(createWorktree(root, tools, "scripts/only-root.sh", "release/cw-missing")).rejects.toThrow(/new-worktree script missing/);
    expect(existsSync(decoy)).toBe(false);
  });

  it("fails with main link check failed when the main .git/commondir exists, and runs no script", async () => {
    const mark = path.join(tmp, "mark-link");
    writeFileSync(path.join(tools, "scripts", "link.sh"), `#!/bin/bash\ntouch ${mark}\n`);
    const commondir = path.join(root, ".git", "commondir");
    writeFileSync(commondir, "/nonexistent\n");
    try {
      await expect(createWorktree(root, tools, "scripts/link.sh", "release/cw-link")).rejects.toThrow(/main link check failed/);
      await expect(createWorktree(root, tools, "scripts/link.sh", "release/cw-link")).rejects.toBeInstanceOf(WorktreeError);
      expect(existsSync(mark)).toBe(false);
    } finally {
      rmSync(commondir, { force: true });
    }
  });
});
