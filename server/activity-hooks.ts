// Claude の設定ファイル（settings.json）に、agent-console の記録用 hook を足す・外す・点検する。設計 §3-3。
// サーバー（K8 の点検）と scripts/ac-hooks.mjs（足す・外す）が共有する。後者は node の型除去でこのファイルを直接読むため、
// 型の注釈だけで書く（enum・パラメータプロパティなど、型を消しただけでは動かない構文は使わない）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 自分の handler の目印: args[0] がこの文字列で終わる */
export const OWN_HOOK_SUFFIX = "/hooks/activity-hook.mjs";
export const BACKUP_PREFIX = "settings.json.ac-backup-";
const BACKUP_NAME = /^settings\.json\.ac-backup-\d{8}T\d{9}Z$/;
export const BACKUPS_KEPT = 3;
const SETTINGS_MODE = 0o600;

export interface HookSpec {
  event: string;
  matcher?: string;
}

/**
 * 記録する 9 つのイベント。Notification は使わない（状態は claude agents --json が正本）。
 * Stop（返事）と StopFailure（API エラー）はチャット画面の会話の記録のため（v0.11.0）。状態の判定には使わない。
 * SubagentStart は担当の呼び出しと再開の印（v0.12.0 作戦ボード）。再開した担当を「動いている担当」に戻すために使う。
 */
export const HOOK_SPECS: readonly HookSpec[] = [
  { event: "PreToolUse", matcher: "Agent|SubagentHandback" },
  { event: "PostToolUse", matcher: "Agent" },
  { event: "SubagentStop" },
  { event: "TaskCreated" },
  { event: "TaskCompleted" },
  { event: "UserPromptSubmit" },
  { event: "Stop" },
  { event: "StopFailure" },
  { event: "SubagentStart" },
];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export class HookSettingsError extends Error {}

export interface Handler {
  type: "command";
  command: string;
  args: string[];
  async: true;
}

/** exec の形（args に 1 要素ずつ渡す。引用符は要らず、空白を含むパスでも壊れない） */
export function buildHandler(nodePath: string, hookPath: string): Handler {
  return { type: "command", command: nodePath, args: [hookPath], async: true };
}

export function isOwnHandler(handler: unknown): boolean {
  if (!isObject(handler) || handler.type !== "command" || !Array.isArray(handler.args)) return false;
  const first = handler.args[0];
  return typeof first === "string" && first.endsWith(OWN_HOOK_SUFFIX);
}

function sameHandler(handler: unknown, nodePath: string, hookPath: string): boolean {
  return JSON.stringify(handler) === JSON.stringify(buildHandler(nodePath, hookPath));
}

/** settings の hooks をたどる。形が想定外なら理由つきで例外（何も書かない） */
function eventGroups(settings: Json, event: string): unknown[] {
  const hooks = settings.hooks;
  if (hooks === undefined) return [];
  if (!isObject(hooks)) throw new HookSettingsError("settings.json の hooks が想定した形（オブジェクト）ではありません");
  const groups = hooks[event];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new HookSettingsError(`settings.json の hooks.${event} が想定した形（配列）ではありません`);
  return groups;
}

function groupHandlers(group: unknown): unknown[] | null {
  return isObject(group) && Array.isArray(group.hooks) ? group.hooks : null;
}

function withEvent(settings: Json, event: string, groups: unknown[] | null): Json {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const { [event]: _removed, ...others } = hooks;
  return { ...settings, hooks: groups === null ? others : { ...others, [event]: groups } };
}

export interface EditResult {
  settings: Json;
  changed: boolean;
}

