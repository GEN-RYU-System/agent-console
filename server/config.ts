import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RoleConfig {
  id: string;
  labelKey: string;
  command: string[];
  needsWorktree: boolean;
  /** 再開用の起動コマンド（config 固定）。id なしの `--resume` で Claude 公式の会話選択リストが開く。画面の文字列はコマンドに入れない。 */
  resumeCommand?: string[];
  /** 再開できる作業場所: main=本店そのもの（Opus 設計役）/ worktree=本店のワークツリー（Sonnet 実装役）。resumeCommand と対で指定する。 */
  resumeScope?: ResumeScope;
  /**
   * 前回の続きとして開き直す命令（config 固定）。環境変数 AC_RESUME_ID に Claude の sessionId（UUID）が入る。
   * 無い役割は、通常の command で開き直す。
   */
  restoreCommand?: string[];
}

export type ResumeScope = "main" | "worktree";
const RESUME_SCOPES: readonly string[] = ["main", "worktree"];

export interface NotifyConfig {
  /** 区切りの macOS 通知（既定 true） */
  macos: boolean;
  osascriptBin: string;
}

export const DEFAULT_OSASCRIPT_BIN = "/usr/bin/osascript";
export const DEFAULT_RESTORE_STAGGER_MS = 3000;
export const DEFAULT_DATA_DIR = "~/Library/Application Support/agent-console";
export const DEFAULT_DIFF_BASE_REF = "origin/main";
export const DEFAULT_DIFF_MAX_FILE_BYTES = 1024 * 1024;
export const DEFAULT_DIFF_SEND_MAX_BYTES = 16 * 1024;
export const DEFAULT_PASTE_SUBMIT_DELAY_MS = 2000;
export const DEFAULT_GH_BIN = "gh";
export const DEFAULT_PR_POLL_MS = 120000;
export const DEFAULT_PR_REFRESH_MIN_MS = 10000;
export const DEFAULT_PICK_MAX_KEEP = 50;
export const DEFAULT_PICK_SEND_MAX_BYTES = 16 * 1024;
export const DEFAULT_PICK_HTML_IN_PROMPT_CHARS = 1500;
export const DEFAULT_ACTIVITY_KEEP_DAYS = 7;
export const DEFAULT_CLAUDE_SETTINGS_PATH = "~/.claude/settings.json";
/** VS Code の端末と同じ値。物理的なマウスのホイールのときだけ使う（画面が判定する） */
export const DEFAULT_TERMINAL_SMOOTH_SCROLL_MS = 125;
export const DEFAULT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_UPLOAD_MAX_KEEP = 100;
/** git に渡す基準の名前。`-` で始まるものはオプションと読まれるので許さない。 */
const DIFF_BASE_REF_PATTERN = /^[A-Za-z0-9_./][A-Za-z0-9_./-]*$/;

