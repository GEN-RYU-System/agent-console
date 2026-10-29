// 件のセッション（役割 discord-case）の囲いの設定と見張りの設定を、件ごとに作る。設計 §4-5「Claude の道具の囲い」「外への通信を塞ぐ」。
// 純粋な関数（道の一覧・buildCaseSettings）と、ファイルを書く関数（writeCaseFiles・removeCaseFiles）に分ける。
import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ACTIVITY_HOOK_FILE, BOARD_GUARD_HOOK_FILE, GUARD_HOOK_FILE, SERVER_KILL_GUARD_HOOK_FILE, addHandlers } from "./activity-hooks.ts";
import { caseCloneDir } from "./case-clone.ts";

export class CaseSandboxUnavailableError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const GH_USER = "shingo-cc";

export interface CaseParams {
  /** 本店（写しの元。囲いの中からは読めず書けない） */
  M: string;
  /** 件の写し */
  W: string;
  /** 件の一時の置き場（P の直下。P は T の親） */
  T: string;
  /** config.dataDir */
  D: string;
  /** os.homedir() */
  H: string;
  /** 報告の置き場 */
  R: string;
  /** 件の gh の設定の置き場 */
  GH: string;
  /** 件ごとの claude の状態の置き場 D/case-home/<id> */
  CH: string;
  guardScript: string;
  nodeBin: string;
  caseFile: string;
  hookPath: string;
}

const uid = (): number => process.getuid?.() ?? 0;
const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const parentOf = (T: string): string => path.dirname(T);

/** 件のセッションが使う道の一式（どれも realpath にそろえる）。W は写しの置き場、R は報告、T は一時、GH は gh の設定 */
export function casePaths(p: { id: string; H: string; D: string; tmpRoot?: string }): { H: string; D: string; W: string; R: string; P: string; T: string; GH: string; CH: string } {
  if (!UUID.test(p.id)) throw new CaseSandboxUnavailableError("sandbox unavailable: case id must be a UUID");
  const H = realOr(p.H);
  const D = realOr(p.D);
  const tmp = realOr(p.tmpRoot ?? "/tmp");
  const P = path.join(tmp, "acc");
  return {
    H,
    D,
    W: caseCloneDir(H, p.id),
    R: path.join(tmp, "CC報告ファイル", "discord-case", p.id),
    P,
    T: path.join(P, p.id.slice(0, 8)),
    GH: path.join(D, "case-gh", p.id),
    CH: path.join(D, "case-home", p.id),
  };
}

export const CASE_DENY_WRITE = (p: CaseParams): string[] => [
  path.join(p.W, ".git", "hooks"),
  path.join(p.W, ".git", "config"),
  path.join(p.W, ".git", "commondir"),
  path.join(p.W, ".git", "objects", "info", "alternates"),
  path.join(p.W, ".claude"),
  path.join(p.W, ".mcp.json"),
  path.join(p.R, ".claude"),
  path.join(p.D, "cases"),
  path.join(p.D, "case-gh"),
  path.join(p.D, "hooks"),
  path.join(p.D, "activity"),
  path.join(p.H, ".claude"),
  path.join(p.H, ".claude.json"),
  path.join(p.H, ".zshrc"),
  `/private/tmp/claude-${uid()}`,
  p.M,
];

export const CASE_DENY_READ = (p: CaseParams): string[] => [
  path.join(p.D, "reserve-token"),
  path.join(p.H, ".claude-access.env"),
  path.join(p.H, ".claude", "channels"),
  path.join(p.H, ".claude", "projects"),
  path.join(p.H, ".claude", ".credentials.json"),
  path.join(p.H, "Library", "Keychains"),
  path.join(p.H, ".config", "gh"),
  path.join(p.D, "cases"),
  path.join(p.H, ".config", "git", "credentials"),
  path.join(p.H, ".git-credentials"),
];

