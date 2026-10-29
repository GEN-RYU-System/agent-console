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
