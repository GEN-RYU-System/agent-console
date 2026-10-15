// agent-console: Claude の利用量（週・5 時間）の写し取り。設計 docs/handoff/usage-meter/design.md §3-1・§10。
// Claude Code の statusLine の命令として動く。標準入力の JSON から rate_limits だけを取り出し、dataDir/usage.json に書く。
// 標準出力には Claude の画面の下の行に出す 1 行（「週 N% · 5時間 M%」。数字と記号だけ）を出す。
// 検査（extractUsage）・書き込み（writeUsage）・読み出し（readUsage）はこの 1 ファイルが持つ。サーバーはこのファイルを import し、
// 命令は dataDir/bin に写した同じファイルが動く。node の標準の部品だけを使う。外部へは通信しない。
// 壊れた入力・rate_limits の無い入力・範囲外の値のときは usage.json を書き換えず、空の行を出して終了コード 0（Claude の画面を止めない）。
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE_VERSION = 1;
export const USAGE_FILE_NAME = "usage.json";
export const SESSION_METRICS_VERSION = 1;
export const SESSION_METRICS_FILE_NAME = "session-metrics.json";
/** session-metrics.json の updatedAt がこれより古ければ、セッション行に値を出さない（サーバーが止まったときの古い値を見せない） */
export const SESSION_METRICS_FRESH_MS = 30 * 1000;
/** session_id の長さの上限（暴走した入力だけを止める） */
const MAX_SESSION_ID_CHARS = 128;
/** 標準入力の上限（byte）。statusLine の入力は数 KB。暴走した入力だけを止める */
const MAX_INPUT_BYTES = 1024 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_PERCENT = 100;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** 窓 1 つ（{used_percentage, resets_at}）の検査。通れば {usedPercentage, resetsAt}、外れれば null */
function windowOf(raw) {
  if (!isObject(raw)) return null;
  const pct = raw.used_percentage;
  const resets = raw.resets_at;
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > MAX_PERCENT) return null;
  if (typeof resets !== "number" || !Number.isInteger(resets) || resets <= 0) return null;
  return { usedPercentage: pct, resetsAt: resets };
}

/** 保存した形の窓（usedPercentage・resetsAt）の検査 */
function storedWindowOf(raw) {
  if (!isObject(raw)) return null;
  return windowOf({ used_percentage: raw.usedPercentage, resets_at: raw.resetsAt });
}

/**
 * statusLine の入力（パース済み）から、利用量を取り出す。
 * 戻り値: {fiveHour?, sevenDay?}（少なくとも 1 つ）。rate_limits が無い・窓が 1 つも無い・出ている窓が 1 つでも範囲外なら null。
 */
