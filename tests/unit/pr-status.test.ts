import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ciOf,
  ciOfResponse,
  classifyGhFailure,
  GhFailure,
  isSafeBranch,
  parseGitHubRepo,
  runGh,
  safeGithubUrl,
  summarizeChecks,
  type PrResponse,
} from "../../server/pr-status.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
const STUB = path.join(here, "..", "fixtures", "gh-stub.sh");

describe("parseGitHubRepo (設計 3-1)", () => {
  it("accepts https and ssh forms of github.com, with or without .git", () => {
    expect(parseGitHubRepo("https://github.com/shingo-cc/agent-console.git")).toBe("shingo-cc/agent-console");
    expect(parseGitHubRepo("https://github.com/shingo-cc/agent-console")).toBe("shingo-cc/agent-console");
    expect(parseGitHubRepo("git@github.com:shingo-ops/salesanchor.git")).toBe("shingo-ops/salesanchor");
    expect(parseGitHubRepo("git@github.com:a.b/c_d-e")).toBe("a.b/c_d-e");
  });
  it("rejects everything else", () => {
    for (const u of ["https://gitlab.com/a/b.git", "/Users/x/repo", "https://github.com/a", "https://github.com/a/b/c", "http://github.com/a/b", "https://github.com.evil.example/a/b", "https://github.com/a/b; rm", "", "ssh://git@github.com/a/b.git"]) {
      expect(parseGitHubRepo(u), u).toBeNull();
    }
  });
});

describe("isSafeBranch (設計 3-1)", () => {
  it("accepts ordinary branch names", () => {
    for (const b of ["main", "release/pr-ci", "feature/a.b_c-d", "v1.2"]) expect(isSafeBranch(b), b).toBe(true);
  });
  it("rejects names that start with '-' or hold characters outside the whitelist", () => {
    for (const b of ["-x", "--head", "a b", "a;b", "a$(b)", "a`b`", "", "a\nb", "日本語"]) expect(isSafeBranch(b), JSON.stringify(b)).toBe(false);
  });
});

describe("safeGithubUrl (K8)", () => {
  it("keeps only https://github.com/ urls", () => {
    expect(safeGithubUrl("https://github.com/a/b/pull/1")).toBe("https://github.com/a/b/pull/1");
    for (const u of ["javascript:alert(1)", "http://github.com/a/b", "https://github.com.evil.example/x", "https://evil.example/https://github.com/", "//github.com/x", "", null, undefined, 5]) {
      expect(safeGithubUrl(u), String(u)).toBe("");
    }
  });
});

describe("summarizeChecks / ciOf (K2, K3)", () => {
  const row = (bucket: string, name = `n-${bucket}`, link = "https://github.com/a/b/actions/runs/1") => ({ name, state: "X", bucket, link, workflow: "ci" });

  it("counts the five buckets and lists only fail, cancel and pending (fail, cancel, pending order)", () => {
    const s = summarizeChecks([row("pass"), row("pass", "p2"), row("skipping"), row("pending", "slow"), row("cancel", "gone"), row("fail", "red")]);
    expect(s.counts).toEqual({ pass: 2, fail: 1, pending: 1, skipping: 1, cancel: 1 });
    expect(s.items.map((i) => [i.name, i.bucket])).toEqual([
      ["red", "fail"],
      ["gone", "cancel"],
      ["slow", "pending"],
    ]);
  });
  it("blanks links that are not https://github.com/ (K8) and keeps the workflow name", () => {
    const s = summarizeChecks([row("fail", "a", "javascript:alert(1)"), row("fail", "b")]);
    expect(s.items.map((i) => i.link)).toEqual(["", "https://github.com/a/b/actions/runs/1"]);
    expect(s.items[0].workflow).toBe("ci");
  });
  it("treats an unknown bucket as pending (not final) and skips rows without a usable shape", () => {
    const s = summarizeChecks([row("weird"), null, 5, { bucket: "pass" }]);
    expect(s.counts).toEqual({ pass: 0, fail: 0, pending: 1, skipping: 0, cancel: 0 });
  });
  it("ciOf: fail or cancel -> fail; else pending -> pending; else all pass/skipping -> pass; zero checks -> null", () => {
    const c = (o: Partial<Record<"pass" | "fail" | "pending" | "skipping" | "cancel", number>>) => ({ pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0, ...o });
    expect(ciOf(c({ pass: 5, fail: 1, pending: 2 }))).toBe("fail");
    expect(ciOf(c({ pass: 5, cancel: 1 }))).toBe("fail");
    expect(ciOf(c({ pass: 5, pending: 1 }))).toBe("pending");
    expect(ciOf(c({ pass: 5, skipping: 3 }))).toBe("pass");
    expect(ciOf(c({ skipping: 2 }))).toBe("pass");
    expect(ciOf(c({}))).toBeNull();
  });
});

