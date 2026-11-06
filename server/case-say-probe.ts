// 件の claude の版を人の手なしで確かめる「probe の件」（設計 Sales Anchor docs/handoff/conversation-consent/design.md §14-14-3 D3'・D4・§14-14-4）。
// サーバーが自分で probe の件を開き、定数の文 3 つを送って、E1〜E4・P0〜P5 を機械条件で判定し、結果を dataDir の記録と監査に残す。
// 外の物（件を開く・端末へ送る・画面の写し・時計）はすべて ProbePorts 越しに触るので、試験では偽物に差し替えられる。
import path from "node:path";
import type { CaseStateFile } from "./case-agents.ts";
import { CaseSayVersionStore, type Fingerprint, type VersionEntry, type VersionNoticeReason } from "./case-say-versions.ts";
import type { RoutineAuditEntry } from "./routine-audit.ts";

export const PROBE_TOTAL_MS = 10 * 60 * 1000;
export const PROBE_P0_MS = 60 * 1000;
export const PROBE_P1_MS = 120 * 1000;
export const PROBE_P2_MS = 180 * 1000;
export const PROBE_P3_MS = 120 * 1000;
export const PROBE_POST_IDLE_WAIT_MS = 3000;
export const PROBE_VERSION_TIMEOUT_MS = 15 * 1000;
export const PROBE_RETRY_AFTER_FAIL_MS = 24 * 60 * 60 * 1000;
export const PROBE_MAX_FAILS = 3;
export const PROBE_PANE_MAX_BYTES = 4096;
export const PROBE_PANE_MAX_SAMPLES = 4;
/** probe を開いた後も件の枠が 1 つ以上空くときだけ始める */
export const PROBE_FREE_SLOTS = 2;
const VERSION_NAME = /^\d+\.\d+\.\d+$/;

/** 台本の文 3 つ。コードの定数（Opus・PO・外からの入力は入らない）。<R> はその probe の件の R */
export const probeSentences = (R: string): [string, string, string] => [
  `${R}/probe-1.txt に ok とだけ書いてください。`,
  `Agent で下請けを1つ動かし、下請けに ${R}/probe-2.txt へ ok とだけ書かせてください。`,
  `/plan ${R}/probe-3.txt に ok とだけ書いてください。`,
];

/** probe の件の道具の記録（pre・post）。tool_input・tool_response は持たない */
export interface ProbeToolRecord {
  ts: number;
  phase: "pre" | "post";
  agent_id: string;
  tool: string;
  tool_use_id: string;
  permission_mode: string;
  /** Write のときだけ tool_input.file_path（文字列のとき）。ほかの道具・無いときは "" */
  path: string;
}

/** 受け口が受けた JSON から、持ってよい欄だけを取り出す。pre / post の判別ができなければ null */
export function toolRecordOf(body: unknown, ts: number): ProbeToolRecord | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const ev = o.hook_event_name;
  const phase = ev === "PreToolUse" ? "pre" : ev === "PostToolUse" ? "post" : null;
  if (phase === null) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v.slice(0, 200) : "");
  const tool = str(o.tool_name);
  const input = typeof o.tool_input === "object" && o.tool_input !== null && !Array.isArray(o.tool_input) ? (o.tool_input as Record<string, unknown>) : undefined;
  const filePath = tool === "Write" && typeof input?.file_path === "string" ? input.file_path.slice(0, 1024) : "";
  return { ts, phase, agent_id: str(o.agent_id), tool, tool_use_id: str(o.tool_use_id), permission_mode: str(o.permission_mode), path: filePath };
}

/** 画面の写し: 制御文字（改行以外）を除き、末尾 4KiB に切る */
export function sanitizePane(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
  const buf = Buffer.from(clean, "utf8");
  if (buf.length <= PROBE_PANE_MAX_BYTES) return clean;
  return buf.subarray(buf.length - PROBE_PANE_MAX_BYTES).toString("utf8").replace(/^�+/, "");
}

/** P4: 選ぶ画面の形の数。行頭の番号付き選択肢が 2 行以上連続・(y/n)・Do you want to・Esc to cancel・Yes と No が同じ行 */
export function countPickScreens(sample: string): number {
  let n = 0;
  const lines = sample.split("\n");
  let run = 0;
  for (const line of lines) {
    if (/^\s*[❯>]?\s*\d+\.\s/.test(line)) {
      run += 1;
      if (run === 2) n += 1;
    } else run = 0;
    if (/\bYes\b/.test(line) && /\bNo\b/.test(line)) n += 1;
  }
  n += (sample.match(/\(y\/n\)/g) ?? []).length;
  n += (sample.match(/Do you want to/g) ?? []).length;
  n += (sample.match(/Esc to cancel/g) ?? []).length;
  return n;
}

