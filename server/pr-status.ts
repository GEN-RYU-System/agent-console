import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GH_TIMEOUT_MS = 15000;
const GH_MAX_BUFFER = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10000;
const STDERR_KEEP_CHARS = 300;
const LIST_LIMIT = "5";
const AUTH_EXIT_CODE = 4;

/** アプリが gh に許すコマンド。GitHub に書き込むものは含めない（K7）。gh を呼ぶのはこのファイルの runGh だけ。 */
const ALLOWED_PR_SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "view", "checks"]);
/** 問い合わせで止まらないように、更新の通知が stderr に混じらないように（gh help environment） */
const GH_ENV: Readonly<Record<string, string>> = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };

export type GhFailureKind = "ghMissing" | "timeout" | "authRequired" | "rateLimited" | "ghFailed";

/** gh が失敗したときの分類。stderr は先頭だけ持ち、サーバーの記録にだけ使う（画面には出さない）。 */
export class GhFailure extends Error {
  constructor(
    readonly kind: GhFailureKind,
    readonly stderr: string,
  ) {
    super(`gh failed (${kind})`);
  }
}

type FailureShape = { code?: unknown; killed?: unknown; stderr?: unknown };

export function classifyGhFailure(err: unknown): GhFailure {
  const e = (typeof err === "object" && err !== null ? err : {}) as FailureShape;
  const stderr = (typeof e.stderr === "string" ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : "").slice(0, STDERR_KEEP_CHARS);
  if (e.code === "ENOENT") return new GhFailure("ghMissing", stderr);
  if (e.killed === true) return new GhFailure("timeout", stderr);
  if (e.code === AUTH_EXIT_CODE || stderr.includes("gh auth login")) return new GhFailure("authRequired", stderr);
  if (/rate limit|RATE_LIMITED/i.test(stderr)) return new GhFailure("rateLimited", stderr);
  return new GhFailure("ghFailed", stderr);
}

export interface RunGhOptions {
  cwd: string;
  timeoutMs?: number;
}

/** gh を 1 回実行する（シェルは通さない）。`gh pr list|view|checks` 以外は、起動する前に例外にする。 */
export async function runGh(bin: string, args: readonly string[], options: RunGhOptions): Promise<string> {
  if (args[0] !== "pr" || args[1] === undefined || !ALLOWED_PR_SUBCOMMANDS.has(args[1])) {
    throw new Error(`gh command not allowed: ${args.slice(0, 2).join(" ")}`);
  }
  try {
    const { stdout } = await execFileAsync(bin, [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      env: { ...process.env, ...GH_ENV },
    });
    return stdout;
  } catch (err) {
    throw classifyGhFailure(err);
  }
}

// ---- 作業場所 -> (repo, branch) --------------------------------------------------------------

const REPO_PATTERNS: readonly RegExp[] = [
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
];
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
const GITHUB_URL_PREFIX = "https://github.com/";