/** 9 つのイベントに自分の handler を足した新しい設定を返す。すでにあれば足さない。内容が違えば（node のパス変更など）その場で直す */
export function addHandlers(settings: Json, nodePath: string, hookPath: string): EditResult {
  let next = settings;
  let changed = false;
  for (const spec of HOOK_SPECS) {
    const groups = eventGroups(next, spec.event);
    let found = false;
    let stale = false;
    const rewritten = groups.map((group) => {
      const handlers = groupHandlers(group);
      if (handlers === null || !handlers.some(isOwnHandler)) return group;
      found = true;
      const updated = handlers.map((h) => {
        if (!isOwnHandler(h) || sameHandler(h, nodePath, hookPath)) return h;
        stale = true;
        return buildHandler(nodePath, hookPath);
      });
      return stale ? { ...(group as Json), hooks: updated } : group;
    });
    if (found && !stale) continue;
    changed = true;
    if (found) {
      next = withEvent(next, spec.event, rewritten);
      continue;
    }
    const group: Json = spec.matcher === undefined ? { hooks: [buildHandler(nodePath, hookPath)] } : { matcher: spec.matcher, hooks: [buildHandler(nodePath, hookPath)] };
    next = withEvent(next, spec.event, [...groups, group]);
  }
  return { settings: next, changed };
}

export interface RemoveResult extends EditResult {
  removed: number;
}

/** 自分の handler だけを外した新しい設定を返す。外して空になった group と、空になったイベントのキーは消す */
export function removeHandlers(settings: Json): RemoveResult {
  let next = settings;
  let removed = 0;
  const hooks = settings.hooks;
  if (hooks === undefined) return { settings, changed: false, removed: 0 };
  if (!isObject(hooks)) throw new HookSettingsError("settings.json の hooks が想定した形（オブジェクト）ではありません");
  for (const event of Object.keys(hooks)) {
    // 外す側は、自分に関係のない形のイベント（配列でないもの）には触れない
    if (!Array.isArray(hooks[event])) continue;
    const groups = eventGroups(next, event);
    let touched = false;
    const kept: unknown[] = [];
    for (const group of groups) {
      const handlers = groupHandlers(group);
      if (handlers === null || !handlers.some(isOwnHandler)) {
        kept.push(group);
        continue;
      }
      touched = true;
      const rest = handlers.filter((h) => !isOwnHandler(h));
      removed += handlers.length - rest.length;
      if (rest.length > 0) kept.push({ ...(group as Json), hooks: rest });
    }
    if (touched) next = withEvent(next, event, kept.length > 0 ? kept : null);
  }
  return { settings: next, changed: removed > 0, removed };
}

export interface HookCheck {
  ok: boolean;
  reason?: "noSettings" | "unreadable" | "missingHandler" | "nodeMissing" | "hookFileMissing";
  /** reason が missingHandler のとき、handler が無かったイベント */
  missingEvents?: string[];
}

/** この hookPath を指す自分の handler（node のパスも返す）。無ければ null */
function findHandler(settings: Json, event: string, hookPath: string): Json | null {
  for (const group of eventGroups(settings, event)) {
    for (const h of groupHandlers(group) ?? []) {
      if (isOwnHandler(h) && (h as Json).args instanceof Array && ((h as Json).args as unknown[])[0] === hookPath) return h as Json;
    }
  }
  return null;
}

export interface CheckInput {
  settingsPath: string;
  /** dataDir/hooks/activity-hook.mjs */
  hookPath: string;
}