export function extractUsage(input) {
  if (!isObject(input) || !isObject(input.rate_limits)) return null;
  const out = {};
  for (const [from, to] of [["five_hour", "fiveHour"], ["seven_day", "sevenDay"]]) {
    if (!(from in input.rate_limits)) continue;
    const w = windowOf(input.rate_limits[from]);
    if (w === null) return null;
    out[to] = w;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Claude の画面の下の行。両方あれば「週 N% · 5時間 M%」、片方なら片方、無ければ空 */
export function formatLine(usage) {
  if (usage === null || usage === undefined) return "";
  const parts = [];
  if (usage.sevenDay) parts.push(`週 ${Math.round(usage.sevenDay.usedPercentage)}%`);
  if (usage.fiveHour) parts.push(`5時間 ${Math.round(usage.fiveHour.usedPercentage)}%`);
  return parts.join(" · ");
}

/** dataDir/<fileName> に JSON を書く（一時ファイル→600→rename。同時に書かれても、半分だけのファイルを読む人は出ない） */
function writeJsonAtomic(dataDir, fileName, body) {
  mkdirSync(dataDir, { recursive: true, mode: DIR_MODE });
  const file = path.join(dataDir, fileName);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd = null;
  try {
    fd = openSync(tmp, "wx", FILE_MODE);
    writeSync(fd, `${JSON.stringify(body)}\n`);
    closeSync(fd);
    fd = null;
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

/** dataDir/usage.json に書く */
export function writeUsage(dataDir, usage, now = Date.now()) {
  return writeJsonAtomic(dataDir, USAGE_FILE_NAME, { version: USAGE_VERSION, observedAt: now, ...usage });
}

/** 0〜100 の有限な数か（セッションの CPU・RAM の検査） */
const isPercent = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_PERCENT;

/**
 * サーバーの定期計測（MemoryCollector）の写しを dataDir/session-metrics.json に書く。
 * sessions は { "<claudeSessionId>": { cpuPercent, ramPercent } }。範囲外の値の項目は載せない（ramPercent は null も可）。
 */
export function writeSessionMetrics(dataDir, sessions, now = Date.now()) {
  const out = {};
  for (const [id, m] of Object.entries(sessions)) {
    if (id === "" || id.length > MAX_SESSION_ID_CHARS || !isObject(m) || !isPercent(m.cpuPercent)) continue;
    if (m.ramPercent !== null && !isPercent(m.ramPercent)) continue;
    out[id] = { cpuPercent: m.cpuPercent, ramPercent: m.ramPercent };
  }
  return writeJsonAtomic(dataDir, SESSION_METRICS_FILE_NAME, { version: SESSION_METRICS_VERSION, updatedAt: now, sessions: out });
}

/** dataDir/session-metrics.json から session_id の項目を引く。無い・壊れた・古い（30 秒超）・未来のときは null */
export function readSessionMetrics(dataDir, sessionId, now = Date.now()) {
  if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > MAX_SESSION_ID_CHARS) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path.join(dataDir, SESSION_METRICS_FILE_NAME), "utf8"));
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.version !== SESSION_METRICS_VERSION || typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return null;
  const age = now - raw.updatedAt;
  if (age < 0 || age > SESSION_METRICS_FRESH_MS) return null;
  if (!isObject(raw.sessions) || !Object.prototype.hasOwnProperty.call(raw.sessions, sessionId)) return null;
  const m = raw.sessions[sessionId];
  if (!isObject(m) || !isPercent(m.cpuPercent)) return null;
  if (m.ramPercent !== null && !isPercent(m.ramPercent)) return null;
  return { cpuPercent: m.cpuPercent, ramPercent: m.ramPercent };
}

/** セッション行に足す文字列。「 · CPU N% · RAM M%」（先頭に区切りを含む）。ramPercent が null なら CPU だけ。metrics が null なら空 */
export function formatMetrics(metrics) {
  if (metrics === null || metrics === undefined) return "";
  const parts = [` · CPU ${Math.round(metrics.cpuPercent)}%`];
  if (metrics.ramPercent !== null) parts.push(` · RAM ${Math.round(metrics.ramPercent)}%`);
  return parts.join("");
}

/**
 * --metrics モードの本体。標準入力の session_id で session-metrics.json を引き、セッション行に足す文字列を返す（改行なし）。
 * 何があっても例外を投げず、出せないときは空文字列。何も書かない。
 */
export function runMetrics({ stdinText, dataDir, now = Date.now() }) {
  if (typeof stdinText !== "string" || Buffer.byteLength(stdinText, "utf8") > MAX_INPUT_BYTES) return { code: 0, stdout: "" };
  let parsed;
  try {
    parsed = JSON.parse(stdinText);
  } catch {
    return { code: 0, stdout: "" };
  }
  if (!isObject(parsed)) return { code: 0, stdout: "" };
  return { code: 0, stdout: formatMetrics(readSessionMetrics(dataDir, parsed.session_id, now)) };
}

/** dataDir/usage.json の読み出し。無ければ none、壊れていれば invalid（ファイルは書き換えない） */
export function readUsage(dataDir) {
  let text;
  try {
    text = readFileSync(path.join(dataDir, USAGE_FILE_NAME), "utf8");
  } catch (err) {
    return err && err.code === "ENOENT" ? { status: "none" } : { status: "invalid" };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "invalid" };
  }
  if (!isObject(raw) || raw.version !== USAGE_VERSION || typeof raw.observedAt !== "number" || !Number.isFinite(raw.observedAt)) return { status: "invalid" };
  const out = { status: "ok", observedAt: raw.observedAt };
  for (const key of ["fiveHour", "sevenDay"]) {
    if (!(key in raw)) continue;
    const w = storedWindowOf(raw[key]);
    if (w === null) return { status: "invalid" };
    out[key] = w;
  }
  if (!("fiveHour" in out) && !("sevenDay" in out)) return { status: "invalid" };
  return out;
}

/**
 * 命令の本体。標準入力の文字列から usage.json を（書けるときだけ）書き、標準出力の 1 行を返す。
 * 何があっても例外を投げず、終了コードは 0（Claude の画面を止めない）。
 */
export function runStatusline({ stdinText, dataDir, now = Date.now() }) {
  const empty = { code: 0, stdout: "\n" };
  if (typeof stdinText !== "string" || Buffer.byteLength(stdinText, "utf8") > MAX_INPUT_BYTES) return empty;
  let parsed;
  try {
    parsed = JSON.parse(stdinText);
  } catch {
    return empty;
  }
  const usage = extractUsage(parsed);
  if (usage === null) return empty;
  try {
    writeUsage(dataDir, usage, now);
  } catch {
    // 書けなくても、Claude の画面の行は出す
  }
  return { code: 0, stdout: `${formatLine(usage)}\n` };
}

function isMain() {
  try {
    // 一時フォルダなどがシンボリックリンク越し（macOS の /var → /private/var）でも同じ実体と判定する
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let stdinText = "";
  try {
    stdinText = readFileSync(0, "utf8");
  } catch {
    stdinText = "";
  }
  // dataDir/bin に写された場所から動くときだけ書く・読む（リポジトリの hooks/ から直接動かしても、どこにも書かない）
  const inBin = path.basename(here) === "bin";
  const dataDir = path.resolve(here, "..");
  // --metrics は読むだけ。セッション行に足す文字列（改行なし）を出す。ふつうの動作は usage.json を書き、利用量の 1 行を出す
  const result = process.argv.includes("--metrics")
    ? inBin ? runMetrics({ stdinText, dataDir }) : { code: 0, stdout: "" }
    : inBin ? runStatusline({ stdinText, dataDir }) : { code: 0, stdout: "\n" };
  process.stdout.write(result.stdout);
  process.exitCode = result.code;
}