export interface ToolCounts {
  /** P2 の間（文2 の送信から文3 の送信まで）の post の行 */
  p2Posts: number;
  /** 文3 の後の主の会話の pre の plan の行 */
  planPres: number;
  /** その中で tool_use_id が空の行 */
  planPresNoId: number;
  /** plan の行と同じ tool_use_id の post の行（道具が通った） */
  planPosts: number;
  /** 文3 の後の主の会話の post の行（tool_use_id を問わない） */
  mainPostsAfter3: number;
  /** pre に Bash の行 */
  bashPres: number;
  /** P1・P2 の pre の行のうち対の post が無い行 */
  unpairedPres: number;
}

/** probe の道具の記録の数え方（P3・P5。審査2〜4回目）。sent2At・sent3At は文2・文3 を送った時刻 */
export function countTools(records: readonly ProbeToolRecord[], sent2At: number, sent3At: number): ToolCounts {
  const before3 = records.filter((r) => r.ts < sent3At);
  const after3 = records.filter((r) => r.ts >= sent3At);
  const postIds = new Set(records.filter((r) => r.phase === "post" && r.tool_use_id !== "").map((r) => r.tool_use_id));
  const planPres = after3.filter((r) => r.phase === "pre" && r.agent_id === "" && r.permission_mode === "plan");
  const planIds = new Set(planPres.map((r) => r.tool_use_id).filter((id) => id !== ""));
  return {
    p2Posts: records.filter((r) => r.phase === "post" && r.ts >= sent2At && r.ts < sent3At).length,
    planPres: planPres.length,
    planPresNoId: planPres.filter((r) => r.tool_use_id === "").length,
    planPosts: records.filter((r) => r.phase === "post" && planIds.has(r.tool_use_id)).length,
    mainPostsAfter3: after3.filter((r) => r.phase === "post" && r.agent_id === "").length,
    bashPres: records.filter((r) => r.phase === "pre" && r.tool === "Bash").length,
    unpairedPres: before3.filter((r) => r.phase === "pre" && (r.tool_use_id === "" || !postIds.has(r.tool_use_id))).length,
  };
}

/** probe の件 1 つの外から見える形 */
export interface ProbeCase {
  id: string;
  /** 手順書の置き場 R */
  R: string;
}

export interface ProbeState {
  state: CaseStateFile | undefined;
  /** 区画の pid（tmux の pane_pid） */
  panePid: number | undefined;
}

export interface AgentEvidence {
  /** probe-2.txt を担当（agent_id 付き）が書いた記録がある */
  agentWrite: boolean;
  subagentStarts: number;
  subagentStops: number;
}

/** 外の物への入り口。試験は偽物を渡す */
export interface ProbePorts {
  now(): number;
  isoNow(): string;
  sleep(ms: number): Promise<void>;
  /** PATH の claude の実体の道（realpath）。無ければ null */
  resolveReal(): string | null;
  fingerprint(real: string): Promise<Fingerprint | null>;
  stat(real: string): { isFile: boolean; executable: boolean; nlink: number } | null;
  /** `<real> --version` の出力（15 秒で打ち切り。失敗は投げる） */
  versionOutput(real: string): Promise<string>;
  /** 件の枠が n 以上空いているか */
  hasFreeSlots(n: number): boolean;
  /** probe の件を開く（役割 discord-case・名前は probe claude <版>・versionProbe 印付き） */
  openCase(name: string): Promise<ProbeCase>;
  closeCase(caseId: string): Promise<void>;
  /** 閉じた後の片付け: removeCaseFiles・R・W */
  cleanup(c: ProbeCase): Promise<void>;
  readState(c: ProbeCase): Promise<ProbeState>;
  /** 定数の文を 1 回送る（貼る → 待つ → idle を確かめ直す → Enter）。送れたら true */
  send(c: ProbeCase, text: string): Promise<boolean>;
  capturePane(c: ProbeCase): Promise<string>;
  /** R の下のファイルの中身。無ければ undefined */
  readFile(c: ProbeCase, name: string): Promise<string | undefined>;
  /** records は probe の道具の記録。P2 の間（sent2At 以降）の Write の post で path が probeFile に完全一致し agent_id が空でない記録から、その agent_id の開始・終了の数を読む */
  agentEvidence(c: ProbeCase, probeFile: string, records: readonly ProbeToolRecord[], sent2At: number): Promise<AgentEvidence>;
  audit(entry: RoutineAuditEntry): Promise<void>;
  notice(n: { reason: VersionNoticeReason; claudeVersion: string; sha256: string; detail?: string }): void;
}

