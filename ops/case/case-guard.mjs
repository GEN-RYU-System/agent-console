#!/usr/bin/env node
// 件のセッション（役割 discord-case）の Claude の道具の見張り（PreToolUse の同期フック）。設計 §4-5「Claude の道具の囲い」。
// 引数1つ: case.json の道。標準入力の JSON の tool_name・tool_input を読む。通すときは何も出さず 0、止めるときは理由を標準エラーに1行出して 2。
// node だけで動き、依存を足さない。どこかで例外になれば 2（settings 側の onFailure: "block" にも重ねる）。
import fs from "node:fs";

class Block extends Error {}

const block = (reason) => {
  throw new Block(reason);
};

const under = (p, base) => p === base || p.startsWith(base + "/");

/** 拒否の一覧との比べ用。APFS は大文字小文字と Unicode の正規化を区別しない（toUpperCase は ſ を s にそろえるため）。許す側の比べには使わない */
const fold = (s) => s.normalize("NFKC").toUpperCase().toLowerCase();
const underFolded = (p, base) => under(fold(p), fold(base));

/** 字面で . .. を縮めない。ある道は realpath、無い道は一番近いある親の realpath に外した名前をそのままつなぐ */
function resolvePath(p) {
  if (typeof p !== "string" || !p.startsWith("/")) block("path is not an absolute string");
  let cur = p;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length === 0 ? real : (real === "/" ? "" : real) + "/" + tail.join("/");
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") block("path cannot be resolved");
    }
    // realpath が解けないのに何かがある＝先の無いシンボリックリンク。W の外を指しうるので止める
    try {
      fs.lstatSync(cur);
      block("path cannot be resolved");
    } catch (err) {
      if (err instanceof Block) throw err;
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") block("path cannot be resolved");
    }
    const name = cur.slice(cur.lastIndexOf("/") + 1);
    if (name === "..") block("path has .. in a missing part");
    if (cur === "/" || cur === "") block("path cannot be resolved");
    if (name !== "" && name !== ".") tail.unshift(name);
    const parent = cur.slice(0, cur.lastIndexOf("/"));
    cur = parent === "" ? "/" : parent;
  }
}

/** 一覧の道。起動の時に realpath にそろえてあるが、そろえ直す（解けなければそのまま） */
function align(list) {
  if (!Array.isArray(list)) block("case file list is invalid");
  return list.map((x) => {
    try {
      return resolvePath(x);
    } catch {
      if (typeof x !== "string") block("case file list is invalid");
      return x;
    }
  });
}

/** 解いた道にすでに本物のファイルがあり、ハードリンクが2つ以上なら止める（realpath はハードリンクを見分けない） */
function checkHardLink(real) {
  let st;
  try {
    st = fs.statSync(real);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return;
    block("path cannot be examined");
  }
  if (st.isFile() && st.nlink >= 2) block("path is a hard link");
}

const AGENT_KEYS = new Set(["description", "prompt", "subagent_type", "model", "run_in_background"]);

function decide(input, c) {
  const name = input.tool_name;
  const ti = input.tool_input;
  if (typeof name !== "string") block("tool name missing");
  const worktree = align([c.worktree])[0];
  const report = align([c.report])[0];
  const tmp = align([c.tmp])[0];
  const denyWrite = align(c.denyWrite);
  const denyRead = align(c.denyRead);
  const obj = typeof ti === "object" && ti !== null ? ti : {};
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
    const real = resolvePath(obj.file_path ?? obj.notebook_path);
    checkHardLink(real);
    if (denyWrite.some((d) => underFolded(real, d))) block("write to a protected path");
    if (under(real, worktree) || under(real, report)) return;
    block("write outside the case work area");
  }
  if (name === "Read" || name === "Glob" || name === "Grep") {
    if (name === "Glob") {
      const pat = obj.pattern;
      if (typeof pat !== "string" || pat.startsWith("/") || pat.startsWith("~") || pat.includes("..")) block("glob pattern is not allowed");
    }
    const raw = name === "Read" ? obj.file_path : (obj.path ?? worktree);
    const real = resolvePath(raw);
    checkHardLink(real);
    if (denyRead.some((d) => underFolded(real, d))) block("read of a protected path");
    if (under(real, worktree) || under(real, report) || under(real, tmp)) return;
    block("read outside the case work area");
  }
  if (name.startsWith("mcp__") || name === "WebFetch" || name === "WebSearch") block("tool is not allowed");
  if (name === "Agent" || name === "Task") {
    for (const k of Object.keys(obj)) if (!AGENT_KEYS.has(k)) block("agent option is not allowed");
    return;
  }
  if (name === "Bash" || name === "TodoWrite" || name === "ToolSearch") return;
  block("unknown tool");
}

try {
  const caseFile = process.argv[2];
  if (typeof caseFile !== "string" || caseFile === "") block("case file missing");
  const c = JSON.parse(fs.readFileSync(caseFile, "utf8"));
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (typeof input !== "object" || input === null) block("input is not an object");
  decide(input, c);
  process.exit(0);
} catch (err) {
  process.stderr.write(`case-guard: ${err instanceof Block ? err.message : "error"}\n`);
  process.exit(2);
}