/** origin の URL から `owner/name` を取る。GitHub の https / ssh の 2 形だけ受け付け、それ以外は null。 */
export function parseGitHubRepo(url: string): string | null {
  for (const pattern of REPO_PATTERNS) {
    const m = pattern.exec(url);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

/** gh へ渡してよいブランチ名（`-` で始まるものはオプションと読まれるので許さない）。 */
export function isSafeBranch(branch: string): boolean {
  return SAFE_BRANCH.test(branch) && !branch.startsWith("-");
}

/** リンクにしてよい url は https://github.com/ で始まるものだけ。それ以外は空文字（K8）。 */
export function safeGithubUrl(value: unknown): string {
  return typeof value === "string" && value.startsWith(GITHUB_URL_PREFIX) ? value : "";
}

// ---- 画面へ返す形 ----------------------------------------------------------------------------

export type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";
export interface CheckCounts {
  pass: number;
  fail: number;
  pending: number;
  skipping: number;
  cancel: number;
}
export interface CheckItem {
  name: string;
  bucket: "fail" | "cancel" | "pending";
  link: string;
  workflow: string;
}
export interface ChecksSummary {
  counts: CheckCounts;
  items: CheckItem[];
}
export type PrState = "OPEN" | "MERGED" | "CLOSED";
export interface PrInfo {
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  url: string;
  mergeStateStatus: string;
}
export type PrFailureStatus = "ghMissing" | "authRequired" | "timeout" | "rateLimited" | "ghFailed";
export type PrMessageStatus = "loading" | "noPr" | "notGitHub" | "detached" | PrFailureStatus;
export type PrResponse = { status: "ok"; pr: PrInfo; checks: ChecksSummary; fetchedAt: number } | { status: PrMessageStatus; fetchedAt?: number };
export type CiState = "fail" | "pending" | "pass";

const BUCKETS: readonly string[] = ["pass", "fail", "pending", "skipping", "cancel"];
const LISTED_RANK: Readonly<Record<CheckItem["bucket"], number>> = { fail: 0, cancel: 1, pending: 2 };
const emptyCounts = (): CheckCounts => ({ pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * `gh pr checks --json` の行を集計する。形の合わない行は数えない。知らない bucket は、終わっていないものとして pending に数える
 * （成功と見せかけず、自動の取り直しも止めないため）。一覧に出すのは fail・cancel・pending だけ。
 */
export function summarizeChecks(rows: readonly unknown[]): ChecksSummary {
  const counts = emptyCounts();
  const items: CheckItem[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.bucket !== "string" || typeof row.name !== "string") continue;
    const bucket = (BUCKETS.includes(row.bucket) ? row.bucket : "pending") as CheckBucket;
    counts[bucket] += 1;
    if (bucket === "fail" || bucket === "cancel" || bucket === "pending") {
      items.push({ name: row.name, bucket, link: safeGithubUrl(row.link), workflow: str(row.workflow) });
    }
  }
  items.sort((a, b) => LISTED_RANK[a.bucket] - LISTED_RANK[b.bucket]);
  return { counts, items };
}

/** セッション一覧の印。失敗か取り消しが 1 件でもあれば fail、実行中があれば pending、1 件以上あってすべて成功かスキップなら pass、0 件なら null。 */
export function ciOf(counts: CheckCounts): CiState | null {
  if (counts.fail > 0 || counts.cancel > 0) return "fail";
  if (counts.pending > 0) return "pending";
  return counts.pass + counts.skipping > 0 ? "pass" : null;
}

/** セッション一覧の印。開いている PR（state が OPEN）のときだけ値を返す。閉じた・マージ済みの PR の古い失敗は出さない。 */
export function ciOfResponse(response: PrResponse | undefined): CiState | undefined {
  if (response?.status !== "ok" || response.pr.state !== "OPEN") return undefined;
  return ciOf(response.checks.counts) ?? undefined;
}

/** マージ済みかクローズで、実行中の検査が無い PR。定期の取り直しの対象から外す（K5）。 */
export function isSettled(response: PrResponse): boolean {
  return response.status === "ok" && response.pr.state !== "OPEN" && response.checks.counts.pending === 0;
}

// ---- 取得 ------------------------------------------------------------------------------------

export interface PrTarget {
  repo: string;
  branch: string;
}
export type TargetResult = { kind: "target"; target: PrTarget } | { kind: "immediate"; response: PrResponse };

async function gitOut(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

/**
 * 照合済みの作業場所から (repo, branch) を決める。ブランチの正本は git の HEAD、repo の正本は origin。
 * GitHub でない・ブランチにいない場合は、gh を呼ばずにそのまま答えを返す。
 */
export async function resolveTarget(dir: string): Promise<TargetResult> {
  const remote = await gitOut(dir, ["remote", "get-url", "origin"]).catch(() => "");
  const repo = parseGitHubRepo(remote);
  if (repo === null) return { kind: "immediate", response: { status: "notGitHub" } };
  let branch: string;
  try {
    branch = await gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch (err) {
    console.error("pr: git rev-parse failed:", err instanceof Error ? err.message : err);
    return { kind: "immediate", response: { status: "ghFailed" } };
  }
  if (branch === "HEAD") return { kind: "immediate", response: { status: "detached" } };
  if (!isSafeBranch(branch)) return { kind: "immediate", response: { status: "noPr" } };
  return { kind: "target", target: { repo, branch } };
}

export interface FetchOptions {
  ghBin: string;
  /** 照合済みの作業場所（gh の cwd） */
  cwd: string;
  timeoutMs?: number;
}

interface PrRow {
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  url: string;
  updatedAt: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GhFailure("ghFailed", `invalid JSON from gh: ${text.slice(0, 80)}`);
  }
}

function toPrRow(v: unknown): PrRow | null {
  if (!isRecord(v) || !Number.isInteger(v.number) || (v.number as number) <= 0) return null;
  if (v.state !== "OPEN" && v.state !== "MERGED" && v.state !== "CLOSED") return null;
  return { number: v.number as number, title: str(v.title), state: v.state, isDraft: v.isDraft === true, url: str(v.url), updatedAt: str(v.updatedAt) };
}

/** open があれば、その中で updatedAt が最新のもの。無ければ全体で最新。gh の並び順には頼らない。 */
function choosePr(rows: readonly PrRow[]): PrRow | null {
  const newest = (list: readonly PrRow[]): PrRow | null => list.reduce<PrRow | null>((best, r) => (best === null || r.updatedAt > best.updatedAt ? r : best), null);
  return newest(rows.filter((r) => r.state === "OPEN")) ?? newest(rows);
}

async function fetchChecks(target: PrTarget, number: number, options: FetchOptions): Promise<ChecksSummary> {
  try {
    const out = await runGh(options.ghBin, ["pr", "checks", String(number), "-R", target.repo, "--json", "name,state,bucket,link,workflow,completedAt"], options);
    const rows = parseJson(out);
    return summarizeChecks(Array.isArray(rows) ? rows : []);
  } catch (err) {
    // 検査が 1 件も無い PR は exit 1 で "no checks reported on the '<branch>' branch" を返す（ブランチ名が入るので前方一致）
    if (err instanceof GhFailure && err.kind === "ghFailed" && err.stderr.startsWith("no checks reported")) return summarizeChecks([]);
    throw err;
  }
}

async function fetchMergeState(target: PrTarget, number: number, options: FetchOptions): Promise<string> {
  const out = await runGh(options.ghBin, ["pr", "view", String(number), "-R", target.repo, "--json", "number,title,state,isDraft,url,mergeStateStatus,headRefName"], options);
  const view = parseJson(out);
  return isRecord(view) && typeof view.mergeStateStatus === "string" && view.mergeStateStatus !== "" ? view.mergeStateStatus : "UNKNOWN";
}

/** (repo, branch) の PR と検査を GitHub から読む（読むだけ）。失敗は status に直して返し、例外にしない。 */
export async function fetchPr(target: PrTarget, options: FetchOptions): Promise<PrResponse> {
  try {
    const listOut = await runGh(
      options.ghBin,
      ["pr", "list", "-R", target.repo, "--head", target.branch, "--state", "all", "--limit", LIST_LIMIT, "--json", "number,title,state,isDraft,url,updatedAt"],
      options,
    );
    const listed = parseJson(listOut);
    const row = choosePr(Array.isArray(listed) ? listed.map(toPrRow).filter((r): r is PrRow => r !== null) : []);
    if (row === null) return { status: "noPr", fetchedAt: Date.now() };
    // list の mergeStateStatus は UNKNOWN になりがちなので、open のときだけ view で引く（マージ済み・クローズには意味のある値が無い）
    const mergeStateStatus = row.state === "OPEN" ? await fetchMergeState(target, row.number, options) : "UNKNOWN";
    const checks = await fetchChecks(target, row.number, options);
    const pr: PrInfo = { number: row.number, title: row.title, state: row.state, isDraft: row.isDraft, url: safeGithubUrl(row.url), mergeStateStatus };
    return { status: "ok", pr, checks, fetchedAt: Date.now() };
  } catch (err) {
    const failure = err instanceof GhFailure ? err : new GhFailure("ghFailed", err instanceof Error ? err.message : String(err));
    if (failure.kind === "ghFailed") console.error(`pr: gh failed for ${target.repo}#${target.branch}:`, failure.stderr);
    return { status: failure.kind, fetchedAt: Date.now() };
  }
}