describe("classifyGhFailure (K6)", () => {
  const fail = (o: Record<string, unknown>) => classifyGhFailure(Object.assign(new Error("x"), o));
  it("ENOENT -> ghMissing", () => expect(fail({ code: "ENOENT" }).kind).toBe("ghMissing"));
  it("killed -> timeout", () => expect(fail({ killed: true, signal: "SIGTERM", code: null }).kind).toBe("timeout"));
  it("exit 4 -> authRequired; so does stderr mentioning gh auth login", () => {
    expect(fail({ code: 4, stderr: "" }).kind).toBe("authRequired");
    expect(fail({ code: 1, stderr: "To get started with GitHub CLI, please run:  gh auth login" }).kind).toBe("authRequired");
  });
  it("rate limit text (any case) or RATE_LIMITED -> rateLimited", () => {
    expect(fail({ code: 1, stderr: "GraphQL: API rate limit exceeded for user ID 1." }).kind).toBe("rateLimited");
    expect(fail({ code: 1, stderr: "type: RATE_LIMITED" }).kind).toBe("rateLimited");
  });
  it("anything else -> ghFailed, with the first 300 chars of stderr kept for the server log", () => {
    const f = fail({ code: 1, stderr: "x".repeat(500) });
    expect(f.kind).toBe("ghFailed");
    expect(f.stderr.length).toBe(300);
  });
});

describe("runGh (K7: gh は pr list / view / checks だけ)", () => {
  let dir: string;
  let logFile: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ac-prstatus-"));
    logFile = path.join(dir, "gh.log");
    writeFileSync(logFile, "");
    mkdirSync(path.join(dir, "fx"));
    process.env.STUB_GH_DIR = path.join(dir, "fx");
    process.env.STUB_GH_LOG = logFile;
    chmodSync(STUB, 0o755);
  });
  const run = (args: string[]) => runGh(STUB, args, { cwd: os.tmpdir(), timeoutMs: 5000 });

  it("refuses every other gh command before spawning anything", async () => {
    const forbidden = [
      ["pr", "merge", "1"],
      ["pr", "create"],
      ["pr", "close", "1"],
      ["pr", "comment", "1"],
      ["pr", "review", "1"],
      ["pr", "edit", "1"],
      ["pr"],
      ["api", "repos/a/b"],
      ["issue", "list"],
      ["auth", "token"],
      ["list", "pr"],
      [],
    ];
    for (const args of forbidden) await expect(run(args), args.join(" ")).rejects.toThrow(/not allowed/);
    expect(readFileSync(logFile, "utf8")).toBe("");
  });

  it("runs pr list / view / checks, with GH_PROMPT_DISABLED=1 and GH_NO_UPDATE_NOTIFIER=1 in the child env", async () => {
    writeFileSync(path.join(dir, "fx", "list.out"), "[]");
    await expect(run(["pr", "list", "--head", "x"])).resolves.toBe("[]");
    await run(["pr", "view", "1"]);
    await run(["pr", "checks", "1"]);
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toMatch(/\| GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1$/);
  });

  it("throws GhFailure(timeout) when gh does not answer in time, and GhFailure(ghMissing) when it is not there", async () => {
    writeFileSync(path.join(dir, "fx", "view.delay"), "5");
    const t = await runGh(STUB, ["pr", "view", "1"], { cwd: os.tmpdir(), timeoutMs: 300 }).catch((e: unknown) => e);
    expect(t).toBeInstanceOf(GhFailure);
    expect((t as GhFailure).kind).toBe("timeout");
    const m = await runGh("/nonexistent/gh", ["pr", "view", "1"], { cwd: os.tmpdir(), timeoutMs: 1000 }).catch((e: unknown) => e);
    expect((m as GhFailure).kind).toBe("ghMissing");
  });
});

describe("ciOfResponse (K1: 開いている PR のときだけ一覧の印を出す)", () => {
  const counts = (over: Partial<Record<"pass" | "fail" | "pending" | "skipping" | "cancel", number>>) => ({ pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0, ...over });
  const ok = (state: "OPEN" | "MERGED" | "CLOSED", over = {}): PrResponse => ({
    status: "ok",
    pr: { number: 1, title: "t", state, isDraft: false, url: "", mergeStateStatus: "CLEAN" },
    checks: { counts: counts(over), items: [] },
    fetchedAt: 0,
  });

  it("OPEN keeps the existing values (fail / pending / pass)", () => {
    expect(ciOfResponse(ok("OPEN", { pass: 1, fail: 1 }))).toBe("fail");
    expect(ciOfResponse(ok("OPEN", { pass: 1, pending: 1 }))).toBe("pending");
    expect(ciOfResponse(ok("OPEN", { pass: 2 }))).toBe("pass");
  });
  it("CLOSED and MERGED give undefined even when checks failed", () => {
    expect(ciOfResponse(ok("CLOSED", { pass: 49, fail: 8 }))).toBeUndefined();
    expect(ciOfResponse(ok("MERGED", { pass: 3, fail: 1 }))).toBeUndefined();
  });
  it("undefined or non-ok responses give undefined", () => {
    expect(ciOfResponse(undefined)).toBeUndefined();
    expect(ciOfResponse({ status: "noPr" })).toBeUndefined();
  });
});
