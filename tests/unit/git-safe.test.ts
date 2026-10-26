import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkGitLink, checkMainLink, safeGitArgs } from "../../server/git-safe.ts";

// git を何度も起動する試験。機械が混んでいても 5 秒の既定に収まらないことがあるため長くする
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });

let tmp: string;
let main: string;
let n = 0;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-gitsafe-")));
  main = path.join(tmp, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(path.join(main, "a.txt"), "1\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 新しい worktree と、その gitdir（G）を返す */
function fresh(detach = false): { dir: string; G: string } {
  const dir = path.join(tmp, `wt-${n++}`);
  if (detach) git(main, "worktree", "add", "-q", "--detach", dir);
  else git(main, "worktree", "add", "-q", "-b", `release/t-${n}`, dir);
  return { dir, G: git(dir, "rev-parse", "--absolute-git-dir").trim() };
}
/** 本店のコピー（worktrees を除く）= 偽の置き場 */
function fakeStore(): string {
  const fake = path.join(tmp, `fake-${n++}`);
  cpSync(path.join(main, ".git"), fake, { recursive: true, filter: (s) => path.relative(path.join(main, ".git"), s).split(path.sep)[0] !== "worktrees" });
  return fake;
}

describe("checkMainLink", () => {
  it("is null for a real main checkout and fails (without throwing) for each tampered form", async () => {
    expect(await checkMainLink(main)).toBeNull();
    const m = path.join(tmp, "m-bad");
    mkdirSync(m);
    git(m, "init", "-q");
    expect(await checkMainLink(m)).toBeNull();
    writeFileSync(path.join(m, ".git", "commondir"), "/x\n");
    expect(await checkMainLink(m)).toContain("commondir");
    rmSync(path.join(m, ".git", "commondir"));
    writeFileSync(path.join(m, ".git", "config.worktree"), "");
    expect(await checkMainLink(m)).toContain("config.worktree");
    const s = path.join(tmp, "m-sym");
    mkdirSync(s);
    symlinkSync(path.join(main, ".git"), path.join(s, ".git"));
    expect(await checkMainLink(s)).not.toBeNull();
    const none = path.join(tmp, "m-none");
    mkdirSync(none);
    expect(await checkMainLink(none)).not.toBeNull();
    expect(await checkMainLink(path.join(tmp, "does-not-exist"))).not.toBeNull();
  });
});

describe("checkGitLink", () => {
  it("is null for the main checkout, a worktree and a detached worktree", async () => {
    expect(await checkGitLink(main, main)).toBeNull();
    expect(await checkGitLink(fresh().dir, main)).toBeNull();
    expect(await checkGitLink(fresh(true).dir, main)).toBeNull();
  });

  it("fails when the main .git/commondir exists, even for a worktree", async () => {
    const { dir } = fresh();
    const commondir = path.join(main, ".git", "commondir");
    writeFileSync(commondir, "/x\n");
    try {
      expect(await checkGitLink(main, main)).not.toBeNull();
      expect(await checkGitLink(dir, main)).not.toBeNull();
    } finally {
      rmSync(commondir, { force: true });
    }
  });

  it("fails when the worktree .git is a symlink, a directory, two lines, not gitdir:, or missing", async () => {
    const forms: Array<(dotgit: string, content: string) => void> = [
      (p, c) => {
        const real = `${p}.real`;
        writeFileSync(real, c);
        rmSync(p);
        symlinkSync(real, p);
      },
      (p) => {
        rmSync(p);
        mkdirSync(p);
      },
      (p, c) => writeFileSync(p, `${c}gitdir: /elsewhere\n`),
      (p) => writeFileSync(p, "nonsense\n"),
      (p) => rmSync(p),
    ];
    for (const mutate of forms) {
      const { dir } = fresh();
      const dotgit = path.join(dir, ".git");
      mutate(dotgit, readFileSync(dotgit, "utf8"));
      expect(await checkGitLink(dir, main), mutate.toString()).not.toBeNull();
    }
  });

  it("fails when .git points at a gitdir outside the main .git/worktrees (a copy)", async () => {
    const { dir, G } = fresh();
    const copy = path.join(tmp, `gd-copy-${n++}`);
    cpSync(G, copy, { recursive: true });
    writeFileSync(path.join(dir, ".git"), `gitdir: ${copy}\n`);
    expect(await checkGitLink(dir, main)).toContain("outside");
  });

  it("fails when commondir points at a fake store, gitdir points elsewhere, or G/config or G/config.worktree exist", async () => {
    let w = fresh();
    writeFileSync(path.join(w.G, "commondir"), `${fakeStore()}\n`);
    expect(await checkGitLink(w.dir, main)).toContain("commondir");
    w = fresh();
    writeFileSync(path.join(w.G, "gitdir"), `${path.join(tmp, "somewhere", ".git")}\n`);
    expect(await checkGitLink(w.dir, main)).toContain("gitdir");
    w = fresh();
    writeFileSync(path.join(w.G, "config"), "");
    expect(await checkGitLink(w.dir, main)).toContain("config");
    w = fresh();
    writeFileSync(path.join(w.G, "config.worktree"), "");
    expect(await checkGitLink(w.dir, main)).toContain("config.worktree");
  });
});

describe("safeGitArgs", () => {
  it("puts the config overrides before -C and keeps the given args", () => {
    expect(safeGitArgs("/x", ["rev-parse", "HEAD"])).toEqual(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", "/x", "rev-parse", "HEAD"]);
  });
});