/** 囲いの `filesystem.denyRead` に入れる一覧。権限の Read の deny は CASE_DENY_READ のまま（Claude の読む道具は --restricted と見張りで守る） */
export const CASE_DENY_READ_SANDBOX = (p: CaseParams): string[] => [
  p.H,
  "/private/tmp/CC報告ファイル",
  `/private/tmp/claude-${uid()}`,
  realOr(os.tmpdir()),
  p.M,
  parentOf(p.T),
  ...CASE_DENY_READ(p),
];

export const CASE_ALLOW_WRITE = (p: CaseParams): string[] => [p.W, p.R, p.T];

/** node の置き場（実体の2つ上）。H の下にあるときだけ返す。ホーム丸ごと・ホーム直下になるなら使えない */
export function caseNodeHome(p: { H: string; nodeBin: string }): string | null {
  const real = realOr(p.nodeBin);
  const home = path.dirname(path.dirname(real));
  if (home !== p.H && !home.startsWith(p.H + path.sep)) return null;
  if (home === p.H || path.dirname(home) === p.H) throw new CaseSandboxUnavailableError("sandbox unavailable: node home is the home directory or directly under it");
  return home;
}

/** 囲いの中の命令に、塞いだホームの中から開け直す場所 */
export const CASE_ALLOW_READ = (p: CaseParams): string[] => {
  const nodeHome = caseNodeHome(p);
  return [
    p.W,
    p.R,
    p.GH,
    p.T,
    path.join(p.H, ".gitconfig"),
    path.join(p.H, ".config", "git", "config"),
    path.join(p.H, ".config", "git", "ignore"),
    path.join(p.H, ".config", "git", "attributes"),
    ...(nodeHome === null ? [] : [nodeHome]),
  ];
};

export const CASE_ALLOWED_DOMAINS: readonly string[] = ["api.github.com", "github.com", "api.salesanchor.jp", "127.0.0.1", "localhost"];

export const CASE_MAIN_ONLY_DOMAINS: readonly string[] = ["api.anthropic.com"];

/** 受付（case-proxy）の通す行き先。ローカルの2つを除いた CASE_ALLOWED_DOMAINS と CASE_MAIN_ONLY_DOMAINS。ほかの所に一覧を書かない */
export const caseProxyDomains = (): string[] => [...CASE_ALLOWED_DOMAINS.filter((d) => d !== "127.0.0.1" && d !== "localhost"), ...CASE_MAIN_ONLY_DOMAINS];

/** 受付の番号（セッションごとに変えない。起こし直しで部屋の設定と番号がずれないように） */
export const CASE_PROXY_PORT = 18124;