export interface Config {
  port: number;
  salesanchorRoot: string;
  newWorktreeScript: string;
  ledgerLookupScript: string;
  ledgerDir: string;
  claudeBin: string;
  agentsPollMs: number;
  ledgerPollMs: number;
  ringBufferBytes: number;
  roles: RoleConfig[];
  /** よく使う指示などアプリが保存するデータの置き場 */
  dataDir: string;
  notify: NotifyConfig;
  /** 端末の子プロセスの環境へ重ねる変数（例 LANG）。TERM と BLOCKLIST のキーは指定できない。 */
  terminalEnv: Record<string, string>;
  /** 起動時の復元で、1 件ずつ開く間隔（ms） */
  restoreStaggerMs: number;
  /** 変更の基準にする git の参照（既定 origin/main。最後に取得した値で、アプリは fetch しない） */
  diffBaseRef: string;
  /** 1 ファイルの変更をこの大きさ（byte）まで表示する */
  diffMaxFileBytes: number;
  /** 「Claude に送る」文章の上限（byte） */
  diffSendMaxBytes: number;
  /** 文章を貼ってから Enter を送るまでの待ち（ms）。本物の claude で 1 つの依頼になると実測した値が既定 */
  pasteSubmitDelayMs: number;
  /** GitHub CLI の場所（既定 "gh"。PATH から探す）。PR と検査の状態を読むためだけに使う */
  ghBin: string;
  /** PR と検査の状態を取り直す間隔（ms） */
  prPollMs: number;
  /** PR タブの「更新」を受け付ける最小の間隔（ms）。連打で GitHub の利用上限を使い切らないため */
  prRefreshMinMs: number;
  /** 部品（Chrome で選んだ画面の一部）を残す件数。超えたら古い順に消す */
  pickMaxKeep: number;
  /** 部品を「Claude に送る」文章の上限（byte） */
  pickSendMaxBytes: number;
  /** 送る文章に入れる部品 1 件あたりの HTML の長さ（字）。保存は拡張が送った長さのまま */
  pickHtmlInPromptChars: number;
  /** セッションの様子の記録（dataDir/activity/events-YYYYMMDD.jsonl）を残す日数。これより古い日付のファイルは本番のポートのサーバーが消す */
  activityKeepDays: number;
  /** 記録の仕組み（hooks）が入っているかを点検するために読む Claude の設定ファイル。読むだけで書かない */
  claudeSettingsPath: string;
  /** マウスのホイールでスクロールするときのなめらかさ（ms）。0 で無し */
  terminalSmoothScrollMs: number;
  /** 端末に貼る画像 1 枚の上限（byte） */
  uploadMaxBytes: number;
  /** 貼った画像を残す枚数。超えたら古い順に消す */
  uploadMaxKeep: number;
}

const STRING_KEYS = ["salesanchorRoot", "newWorktreeScript", "ledgerLookupScript", "ledgerDir", "claudeBin"] as const;
const NUMBER_KEYS = ["port", "agentsPollMs", "ledgerPollMs", "ringBufferBytes"] as const;

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseRole(raw: unknown, index: number): RoleConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`config: roles[${index}] must be an object`);
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") throw new Error(`config: roles[${index}].id is required`);
  if (typeof r.labelKey !== "string" || r.labelKey === "") throw new Error(`config: roles[${index}].labelKey is required`);
  if (!Array.isArray(r.command) || r.command.length === 0 || !r.command.every((c) => typeof c === "string")) {
    throw new Error(`config: roles[${index}].command must be a non-empty string array`);
  }
  if (typeof r.needsWorktree !== "boolean") throw new Error(`config: roles[${index}].needsWorktree must be boolean`);
  const base: RoleConfig = { id: r.id, labelKey: r.labelKey, command: r.command as string[], needsWorktree: r.needsWorktree };
  const role = r.restoreCommand === undefined ? base : { ...base, restoreCommand: parseCommand(r.restoreCommand, `roles[${index}].restoreCommand`) };
  if (r.resumeCommand === undefined) {
    if (r.resumeScope !== undefined) throw new Error(`config: roles[${index}].resumeScope requires resumeCommand`);
    return role;
  }
  const resumeCommand = parseCommand(r.resumeCommand, `roles[${index}].resumeCommand`);
  if (r.resumeScope === undefined) return { ...role, resumeCommand };
  if (typeof r.resumeScope !== "string" || !RESUME_SCOPES.includes(r.resumeScope)) {
    throw new Error(`config: roles[${index}].resumeScope must be "main" or "worktree"`);
  }
  return { ...role, resumeCommand, resumeScope: r.resumeScope as ResumeScope };
}

function parseCommand(raw: unknown, key: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((c) => typeof c === "string")) {
    throw new Error(`config: ${key} must be a non-empty string array`);
  }
  return raw as string[];
}

function parseNotify(raw: unknown): NotifyConfig {
  if (raw === undefined) return { macos: true, osascriptBin: DEFAULT_OSASCRIPT_BIN };
  if (typeof raw !== "object" || raw === null) throw new Error("config: notify must be an object");
  const n = raw as Record<string, unknown>;
  if (n.macos !== undefined && typeof n.macos !== "boolean") throw new Error("config: notify.macos must be boolean");
  if (n.osascriptBin !== undefined && (typeof n.osascriptBin !== "string" || n.osascriptBin === "")) {
    throw new Error("config: notify.osascriptBin must be a non-empty string");
  }
  return { macos: (n.macos as boolean | undefined) ?? true, osascriptBin: (n.osascriptBin as string | undefined) ?? DEFAULT_OSASCRIPT_BIN };
}