export interface ProbeOptions {
  /** 状態ファイルを見る間隔（既定 1 秒） */
  pollMs?: number;
  /** idle の後に待つ時間（既定 3 秒。hook の送信の打ち切り 2 秒より長い） */
  postIdleWaitMs?: number;
  totalMs?: number;
}

export type ProbeOutcome = "ok" | "denied" | "aborted" | "audit_failed" | "waiting";

export interface ProbeResult {
  outcome: ProbeOutcome;
  failedCheck?: string;
}

interface Target {
  real: string;
  fp: Fingerprint | null;
}

class ProbeAborted extends Error {}
class ProbeFailed extends Error {
  constructor(readonly check: string) {
    super(check);
  }
}

export class CaseVersionProbe {
  private runningCase: string | undefined;
  private runningSha: string | undefined;
  private active: Promise<ProbeResult> | undefined;
  private abortFlag = false;
  private records: ProbeToolRecord[] = [];
  private pendingTrigger: "t1" | "t2" | undefined;
  private pendingTarget: Target | undefined;
  private readonly pollMs: number;
  private readonly postIdleWaitMs: number;
  private readonly totalMs: number;

  constructor(
    private readonly store: CaseSayVersionStore,
    private readonly ports: ProbePorts,
    options: ProbeOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 1000;
    this.postIdleWaitMs = options.postIdleWaitMs ?? PROBE_POST_IDLE_WAIT_MS;
    this.totalMs = options.totalMs ?? PROBE_TOTAL_MS;
  }

  /** 今動いている probe の件の id（新しい受け口が送り元を確かめるのに使う） */
  runningCaseId(): string | undefined {
    return this.runningCase;
  }

  /** この指紋の probe が動いている（判定 4b の claude_version_probing） */
  isProbing(sha256: string): boolean {
    return this.runningSha === sha256;
  }

  probingVersions(): string[] {
    return this.runningSha === undefined ? [] : [this.versionNameOf(this.runningSha)].filter((v) => v !== "");
  }

  private runningVersion = "";
  private versionNameOf(sha: string): string {
    return this.runningSha === sha ? this.runningVersion : "";
  }

  /** 受け口から: probe の件の道具の記録を足す（実行中だけ。件の確かめは受け口の側） */
  recordTool(body: unknown): boolean {
    if (this.runningCase === undefined) return false;
    const rec = toolRecordOf(body, this.ports.now());
    if (rec === null) return false;
    this.records.push(rec);
    return true;
  }

  /** 発火の予約（t1 件を開いた / t2 サーバー起動）。target が無ければ PATH の claude を解く。同時に動く probe は 1 つ */
  request(trigger: "t1" | "t2", target?: { real: string; fp: Fingerprint | undefined }): Promise<ProbeResult | undefined> {
    if (this.pendingTrigger === undefined || trigger === "t1") this.pendingTrigger = trigger;
    if (target !== undefined) this.pendingTarget = { real: target.real, fp: target.fp ?? null };
    return this.kick();
  }

  /** 空きができたとき・予約があるときに呼ぶ。予約が無い・動いている最中なら何もしない */
  async kick(): Promise<ProbeResult | undefined> {
    if (this.active !== undefined || this.pendingTrigger === undefined) return undefined;
    const trigger = this.pendingTrigger;
    let target = this.pendingTarget;
    if (target === undefined) {
      const real = this.ports.resolveReal();
      if (real === null) {
        this.pendingTrigger = undefined;
        return undefined;
      }
      target = { real, fp: await this.ports.fingerprint(real) };
    }
    if (this.active !== undefined) return undefined;
    if (target.fp === null) {
      // 指紋が取れない: 記録の項目は作れない。知らせるだけ（E4 ×）
      this.pendingTrigger = undefined;
      this.pendingTarget = undefined;
      this.ports.notice({ reason: "n4", claudeVersion: path.basename(target.real), sha256: "", detail: "E4" });
      return undefined;
    }
    const fp = target.fp;
    if (this.store.isUsable(fp) || this.skipForFailures(fp.sha256)) {
      this.pendingTrigger = undefined;
      this.pendingTarget = undefined;
      return undefined;
    }
    if (this.store.isLocked()) {
      // 記録に書けない状態（読めない・MAC の合わない項目あり）では probe しない。D1 n5 は起動時に出している
      this.pendingTrigger = undefined;
      this.pendingTarget = undefined;
      return undefined;
    }
    if (!this.ports.hasFreeSlots(PROBE_FREE_SLOTS)) return undefined;
    this.pendingTrigger = undefined;
    this.pendingTarget = undefined;
    this.runningSha = fp.sha256;
    this.runningVersion = path.basename(target.real);
    this.active = this.run({ real: target.real, fp }, trigger).finally(() => {
      this.active = undefined;
      this.runningSha = undefined;
      this.runningVersion = "";
    });
    return this.active;
  }