/** 部屋（room.sb）の土台と既定の許可。mach-lookup は CASE_ROOM_MACH に完全な名前で書く（AppleEvents・lsopen は無し） */
export const CASE_ROOM_BASE = [
  "; ===== 1. 土台 =====",
  "; from @anthropic-ai/sandbox-runtime 0.0.81 dist/sandbox/macos-sandbox-utils.js:760-769 (Apache-2.0)",
  "(allow process-exec)",
  "(allow process-fork)",
  "(allow process-info* (target same-sandbox))",
  "(allow signal (target same-sandbox))",
  "(allow mach-priv-task-port (target same-sandbox))",
  "(allow user-preference-read)",
  "; from @anthropic-ai/sandbox-runtime 0.0.81 dist/sandbox/macos-sandbox-utils.js:817-834 (Apache-2.0)",
  "(allow ipc-posix-shm)",
  "(allow ipc-posix-sem)",
  '(allow iokit-open (iokit-registry-entry-class "IOSurfaceRootUserClient") (iokit-registry-entry-class "RootDomainUserClient") (iokit-user-client-class "IOSurfaceSendRight"))',
  "(allow iokit-get-properties)",
  "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
  "; from @anthropic-ai/sandbox-runtime 0.0.81 dist/sandbox/macos-sandbox-utils.js:836-897 (Apache-2.0)",
  "(allow sysctl-read",
  ...[
    "hw.activecpu", "hw.busfrequency_compat", "hw.byteorder", "hw.cacheconfig", "hw.cachelinesize_compat", "hw.cpufamily", "hw.cpufrequency", "hw.cpufrequency_compat", "hw.cputype",
    "hw.l1dcachesize_compat", "hw.l1icachesize_compat", "hw.l2cachesize_compat", "hw.l3cachesize_compat", "hw.logicalcpu", "hw.logicalcpu_max", "hw.machine", "hw.memsize", "hw.ncpu",
    "hw.nperflevels", "hw.packages", "hw.pagesize_compat", "hw.pagesize", "hw.physicalcpu", "hw.physicalcpu_max", "hw.tbfrequency_compat", "hw.vectorunit", "kern.argmax", "kern.bootargs",
    "kern.hostname", "kern.maxfiles", "kern.maxfilesperproc", "kern.maxproc", "kern.ngroups", "kern.osproductversion", "kern.osrelease", "kern.ostype", "kern.osvariant_status",
    "kern.osversion", "kern.secure_kernel", "kern.tcsm_available", "kern.tcsm_enable", "kern.usrstack64", "kern.version", "kern.willshutdown", "machdep.cpu.brand_string",
    "machdep.ptrauth_enabled", "security.mac.lockdown_mode_state", "sysctl.proc_cputype", "vm.loadavg",
  ].map((n) => `  (sysctl-name "${n}")`),
  ...["hw.optional.arm", "hw.optional.arm.", "hw.optional.armv8_", "hw.perflevel", "kern.proc.all", "kern.proc.pgrp.", "kern.proc.pid.", "machdep.cpu.", "net.routetable."].map((n) => `  (sysctl-name-prefix "${n}")`),
  ")",
  '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
  "(allow distributed-notification-post)",
  "; from @anthropic-ai/sandbox-runtime 0.0.81 dist/sandbox/macos-sandbox-utils.js:909-922 (Apache-2.0)",
  ...["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/dtracehelper", "/dev/tty"].map((d) => `(allow file-ioctl (literal "${d}"))`),
  '(allow file-ioctl file-read-data file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))',
].join("\n");

/**
 * 部屋で通す mach-lookup の名前（完全な名前だけ。`*` は使わない）。srt の :772-792 の一覧に、gh の TLS に要る `com.apple.trustd.agent`（:789）を足した物。
 * `com.apple.SecurityServer`・`com.apple.securityd.xpc` は入れない（Keychain は開けない。設計 §4-3）
 */
export const CASE_ROOM_MACH: readonly string[] = [
  "com.apple.audio.systemsoundserver",
  "com.apple.distributed_notifications@Uv3",
  "com.apple.FontObjectsServer",
  "com.apple.fonts",
  "com.apple.logd",
  "com.apple.lsd.mapdb",
  "com.apple.PowerManagement.control",
  "com.apple.system.logger",
  "com.apple.system.notification_center",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.bsd.dirhelper",
  "com.apple.coreservices.launchservicesd",
  "com.apple.trustd.agent",
];

export type CaseRoomParams = CaseParams & { claudeReal: string };

/**
 * 部屋の中で、読み取りに名前を挙げて開ける物。case-home の根 CH だけが subpath で、ほかはファイル1つずつの literal。
 * 件の設定・件の情報・見張りの台本・記録用 hook・担当の見張り・停止の見張り・claude の実体。git の設定の4つは CASE_ALLOW_READ にあるので足さない
 */
export const CASE_ROOM_READ_NAMED = (p: CaseRoomParams): string[] => [
  path.join(caseDirOf(p.D, caseIdOf(p)), "settings.json"),
  path.join(caseDirOf(p.D, caseIdOf(p)), "case.json"),
  p.guardScript,
  path.join(p.D, "hooks", ACTIVITY_HOOK_FILE),
  path.join(p.D, "hooks", GUARD_HOOK_FILE),
  path.join(p.D, "hooks", SERVER_KILL_GUARD_HOOK_FILE),
  p.claudeReal,
  p.CH,
];

