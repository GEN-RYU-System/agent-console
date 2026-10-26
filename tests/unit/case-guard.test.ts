import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GUARD = path.join(process.cwd(), "ops", "case", "case-guard.mjs");

let tmp: string;
let W: string;
let R: string;
let T: string;
let P: string;
let H: string;
let D: string;
let caseFile: string;
let denyRead: string[];

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-guard-")));
  H = path.join(tmp, "home");
  D = path.join(tmp, "data");
  W = path.join(H, "worktrees", "discord-cases", "case1");
  R = path.join(tmp, "report");
  P = path.join(tmp, "acc");
  T = path.join(P, "case1");
  for (const d of [W, R, T, path.join(P, "other"), D, path.join(W, "src", "sub"), path.join(W, ".git", "hooks"), path.join(R, ".claude"), path.join(H, ".ssh"), path.join(H, ".claude", "projects"), path.join(H, "Library", "Keychains"), path.join(W, ".claude")]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(W, "a.txt"), "a");
  writeFileSync(path.join(W, ".git", "config"), "");
  writeFileSync(path.join(W, ".git", "commondir"), "x");
  writeFileSync(path.join(D, "reserve-token"), "x");
  denyRead = [path.join(D, "reserve-token"), path.join(H, ".claude", "projects"), path.join(H, "Library", "Keychains")];
  caseFile = path.join(tmp, "case.json");
  writeFileSync(
    caseFile,
    JSON.stringify({
      worktree: W,
      report: R,
      tmp: T,
      denyWrite: [path.join(W, ".git", "hooks"), path.join(W, ".git", "config"), path.join(W, ".git", "commondir"), path.join(W, ".git", "objects", "info", "alternates"), path.join(W, ".claude"), path.join(W, ".mcp.json"), path.join(R, ".claude"), path.join(D, "hooks")],
      denyRead,
    }),
  );
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(tool: string, input: unknown, file = caseFile): { code: number | null; err: string } {
  const r = spawnSync(process.execPath, [GUARD, file], { input: JSON.stringify({ tool_name: tool, tool_input: input }), encoding: "utf8" });
  return { code: r.status, err: r.stderr };
}
const code = (tool: string, input: unknown): number | null => run(tool, input).code;

describe("case-guard: Edit / Write", { timeout: 20_000 }, () => {
  it("allows files in W (existing or not yet created) and in R", () => {
    for (const tool of ["Edit", "Write"]) {
      expect(code(tool, { file_path: path.join(W, "a.txt") })).toBe(0);
      expect(code(tool, { file_path: path.join(W, "new", "deep", "b.txt") })).toBe(0);
      expect(code(tool, { file_path: path.join(R, "report.md") })).toBe(0);
    }
  });
  it("blocks R/.claude, protected .git parts, W/.claude and files outside W", () => {
    expect(code("Write", { file_path: path.join(R, ".claude", "agents", "x.md") })).toBe(2);
    expect(code("Edit", { file_path: path.join(W, ".git", "config") })).toBe(2);
    expect(code("Write", { file_path: path.join(W, ".git", "hooks", "pre-commit") })).toBe(2);
    expect(code("Write", { file_path: path.join(W, ".git", "commondir") })).toBe(2);
    expect(code("Write", { file_path: path.join(W, ".claude", "settings.json") })).toBe(2);
    expect(code("Write", { file_path: path.join(H, ".bashrc") })).toBe(2);
    expect(code("Write", { file_path: path.join(D, "hooks", "x.mjs") })).toBe(2);
  });
  it("blocks a hard link in W to a file outside (Edit and Read)", () => {
    const outside = path.join(H, "secret.txt");
    writeFileSync(outside, "s");
    linkSync(outside, path.join(W, "linked.txt"));
    expect(code("Edit", { file_path: path.join(W, "linked.txt") })).toBe(2);
    expect(code("Read", { file_path: path.join(W, "linked.txt") })).toBe(2);
  });
  it("blocks a symlink in W that points outside, ../ that leaves W, relative paths and bad inputs", () => {
    symlinkSync(H, path.join(W, "homelink"));
    expect(code("Write", { file_path: path.join(W, "homelink", "x") })).toBe(2);
    expect(code("Write", { file_path: path.join(W, "a", "..", "..", "x") })).toBe(2);
    expect(code("Write", { file_path: "a.txt" })).toBe(2);
    expect(code("Write", { file_path: 5 })).toBe(2);
    expect(code("Write", {})).toBe(2);
  });
  it("NotebookEdit follows notebook_path", () => {
    expect(code("NotebookEdit", { notebook_path: path.join(W, "n.ipynb") })).toBe(0);
    expect(code("NotebookEdit", { notebook_path: path.join(H, "n.ipynb") })).toBe(2);
  });
  it("blocks writes into T (read only)", () => {
    expect(code("Write", { file_path: path.join(T, "x") })).toBe(2);
    expect(code("Edit", { file_path: path.join(T, "x") })).toBe(2);
  });
});

