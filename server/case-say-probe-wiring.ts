// 件の claude の版の自動の確かめを、実物の SessionManager・Hub・監査・活動の記録へ結ぶ（設計 conversation-consent §14-14-3 D1・D4・§14-14-6 の 3）。
import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, lstatSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ActivityStore } from "./activity.ts";
import { readCaseStateFile } from "./case-agents.ts";
import { caseCloneDir } from "./case-clone.ts";
import { removeCaseFiles, resolveClaudeReal, UUID } from "./case-sandbox.ts";
import { CaseVersionProbe, type ProbePorts } from "./case-say-probe.ts";
import { CaseSayVersionStore, fingerprintFile } from "./case-say-versions.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { descendantPids, readProcessTable } from "./process-tree.ts";
import type { RoutineAuditEntry } from "./routine-audit.ts";
import type { SessionManager } from "./sessions.ts";
import { sessionName } from "./terminal-host/tmux-protocol.ts";
import { PROBE_VERSION_TIMEOUT_MS } from "./case-say-probe.ts";

const PROBE_FILE_MAX_BYTES = 4096;

export interface CaseVersionDeps {
  config: Config;
  sessions: SessionManager;
  hub: Hub;
  activity: ActivityStore;
  audit: (entry: RoutineAuditEntry) => Promise<void>;
}

export interface CaseVersionService {
  store: CaseSayVersionStore;
  probe: CaseVersionProbe;
  /** 起動時の記録の読み込み・再確認・前回の probe の片付け。復元（restore）より前に呼ぶ。投げない */
  startupCleanup(): Promise<void>;
  /** 復元と hub.start() の後に呼ぶ: PATH の claude の指紋が未記録なら probe を予約する（D4 t2） */
  start(): Promise<void>;
}