/** 件の id は CH（D/case-home/<id>）の最後の名前 */
const caseIdOf = (p: { CH: string }): string => path.basename(p.CH);

const PROTECTED_FILES = [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".claude/scheduled_tasks.json", ".git/config"];
const PROTECTED_DIRS = [".vscode", ".idea", ".claude/commands", ".claude/agents", ".claude/skills", ".claude/hooks", ".claude/workflows", ".git/hooks"];
const PROTECTED_BARE = ["HEAD", "objects", "refs", "config"];

const reesc = (s: string): string => s.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
/** 1文字ずつ大小を問わない形（`git` → `[gG][iI][tT]`）。英字以外は逃がすだけ */
const cip = (s: string): string => [...s].map((ch) => (/[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : reesc(ch))).join("");

/** 書き込みを拒否する保護の道（正規表現）。X＝W・R・CH のそれぞれの realpath について、設計 §4-1 の規則の順 3 の3つの形 */
export const CASE_PROTECTED_WRITE = (p: Pick<CaseParams, "W" | "R" | "CH">): string[] =>
  [p.W, p.R, p.CH].flatMap((X) => [
    ...PROTECTED_FILES.map((n) => `^${reesc(X)}/(.+/)?${cip(n)}$`),
    ...PROTECTED_DIRS.map((n) => `^${reesc(X)}/(.+/)?${cip(n)}(/.*)?$`),
    ...PROTECTED_BARE.map((n) => `^${reesc(X)}/${cip(n)}(/.*)?$`),
  ]);

/** case-home の中で本体が書く記録（§4-2 (A)）。置き場6つ（subpath）と、ファイル2つ（literal） */
const CH_RECORD_DIRS = ["projects", "sessions", "session-env", "shell-snapshots", "tasks", "teams"];
const CH_RECORD_FILES = [".last-cleanup", ".claude.json"];
/** case-home の中の設定として読み戻される名前（§4-2 (B)）。書き込みの拒否と作成・削除の塞ぎに入れる */
const chSettingNames = (CH: string): string[] => [
  `^${reesc(CH)}/(remote-settings\\.json|remote-settings\\.json\\.synced-at|plugins|backups|settings\\.json|agents|hooks|commands|skills|CLAUDE\\.md)(/.*)?$`,
  `^${reesc(CH)}/policy-limits[^/]*\\.json$`,
];

export interface CaseRoomOptions {
  proxyPort: number;
  consolePort: number;
  /** claude の実体の道（realpath） */
  claudeReal: string;
  /** 見張りの台本（realpath） */
  guardScript: string;
}

const q = (s: string): string => {
  if (/[\n\r\0]/.test(s)) throw new CaseSandboxUnavailableError("sandbox unavailable: a path contains a control character");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};
/** room.sb に書く `(literal "<道>")` の形（起動の確かめ ⑫ が、同じ文字列で書かれているかを見るために使う） */
export const caseRoomLiteral = (p: string): string => `(literal ${q(p)})`;
const rx = (s: string): string => {
  if (s.includes('"')) throw new CaseSandboxUnavailableError("sandbox unavailable: a path contains a double quote");
  return `(regex #"${s}")`;
};
const uniq = (xs: string[]): string[] => [...new Set(xs)];
const isStrictlyUnder = (child: string, parent: string): boolean => child.startsWith(parent.endsWith("/") ? parent : parent + "/");
/** ルートを除く祖先のディレクトリ（srt の getAncestorDirectories と同じ） */
function ancestorsOf(p: string): string[] {
  const out: string[] = [];
  for (let cur = path.dirname(p); cur !== "/" && cur !== "."; ) {
    out.push(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

/**
 * 部屋の設定（Seatbelt の room.sb）を作る。純粋な関数。規則の順は設計 §4-1 の 1〜5。道はすべて realpath にそろえて受け取る。
 * REVIEW INVARIANT（srt macos-sandbox-utils.js:628-632）: 読み取りの開け直しの塊のあとに `(allow file-read*` を置かない。
 */
export function buildCaseRoomProfile(p: CaseParams, opts: CaseRoomOptions): string {
  const full: CaseRoomParams = { ...p, guardScript: opts.guardScript, claudeReal: opts.claudeReal };
  const { W, R, T, CH } = p;
  const L: string[] = [];
  const add = (...lines: string[]): void => void L.push(...lines);
  const block = (head: string, filters: string[]): void => {
    if (filters.length > 0) add(head, ...filters.map((f) => `  ${f}`), ")");
  };
  const protectedWrite = CASE_PROTECTED_WRITE(full);
  const chNames = chSettingNames(CH);

  // 1. 土台
  add("(version 1)", "(deny default)", CASE_ROOM_BASE);
  add("(allow mach-lookup", ...CASE_ROOM_MACH.map((m) => `  (global-name ${q(m)})`), ")");

  // 2. 読み取り
  const denyRead = uniq([...CASE_DENY_READ_SANDBOX(p), ...CASE_DENY_READ(p)]);
  const named = CASE_ROOM_READ_NAMED(full);
  const allowSub = uniq(CASE_ALLOW_READ(p));
  add("; ===== 2. 読み取り（srt macos-sandbox-utils.js:639-690・:1009-1020 の形）=====", "(allow file-read*)");
  block("(deny file-read*", denyRead.map((d) => `(subpath ${q(d)})`));
  block("(allow file-read*", [...allowSub.map((a) => `(subpath ${q(a)})`), ...named.map((n) => (n === CH ? `(subpath ${q(n)})` : `(literal ${q(n)})`)), '(literal "/dev/null")', '(literal (param "TTY"))']);
  // 開け直しの道の中にある拒否だけを再び拒否する（srt の lateReadDenyFilters と同じ形。拒否だけを足す）
  const reopenedRoots = [...allowSub, CH];
  block("(deny file-read*", denyRead.filter((d) => reopenedRoots.some((a) => isStrictlyUnder(d, a))).map((d) => `(subpath ${q(d)})`));
  add("(allow file-read-metadata (vnode-type DIRECTORY))");
  // 移動の塞ぎ: 読み取りを拒否した道そのものと、その祖先のディレクトリ全部（srt の moveBlockingFilters と同じ形）
  block("(deny file-write-unlink file-write-create", uniq(denyRead.flatMap((d) => [`(subpath ${q(d)})`, ...ancestorsOf(d).map((a) => `(literal ${q(a)})`)])));
  const chRecordSub = CH_RECORD_DIRS.map((n) => path.join(CH, n));
  const chRecordLit = CH_RECORD_FILES.map((n) => path.join(CH, n));
  block("(allow file-write-unlink file-write-create", [...[W, R, T, ...chRecordSub].map((x) => `(subpath ${q(x)})`), ...chRecordLit.map((x) => `(literal ${q(x)})`)]);
  // 書ける場所 W・R・T・CH の中にある読み取りの拒否の道は、上の開け直しのあとに、動かせない形へ戻す（srt :1009-1020 の形。開け直しのあとに置く）
  const writeRoots = [W, R, T, CH];
  const under = (x: string): boolean => writeRoots.some((w) => isStrictlyUnder(x, w));
  block("(deny file-write-unlink", uniq(denyRead.filter(under).flatMap((d) => [`(subpath ${q(d)})`, ...ancestorsOf(d).filter(under).map((a) => `(literal ${q(a)})`)])));

  // 3. 書き込み
  add("; ===== 3. 書き込み =====");
  block("(allow file-write*", [...[W, R, T, ...chRecordSub].map((x) => `(subpath ${q(x)})`), ...chRecordLit.map((x) => `(literal ${q(x)})`), '(literal "/dev/null")', '(literal (param "TTY"))']);
  add('(allow file-ioctl (literal (param "TTY")))');
  block("(deny file-write*", [...CASE_DENY_WRITE(p).map((d) => `(subpath ${q(d)})`), ...protectedWrite.map(rx), ...chNames.map(rx)]);

  // 4. 作成・削除・移動の塞ぎ
  add("; ===== 4. 作成・削除・移動の塞ぎ =====");
  const nested = [W, R, CH].flatMap((X) => [`^${reesc(X)}/(.+/)?${cip(".git")}$`, `^${reesc(X)}/(.+/)?${cip(".claude")}$`]);
  block("(deny file-write-unlink file-write-create", [
    ...protectedWrite.map(rx),
    ...chNames.map(rx),
    ...[W, R, CH].flatMap((X) => [`(literal ${q(X)})`, `(literal ${q(path.join(X, ".claude"))})`, `(literal ${q(path.join(X, ".git"))})`]),
    ...nested.map(rx),
  ]);

  // 5. 通信（受付と agent-console の2つの番号だけ。Unix ソケット・待ち受けは許さない）
  add("; ===== 5. 通信 =====", `(allow network-outbound (remote ip "localhost:${opts.proxyPort}") (remote ip "localhost:${opts.consolePort}"))`);
  return L.join("\n") + "\n";
}

export interface CaseRoomIo {
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
}

const ROOM_TMP = /^room\.sb\..+\.tmp$/;
const ROOM_FAILED = "sandbox unavailable: room profile could not be written";

/** 同期で一時の名前（0o600）に書いてから room.sb へ名前を付け替える。失敗したら前の room.sb も消して CaseSandboxUnavailableError。前の room.sb は使わない */
function writeAtomicSync(file: string, text: string, io: CaseRoomIo = {}): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    (io.writeFileSync ?? writeFileSync)(tmp, text, { mode: FILE_MODE });
    (io.renameSync ?? renameSync)(tmp, file);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
}

function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // 消せなくても、呼び出し元は投げ直す
  }
}

/** D/cases/<id>/room.sb を書く（同期）。書く前に room.sb.*.tmp の残りを消す。どこかで失敗したら room.sb を消してから CaseSandboxUnavailableError */
export function writeCaseRoom(p: CaseParams, opts: CaseRoomOptions & { io?: CaseRoomIo }): string {
  const dir = caseDirOf(p.D, caseIdOf(p));
  const file = path.join(dir, "room.sb");
  try {
    for (const name of readdirSync(dir)) if (ROOM_TMP.test(name)) rmSync(path.join(dir, name), { force: true });
    writeAtomicSync(file, buildCaseRoomProfile(p, opts), opts.io);
    return file;
  } catch (err) {
    removeQuietly(file);
    throw err instanceof CaseSandboxUnavailableError ? err : new CaseSandboxUnavailableError(ROOM_FAILED);
  }
}

const KEEP_CLAUDE_JSON_KEYS = ["userID", "machineID", "firstStartTime", "firstStartVersion", "migrationVersion", "opusProMigrationComplete", "sonnet1m45MigrationComplete"];

/**
 * CH/.claude.json を「残すキーの許可の一覧」だけの形に書き直す（同期）。前のファイルが無い・壊れていれば空とみなす。
 * 値は記録・画面に出さない。書けなければ CaseSandboxUnavailableError
 */
export function rewriteCaseClaudeJson(CH: string, W: string): void {
  const file = path.join(CH, ".claude.json");
  let prev: Record<string, unknown> = {};
  try {
    if (lstatSync(file).isFile()) {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) prev = parsed as Record<string, unknown>;
    }
  } catch {
    prev = {};
  }
  const next: Record<string, unknown> = {};
  for (const k of KEEP_CLAUDE_JSON_KEYS) {
    const v = prev[k];
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) next[k] = v;
  }
  next.hasCompletedOnboarding = true;
  next.projects = { [realOr(W)]: { hasTrustDialogAccepted: true } };
  try {
    writeAtomicSync(file, JSON.stringify(next, null, 2) + "\n");
  } catch {
    throw new CaseSandboxUnavailableError("sandbox unavailable: claude.json could not be rewritten");
  }
}

