import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOARD_LIMITS, boardPathFor, readBoard, validateBoard, writeBoard } from "../../hooks/ac-board.mjs";
import { boardCommandPathIn, installBoardCommand } from "../../server/activity-setup.ts";

vi.setConfig({ testTimeout: 60000 });

const REPO = process.cwd();
const SID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const NOW = Date.UTC(2026, 9, 13, 3, 0, 0);

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "ac-board-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const VALID = {
  theme: "作戦ボード",
  kgi: [{ text: "PO が画面で○×を判定できる" }],
  kpis: [{ name: "試験の数", target: "100", current: "40", unit: "件" }],
  roadmap: [
    { title: "設計", status: "done" },
    { title: "実装", status: "doing" },
    { title: "導入", status: "todo" },
  ],
  tasks: [
    { title: "試験を書く", status: "done" },
    { title: "実装する", status: "doing" },
    { title: "導入する", status: "todo" },
  ],
};
/** 古い形（tasks なし）。tasks の足される前のボード */
const { tasks: _tasks, ...LEGACY } = VALID;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const failReason = (input: unknown): string => {
  const r = validateBoard(input);
  if (r.ok) throw new Error("expected invalid");
  return r.reason;
};

describe("K5: validateBoard（入力の検査）", () => {
  it("形が合うものは通る。丸ごとの board（version なし）が返る", () => {
    const r = validateBoard(VALID);
    expect(r).toEqual({ ok: true, board: VALID });
  });

  it("空の配列は通る（まだ決まっていない欄）。KPI の目標・今の値・単位は空でもよい", () => {
    expect(validateBoard({ theme: "t", kgi: [], kpis: [], roadmap: [], tasks: [] }).ok).toBe(true);
    expect(validateBoard({ theme: "t", kgi: [], kpis: [{ name: "n", target: "", current: "", unit: "" }], roadmap: [] }).ok).toBe(true);
  });

  it("K8 tasks は省ける鍵。省いた入力は通り、tasks: [] として返る。tasks があれば title と status だけを写す", () => {
    expect(validateBoard(LEGACY)).toEqual({ ok: true, board: { ...LEGACY, tasks: [] } });
    expect(validateBoard(VALID)).toEqual({ ok: true, board: VALID });
  });

  it("K2 tasks の型と上限: 配列・title は空にできない・status は todo/doing/done・余分な鍵は不可。100 件×200 字ちょうどは通り、超えると拒否", () => {
    expect(BOARD_LIMITS).toMatchObject({ taskItems: 100, taskChars: 200 });
    expect(failReason({ ...VALID, tasks: "x" })).toContain("tasks");
    expect(failReason({ ...VALID, tasks: ["x"] })).toContain("tasks[0]");
    expect(failReason({ ...VALID, tasks: [{ title: "", status: "todo" }] })).toContain("tasks[0].title");
    expect(failReason({ ...VALID, tasks: [{ title: "a", status: "finished" }] })).toContain("tasks[0].status");
    expect(failReason({ ...VALID, tasks: [{ title: "a" }] })).toContain("tasks[0].status");
    expect(failReason({ ...VALID, tasks: [{ title: "a", status: "todo", extra: 1 }] })).toContain("tasks[0].extra");
    expect(failReason({ ...VALID, tasks: [{ title: "a\u001b", status: "todo" }] })).toContain("tasks[0].title");
    expect(validateBoard({ ...VALID, tasks: Array.from({ length: 100 }, () => ({ title: "あ".repeat(200), status: "todo" })) }).ok).toBe(true);
    expect(failReason({ ...VALID, tasks: Array.from({ length: 101 }, () => ({ title: "a", status: "todo" })) })).toContain("tasks");
    expect(failReason({ ...VALID, tasks: [{ title: "あ".repeat(201), status: "todo" }] })).toContain("tasks[0].title");
  });

  it("オブジェクトでない・欠けている・余分な項目があるものは、理由を付けて拒否する", () => {
    expect(failReason(null)).toMatch(/オブジェクト/);
    expect(failReason([])).toMatch(/オブジェクト/);
    expect(failReason("x")).toMatch(/オブジェクト/);
    for (const key of ["theme", "kgi", "kpis", "roadmap"]) {
      const missing: Record<string, unknown> = clone(VALID);
      delete missing[key];
      expect(failReason(missing)).toContain(key);
    }
    expect(failReason({ ...VALID, extra: 1 })).toContain("extra");
    // version と updatedAt は命令が付けるので、入力には含めない
    expect(failReason({ ...VALID, version: 1 })).toContain("version");
    expect(failReason({ ...VALID, updatedAt: 1 })).toContain("updatedAt");
  });

  it("型が違うものを拒否する（文字列でない theme、配列でない kgi、数値の KPI など）", () => {
    expect(failReason({ ...VALID, theme: 1 })).toContain("theme");
    expect(failReason({ ...VALID, theme: "" })).toContain("theme");
    expect(failReason({ ...VALID, kgi: "x" })).toContain("kgi");
    expect(failReason({ ...VALID, kgi: [{ text: 1 }] })).toContain("kgi[0].text");
    expect(failReason({ ...VALID, kgi: [{ text: "" }] })).toContain("kgi[0].text");
    expect(failReason({ ...VALID, kgi: [{ text: "a", extra: 1 }] })).toContain("kgi[0].extra");
    expect(failReason({ ...VALID, kpis: [{ name: "n", target: 100, current: "1", unit: "" }] })).toContain("kpis[0].target");
    expect(failReason({ ...VALID, kpis: [{ name: "", target: "", current: "", unit: "" }] })).toContain("kpis[0].name");
    expect(failReason({ ...VALID, kpis: [{ name: "n", target: "", current: "" }] })).toContain("kpis[0].unit");
    expect(failReason({ ...VALID, roadmap: [{ title: "x", status: "finished" }] })).toContain("roadmap[0].status");
    expect(failReason({ ...VALID, roadmap: [{ title: "", status: "todo" }] })).toContain("roadmap[0].title");
    expect(failReason({ ...VALID, roadmap: ["x"] })).toContain("roadmap[0]");
  });

  it("長さの上限: theme 200 字、kgi 10 件×500 字、kpis 20 件×各項目 200 字、roadmap 50 件×200 字。上限ちょうどは通り、1 つ超えると拒否", () => {
    expect(BOARD_LIMITS).toEqual({ themeChars: 200, kgiItems: 10, kgiChars: 500, kpiItems: 20, kpiChars: 200, roadmapItems: 50, roadmapChars: 200, taskItems: 100, taskChars: 200 });
    expect(validateBoard({ ...VALID, theme: "あ".repeat(200) }).ok).toBe(true);
    expect(failReason({ ...VALID, theme: "あ".repeat(201) })).toContain("theme");
    // コードポイントで数える（絵文字 1 つは 1 字）
    expect(validateBoard({ ...VALID, theme: "😀".repeat(200) }).ok).toBe(true);
    expect(failReason({ ...VALID, theme: "😀".repeat(201) })).toContain("theme");

    expect(validateBoard({ ...VALID, kgi: Array.from({ length: 10 }, () => ({ text: "あ".repeat(500) })) }).ok).toBe(true);
    expect(failReason({ ...VALID, kgi: Array.from({ length: 11 }, () => ({ text: "a" })) })).toContain("kgi");
    expect(failReason({ ...VALID, kgi: [{ text: "あ".repeat(501) }] })).toContain("kgi[0].text");

    const kpi = (over: Record<string, string> = {}) => ({ name: "n", target: "t", current: "c", unit: "u", ...over });
    expect(validateBoard({ ...VALID, kpis: Array.from({ length: 20 }, () => kpi({ name: "あ".repeat(200), target: "あ".repeat(200), current: "あ".repeat(200), unit: "あ".repeat(200) })) }).ok).toBe(true);
    expect(failReason({ ...VALID, kpis: Array.from({ length: 21 }, () => kpi()) })).toContain("kpis");
    for (const field of ["name", "target", "current", "unit"]) expect(failReason({ ...VALID, kpis: [kpi({ [field]: "あ".repeat(201) })] })).toContain(`kpis[0].${field}`);

    expect(validateBoard({ ...VALID, roadmap: Array.from({ length: 50 }, () => ({ title: "あ".repeat(200), status: "todo" })) }).ok).toBe(true);
    expect(failReason({ ...VALID, roadmap: Array.from({ length: 51 }, () => ({ title: "a", status: "todo" })) })).toContain("roadmap");
    expect(failReason({ ...VALID, roadmap: [{ title: "あ".repeat(201), status: "todo" }] })).toContain("roadmap[0].title");
  });

  it("改行とタブ以外の制御文字（NUL・ESC・CR・DEL など）は拒否する。改行とタブは通る", () => {
    for (const bad of ["\u0000", "\u001b[31m", "\r", "\u007f", "\u0008", "\u000b"]) {
      expect(failReason({ ...VALID, theme: `a${bad}b` })).toContain("制御文字");
      expect(failReason({ ...VALID, kgi: [{ text: `a${bad}` }] })).toContain("kgi[0].text");
      expect(failReason({ ...VALID, kpis: [{ name: "n", target: "", current: `1${bad}`, unit: "" }] })).toContain("kpis[0].current");
      expect(failReason({ ...VALID, roadmap: [{ title: `x${bad}`, status: "todo" }] })).toContain("roadmap[0].title");
    }
    expect(validateBoard({ ...VALID, theme: "1行目\n2行目\tタブ" }).ok).toBe(true);
  });
});