/** 実物の ProbePorts。設定の外の物（tmux・ファイル・時計）に触るのはここだけ */
export function realProbePorts(deps: CaseVersionDeps, notice: ProbePorts["notice"]): ProbePorts {
  const { config, sessions, hub, activity, audit } = deps;
  return {
    now: () => Date.now(),
    isoNow: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    resolveReal: () => resolveClaudeReal(config.claudeBin, process.env.PATH),
    fingerprint: (real) => fingerprintFile(real),
    stat: (real) => {
      try {
        const st = statSync(real);
        let executable = true;
        try {
          accessSync(real, fsConstants.X_OK);
        } catch {
          executable = false;
        }
        return { isFile: st.isFile(), executable, nlink: st.nlink };
      } catch {
        return null;
      }
    },
    versionOutput: (real) =>
      new Promise((resolve, reject) => {
        execFile(real, ["--version"], { timeout: PROBE_VERSION_TIMEOUT_MS }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
      }),
    hasFreeSlots: (n) => sessions.maxSessionCount() - sessions.occupiedCount() >= n,
    openCase: async (name) => {
      const s = await sessions.openVersionProbe(name);
      return { id: s.id, R: sessions.caseCleanupPaths(s.id).R };
    },
    closeCase: (id) => sessions.close(id),
    cleanup: async (c) => {
      const p = sessions.caseCleanupPaths(c.id);
      // 閉じる道は件のファイルも写しも消さないので、自分で消す（どれも既に無ければ何もしない形）
      await removeCaseFiles(p.D, c.id, { tmp: true, tmpRoot: p.tmpRoot }).catch(() => undefined);
      await rm(p.R, { recursive: true, force: true }).catch(() => undefined);
      if (p.W === caseCloneDir(p.H, c.id)) await rm(p.W, { recursive: true, force: true }).catch(() => undefined);
    },
    readState: async (c) => {
      const CH = sessions.caseHomeOf(c.id);
      const main = sessions.caseMainProcesses().get(c.id);
      if (CH === undefined || main === undefined) return { state: undefined, panePid: undefined };
      const table = await readProcessTable().catch(() => null);
      if (table === null) return { state: undefined, panePid: undefined };
      return { state: readCaseStateFile(CH, descendantPids(main.pid, table)), panePid: sessions.casePaneInfo(c.id)?.panePid };
    },
    send: (c, text) => hub.probeSend(c.id, text),
    capturePane: async (c) => sessions.captureCasePane(c.id),
    readFile: async (c, name) => {
      const file = path.join(c.R, name);
      try {
        const st = lstatSync(file);
        if (!st.isFile() || st.nlink !== 1 || st.size > PROBE_FILE_MAX_BYTES) return undefined;
        return await readFile(file, "utf8");
      } catch {
        return undefined;
      }
    },
    agentEvidence: async (c, probeFile, records, sent2At) => {
      const none = { agentWrite: false, subagentStarts: 0, subagentStops: 0 };
      const csid = sessions.get(c.id)?.claudeSessionId;
      if (csid === undefined) return none;
      // P2 の間の Write の post で、path が probe-2.txt に完全一致し、agent_id が空でない記録
      const ids = new Set(records.filter((r) => r.phase === "post" && r.tool === "Write" && r.ts >= sent2At && r.path === probeFile && r.agent_id !== "").map((r) => r.agent_id));
      if (ids.size === 0) return none;
      await activity.refresh().catch(() => undefined);
      let best = { starts: 0, stops: 0 };
      for (const id of ids) {
        const life = activity.agentLifecycle(csid, id);
        if (life.starts >= 1 && life.stops >= 1) {
          best = life;
          break;
        }
        if (life.starts + life.stops > best.starts + best.stops) best = life;
      }
      return { agentWrite: true, subagentStarts: best.starts, subagentStops: best.stops };
    },
    audit,
    notice,
  };
}

export function setupCaseVersionService(deps: CaseVersionDeps): CaseVersionService {
  const { sessions, hub, audit } = deps;
  const store = new CaseSayVersionStore(deps.config.dataDir);
  const notice: ProbePorts["notice"] = (n) => {
    const sha16 = n.sha256.slice(0, 16);
    hub.addCaseVersionNotice({ reason: n.reason, claudeVersion: n.claudeVersion, sha16, ...(n.detail !== undefined ? { detail: n.detail } : {}) });
    // n6 は監査に書けなかった知らせなので、監査には書かない
    if (n.reason === "n6") return;
    void audit({ at: new Date().toISOString(), action: "caseClaudeVersionNotice", outcome: "ok", callerSessionId: null, reason: n.reason, claudeVersion: n.claudeVersion, sha16 }).catch(() => {
      hub.addCaseVersionNotice({ reason: "n6", claudeVersion: n.claudeVersion, sha16 });
    });
  };
  const ports = realProbePorts(deps, notice);
  const probe = new CaseVersionProbe(store, ports);
  hub.setCaseVersions(store, probe);
  sessions.setVersionProbeAborter(() => probe.abort());
  // 件を開いたとき（t1）: 指紋が使える項目に無ければ知らせ、probe を予約する
  sessions.setCaseOpenedListener(({ real, fp }) => {
    if (store.isUsable(fp)) return;
    notice({ reason: "n1", claudeVersion: path.basename(real), sha256: fp?.sha256 ?? "", ...(fp === undefined ? { detail: "fingerprint" } : {}) });
    if (fp !== undefined) void probe.request("t1", { real, fp }).catch(() => undefined);
  });
  // 枠が空いたとき・件が閉じたときに、待っている予約を進める
  sessions.onChange(() => void probe.kick().catch(() => undefined));

  const startupCleanup = async (): Promise<void> => {
    try {
      const report = await store.load();
      if (report.discarded) notice({ reason: "n5", claudeVersion: "", sha256: "" });
      // 前回の probe が残っていれば片付ける（順: 一覧 → kill-session 1 つ → 写し・R・D/cases → 記録 → 復元）
      const running = store.runningVersionProbe();
      if (running !== undefined && !UUID.test(running.caseId)) {
        // caseId が UUID の形でない記録は信じない: kill も片付けもせず、記録を消して知らせだけ出す
        await store.setRunning(undefined);
        notice({ reason: "n5", claudeVersion: "", sha256: "" });
      } else if (running !== undefined) {
        const name = sessionName(running.caseId);
        sessions.killSweptSession(name);
        await ports.cleanup({ id: running.caseId, R: sessions.caseCleanupPaths(running.caseId).R }).catch(() => undefined);
        await store.setRunning(undefined);
        const at = new Date().toISOString();
        await audit({ at, action: "caseClaudeVersionProbe", outcome: "aborted", callerSessionId: null, startedAt: new Date(running.startedAt).toISOString(), endedAt: at, probeCaseId: running.caseId, ...(running.sha256 !== undefined ? { sha16: running.sha256.slice(0, 16) } : {}), ...(running.claudeVersion !== undefined ? { claudeVersion: running.claudeVersion } : {}) }).catch(() => undefined);
        if (running.sha256 !== undefined) {
          const prev = store.entryOf(running.sha256);
          if (prev !== undefined) {
            const { mac: _mac, ...rest } = prev;
            await store.upsert({ ...rest, lastResult: "aborted", lastProbeAt: at });
          }
        }
      }
      const revoked = await store.recheck(() => new Date().toISOString());
      for (const e of revoked) {
        notice({ reason: "n3", claudeVersion: e.claudeVersion, sha256: e.sha256 });
      }
    } catch (err) {
      console.error("case-say-versions: startup failed:", err instanceof Error ? err.message : err);
    }
  };

  const start = async (): Promise<void> => {
    try {
      const real = ports.resolveReal();
      if (real === null) return;
      const fp = await ports.fingerprint(real);
      if (fp === null || store.isUsable(fp)) return;
      notice({ reason: "n2", claudeVersion: path.basename(real), sha256: fp.sha256 });
      void probe.request("t2", { real, fp }).catch(() => undefined);
    } catch (err) {
      console.error("case-say-versions: start failed:", err instanceof Error ? err.message : err);
    }
  };
  return { store, probe, startupCleanup, start };
}
