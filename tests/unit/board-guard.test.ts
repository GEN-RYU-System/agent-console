import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOARD_LIMITS } from "../../hooks/ac-board.mjs";
import { buildReason, decide, reachesToolUses, TOOL_USE_THRESHOLD } from "../../hooks/board-guard.mjs";

vi.setConfig({ testTimeout: 60000 });

const REPO = process.cwd();
const SID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(path.join(d, "board-guard"), 0o700);
    } catch {
      // 無ければ何もしない
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const toolUse = (id: number): object => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t${id}`, name: "Bash", input: { command: "ls" } }] } });
const text = (): object => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "こんにちは" }] } });
const jsonl = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

interface Env {
  dataDir: string;
  hook: string;
  transcript: string;
}
interface Options {
  /** open-sessions.json の中身。省略は SID を 1 件持つ。false なら作らない。文字列ならそのまま書く */
  openSessions?: false | string | object;
  /** bin/ac-board.mjs を置くか（既定 true） */
  bin?: boolean;
  /** transcript の中身。false なら作らない */
  transcript?: false | string;
}
/** 一時フォルダだけを dataDir にする。本物の dataDir は読まない・書かない */
function makeEnv(opts: Options = {}): Env {
  // hook は自分の実体のパス（macOS では /private/var/…）から dataDir を決めるので、試験も実体のパスで比べる
  const dataDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-board-guard-")));
  dirs.push(dataDir);
  mkdirSync(path.join(dataDir, "hooks"), { recursive: true });
  const hook = path.join(dataDir, "hooks", "board-guard.mjs");
  copyFileSync(path.join(REPO, "hooks", "board-guard.mjs"), hook);
  if (opts.bin !== false) {
    mkdirSync(path.join(dataDir, "bin"), { recursive: true });
    copyFileSync(path.join(REPO, "hooks", "ac-board.mjs"), path.join(dataDir, "bin", "ac-board.mjs"));
  }
  const open = opts.openSessions ?? { version: 1, items: [{ id: "x", roleId: "r", name: "n", cwd: "/tmp", claudeSessionId: SID }] };
  if (open !== false) writeFileSync(path.join(dataDir, "open-sessions.json"), typeof open === "string" ? open : JSON.stringify(open));
  const transcript = path.join(dataDir, "transcript.jsonl");
  if (opts.transcript !== false) writeFileSync(transcript, opts.transcript ?? jsonl([text(), toolUse(1), toolUse(2), toolUse(3)]));
  return { dataDir, hook, transcript };
}

function run(e: Env, input: object | string, sessionId = SID): { status: number | null; stdout: string; stderr: string } {
  const body = typeof input === "string" ? input : JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, transcript_path: e.transcript, stop_hook_active: false, ...input });
  const r = spawnSync(process.execPath, [e.hook], { input: body, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const markPath = (e: Env, id = SID): string => path.join(e.dataDir, "board-guard", id);
const errorLog = (e: Env): string => path.join(e.dataDir, "board-guard", "errors.log");
const errorLines = (e: Env): string[] => (existsSync(errorLog(e)) ? readFileSync(errorLog(e), "utf8").split("\n").filter((l) => l !== "") : []);
function writeValidBoard(e: Env, id = SID): void {
  mkdirSync(path.join(e.dataDir, "boards"), { recursive: true });
  writeFileSync(path.join(e.dataDir, "boards", `${id}.json`), JSON.stringify({ version: 1, theme: "t", kgi: [], kpis: [], roadmap: [], tasks: [], updatedAt: 1 }));
}
function expectSilent(r: { status: number | null; stdout: string; stderr: string }): void {
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("");
}

describe("K1: ボードが無いセッションは 1 回止まり、書き方が出る", () => {
  it("open-sessions.json に番号があり、tool_use が 3 件以上で、ボードが無ければ block。reason に命令・JSON の形・上限が入り、印が作られる", () => {
    const e = makeEnv();
    const r = run(e, {});
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain(`node "${path.join(e.dataDir, "bin", "ac-board.mjs")}" write`);
    expect(out.reason).toContain('"theme"');
    expect(out.reason).toContain('"roadmap"');
    expect(out.reason).toContain("1 回だけ");
    expect(out.reason).toContain("theme だけ");
    expect(out.reason).toContain("まだありません");
    expect(out.reason).not.toContain("壊れて");
    // 上限は ac-board.mjs の BOARD_LIMITS から組む
    expect(out.reason).toContain(`theme ${BOARD_LIMITS.themeChars} 字`);
    expect(out.reason).toContain(`tasks ${BOARD_LIMITS.taskItems} 件・各 ${BOARD_LIMITS.taskChars} 字`);
    expect(existsSync(markPath(e))).toBe(true);
    expect(errorLines(e)).toEqual([]);
  });

  it("tool_use が 3 件に満たなければ止めない（印も作らない）。1 行に複数あっても件数で数える", () => {
    const e = makeEnv({ transcript: jsonl([text(), toolUse(1), toolUse(2)]) });
    expectSilent(run(e, {}));
    expect(existsSync(markPath(e))).toBe(false);
    const multi = makeEnv({ transcript: jsonl([{ type: "assistant", message: { content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }, { type: "tool_use", id: "c" }] } }]) });
    expect(JSON.parse(run(multi, {}).stdout).decision).toBe("block");
  });

  it("user 行の tool_result や壊れた行は数えない", () => {
    const rows = jsonl([toolUse(1), toolUse(2)]) + "not json tool_use\n" + JSON.stringify({ type: "user", message: { content: [{ type: "tool_use", id: "z" }] } }) + "\n";
    const e = makeEnv({ transcript: rows });
    expectSilent(run(e, {}));
  });
});

describe("K2: 同じセッションでは 2 回目以降は止めない", () => {
  it("1 回目は block、書かなくても 2 回目・3 回目は出力なし", () => {
    const e = makeEnv();
    expect(JSON.parse(run(e, {}).stdout).decision).toBe("block");
    expectSilent(run(e, {}));
    expectSilent(run(e, {}));
  });
});

describe("K3: open-sessions.json に無い番号は止めない", () => {
  it("agent-console の外の Claude（番号が載っていない）は出力なし・印なし", () => {
    const e = makeEnv();
    expectSilent(run(e, {}, OTHER));
    expect(existsSync(markPath(e, OTHER))).toBe(false);
    expect(errorLines(e)).toEqual([]);
  });

  it("番号が UUID の形でない・session_id が無い入力は止めない", () => {
    const e = makeEnv();
    expectSilent(run(e, {}, "../../etc/passwd"));
    expectSilent(run(e, JSON.stringify({ hook_event_name: "Stop", transcript_path: e.transcript })));
    expect(existsSync(path.join(e.dataDir, "board-guard"))).toBe(false);
  });
});

describe("K4: ボードの状態", () => {
  it("ok なら止めない（印も作らない）", () => {
    const e = makeEnv();
    writeValidBoard(e);
    expectSilent(run(e, {}));
    expect(existsSync(markPath(e))).toBe(false);
  });

  it("invalid（壊れた JSON）なら K1 と同じく 1 回止まり、reason に「壊れて」が入る", () => {
    const e = makeEnv();
    mkdirSync(path.join(e.dataDir, "boards"), { recursive: true });
    writeFileSync(path.join(e.dataDir, "boards", `${SID}.json`), "{broken");
    const out = JSON.parse(run(e, {}).stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("壊れて");
    expectSilent(run(e, {}));
  });
});

describe("K5: stop_hook_active が true なら止めない", () => {
  it("出力なし・印なし", () => {
    const e = makeEnv();
    expectSilent(run(e, { stop_hook_active: true }));
    expect(existsSync(markPath(e))).toBe(false);
    expect(JSON.parse(run(e, { stop_hook_active: false }).stdout).decision).toBe("block");
  });
});

describe("K6: どこで失敗しても止めない（exit 0・出力なし・errors.log に日時つき 1 行）", () => {
  const ISO_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z .+/;
  function expectFailedQuietly(e: Env, r: { status: number | null; stdout: string; stderr: string }): void {
    expectSilent(r);
    const lines = errorLines(e);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(ISO_LINE);
  }

  it("open-sessions.json が壊れている", () => {
    const e = makeEnv({ openSessions: "{broken" });
    expectFailedQuietly(e, run(e, {}));
  });

  it("open-sessions.json が無い", () => {
    const e = makeEnv({ openSessions: false });
    expectFailedQuietly(e, run(e, {}));
  });

  it("bin/ac-board.mjs が無い", () => {
    const e = makeEnv({ bin: false });
    expectFailedQuietly(e, run(e, {}));
    expect(existsSync(markPath(e))).toBe(false);
  });

  it("transcript が無い", () => {
    const e = makeEnv({ transcript: false });
    expectFailedQuietly(e, run(e, {}));
    expect(existsSync(markPath(e))).toBe(false);
  });

  it("印が書けない（board-guard フォルダが書き込み不可。errors.log は先にある）", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root は書き込み不可にできない
    const e = makeEnv();
    mkdirSync(path.join(e.dataDir, "board-guard"), { recursive: true, mode: 0o700 });
    writeFileSync(errorLog(e), "", { mode: 0o600 });
    chmodSync(path.join(e.dataDir, "board-guard"), 0o500);
    const r = run(e, {});
    chmodSync(path.join(e.dataDir, "board-guard"), 0o700);
    expectFailedQuietly(e, r);
    expect(existsSync(markPath(e))).toBe(false);
  });

  it("標準入力が JSON でない・空でも止めない", () => {
    const e = makeEnv();
    expectFailedQuietly(e, run(e, "not json"));
    const e2 = makeEnv();
    expectFailedQuietly(e2, run(e2, ""));
  });
});

describe("判定の関数（import）", () => {
  it("decide: 止めないときは null、止めるときは block と reason。stop_hook_active と形の違う入力は null", async () => {
    const e = makeEnv();
    expect(await decide(undefined, e.dataDir)).toBeNull();
    expect(await decide({ session_id: SID, stop_hook_active: true, transcript_path: e.transcript }, e.dataDir)).toBeNull();
    const r = await decide({ session_id: SID, transcript_path: e.transcript }, e.dataDir);
    expect(r?.decision).toBe("block");
    expect(await decide({ session_id: SID, transcript_path: e.transcript }, e.dataDir)).toBeNull();
  });

  it("reachesToolUses: 既定の件数は 3。足りなければ false、読み止めの境目をまたぐ多バイト文字でも数え間違えない", () => {
    expect(TOOL_USE_THRESHOLD).toBe(3);
    const e = makeEnv({ transcript: false });
    const filler = { type: "assistant", message: { content: [{ type: "text", text: "あ".repeat(400_000) }] } };
    writeFileSync(e.transcript, jsonl([filler, filler, toolUse(1), toolUse(2), filler, toolUse(3)]));
    expect(reachesToolUses(e.transcript)).toBe(true);
    expect(reachesToolUses(e.transcript, 4)).toBe(false);
    expect(() => reachesToolUses(path.join(e.dataDir, "none.jsonl"))).toThrow();
  });

  it("buildReason: 上限は渡された limits から組む（数値を書き写さない）", () => {
    const limits = { ...BOARD_LIMITS, themeChars: 777 };
    expect(buildReason({ dataDir: "/d", limits, invalid: false })).toContain("theme 777 字");
  });
});
