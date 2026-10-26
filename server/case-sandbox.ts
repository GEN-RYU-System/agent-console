// 件のセッション（役割 discord-case）の囲いの設定と見張りの設定を、件ごとに作る。設計 §4-5「Claude の道具の囲い」「外への通信を塞ぐ」。
// 純粋な関数（道の一覧・buildCaseSettings）と、ファイルを書く関数（writeCaseFiles・removeCaseFiles）に分ける。
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addHandlers } from "./activity-hooks.ts";
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
export function casePaths(p: { id: string; H: string; D: string; tmpRoot?: string }): { H: string; D: string; W: string; R: string; P: string; T: string; GH: string } {
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
  `/private/tmp/claude-${uid()}`,
  p.M,
];

export const CASE_DENY_READ = (p: CaseParams): string[] => [
  path.join(p.D, "reserve-token"),
  path.join(p.H, ".claude-access.env"),
  path.join(p.H, ".claude", "channels"),
  path.join(p.H, ".claude", "projects"),
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

/** 権限の絶対の道は先頭を `//` にする（realpath の先頭の `/` を除いてつなぐ） */
const rule = (tool: string, abs: string, suffix = ""): string => `${tool}(//${abs.replace(/^\/+/, "")}${suffix})`;

export function buildCaseSettings(p: CaseParams): Record<string, unknown> {
  const denyWrite = CASE_DENY_WRITE(p);
  const denyRead = CASE_DENY_READ(p);
  const base = addHandlers({}, p.nodeBin, p.hookPath).settings as { hooks?: { PreToolUse?: unknown[] } & Record<string, unknown> };
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
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      enableWeakerNetworkIsolation: true,
      network: {
        allowedDomains: [...CASE_ALLOWED_DOMAINS],
        strictAllowlist: true,
        allowLocalBinding: true,
        allowMachLookup: ["com.apple.SecurityServer", "com.apple.securityd*"],
      },
      filesystem: {
        allowWrite: CASE_ALLOW_WRITE(p),
        denyWrite,
        denyRead: CASE_DENY_READ_SANDBOX(p),
        allowRead: CASE_ALLOW_READ(p),
      },
    },
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
export async function writeCaseFiles(p: Omit<CaseParams, "caseFile">, sessionId: string): Promise<{ settingsPath: string; ghDir: string; caseFile: string; tmp: string }> {
  if (!UUID.test(sessionId)) throw new CaseSandboxUnavailableError("sandbox unavailable: case id must be a UUID");
  const dir = caseDirOf(p.D, sessionId);
  const settingsPath = path.join(dir, "settings.json");
  const caseFile = path.join(dir, "case.json");
  const full: CaseParams = { ...p, caseFile };
  const made: string[] = [];
  try {
    const settings = buildCaseSettings(full);
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

/** D/cases/<id> と D/case-gh/<id> を消す。opts.tmp === true のときは T も（P の直下で名前が id の先頭8字のときだけ。P は消さない）。id が UUID でなければ何もしない */
export async function removeCaseFiles(D: string, sessionId: string, opts: { tmp?: boolean; tmpRoot?: string } = {}): Promise<void> {
  if (!UUID.test(sessionId)) return;
  await rm(path.join(D, "cases", sessionId), { recursive: true, force: true });
  await rm(path.join(D, "case-gh", sessionId), { recursive: true, force: true });
  if (opts.tmp !== true) return;
  const P = path.join(realOr(opts.tmpRoot ?? "/tmp"), "acc");
  if (!(await isOwnRealDirectory(P))) return;
  const T = path.join(P, sessionId.slice(0, 8));
  if (path.dirname(T) === P) await rm(T, { recursive: true, force: true });
}