function parseDataDir(raw: unknown): string {
  if (raw === undefined) return expandHome(DEFAULT_DATA_DIR);
  if (typeof raw !== "string" || raw === "") throw new Error("config: dataDir must be a non-empty string");
  return expandHome(raw);
}

function parseStagger(raw: unknown): number {
  if (raw === undefined) return DEFAULT_RESTORE_STAGGER_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new Error("config: restoreStaggerMs must be a non-negative number");
  return raw;
}

function parseDiffBaseRef(raw: unknown): string {
  if (raw === undefined) return DEFAULT_DIFF_BASE_REF;
  if (typeof raw !== "string" || !DIFF_BASE_REF_PATTERN.test(raw)) {
    throw new Error("config: diffBaseRef must match ^[A-Za-z0-9_./][A-Za-z0-9_./-]*$ (no leading '-')");
  }
  return raw;
}

function parsePositive(raw: unknown, key: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) throw new Error(`config: ${key} must be a positive number`);
  return raw;
}

function parseSmoothScroll(raw: unknown): number {
  if (raw === undefined) return DEFAULT_TERMINAL_SMOOTH_SCROLL_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new Error("config: terminalSmoothScrollMs must be a non-negative number");
  return raw;
}

function parsePasteDelay(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PASTE_SUBMIT_DELAY_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new Error("config: pasteSubmitDelayMs must be a non-negative number");
  return raw;
}

function parseGhBin(raw: unknown): string {
  if (raw === undefined) return DEFAULT_GH_BIN;
  if (typeof raw !== "string" || raw === "") throw new Error("config: ghBin must be a non-empty string");
  return raw;
}

function parseClaudeSettingsPath(raw: unknown): string {
  if (raw === undefined) return expandHome(DEFAULT_CLAUDE_SETTINGS_PATH);
  if (typeof raw !== "string" || raw === "") throw new Error("config: claudeSettingsPath must be a non-empty string");
  return expandHome(raw);
}

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
// eslint-disable-next-line no-control-regex
const ENV_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** 端末内のプロセスから見えてはいけない変数（サーバー秘密・認証方式・キーチェーン読込の差し替え口）。 */
export const CHILD_ENV_BLOCKLIST: ReadonlySet<string> = new Set(["AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_AUTH", "AC_SECURITY", "AC_STUB_LOG"]);
/** terminalEnv で指定できない変数（TERM は固定値 + BLOCKLIST）。 */
export const TERMINAL_ENV_FORBIDDEN: ReadonlySet<string> = new Set(["TERM", ...CHILD_ENV_BLOCKLIST]);

function parseTerminalEnv(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("config: terminalEnv must be an object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!ENV_KEY.test(k)) throw new Error(`config: terminalEnv key ${JSON.stringify(k)} is invalid (A-Z, 0-9, _)`);
    if (TERMINAL_ENV_FORBIDDEN.has(k)) throw new Error(`config: terminalEnv.${k} cannot be set`);
    if (typeof v !== "string" || v === "" || ENV_CONTROL_CHARS.test(v)) {
      throw new Error(`config: terminalEnv.${k} must be a non-empty string without control characters`);
    }
    out[k] = v;
  }
  return out;
}