  /** ×の後 24 時間は再 probe せず、連続 3 回×で止める。aborted・audit_failed・revoked は数えない */
  private skipForFailures(sha256: string): boolean {
    const e = this.store.entryOf(sha256);
    if (e === undefined || e.usable) return false;
    if (!/^(E[1-4]|P[0-5]|R1)$/.test(e.lastResult)) return false;
    if (e.failCount >= PROBE_MAX_FAILS) return true;
    const at = Date.parse(e.lastProbeAt);
    return Number.isFinite(at) && this.ports.now() - at < PROBE_RETRY_AFTER_FAIL_MS;
  }

  /** 動いている probe を中断して閉じるまで待つ（PO が件を開くのに枠が足りないとき） */
  async abort(): Promise<void> {
    const running = this.active;
    if (running === undefined) return;
    this.abortFlag = true;
    await running.catch(() => undefined);
  }

  /** 動いている probe が終わるまで待つ（試験・停止用） */
  async idle(): Promise<void> {
    while (this.active !== undefined) await this.active.catch(() => undefined);
  }

  private async tick(deadline: number): Promise<void> {
    if (this.abortFlag) throw new ProbeAborted("abort");
    if (this.ports.now() > deadline) throw new ProbeFailed("P5");
    await this.ports.sleep(this.pollMs);
    if (this.abortFlag) throw new ProbeAborted("abort");
  }

