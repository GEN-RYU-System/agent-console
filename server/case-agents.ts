import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isClaudeSessionId } from "./sessions.ts";

/** case-home の sessions/<pid>.json の大きさの上限 */
export const CASE_SESSION_FILE_MAX = 64 * 1024;

const isRealDir = (p: string): fs.Stats | undefined => {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink() ? st : undefined;
  } catch {
    return undefined;
  }
};

/** 開いて読む。名前付きパイプ・リンク・大きすぎる物は読まない。どの失敗でも undefined */
function readSmallRegular(p: string): string | undefined {
  try {
    const l = fs.lstatSync(p);
    if (!l.isFile() || l.isSymbolicLink() || l.size > CASE_SESSION_FILE_MAX) return undefined;
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > CASE_SESSION_FILE_MAX) return undefined;
      const buf = Buffer.alloc(CASE_SESSION_FILE_MAX + 1);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (n > CASE_SESSION_FILE_MAX) return undefined;
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * 件の本体が case-home の sessions/<pid>.json に書く会話の番号を、部屋の外で読む。
 * pids は件の端末の子孫の pid。どの失敗でも投げず undefined。違う番号が2つ以上見つかったときも undefined。
 */
export function readCaseClaudeSessionId(caseHome: string, pids: ReadonlySet<number>): string | undefined {
  try {
    const dir = path.join(caseHome, "sessions");
    const before = isRealDir(dir);
    if (!before) return undefined;
    const found = new Set<string>();
    for (const name of fs.readdirSync(dir)) {
      const m = /^([0-9]+)\.json$/.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!pids.has(pid)) continue;
      const text = readSmallRegular(path.join(dir, name));
      if (text === undefined) continue;
      let j: unknown;
      try {
        j = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof j !== "object" || j === null) continue;
      const o = j as { pid?: unknown; sessionId?: unknown };
      if (o.pid === pid && isClaudeSessionId(o.sessionId)) found.add(o.sessionId);
    }
    const after = isRealDir(dir);
    if (!after || after.dev !== before.dev || after.ino !== before.ino) return undefined;
    return found.size === 1 ? [...found][0] : undefined;
  } catch {
    return undefined;
  }
}

/** 件の本体の状態ファイル（sessions/<pid>.json）から、case-say の判定 7 が使う値だけを取り出した物 */
export interface CaseStateFile {
  /** ファイル名の pid */
  filePid: number;
  /** JSON の中の pid（数でなければ undefined） */
  pid: number | undefined;
  /** JSON の status（文字列でなければ undefined） */
  status: string | undefined;
  /** 名前に `wait` を含むキー（大小文字を区別しない） */
  waitKeys: string[];
  /** JSON の version（文字列のときだけ。probe の P0 が使う。無ければ undefined） */
  version?: string;
}

/**
 * 件の本体の状態ファイルを部屋の外で読む（case-say の判定 7）。pids は件の端末の子孫の pid。
 * 安全な読み方（リンク・名前付きパイプ・固いリンク・64KiB 超を断る）は readCaseClaudeSessionId と同じ。
 * 読めて JSON のオブジェクトだったファイルがちょうど 1 つのときだけ返す。0 個・2 個以上・読む間にフォルダが入れ替わったときは undefined。投げない
 */
export function readCaseStateFile(caseHome: string, pids: ReadonlySet<number>): CaseStateFile | undefined {
  try {
    const dir = path.join(caseHome, "sessions");
    const before = isRealDir(dir);
    if (!before) return undefined;
    const found: CaseStateFile[] = [];
    for (const name of fs.readdirSync(dir)) {
      const m = /^([0-9]+)\.json$/.exec(name);
      if (!m) continue;
      const filePid = Number(m[1]);
      if (!pids.has(filePid)) continue;
      const text = readSmallRegular(path.join(dir, name));
      if (text === undefined) continue;
      let j: unknown;
      try {
        j = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof j !== "object" || j === null || Array.isArray(j)) continue;
      const o = j as Record<string, unknown>;
      found.push({
        filePid,
        pid: typeof o.pid === "number" ? o.pid : undefined,
        status: typeof o.status === "string" ? o.status : undefined,
        waitKeys: Object.keys(o).filter((k) => k.toLowerCase().includes("wait")),
        ...(typeof o.version === "string" ? { version: o.version } : {}),
      });
    }
    const after = isRealDir(dir);
    if (!after || after.dev !== before.dev || after.ino !== before.ino) return undefined;
    return found.length === 1 ? found[0] : undefined;
  } catch {
    return undefined;
  }
}

export const CASE_SAY_STEP_FILE_MAX = 64 * 1024;

/**
 * 手順ファイル `<R>/<stepFile>` を読む（case-say の判定 6）。R がリンクでないフォルダで、O_NOFOLLOW で開き、
 * 通常のファイル・固いリンクでない・64KiB までのときだけ中身の sha256（先頭 16 桁）を返す。どの失敗でも undefined
 */
export function readStepFileSha16(R: string, stepFile: string): string | undefined {
  try {
    if (!isRealDir(R)) return undefined;
    const p = path.join(R, stepFile);
    const l = fs.lstatSync(p);
    if (!l.isFile() || l.isSymbolicLink() || l.size > CASE_SAY_STEP_FILE_MAX) return undefined;
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > CASE_SAY_STEP_FILE_MAX) return undefined;
      const buf = Buffer.alloc(CASE_SAY_STEP_FILE_MAX + 1);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (n > CASE_SAY_STEP_FILE_MAX) return undefined;
      return createHash("sha256").update(buf.subarray(0, n)).digest("hex").slice(0, 16);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