describe("case-guard: dangling links and case folding (review 102)", { timeout: 20_000 }, () => {
  it("blocks a dangling symlink in W that points to a missing path outside W (Edit, Write, Read)", () => {
    const target = path.join(H, "not-yet", "file.txt");
    symlinkSync(target, path.join(W, "dangle"));
    for (const tool of ["Edit", "Write", "Read"]) expect(code(tool, { file_path: path.join(W, "dangle") }), tool).toBe(2);
  });
  it("blocks a path below a dangling directory symlink", () => {
    symlinkSync(path.join(H, "missing-dir"), path.join(W, "dl"));
    expect(code("Write", { file_path: path.join(W, "dl", "sub", "x") })).toBe(2);
  });
  it("blocks denyWrite paths that differ only in case or Unicode form", () => {
    expect(code("Write", { file_path: path.join(R, ".Claude", "agents", "x.md") })).toBe(2);
    expect(code("Write", { file_path: path.join(W, ".MCP.json") })).toBe(2);
    expect(code("Write", { file_path: path.join(W, ".CLAUDE", "settings.json") })).toBe(2);
    expect(code("Write", { file_path: path.join(W, ".mcp.j\u017Fon") })).toBe(2);
    // U+0131 (dotless i) only folds to "i" through toUpperCase, so this one pins the toUpperCase step
    expect(code("Write", { file_path: path.join(W, ".git", "objects", "\u0131nfo", "alternates") })).toBe(2);
  });
  it("blocks denyRead paths that differ only in case", () => {
    expect(code("Read", { file_path: path.join(D, "Reserve-Token") })).toBe(2);
  });
  it("still allows a missing file in W whose name has capitals (allow list is compared as written)", () => {
    expect(code("Write", { file_path: path.join(W, "Src", "New.ts") })).toBe(0);
  });
});

describe("case-guard: Read / Grep / Glob", { timeout: 20_000 }, () => {
  it("allows T, W and R, but not another case's tmp under P", () => {
    writeFileSync(path.join(T, "t.txt"), "t");
    for (const tool of ["Read", "Grep", "Glob"]) {
      const key = tool === "Read" ? "file_path" : "path";
      expect(code(tool, tool === "Glob" ? { pattern: "*", path: T } : { [key]: path.join(T, "t.txt") }), tool).toBe(0);
      expect(code(tool, tool === "Glob" ? { pattern: "*", path: path.join(P, "other") } : { [key]: path.join(P, "other", "x") }), tool).toBe(2);
    }
    expect(code("Read", { file_path: path.join(W, "a.txt") })).toBe(0);
    expect(code("Read", { file_path: path.join(R, "x") })).toBe(0);
  });
  it("blocks the secret places and anything else outside", () => {
    expect(code("Read", { file_path: path.join(D, "reserve-token") })).toBe(2);
    expect(code("Read", { file_path: path.join(H, ".claude", "projects", "x") })).toBe(2);
    expect(code("Read", { file_path: path.join(H, ".ssh", "id") })).toBe(2);
  });
  it("blocks an ancestor path (the home, /, Keychains) for Grep and Glob; no path means W", () => {
    expect(code("Grep", { pattern: "x", path: H })).toBe(2);
    expect(code("Grep", { pattern: "x", path: "/" })).toBe(2);
    expect(code("Grep", { pattern: "x", path: path.join(H, "Library", "Keychains") })).toBe(2);
    expect(code("Grep", { pattern: "x" })).toBe(0);
    expect(code("Glob", { pattern: "*.ts" })).toBe(0);
  });
  it("checks the Glob pattern", () => {
    expect(code("Glob", { pattern: "/etc/**" })).toBe(2);
    expect(code("Glob", { pattern: "~/x" })).toBe(2);
    expect(code("Glob", { pattern: "../x" })).toBe(2);
    expect(code("Glob", { pattern: 5 })).toBe(2);
    expect(code("Glob", { pattern: "src/**" })).toBe(0);
  });
  it("does not stop on a directory's link count (a directory with subdirectories has nlink >= 2)", () => {
    expect(code("Grep", { pattern: "x", path: W })).toBe(0);
    expect(code("Glob", { pattern: "*", path: path.join(W, "src") })).toBe(0);
  });
});

describe("case-guard: other tools", { timeout: 20_000 }, () => {
  it("lets Agent through only with the known keys", () => {
    const base = { description: "d", prompt: "p", subagent_type: "general-purpose" };
    expect(code("Agent", base)).toBe(0);
    expect(code("Agent", { ...base, isolation: "worktree" })).toBe(2);
    expect(code("Agent", { ...base, name: "n" })).toBe(2);
    expect(code("Agent", { ...base, whatever: 1 })).toBe(2);
  });
  it("blocks mcp, WebFetch, WebSearch and unknown tools; lets Bash and TodoWrite through", () => {
    for (const t of ["mcp__x__y", "WebFetch", "WebSearch", "EnterWorktree"]) expect(code(t, {}), t).toBe(2);
    for (const t of ["Bash", "TodoWrite"]) expect(code(t, { command: "ls" }), t).toBe(0);
  });
  it("blocks on broken JSON and on a missing case file", () => {
    const r = spawnSync(process.execPath, [GUARD, caseFile], { input: "{not json", encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(run("Bash", {}, path.join(tmp, "nope.json")).code).toBe(2);
  });
});