  async run(target: { real: string; fp: Fingerprint }, trigger: "t1" | "t2"): Promise<ProbeResult> {
    const { ports } = this;
    const startedAt = ports.isoNow();
    const startMs = ports.now();
    const deadline = startMs + this.totalMs;
    const version = path.basename(target.real);
    const checks: Record<string, boolean> = {};
    const panes: string[] = [];
    const observed = new Set<string>();
    let probeCase: ProbeCase | undefined;
    let counts: Record<string, number> = {};
    let failed: string | undefined;
    let aborted = false;
    this.abortFlag = false;
    this.records = [];
    try {
      // E1〜E4
      checks.E1 = VERSION_NAME.test(version);
      if (!checks.E1) throw new ProbeFailed("E1");
      const st = ports.stat(target.real);
      checks.E2 = st !== null && st.isFile && st.executable && st.nlink === 1;
      if (!checks.E2) throw new ProbeFailed("E2");
      try {
        const out = (await ports.versionOutput(target.real)).trim();
        checks.E3 = out.startsWith(version);
      } catch {
        checks.E3 = false;
      }
      if (!checks.E3) throw new ProbeFailed("E3");
      checks.E4 = true;
      if (this.abortFlag) throw new ProbeAborted("abort");

      // 件を開く（P0）。記録に runningVersionProbe を書く
      probeCase = await ports.openCase(`probe claude ${version}`);
      this.runningCase = probeCase.id;
      try {
        const recorded = await this.store.setRunning({ caseId: probeCase.id, startedAt: startMs, sha256: target.fp.sha256, claudeVersion: version });
        // 本物の store は投げずに false を返す（書けない状態・書き込み失敗）。false も打ち切り
        if (recorded === false) throw new ProbeAborted("setRunning");
      } catch (e) {
        if (e instanceof ProbeAborted) throw e;
        // 記録に書けなければ打ち切る（既存の打ち切りと同じ片付けの道へ。outcome は aborted）
        throw new ProbeAborted("setRunning");
      }
      const c = probeCase;
      const idleWait = async (timeoutMs: number, extra?: () => Promise<boolean>): Promise<boolean> => {
        const end = Math.min(ports.now() + timeoutMs, deadline);
        for (;;) {
          const s = await ports.readState(c);
          const status = s.state?.status;
          if (status !== undefined) observed.add(status);
          if (status === "idle" && (extra === undefined || (await extra()))) return true;
          if (ports.now() >= end) return false;
          await this.tick(deadline);
        }
      };
      const sample = async (): Promise<void> => {
        if (panes.length >= PROBE_PANE_MAX_SAMPLES) return;
        panes.push(sanitizePane(await ports.capturePane(c)));
      };

      // P0
      const p0End = ports.now() + PROBE_P0_MS;
      let p0 = false;
      for (;;) {
        const s = await ports.readState(c);
        const st0 = s.state;
        if (st0 !== undefined) {
          const status = st0.status;
          if (status !== undefined) observed.add(status);
          const okVersion = st0.version === undefined || st0.version.includes(version);
          if (st0.pid !== undefined && st0.pid === st0.filePid && st0.pid === s.panePid && status === "idle" && st0.waitKeys.length === 0 && okVersion) {
            p0 = true;
            break;
          }
        }
        if (ports.now() >= p0End) break;
        await this.tick(deadline);
      }
      checks.P0 = p0;
      if (!p0) throw new ProbeFailed("P0");
      await sample();

      const [s1, s2, s3] = probeSentences(c.R);
      // P1
      if (!(await ports.send(c, s1))) throw new ProbeFailed("P1");
      let p1 = false;
      {
        const end = ports.now() + PROBE_P1_MS;
        for (;;) {
          const body = await ports.readFile(c, "probe-1.txt");
          if (body !== undefined && body.trim() === "ok" && (await idleWait(Math.max(0, end - ports.now())))) {
            p1 = true;
            break;
          }
          if (ports.now() >= end) break;
          await this.tick(deadline);
        }
      }
      checks.P1 = p1;
      if (!p1) throw new ProbeFailed("P1");
      await sample();

      // P2
      const sent2At = ports.now();
      if (!(await ports.send(c, s2))) throw new ProbeFailed("P2");
      let p2 = false;
      {
        const end = ports.now() + PROBE_P2_MS;
        for (;;) {
          const body = await ports.readFile(c, "probe-2.txt");
          if (body !== undefined && body.trim() === "ok" && (await idleWait(Math.max(0, end - ports.now())))) {
            p2 = true;
            break;
          }
          if (ports.now() >= end) break;
          await this.tick(deadline);
        }
      }
      const ev = await ports.agentEvidence(c, path.join(c.R, "probe-2.txt"), this.records, sent2At);
      p2 = p2 && ev.agentWrite && ev.subagentStarts >= 1 && ev.subagentStops >= 1;
      checks.P2 = p2;
      counts = { p2AgentWrite: ev.agentWrite ? 1 : 0, p2SubagentStarts: ev.subagentStarts, p2SubagentStops: ev.subagentStops };
      if (!p2) throw new ProbeFailed("P2");
      await sample();

      // P3（文3 の後、計画の形では道具が止まる）
      const sent3At = ports.now();
      if (!(await ports.send(c, s3))) throw new ProbeFailed("P3");
      {
        const end = ports.now() + PROBE_P3_MS;
        const back = await idleWait(Math.max(0, end - ports.now()), async () =>
          this.records.some((r) => r.ts >= sent3At && r.phase === "pre" && r.agent_id === "" && r.permission_mode === "plan"),
        );
        if (!back) throw new ProbeFailed("P3");
      }
      // idle に戻った後、hook の送信の打ち切り（2 秒）より長く待ってから判定する
      await ports.sleep(this.postIdleWaitMs);
      if (this.abortFlag) throw new ProbeAborted("abort");
      await sample();
      const tools = countTools(this.records, sent2At, sent3At);
      counts = { ...counts, ...tools };
      const file3 = await ports.readFile(c, "probe-3.txt");
      const p4Count = panes.reduce((n, p) => n + countPickScreens(p), 0);
      counts.p4Matches = p4Count;
      const p3 = tools.planPres >= 1 && tools.planPresNoId === 0 && tools.planPosts === 0 && tools.mainPostsAfter3 === 0 && tools.p2Posts >= 1 && tools.unpairedPres === 0 && file3 === undefined;
      checks.P3 = p3;
      checks.P4 = p4Count === 0;
      // P5
      const statusOk = [...observed].every((s) => s === "idle" || s === "busy");
      checks.P5 = ports.now() - startMs <= this.totalMs && statusOk && tools.bashPres === 0;
      // 番号の若い×から報告する
      for (const key of ["P3", "P4", "P5"]) {
        if (!checks[key]) throw new ProbeFailed(key);
      }
    } catch (err) {
      if (err instanceof ProbeAborted) aborted = true;
      else if (err instanceof ProbeFailed) failed = err.check;
      else {
        // 件が開けない(503 など)・想定外の例外: 途中で終わった扱い（failCount を増やさない）
        aborted = true;
      }
    }
    // 片付け: 閉じる → R・W・D/cases を消す。どこまで進んだかに依らず必ず行う
    if (probeCase !== undefined) {
      await ports.closeCase(probeCase.id).catch(() => undefined);
      await ports.cleanup(probeCase).catch(() => undefined);
    }
    this.runningCase = undefined;
    await this.store.setRunning(undefined).catch(() => undefined);
    this.records = [];
    if (failed === undefined && !aborted && checks.P5 === undefined) failed = "P5";
    return this.finish({ target, trigger, startedAt, version, checks, failed, aborted, counts, panes, probeCaseId: probeCase?.id ?? "" });
  }