describe("K4: 書き込みと読み出し（dataDir/boards/<番号>.json）", () => {
  it("1 か所に書く: dataDir/boards/<番号>.json。ディレクトリ 700・ファイル 600。version 1・updatedAt を命令が付ける", () => {
    const dataDir = tmp();
    const r = writeBoard(dataDir, SID, VALID, NOW);
    expect(r).toEqual({ ok: true, path: path.join(dataDir, "boards", `${SID}.json`) });
    expect(boardPathFor(path.join(dataDir, "boards"), SID)).toBe(path.join(dataDir, "boards", `${SID}.json`));
    expect(statSync(path.join(dataDir, "boards")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dataDir, "boards", `${SID}.json`)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path.join(dataDir, "boards", `${SID}.json`), "utf8"))).toEqual({ version: 1, ...VALID, updatedAt: NOW });
    expect(readdirSync(path.join(dataDir, "boards"))).toEqual([`${SID}.json`]);
  });

  it("丸ごと書き換える: 2 回目の書き込みは 1 回目の内容を引き継がない。ほかの会話の番号のボードは変わらない", () => {
    const dataDir = tmp();
    writeBoard(dataDir, OTHER, VALID, NOW);
    writeBoard(dataDir, SID, VALID, NOW);
    const second = { theme: "新しい", kgi: [], kpis: [], roadmap: [{ title: "だけ", status: "todo" }], tasks: [] };
    writeBoard(dataDir, SID, second, NOW + 5000);
    expect(readBoard(dataDir, SID)).toEqual({ status: "ok", board: { version: 1, ...second, updatedAt: NOW + 5000 } });
    expect(readBoard(dataDir, OTHER)).toEqual({ status: "ok", board: { version: 1, ...VALID, updatedAt: NOW } });
    expect(readdirSync(path.join(dataDir, "boards")).sort()).toEqual([`${OTHER}.json`, `${SID}.json`].sort());
  });

  it("書いたボードは、読み出しを作り直しても（アプリの再起動・更新と同じ）残っている", () => {
    const dataDir = tmp();
    writeBoard(dataDir, SID, VALID, NOW);
    // 読み出しは毎回ファイルを読む。メモリに持たない
    expect(readBoard(dataDir, SID).status).toBe("ok");
    expect(readBoard(dataDir, SID).status).toBe("ok");
  });

  it("ボードが無ければ none。壊れた JSON・形が違う・version が違う・updatedAt が数でないものは invalid（ファイルは書き換えない）", () => {
    const dataDir = tmp();
    expect(readBoard(dataDir, SID)).toEqual({ status: "none" });
    mkdirSync(path.join(dataDir, "boards"), { recursive: true });
    const file = path.join(dataDir, "boards", `${SID}.json`);
    const cases = [
      "{broken",
      "[]",
      JSON.stringify({ version: 2, ...VALID, updatedAt: NOW }),
      JSON.stringify({ version: 1, ...VALID, updatedAt: "x" }),
      JSON.stringify({ version: 1, ...VALID, theme: 1, updatedAt: NOW }),
      JSON.stringify({ ...VALID, updatedAt: NOW }),
    ];
    for (const body of cases) {
      writeFileSync(file, body);
      expect(readBoard(dataDir, SID)).toEqual({ status: "invalid" });
      expect(readFileSync(file, "utf8")).toBe(body);
    }
  });

  it("K8 古い形（tasks なし）の保存ファイルは ok のまま読め、tasks: [] を返す。ファイルは書き換えない", () => {
    const dataDir = tmp();
    mkdirSync(path.join(dataDir, "boards"), { recursive: true });
    const file = path.join(dataDir, "boards", `${SID}.json`);
    const body = JSON.stringify({ version: 1, ...LEGACY, updatedAt: NOW });
    writeFileSync(file, body);
    expect(readBoard(dataDir, SID)).toEqual({ status: "ok", board: { version: 1, ...LEGACY, tasks: [], updatedAt: NOW } });
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  it("K8 tasks の無い write の入力が通る（書かれたファイルには tasks: [] が入る）", () => {
    const dataDir = tmp();
    expect(writeBoard(dataDir, SID, LEGACY, NOW).ok).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dataDir, "boards", `${SID}.json`), "utf8"))).toEqual({ version: 1, ...LEGACY, tasks: [], updatedAt: NOW });
  });

  it("会話の番号が UUID の形でないときは、パスを組み立てない（書かない・読まない）", () => {
    const dataDir = tmp();
    for (const id of ["../evil", "..", "a/b", "", `${SID}/../x`, "11111111-2222-4333-8444-55555555555G", "AAAAAAAA-2222-4333-8444-555555555555"]) {
      expect(boardPathFor(path.join(dataDir, "boards"), id)).toBeNull();
      const w = writeBoard(dataDir, id, VALID, NOW);
      expect(w.ok).toBe(false);
      expect(readBoard(dataDir, id)).toEqual({ status: "none" });
    }
    expect(existsSync(path.join(dataDir, "boards"))).toBe(false);
  });

  it("検査に通らない入力は書かない（既存のボードも変えない）", () => {
    const dataDir = tmp();
    writeBoard(dataDir, SID, VALID, NOW);
    const w = writeBoard(dataDir, SID, { ...VALID, theme: "" }, NOW + 1);
    expect(w.ok).toBe(false);
    expect(readBoard(dataDir, SID)).toEqual({ status: "ok", board: { version: 1, ...VALID, updatedAt: NOW } });
    expect(readdirSync(path.join(dataDir, "boards"))).toEqual([`${SID}.json`]);
  });
});

