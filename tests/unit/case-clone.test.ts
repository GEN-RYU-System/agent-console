import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseBranchOf, caseCloneDir, checkCaseClone, createCaseClone } from "../../server/case-clone.ts";
import { git, makeCaseRepo, pointOriginAtB, pushToB, FAKE_ORIGIN, type CaseRepo } from "./helpers/case-repo.ts";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const ID = "11111111-2222-4333-8444-555555555555";
let r: CaseRepo;
let restore: () => void;
beforeEach(() => {
  r = makeCaseRepo();
  restore = pointOriginAtB(r.B, ["https://x@github.com/test/repo.git"]);
});
afterEach(() => {
  restore();
  r.cleanup();
});

let seq = 0;
const newId = (): string => `aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

describe("createCaseClone", () => {
  it("makes a detached clone of B's main (not M's older local main) with the pinned config and a ledger row", async () => {
    const W = await createCaseClone({ M: r.M, H: r.H, id: ID });
    expect(W).toBe(path.join(r.H, "worktrees", "discord-cases", ID));
    expect(await checkCaseClone(W, r.M)).toBeNull();
    const branch = caseBranchOf(ID);
    expect(branch).toBe("release/discord-case-11111111");
    expect(git(W, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
    expect(git(W, "rev-parse", "HEAD").trim()).toBe(r.mainSha);
    expect(r.mainSha).not.toBe(r.localMainSha);
    expect(readFileSync(path.join(W, "a.txt"), "utf8")).toBe("2\n");
    expect(git(W, "config", "--local", "core.hooksPath").trim()).toBe("frontend/.husky");
    expect(git(W, "config", "--local", "user.name").trim()).toBe("Case Tester");
    expect(git(W, "config", "--local", "user.email").trim()).toBe("case@example.invalid");
    expect(git(W, "config", "--local", "remote.origin.url").trim()).toBe(FAKE_ORIGIN);
    expect(git(W, "config", "--local", `branch.${branch}.remote`).trim()).toBe("origin");
    expect(git(W, "config", "--local", `branch.${branch}.merge`).trim()).toBe(`refs/heads/${branch}`);
    // pack のリンクの数が 1（--no-hardlinks）
    const packDir = path.join(W, ".git", "objects", "pack");
    const packs = readdirSync(packDir).filter((f) => f.endsWith(".pack"));
    expect(packs.length).toBeGreaterThan(0);
    for (const f of packs) expect(lstatSync(path.join(packDir, f)).nlink).toBe(1);
    // 台帳: 1行目が branch:、ledger-lookup.sh と同じ規則で行が1つ見つかる
    const ledger = path.join(W, ".claude-pipeline", "active-work.d", `${branch.replaceAll("/", "-")}.md`);
    const text = readFileSync(ledger, "utf8");
    expect(text.split("\n")[0]).toBe(`branch: ${branch}`);
    const rows = text.split("\n").filter((line) => {
      const cols = line.split("|");
      return cols.length >= 4 && cols[1].trim() === branch;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("IN_PROGRESS");
    expect(statSync(ledger).mode & 0o777).toBe(0o644);
  });

  it("throws and leaves no clone when B's main has no ledger file", async () => {
    pushToB(r, "drop ledger", () => rmSync(path.join(r.work, ".claude-pipeline", "active-work.md")));
    await expect(createCaseClone({ M: r.M, H: r.H, id: ID })).rejects.toThrow();
    expect(existsSync(caseCloneDir(r.H, ID))).toBe(false);
  });

  it("throws when .claude-pipeline is a symlink to a directory outside the clone, and writes nothing there", async () => {
    const outside = path.join(r.root, "outside");
    mkdirSync(path.join(outside, "active-work.d"), { recursive: true });
    writeFileSync(path.join(outside, "active-work.md"), "x\n");
    pushToB(r, "pipeline as symlink", () => {
      rmSync(path.join(r.work, ".claude-pipeline"), { recursive: true });
      symlinkSync(outside, path.join(r.work, ".claude-pipeline"));
    });
    await expect(createCaseClone({ M: r.M, H: r.H, id: ID })).rejects.toThrow();
    expect(existsSync(caseCloneDir(r.H, ID))).toBe(false);
    expect(readdirSync(path.join(outside, "active-work.d"))).toEqual([]);
  });

  it("throws and leaves no clone when M's user.email is empty", async () => {
    git(r.M, "config", "--local", "user.email", "");
    await expect(createCaseClone({ M: r.M, H: r.H, id: ID })).rejects.toThrow();
    expect(existsSync(caseCloneDir(r.H, ID))).toBe(false);
  });

  it("throws and keeps the contents of a clone that already exists", async () => {
    const W = caseCloneDir(r.H, ID);
    mkdirSync(W, { recursive: true });
    writeFileSync(path.join(W, "keep.txt"), "keep\n");
    await expect(createCaseClone({ M: r.M, H: r.H, id: ID })).rejects.toThrow();
    expect(readFileSync(path.join(W, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("throws and leaves no clone when M's origin url carries a user", async () => {
    git(r.M, "remote", "set-url", "origin", "https://x@github.com/test/repo.git");
    await expect(createCaseClone({ M: r.M, H: r.H, id: ID })).rejects.toThrow(/plain github/);
    expect(existsSync(caseCloneDir(r.H, ID))).toBe(false);
  });

  it("throws for an id that is not a UUID", async () => {
    await expect(createCaseClone({ M: r.M, H: r.H, id: "../escape" })).rejects.toThrow();
    expect(existsSync(path.join(r.H, "worktrees"))).toBe(false);
  });

  it("throws when M's .git is a symlink (checkMainLink)", async () => {
    const link = path.join(r.root, "M-link");
    mkdirSync(link);
    symlinkSync(path.join(r.M, ".git"), path.join(link, ".git"));
    await expect(createCaseClone({ M: link, H: r.H, id: ID })).rejects.toThrow(/main link check failed/);
  });
});

describe("checkCaseClone", () => {
  async function fresh(): Promise<string> {
    return createCaseClone({ M: r.M, H: r.H, id: newId() });
  }

  it("passes for a clone as made, even when the process environment sets core.hooksPath", async () => {
    const W = await fresh();
    expect(await checkCaseClone(W, r.M)).toBeNull();
    const saved = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_3, v: process.env.GIT_CONFIG_VALUE_3 };
    process.env.GIT_CONFIG_COUNT = "4";
    process.env.GIT_CONFIG_KEY_2 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_2 = "/dev/null";
    process.env.GIT_CONFIG_KEY_3 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_3 = "/dev/null";
    try {
      expect(await checkCaseClone(W, r.M)).toBeNull();
    } finally {
      delete process.env.GIT_CONFIG_KEY_2;
      delete process.env.GIT_CONFIG_VALUE_2;
      delete process.env.GIT_CONFIG_KEY_3;
      delete process.env.GIT_CONFIG_VALUE_3;
      process.env.GIT_CONFIG_COUNT = saved.c ?? "";
    }
  });

  const tampers: Array<[string, (W: string) => void]> = [
    [".git replaced by a symlink", (W) => {
      renameSync(path.join(W, ".git"), path.join(W, "..", `${path.basename(W)}-realgit`));
      symlinkSync(path.join(W, "..", `${path.basename(W)}-realgit`), path.join(W, ".git"));
    }],
    // 中身が「.」（この .git 自身）の commondir は git が受け付けるので、commondir の確かめだけがこれを落とす
    ["commondir written", (W) => writeFileSync(path.join(W, ".git", "commondir"), ".\n")],
    ["alternates written", (W) => {
      mkdirSync(path.join(W, ".git", "objects", "info"), { recursive: true });
      writeFileSync(path.join(W, ".git", "objects", "info", "alternates"), "/nonexistent-objects\n");
    }],
    ["core.hooksPath changed", (W) => void git(W, "config", "core.hooksPath", "/tmp/evil")],
    ["remote.origin.url changed", (W) => void git(W, "config", "remote.origin.url", "https://github.com/evil/repo.git")],
    ["core.fsmonitor added", (W) => void git(W, "config", "core.fsmonitor", "/tmp/evil.sh")],
    ["include.path added", (W) => {
      writeFileSync(path.join(W, "..", `${path.basename(W)}-inc`), "[core]\n\tfsmonitor = /tmp/evil.sh\n");
      git(W, "config", "include.path", path.join(W, "..", `${path.basename(W)}-inc`));
    }],
    ["filter.x.clean added", (W) => void git(W, "config", "filter.x.clean", "/tmp/evil.sh")],
    ["gitlink added", (W) => {
      const sub = path.join(W, "sub");
      mkdirSync(sub);
      git(sub, "init", "-q");
      writeFileSync(path.join(sub, "f"), "x");
      git(sub, "add", "-A");
      git(sub, "commit", "-q", "-m", "s");
      git(W, "add", "sub");
    }],
    [".gitmodules present", (W) => writeFileSync(path.join(W, ".gitmodules"), "")],
  ];
  it.each(tampers)("is not null when %s", async (_name, mutate) => {
    const W = await fresh();
    mutate(W);
    expect(await checkCaseClone(W, r.M)).not.toBeNull();
  });
});