  private async finish(f: {
    target: { real: string; fp: Fingerprint };
    trigger: "t1" | "t2";
    startedAt: string;
    version: string;
    checks: Record<string, boolean>;
    failed: string | undefined;
    aborted: boolean;
    counts: Record<string, number>;
    panes: string[];
    probeCaseId: string;
  }): Promise<ProbeResult> {
    const { ports, store } = this;
    const endedAt = ports.isoNow();
    const sha16 = f.target.fp.sha256.slice(0, 16);
    const outcome: "ok" | "denied" | "aborted" = f.aborted ? "aborted" : f.failed !== undefined ? "denied" : "ok";
    const prev = store.entryOf(f.target.fp.sha256);
    const auditEntry: RoutineAuditEntry = {
      at: endedAt,
      action: "caseClaudeVersionProbe",
      outcome,
      callerSessionId: null,
      claudeVersion: f.version,
      startedAt: f.startedAt,
      endedAt,
      sha16,
      trigger: f.trigger,
      probeCaseId: f.probeCaseId,
      counts: f.counts,
      paneSamples: f.panes,
      ...(f.failed !== undefined ? { failedCheck: f.failed } : {}),
    };
    let auditOk = true;
    try {
      await ports.audit(auditEntry);
    } catch {
      auditOk = false;
      ports.notice({ reason: "n6", claudeVersion: f.version, sha256: f.target.fp.sha256 });
    }
    const base = {
      sha256: f.target.fp.sha256,
      size: f.target.fp.size,
      claudeVersion: f.version,
      real: f.target.real,
      verifiedAt: endedAt,
      probeCaseId: f.probeCaseId,
      checks: f.checks,
      lastProbeAt: endedAt,
    };
    let entry: Omit<VersionEntry, "mac">;
    let result: ProbeResult;
    if (outcome === "ok" && auditOk) {
      entry = { ...base, usable: true, lastResult: "ok", failCount: 0 };
      result = { outcome: "ok" };
    } else if (outcome === "ok") {
      // 記録の無い○を作らない
      entry = { ...base, usable: false, lastResult: "audit_failed", failCount: prev?.failCount ?? 0 };
      result = { outcome: "audit_failed" };
    } else if (outcome === "denied") {
      entry = { ...base, usable: false, lastResult: f.failed ?? "P5", failCount: (prev?.failCount ?? 0) + 1 };
      result = { outcome: "denied", failedCheck: f.failed };
      const tail = entry.failCount >= PROBE_MAX_FAILS ? "（設計者の確認が要る）" : "";
      ports.notice({ reason: "n4", claudeVersion: f.version, sha256: f.target.fp.sha256, detail: `${f.failed ?? ""}${tail}` });
    } else {
      // aborted: 使える項目はそのまま。failCount は増やさない
      entry = prev !== undefined ? { ...prevWithoutMac(prev), lastResult: "aborted", lastProbeAt: endedAt } : { ...base, usable: false, lastResult: "aborted", failCount: 0 };
      result = { outcome: "aborted" };
    }
    await store.upsert(entry);
    return result;
  }
}

function prevWithoutMac(e: VersionEntry): Omit<VersionEntry, "mac"> {
  const { mac: _mac, ...rest } = e;
  return rest;
}