describe("K3 / §3-2: 命令（dataDir/bin/ac-board.mjs write）", () => {
  /** 本番と同じ並び（dataDir/bin/ac-board.mjs）に、サーバーが使う関数で写す。dataDir は空白入り */
  function install(): { dataDir: string; command: string } {
    const dataDir = path.join(tmp(), "Application Support", "agent-console");
    const placed = installBoardCommand(path.join(REPO, "hooks"), dataDir);
    return { dataDir, command: placed };
  }
  const run = (command: string, args: string[], stdin: string, env: Record<string, string | undefined>) => {
    const baseEnv = { ...process.env };
    delete baseEnv.CLAUDE_CODE_SESSION_ID;
    return spawnSync(process.execPath, [command, ...args], { input: stdin, encoding: "utf8", env: { ...baseEnv, ...env } });
  };

  it("本番と同じ場所に写される（dataDir/bin/ac-board.mjs）。リポジトリの正本と同じ中身", () => {
    const { dataDir, command } = install();
    expect(command).toBe(path.join(dataDir, "bin", "ac-board.mjs"));
    expect(boardCommandPathIn(dataDir)).toBe(command);
    expect(readFileSync(command, "utf8")).toBe(readFileSync(path.join(REPO, "hooks", "ac-board.mjs"), "utf8"));
    expect(statSync(path.join(dataDir, "bin")).mode & 0o777).toBe(0o700);
  });

  it("write: 標準入力の JSON を、環境変数 CLAUDE_CODE_SESSION_ID の番号のボードに丸ごと書く。終了コード 0", () => {
    const { dataDir, command } = install();
    const r = run(command, ["write"], JSON.stringify(VALID), { CLAUDE_CODE_SESSION_ID: SID });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const file = path.join(dataDir, "boards", `${SID}.json`);
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ version: 1, ...VALID });
    expect(typeof saved.updatedAt).toBe("number");
    expect(Math.abs((saved.updatedAt as number) - Date.now())).toBeLessThan(60_000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dataDir, "boards")).mode & 0o777).toBe(0o700);
  });

  it("K5 検査に通らない入力は、書かずに理由を標準エラーに出して、終了コード 1", () => {
    const { dataDir, command } = install();
    const bad = run(command, ["write"], JSON.stringify({ ...VALID, roadmap: [{ title: "x", status: "finished" }] }), { CLAUDE_CODE_SESSION_ID: SID });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("roadmap[0].status");
    const tooLong = run(command, ["write"], JSON.stringify({ ...VALID, theme: "あ".repeat(201) }), { CLAUDE_CODE_SESSION_ID: SID });
    expect(tooLong.status).toBe(1);
    expect(tooLong.stderr).toContain("theme");
    const control = run(command, ["write"], JSON.stringify({ ...VALID, theme: "a\u001bb" }), { CLAUDE_CODE_SESSION_ID: SID });
    expect(control.status).toBe(1);
    expect(control.stderr).toContain("制御文字");
    expect(existsSync(path.join(dataDir, "boards"))).toBe(false);
  });

  it("K5 JSON として読めない・空の入力・大きすぎる入力は、書かずに終了コード 1", () => {
    const { dataDir, command } = install();
    const broken = run(command, ["write"], "{broken", { CLAUDE_CODE_SESSION_ID: SID });
    expect(broken.status).toBe(1);
    expect(broken.stderr).toMatch(/JSON/);
    expect(run(command, ["write"], "", { CLAUDE_CODE_SESSION_ID: SID }).status).toBe(1);
    const huge = run(command, ["write"], JSON.stringify({ ...VALID, theme: "あ".repeat(400_000) }), { CLAUDE_CODE_SESSION_ID: SID });
    expect(huge.status).toBe(1);
    expect(existsSync(path.join(dataDir, "boards"))).toBe(false);
  });

  it("会話の番号は環境変数だけから取る。無い・UUID の形でないときは、パスを組み立てずに終了コード 1。引数で番号を渡しても受け取らない", () => {
    const { dataDir, command } = install();
    const none = run(command, ["write"], JSON.stringify(VALID), {});
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("CLAUDE_CODE_SESSION_ID");
    const evil = run(command, ["write"], JSON.stringify(VALID), { CLAUDE_CODE_SESSION_ID: "../../evil" });
    expect(evil.status).toBe(1);
    const viaArg = run(command, ["write", OTHER], JSON.stringify(VALID), { CLAUDE_CODE_SESSION_ID: SID });
    expect(viaArg.status).toBe(1);
    expect(existsSync(path.join(dataDir, "boards"))).toBe(false);
    expect(existsSync(path.join(dataDir, "..", "evil.json"))).toBe(false);
  });

  it("使い方が違うとき（副命令が無い・知らない副命令）は終了コード 1 で使い方を出す。show の副命令は無い", () => {
    const { command } = install();
    for (const args of [[], ["show"], ["read"]]) {
      const r = run(command, args, JSON.stringify(VALID), { CLAUDE_CODE_SESSION_ID: SID });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("write");
    }
  });
});