/** claude の実体の道（realpath）。`/` を含めばそれを、含まなければ PATH を左から探して実行できる最初のファイルを使う。無ければ null */
export function resolveClaudeReal(claudeBin: string, envPath: string | undefined): string | null {
  const executable = (f: string): string | null => {
    try {
      if (!statSync(f).isFile()) return null;
      accessSync(f, fsConstants.X_OK);
      return realpathSync(f);
    } catch {
      return null;
    }
  };
  if (claudeBin.includes("/")) return executable(claudeBin);
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const found = executable(path.join(dir, claudeBin));
    if (found !== null) return found;
  }
  return null;
}

/** 権限の絶対の道は先頭を `//` にする（realpath の先頭の `/` を除いてつなぐ） */
const rule = (tool: string, abs: string, suffix = ""): string => `${tool}(//${abs.replace(/^\/+/, "")}${suffix})`;

export function buildCaseSettings(p: CaseParams, consolePort: number): Record<string, unknown> {
  const denyWrite = CASE_DENY_WRITE(p);
  const denyRead = CASE_DENY_READ(p);
  // board-guard は件の設定から外す（部屋の中では D/open-sessions.json を読めず、黙って素通りになるため。設計 §4-1）。記録用 hook は部屋の外の受け口へ送る（§4-6）
  const base = addHandlers({}, p.nodeBin, p.hookPath, { skip: [BOARD_GUARD_HOOK_FILE], activityArgs: ["--post", `http://127.0.0.1:${consolePort}/api/agent/case-activity`] }).settings as { hooks?: { PreToolUse?: unknown[] } & Record<string, unknown> };
  const hooks = JSON.parse(JSON.stringify(base.hooks ?? {})) as Record<string, unknown[]>;
  hooks.PreToolUse = [
    { matcher: "*", hooks: [{ type: "command", command: p.nodeBin, args: [p.guardScript, p.caseFile], onFailure: "block", timeout: 10 }] },
    ...(hooks.PreToolUse ?? []),
  ];
  return {
    disableAutoMode: "disable",
    includeGitInstructions: false,
    permissions: {
      defaultMode: "dontAsk",
      disableBypassPermissionsMode: "disable",
      allow: ["Bash", "Agent", rule("Edit", p.W, "/**"), rule("Edit", p.R, "/**"), rule("Read", p.R, "/**"), rule("Read", p.T, "/**")],
      deny: [
        ...denyWrite.flatMap((d) => [rule("Edit", d, "/**"), rule("Edit", d)]),
        ...denyRead.flatMap((d) => [rule("Read", d, "/**"), rule("Read", d)]),
        ...["security", "gh auth", "gh pr merge", "ac-reserve", "ac-routine"].flatMap((c) => [`Bash(${c} *)`, `Bash(${c})`]),
      ],
    },
    // 囲いは部屋（room.sb。sandbox-exec）が受け持つ。claude 自身の Bash の囲いは切る
    sandbox: { enabled: false },
    hooks,
  };
}

