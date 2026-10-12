import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRestoreEnabled } from "../../server/restore.ts";

describe("isRestoreEnabled (restore and recording run only on the real server)", () => {
  it.each([
    [{}, true],
    [{ AGENT_CONSOLE_RESTORE: "off" }, false],
    [{ AGENT_CONSOLE_PORT: "4320" }, false],
    [{ AGENT_CONSOLE_PORT: "4320", AGENT_CONSOLE_RESTORE: "off" }, false],
    [{ AGENT_CONSOLE_PORT: "" }, true],
    [{ AGENT_CONSOLE_PORT: undefined, AGENT_CONSOLE_RESTORE: undefined }, true],
    [{ AGENT_CONSOLE_RESTORE: "OFF" }, true],
    [{ AGENT_CONSOLE_RESTORE: "on" }, true],
  ] as Array<[Record<string, string | undefined>, boolean]>)("%j -> %s", (env, expected) => {
    expect(isRestoreEnabled(env)).toBe(expected);
  });
});

describe("tests never write to the production default dataDir", () => {
  // 既定の dataDir の文字列は、この試験自身が持たないよう分割して組み立てる
  const DEFAULT_DATA_DIR_TEXT = ["Library/Application", " Support/agent-console"].join("");
  // 許可: 「一時ディレクトリ以外は拒否する」ことを確かめる試験（scripts.test.ts）と、既定値の文字列そのものを確かめる試験
  const ALLOWED = new Set(["tests/unit/scripts.test.ts"]);

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }

  it("no test or fixture mentions the default dataDir outside the allowlist", () => {
    const root = process.cwd();
    const offenders = walk(path.join(root, "tests"))
      .map((f) => path.relative(root, f))
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => readFileSync(path.join(root, f), "utf8").includes(DEFAULT_DATA_DIR_TEXT));
    expect(offenders).toEqual([]);
  });

  it("every server child process started by server-process.test.ts is given an explicit temp dataDir and RESTORE=off", () => {
    const src = readFileSync(path.join(process.cwd(), "tests/unit/server-process.test.ts"), "utf8");
    expect(src).toContain('dataDir: path.join(dir, "data")');
    expect(src).toContain('AGENT_CONSOLE_RESTORE: "off"');
  });
});