/** 設定の検証。必須キー欠落・型違いは起動中止（例外）にする。 */
export function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) throw new Error("config: must be a JSON object");
  const o = raw as Record<string, unknown>;
  for (const key of STRING_KEYS) {
    if (typeof o[key] !== "string" || o[key] === "") throw new Error(`config: ${key} is required (string)`);
  }
  for (const key of NUMBER_KEYS) {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`config: ${key} is required (positive number)`);
  }
  if (!Array.isArray(o.roles) || o.roles.length === 0) throw new Error("config: roles is required (non-empty array)");
  const roles = o.roles.map(parseRole);
  const ids = new Set<string>();
  const scopes = new Set<string>();
  for (const role of roles) {
    if (ids.has(role.id)) throw new Error(`config: duplicate role id ${role.id}`);
    ids.add(role.id);
    if (role.resumeScope === undefined) continue;
    if (scopes.has(role.resumeScope)) throw new Error(`config: duplicate resumeScope ${role.resumeScope}`);
    scopes.add(role.resumeScope);
  }
  return {
    port: o.port as number,
    salesanchorRoot: expandHome(o.salesanchorRoot as string),
    newWorktreeScript: o.newWorktreeScript as string,
    ledgerLookupScript: o.ledgerLookupScript as string,
    ledgerDir: o.ledgerDir as string,
    claudeBin: o.claudeBin as string,
    agentsPollMs: o.agentsPollMs as number,
    ledgerPollMs: o.ledgerPollMs as number,
    ringBufferBytes: o.ringBufferBytes as number,
    roles,
    dataDir: parseDataDir(o.dataDir),
    notify: parseNotify(o.notify),
    terminalEnv: parseTerminalEnv(o.terminalEnv),
    restoreStaggerMs: parseStagger(o.restoreStaggerMs),
    diffBaseRef: parseDiffBaseRef(o.diffBaseRef),
    diffMaxFileBytes: parsePositive(o.diffMaxFileBytes, "diffMaxFileBytes", DEFAULT_DIFF_MAX_FILE_BYTES),
    diffSendMaxBytes: parsePositive(o.diffSendMaxBytes, "diffSendMaxBytes", DEFAULT_DIFF_SEND_MAX_BYTES),
    pasteSubmitDelayMs: parsePasteDelay(o.pasteSubmitDelayMs),
    ghBin: parseGhBin(o.ghBin),
    prPollMs: parsePositive(o.prPollMs, "prPollMs", DEFAULT_PR_POLL_MS),
    prRefreshMinMs: parsePositive(o.prRefreshMinMs, "prRefreshMinMs", DEFAULT_PR_REFRESH_MIN_MS),
    pickMaxKeep: parsePositive(o.pickMaxKeep, "pickMaxKeep", DEFAULT_PICK_MAX_KEEP),
    pickSendMaxBytes: parsePositive(o.pickSendMaxBytes, "pickSendMaxBytes", DEFAULT_PICK_SEND_MAX_BYTES),
    pickHtmlInPromptChars: parsePositive(o.pickHtmlInPromptChars, "pickHtmlInPromptChars", DEFAULT_PICK_HTML_IN_PROMPT_CHARS),
    activityKeepDays: parsePositive(o.activityKeepDays, "activityKeepDays", DEFAULT_ACTIVITY_KEEP_DAYS),
    claudeSettingsPath: parseClaudeSettingsPath(o.claudeSettingsPath),
    terminalSmoothScrollMs: parseSmoothScroll(o.terminalSmoothScrollMs),
    uploadMaxBytes: parsePositive(o.uploadMaxBytes, "uploadMaxBytes", DEFAULT_UPLOAD_MAX_BYTES),
    uploadMaxKeep: parsePositive(o.uploadMaxKeep, "uploadMaxKeep", DEFAULT_UPLOAD_MAX_KEEP),
  };
}

export function defaultConfigPath(): string {
  return process.env.AGENT_CONSOLE_CONFIG ?? path.join(process.cwd(), "agent-console.config.json");
}

/** 自己診断（別ポートで起動確認）用に AGENT_CONSOLE_PORT でポートだけ上書きできる。 */
export function applyPortOverride(config: Config, raw: string | undefined): Config {
  if (raw === undefined || raw === "") return config;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_CONSOLE_PORT は 1〜65535 の整数にしてください");
  return { ...config, port };
}

export function loadConfig(file: string = defaultConfigPath()): Config {
  return applyPortOverride(parseConfig(JSON.parse(readFileSync(file, "utf8"))), process.env.AGENT_CONSOLE_PORT);
}