/** 件ごとの設定の置き場 D/cases/<id> */
export const caseDirOf = (D: string, id: string): string => path.join(D, "cases", id);

async function isOwnRealDirectory(p: string): Promise<boolean> {
  const st = await lstat(p).catch(() => null);
  return st !== null && st.isDirectory() && !st.isSymbolicLink() && st.uid === uid();
}

/**
 * 件の設定を書く: D/cases/<id>/settings.json・case.json、GH/config.yml・hosts.yml、R、T。
 * 途中で失敗したら自分が作った物だけを消してから投げる（すでにある T やリンクの先には触らない）。
 */
export async function writeCaseFiles(p: Omit<CaseParams, "caseFile">, sessionId: string, consolePort: number): Promise<{ settingsPath: string; ghDir: string; caseFile: string; tmp: string }> {
  if (!UUID.test(sessionId)) throw new CaseSandboxUnavailableError("sandbox unavailable: case id must be a UUID");
  const dir = caseDirOf(p.D, sessionId);
  const settingsPath = path.join(dir, "settings.json");
  const caseFile = path.join(dir, "case.json");
  const full: CaseParams = { ...p, caseFile };
  const made: string[] = [];
  try {
    const settings = buildCaseSettings(full, consolePort);
    await mkdir(path.join(p.D, "cases"), { recursive: true, mode: DIR_MODE });
    await mkdir(dir, { mode: DIR_MODE });
    made.push(dir);
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: FILE_MODE });
    await writeFile(caseFile, JSON.stringify({ worktree: p.W, report: p.R, tmp: p.T, denyWrite: CASE_DENY_WRITE(full), denyRead: CASE_DENY_READ(full) }, null, 2) + "\n", { mode: FILE_MODE });
    await mkdir(path.join(p.D, "case-gh"), { recursive: true, mode: DIR_MODE });
    await mkdir(p.GH, { mode: DIR_MODE });
    made.push(p.GH);
    await writeFile(path.join(p.GH, "config.yml"), 'version: "1"\n', { mode: FILE_MODE });
    await writeFile(path.join(p.GH, "hosts.yml"), `github.com:\n    user: ${GH_USER}\n    users:\n        ${GH_USER}:\n`, { mode: FILE_MODE });
    // case-home: D/case-home が無ければ 0o700 で作り、すでにあれば自分の持ち物の本物のディレクトリと確かめる。件の分は 0o700 で作る
    const caseHomeRoot = path.dirname(p.CH);
    try {
      await mkdir(caseHomeRoot, { mode: DIR_MODE });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!(await isOwnRealDirectory(caseHomeRoot))) throw new CaseSandboxUnavailableError("sandbox unavailable: case-home parent is not an own real directory");
    }
    await mkdir(p.CH, { mode: DIR_MODE });
    made.push(p.CH);
    await mkdir(p.R, { recursive: true, mode: DIR_MODE });
    made.push(p.R);
    await chmod(p.R, DIR_MODE);
    // T: P と T を recursive 無しで作る。P が既にあるときは本物のディレクトリ・自分の持ち物と確かめる。T が既にあれば失敗（触らない）
    const P = parentOf(p.T);
    try {
      await mkdir(P, { mode: DIR_MODE });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!(await isOwnRealDirectory(P))) throw new CaseSandboxUnavailableError("sandbox unavailable: tmp parent is not an own real directory");
    }
    await mkdir(p.T, { mode: DIR_MODE });
    return { settingsPath, ghDir: p.GH, caseFile, tmp: p.T };
  } catch (err) {
    for (const d of made.reverse()) await rm(d, { recursive: true, force: true }).catch(() => undefined);
    throw err instanceof CaseSandboxUnavailableError ? err : new CaseSandboxUnavailableError(`sandbox unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** D/cases/<id>・D/case-gh/<id>・D/case-home/<id> を消す。opts.tmp === true のときは T も（P の直下で名前が id の先頭8字のときだけ。P は消さない）。id が UUID でなければ何もしない */
export async function removeCaseFiles(D: string, sessionId: string, opts: { tmp?: boolean; tmpRoot?: string } = {}): Promise<void> {
  if (!UUID.test(sessionId)) return;
  await rm(path.join(D, "cases", sessionId), { recursive: true, force: true });
  await rm(path.join(D, "case-gh", sessionId), { recursive: true, force: true });
  await rm(path.join(D, "case-home", sessionId), { recursive: true, force: true });
  if (opts.tmp !== true) return;
  const P = path.join(realOr(opts.tmpRoot ?? "/tmp"), "acc");
  if (!(await isOwnRealDirectory(P))) return;
  const T = path.join(P, sessionId.slice(0, 8));
  if (path.dirname(T) === P) await rm(T, { recursive: true, force: true });
}

