// 未読の印の「付けすぎ率」「付け漏れ率」と、Stop の欄の入り具合を、activity の記録から数える。設計 docs/handoff/unread-ball-with-po/design.md §6・§9。
// 使い方: node scripts/measure-unread.mjs [--since <ISO 日時 か ミリ秒>] [--data-dir <dataDir>] [--help]
// 読むだけで何も書かない（記録・設定・ほかのファイルを変えない）。
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promptKey } from "../hooks/activity-hook.mjs";

const USAGE = `使い方: node scripts/measure-unread.mjs [--since <ISO 日時 か ミリ秒>] [--data-dir <dataDir>] [--help]
  --since     この時刻以降の Stop を数える（既定: 24 時間前。下限に足りなければ 72 時間まで延ばして出す）
  --data-dir  activity の記録の置き場（既定: 設定ファイルの dataDir）
読むだけで何も書きません。`;
const STALE_MS = 30 * 60 * 1000;
const SELF_RESUME_PREFIX = /^\s*(<agent-message\b|<task-notification\b|<cross-session-message\b|# Autonomous loop\b)/;
const OVER_MIN = 100;
const LEAK_MIN = 30;
const HOUR = 60 * 60 * 1000;

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({ options: { since: { type: "string" }, "data-dir": { type: "string" }, help: { type: "boolean", short: "h" } } });
} catch (err) {
  fail(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`, 2);
}
if (parsed.values.help) {
  console.log(USAGE);
  process.exit(0);
}

function parseSince(raw) {
  if (raw === undefined) return undefined;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(ms)) fail(`--since を読めません: ${raw}\n${USAGE}`, 2);
  return ms;
}

async function resolveDataDir() {
  if (parsed.values["data-dir"] !== undefined) return parsed.values["data-dir"];
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { loadConfig } = await import("../server/config.ts");
  return loadConfig(process.env.AGENT_CONSOLE_CONFIG ?? path.join(root, "agent-console.config.json")).dataDir;
}

/** activity の jsonl を全部読み、会話ごとに ts の順に並べる */
function readSessions(activityDir) {
  const bySession = new Map();
  let names = [];
  try {
    names = readdirSync(activityDir).filter((n) => /^events-\d{8}\.jsonl$/.test(n)).sort();
  } catch {
    fail(`activity の記録が読めません: ${activityDir}`, 1);
  }
  for (const name of names) {
    for (const line of readFileSync(path.join(activityDir, name), "utf8").split("\n")) {
      if (line === "") continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof rec !== "object" || rec === null || typeof rec.ts !== "number" || typeof rec.session_id !== "string") continue;
      if (!["Stop", "StopFailure", "UserPromptSubmit"].includes(rec.event)) continue;
      if (typeof rec.agent_id === "string" && rec.agent_id !== "") continue;
      const list = bySession.get(rec.session_id) ?? [];
      list.push(rec);
      bySession.set(rec.session_id, list);
    }
  }
  for (const list of bySession.values()) list.sort((a, b) => a.ts - b.ts);
  return bySession;
}

const isCount = (v) => typeof v === "number" && Number.isFinite(v);
function pendingOf(stop) {
  if (!isCount(stop.bg_tasks) && !isCount(stop.crons_once)) return null;
  return (isCount(stop.bg_tasks) && stop.bg_tasks >= 1) || (isCount(stop.crons_once) && stop.crons_once >= 1);
}
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const pct = (num, den) => (den === 0 ? "-" : `${((num / den) * 100).toFixed(1)}% (${num}/${den})`);

function measure(sessions, since) {
  const r = {
    stops: 0, activeStops: 0, failures: 0, noNext: 0,
    withFields: 0, types: {}, onceMatch: 0, repeatMatch: 0,
    marked: 0, markedOver: 0, pendingStops: 0, pendingLeak: 0, leakByType: {},
  };
  for (const list of sessions.values()) {
    list.forEach((rec, i) => {
      if (rec.ts < since) return;
      if (rec.event === "StopFailure") {
        r.failures += 1;
        return;
      }
      if (rec.event !== "Stop") return;
      if (rec.stop_hook_active === true) {
        r.activeStops += 1;
        return;
      }
      r.stops += 1;
      if (isCount(rec.bg_tasks)) {
        r.withFields += 1;
        for (const [type, n] of Object.entries(rec.bg_types ?? {})) if (isCount(n)) r.types[type] = (r.types[type] ?? 0) + n;
      }
      const next = list.slice(i + 1).find((x) => x.event === "UserPromptSubmit");
      if (next === undefined) {
        r.noNext += 1;
        return;
      }
      const prompt = typeof next.prompt === "string" ? next.prompt : "";
      const key = prompt === "" ? "" : promptKey(prompt);
      const onceHit = key !== "" && strings(rec.cron_once_hashes).includes(key);
      const repeatHit = key !== "" && strings(rec.cron_repeat_hashes).includes(key);
      if (onceHit) r.onceMatch += 1;
      if (repeatHit) r.repeatMatch += 1;
      const aiResume = next.source === "agent" || SELF_RESUME_PREFIX.test(prompt) || onceHit || repeatHit;
      const gap = next.ts - rec.ts;
      const pending = pendingOf(rec);
      if (pending !== true || gap >= STALE_MS) {
        r.marked += 1;
        if (aiResume) r.markedOver += 1;
      }
      if (pending === true) {
        r.pendingStops += 1;
        const leak = !aiResume && gap < STALE_MS;
        if (leak) r.pendingLeak += 1;
        const types = Object.keys(rec.bg_types ?? {});
        for (const type of types.length > 0 ? types : ["(予定の文だけ)"]) {
          const row = (r.leakByType[type] ??= { total: 0, leak: 0 });
          row.total += 1;
          if (leak) row.leak += 1;
        }
      }
    });
  }
  return r;
}

const dataDir = await resolveDataDir();
const sessions = readSessions(path.join(dataDir, "activity"));
const explicit = parseSince(parsed.values.since);
const now = Date.now();
let since = explicit ?? now - 24 * HOUR;
let r = measure(sessions, since);
let widened = false;
if (explicit === undefined && (r.marked < OVER_MIN || r.pendingStops < LEAK_MIN)) {
  since = now - 72 * HOUR;
  r = measure(sessions, since);
  widened = true;
}

console.log(`期間: ${new Date(since).toISOString()} 以降${widened ? "（24 時間では足りず 72 時間に延ばした）" : ""}`);
console.log(`Stop（stop_hook_active が false）: ${r.stops} 件 / stop_hook_active が true: ${r.activeStops} 件（率に入れない）/ StopFailure: ${r.failures} 件（率に入れない）/ 次の入力なし: ${r.noNext} 件（率に入れない）`);
console.log(`欄あり件数: ${r.withFields}`);
console.log(`type ごとの件数: ${Object.keys(r.types).length === 0 ? "なし" : Object.entries(r.types).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`一度きりの予定の文の一致件数: ${r.onceMatch}`);
console.log(`繰り返しの予定の文の一致件数: ${r.repeatMatch}`);
const overOk = r.marked >= OVER_MIN;
const leakOk = r.pendingStops >= LEAK_MIN;
console.log(`付けすぎ率: ${overOk ? pct(r.markedOver, r.marked) : `判定できない（分母 ${r.marked} < ${OVER_MIN}）`}`);
console.log(`付け漏れ率: ${leakOk ? pct(r.pendingLeak, r.pendingStops) : `判定できない（分母 ${r.pendingStops} < ${LEAK_MIN}）`}`);
for (const [type, row] of Object.entries(r.leakByType).sort()) console.log(`  付け漏れ type=${type}: ${pct(row.leak, row.total)}`);