/** 設定ファイルを読むだけ（書かない）。9 つのイベントの handler・node・hook のファイルがそろっているか */
export function checkHooks(input: CheckInput): HookCheck {
  let raw: string;
  try {
    raw = readFileSync(input.settingsPath, "utf8");
  } catch (err) {
    return { ok: false, reason: (err as { code?: string }).code === "ENOENT" ? "noSettings" : "unreadable" };
  }
  let settings: Json;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return { ok: false, reason: "unreadable" };
    settings = parsed;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const found = HOOK_SPECS.map((spec) => ({ event: spec.event, handler: findHandler(settings, spec.event, input.hookPath) }));
    const missingEvents = found.filter((f) => f.handler === null).map((f) => f.event);
    if (missingEvents.length > 0) return { ok: false, reason: "missingHandler", missingEvents };
    const nodePaths = found.map((f) => (f.handler as Json).command);
    if (!nodePaths.every((n) => typeof n === "string" && existsSync(n))) return { ok: false, reason: "nodeMissing" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return existsSync(input.hookPath) ? { ok: true } : { ok: false, reason: "hookFileMissing" };
}

function detectIndent(text: string): string | number {
  const m = /^[ \t]+(?=")/m.exec(text);
  return m !== null ? m[0] : 2;
}

function backupName(now: number): string {
  // 2026-10-12T14:00:00.123Z → 20261012T140000123Z
  return `${BACKUP_PREFIX}${new Date(now).toISOString().replace(/[-:.]/g, "")}`;
}

/** 新しい控えを BACKUPS_KEPT 件だけ残す。消すのは settings.json.ac-backup-<日時> の形のファイルだけ */
function pruneBackups(dir: string): void {
  const names = readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).sort();
  for (const old of names.slice(0, Math.max(0, names.length - BACKUPS_KEPT))) rmSync(path.join(dir, old), { force: true });
}

interface ReadSettings {
  real: string;
  text: string | null;
  settings: Json;
}

function readSettings(settingsPath: string): ReadSettings {
  let real = settingsPath;
  try {
    real = realpathSync(settingsPath);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
  if (!existsSync(real)) return { real, text: null, settings: {} };
  const text = readFileSync(real, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HookSettingsError(`${settingsPath} は JSON として読めません（何も書き換えていません）`);
  }
  if (!isObject(parsed)) throw new HookSettingsError(`${settingsPath} の中身がオブジェクトではありません（何も書き換えていません）`);
  return { real, text, settings: parsed };
}

/** 控えを取り、一時ファイル→rename で書き、読み直して JSON を確かめる。確かめに失敗したら控えから戻す */
function commit(read: ReadSettings, next: Json, now: number): void {
  const dir = path.dirname(read.real);
  mkdirSync(dir, { recursive: true });
  const original = read.text;
  let backup: string | null = null;
  if (original !== null) {
    backup = path.join(dir, backupName(now));
    copyFileSync(read.real, backup);
    pruneBackups(dir);
  }
  const mode = original !== null ? statSync(read.real).mode & 0o777 : SETTINGS_MODE;
  const text = `${JSON.stringify(next, null, original !== null ? detectIndent(original) : 2)}\n`;
  const tmp = path.join(dir, `.settings.json.ac-tmp-${process.pid}-${now}`);
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, read.real);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  try {
    JSON.parse(readFileSync(read.real, "utf8"));
  } catch (err) {
    if (backup !== null) copyFileSync(backup, read.real);
    throw new HookSettingsError(`書いたあとの ${read.real} を読み直せませんでした（控えから戻しました）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface InstallInput {
  settingsPath: string;
  nodePath: string;
  hookPath: string;
  now?: () => number;
}

export interface InstallResult {
  changed: boolean;
}

export function installHooks(input: InstallInput): InstallResult {
  const now = (input.now ?? Date.now)();
  const read = readSettings(input.settingsPath);
  const result = addHandlers(read.settings, input.nodePath, input.hookPath);
  if (!result.changed) return { changed: false };
  commit(read, result.settings, now);
  return { changed: true };
}

export interface UninstallInput {
  settingsPath: string;
  now?: () => number;
}

export interface UninstallResult {
  changed: boolean;
  removed: number;
}

export function uninstallHooks(input: UninstallInput): UninstallResult {
  const now = (input.now ?? Date.now)();
  const read = readSettings(input.settingsPath);
  if (read.text === null) return { changed: false, removed: 0 };
  const result = removeHandlers(read.settings);
  if (!result.changed) return { changed: false, removed: 0 };
  commit(read, result.settings, now);
  return { changed: true, removed: result.removed };
}
