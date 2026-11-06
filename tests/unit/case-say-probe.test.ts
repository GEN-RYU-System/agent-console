import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaseVersionProbe, countPickScreens, countTools, probeSentences, sanitizePane, toolRecordOf, type AgentEvidence, type ProbeCase, type ProbePorts, type ProbeToolRecord } from "../../server/case-say-probe.ts";
import { CaseSayVersionStore, type Fingerprint } from "../../server/case-say-versions.ts";
import type { RoutineAuditEntry } from "../../server/routine-audit.ts";

const R = "/fake/R/probe";
const FP: Fingerprint = { size: 4242, sha256: "d".repeat(64) };
const REAL = "/fake/versions/2.1.320";
const PO_CASE_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd";

interface Opts {
  real?: string;
  fp?: Fingerprint | null;
  nlink?: number;
  versionOutput?: string | Error;
  freeSlots?: boolean;
  auditFails?: boolean;
  version?: string;
  pid?: number;
  panePid?: number;
  waitKeys?: string[];
  status?: string;
  p1?: string | null;
  p2?: string | null;
  evidence?: AgentEvidence;
  screen?: string;
  /** 文ごとの道具の記録を作り替える */
  s1?: (rec: (r: Partial<ProbeToolRecord>) => void) => void;
  s2?: (rec: (r: Partial<ProbeToolRecord>) => void) => void;
  s3?: (rec: (r: Partial<ProbeToolRecord>) => void) => void;
  /** post-idle の待ちの間に届く遅れた記録 */
  late?: Partial<ProbeToolRecord>;
  p3File?: boolean;
  totalMs?: number;
}

function world(dir: string, o: Opts = {}) {
  let clock = 1_000_000;
  const audit: RoutineAuditEntry[] = [];
  const notices: Array<{ reason: string; detail?: string }> = [];
  const closed: string[] = [];
  const cleaned: string[] = [];
  const opened: string[] = [];
  const sent: string[] = [];
  const files = new Map<string, string>();
  let probeRef: CaseVersionProbe | undefined;
  let nextId = 1;
  let statusOverride: string | undefined;
  const store = new CaseSayVersionStore(dir);
  const rec = (r: Partial<ProbeToolRecord>): void => {
    probeRef?.recordTool({ hook_event_name: r.phase === "post" ? "PostToolUse" : "PreToolUse", agent_id: r.agent_id ?? "", tool_name: r.tool ?? "Write", tool_use_id: r.tool_use_id ?? "", permission_mode: r.permission_mode ?? "dontAsk", tool_input: { file_path: "SECRET" } });
  };
  const [s1, s2, s3] = probeSentences(R);
  let abortAt: (() => void) | undefined;
  const ports: ProbePorts = {
    now: () => clock,
    isoNow: () => new Date(clock).toISOString(),
    sleep: async (ms) => {
      clock += ms;
      if (ms === 3000 && o.late !== undefined) rec(o.late);
      abortAt?.();
    },
    resolveReal: () => o.real ?? REAL,
    fingerprint: async () => (o.fp === undefined ? FP : o.fp),
    stat: () => ({ isFile: true, executable: true, nlink: o.nlink ?? 1 }),
    versionOutput: async () => {
      if (o.versionOutput instanceof Error) throw o.versionOutput;
      return o.versionOutput ?? "2.1.320 (Claude Code)";
    },
    hasFreeSlots: () => o.freeSlots !== false,
    openCase: async (name): Promise<ProbeCase> => {
      opened.push(name);
      return { id: `probe-${nextId++}`, R };
    },
    closeCase: async (id) => { closed.push(id); },
    cleanup: async (c) => { cleaned.push(c.id); },
    readState: async () => ({
      state: { filePid: o.pid ?? 500, pid: o.pid ?? 500, status: statusOverride ?? o.status ?? "idle", waitKeys: o.waitKeys ?? [], ...(o.version !== undefined ? { version: o.version } : {}) },
      panePid: o.panePid ?? o.pid ?? 500,
    }),
    send: async (_c, text) => {
      sent.push(text);
      if (text === s1) {
        files.set("probe-1.txt", o.p1 === undefined ? "ok" : (o.p1 ?? ""));
        if (o.s1) o.s1(rec);
        else { rec({ phase: "pre", tool: "Write", tool_use_id: "u1" }); rec({ phase: "post", tool: "Write", tool_use_id: "u1" }); }
      } else if (text === s2) {
        files.set("probe-2.txt", o.p2 === undefined ? "ok" : (o.p2 ?? ""));
        if (o.s2) o.s2(rec);
        else {
          rec({ phase: "pre", tool: "Agent", tool_use_id: "u2" });
          rec({ phase: "pre", tool: "Write", tool_use_id: "u3", agent_id: "a1" });
          rec({ phase: "post", tool: "Write", tool_use_id: "u3", agent_id: "a1" });
          rec({ phase: "post", tool: "Agent", tool_use_id: "u2" });
        }
      } else if (text === s3) {
        if (o.p3File === true) files.set("probe-3.txt", "ok");
        if (o.s3) o.s3(rec);
        else rec({ phase: "pre", tool: "Write", tool_use_id: "u4", permission_mode: "plan" });
      }
      clock += 50;
      return true;
    },
    capturePane: async () => o.screen ?? "❯ \n",
    readFile: async (_c, name) => files.get(name),
    agentEvidence: async () => o.evidence ?? { agentWrite: true, subagentStarts: 1, subagentStops: 1 },
    audit: async (e) => {
      if (o.auditFails === true) throw new Error("disk full");
      audit.push(e);
    },
    notice: (n) => { notices.push(n); },
  };
  const probe = new CaseVersionProbe(store, ports, { pollMs: 1000, postIdleWaitMs: 3000, ...(o.totalMs !== undefined ? { totalMs: o.totalMs } : {}) });
  probeRef = probe;
  return {
    store, probe, ports, audit, notices, closed, cleaned, opened, sent, rec, clockNow: () => clock, advance: (ms: number) => { clock += ms; },
    setStatusOnce: (s: string) => { statusOverride = s; },
    onSleep: (fn: () => void) => { abortAt = fn; },
    clearStatus: () => { statusOverride = undefined; },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ac-probe-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(o: Opts = {}) {
  const w = world(dir, o);
  await w.store.load();
  const result = await w.probe.request("t2");
  return { w, result };
}

describe("probe pure helpers", () => {
  it("the three sentences are constants built from R only", () => {
    expect(probeSentences("/r")).toEqual([
      "/r/probe-1.txt に ok とだけ書いてください。",
      "Agent で下請けを1つ動かし、下請けに /r/probe-2.txt へ ok とだけ書かせてください。",
      "/plan /r/probe-3.txt に ok とだけ書いてください。",
    ]);
  });
  it("toolRecordOf keeps only the allowed fields (no tool_input / tool_response)", () => {
    const r = toolRecordOf({ hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "x", permission_mode: "plan", tool_input: { file_path: "/secret" }, tool_response: "x", agent_id: "" }, 7);
    expect(r).toEqual({ ts: 7, phase: "pre", agent_id: "", tool: "Write", tool_use_id: "x", permission_mode: "plan", path: "/secret" });
    expect(JSON.stringify(r)).not.toContain("tool_response");
    // Write 以外の道具では path を持たない
    expect(toolRecordOf({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/x" } }, 1)?.path).toBe("");
    expect(toolRecordOf({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: 5 } }, 1)?.path).toBe("");
    expect(toolRecordOf({ hook_event_name: "Stop" }, 1)).toBeNull();
    expect(toolRecordOf("x", 1)).toBeNull();
  });
  it("P4 counts picker screens and sanitizePane cuts to 4KiB without control characters", () => {
    expect(countPickScreens("❯ \n")).toBe(0);
    expect(countPickScreens("Do you want to proceed?")).toBe(1);
    expect(countPickScreens("proceed (y/n)")).toBeGreaterThan(0);
    expect(countPickScreens("Esc to cancel")).toBe(1);
    expect(countPickScreens("  ❯ 1. Yes\n    2. No\n")).toBeGreaterThanOrEqual(1);
    expect(countPickScreens("1. one\n")).toBe(0);
    expect(countPickScreens("Yes or No?")).toBe(1);
    const s = sanitizePane(`${"あ".repeat(5000)}\u001b[31mred\u0007`);
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(4096);
    expect(s).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });
  it("countTools separates the P2 window, plan rows, passed tools and Bash rows", () => {
    const r = (ts: number, phase: "pre" | "post", over: Partial<ProbeToolRecord> = {}): ProbeToolRecord => ({ ts, phase, agent_id: "", tool: "Write", tool_use_id: `i${ts}`, permission_mode: "dontAsk", path: "", ...over });
    const c = countTools([r(1, "pre"), r(2, "post", { tool_use_id: "i1" }), r(5, "post"), r(11, "pre", { permission_mode: "plan", tool_use_id: "p" }), r(12, "pre", { tool: "Bash" })], 4, 10);
    expect(c).toMatchObject({ p2Posts: 1, planPres: 1, planPresNoId: 0, planPosts: 0, mainPostsAfter3: 0, bashPres: 1, unpairedPres: 0 });
  });
});

describe("K51: a full run is ok and records usable", () => {
  it("opens one probe case, sends 3 constant sentences, writes a MAC entry, an audit row with every field, then closes and cleans", async () => {
    const { w, result } = await run();
    expect(result).toEqual({ outcome: "ok" });
    expect(w.opened).toEqual(["probe claude 2.1.320"]);
    expect(w.sent).toEqual(probeSentences(R));
    expect(w.closed).toEqual(["probe-1"]);
    expect(w.cleaned).toEqual(["probe-1"]);
    expect(w.probe.runningCaseId()).toBeUndefined();
    expect(w.store.isUsable(FP)).toBe(true);
    expect(w.store.runningVersionProbe()).toBeUndefined();
    const row = w.audit.at(-1)!;
    expect(row).toMatchObject({ action: "caseClaudeVersionProbe", outcome: "ok", callerSessionId: null, claudeVersion: "2.1.320", sha16: FP.sha256.slice(0, 16), trigger: "t2", probeCaseId: "probe-1" });
    expect(typeof row.startedAt).toBe("string");
    expect(typeof row.endedAt).toBe("string");
    expect(row.failedCheck).toBeUndefined();
    expect(row.counts).toMatchObject({ planPres: 1, planPosts: 0, mainPostsAfter3: 0, bashPres: 0, unpairedPres: 0 });
    expect(row.counts?.p2Posts).toBeGreaterThanOrEqual(1);
    expect(row.paneSamples).toHaveLength(4);
    // 起き直しても使える（MAC が合う）
    const again = new CaseSayVersionStore(dir);
    await again.load();
    expect(again.isUsable(FP)).toBe(true);
  });

  it("a probe row is appended per run and the first one stays after a second run", async () => {
    const w = world(dir, { fp: FP });
    await w.store.load();
    await w.probe.request("t2");
    // 使える指紋では窓を開かない
    await w.probe.request("t2");
    expect(w.opened).toHaveLength(1);
    expect(w.audit).toHaveLength(1);
  });
});

describe("K51: exactly one check failing is not usable and names the number", () => {
  const cases: Array<[string, Opts]> = [
    ["E1", { real: "/fake/bin/claude" }],
    ["E2", { nlink: 2 }],
    ["E3", { versionOutput: "9.9.9" }],
    ["P0", { version: "1.0.0" }],
    ["P0", { waitKeys: ["waitingFor"] }],
    ["P0", { panePid: 777 }],
    ["P0", { status: "busy" }],
    ["P1", { p1: "no" }],
    ["P1", { p1: null }],
    ["P2", { evidence: { agentWrite: false, subagentStarts: 1, subagentStops: 1 } }],
    ["P2", { evidence: { agentWrite: true, subagentStarts: 0, subagentStops: 1 } }],
    ["P2", { evidence: { agentWrite: true, subagentStarts: 1, subagentStops: 0 } }],
    ["P2", { p2: "nope" }],
    ["P3", { s3: () => undefined }],
    ["P3", { s3: (rec) => { rec({ phase: "pre", tool: "Write", tool_use_id: "z", permission_mode: "plan" }); rec({ phase: "post", tool: "Write", tool_use_id: "z" }); } }],
    ["P3", { s3: (rec) => rec({ phase: "pre", tool: "Write", tool_use_id: "", permission_mode: "plan" }) }],
    ["P3", { s3: (rec) => { rec({ phase: "pre", tool: "Write", tool_use_id: "z", permission_mode: "plan" }); rec({ phase: "post", tool: "Read", tool_use_id: "" }); } }],
    ["P3", { s2: (rec) => { rec({ phase: "pre", tool: "Agent", tool_use_id: "u2" }); } }],
    ["P3", { s1: (rec) => { rec({ phase: "pre", tool: "Write", tool_use_id: "only-pre" }); rec({ phase: "post", tool: "Write", tool_use_id: "other" }); } }],
    ["P3", { late: { phase: "post", tool: "Write", tool_use_id: "late" } }],
    ["P3", { p3File: true }],
    ["P4", { screen: "Do you want to proceed?\n  ❯ 1. Yes\n    2. No" }],
    ["P5", { s3: (rec) => { rec({ phase: "pre", tool: "Write", tool_use_id: "z", permission_mode: "plan" }); rec({ phase: "pre", tool: "Bash", tool_use_id: "b" }); } }],
  ];
  for (const [check, opts] of cases) {
    it(`${check}: ${JSON.stringify(Object.keys(opts))}`, async () => {
      const { w, result } = await run(opts);
      expect(result?.outcome, JSON.stringify(w.audit.at(-1))).toBe("denied");
      expect(result?.failedCheck).toBe(check);
      expect(w.store.isUsable(FP)).toBe(false);
      expect(w.store.entryOf(FP.sha256)).toMatchObject({ usable: false, lastResult: check, failCount: 1 });
      expect(w.audit.at(-1)).toMatchObject({ action: "caseClaudeVersionProbe", outcome: "denied", failedCheck: check });
      expect(w.notices.some((n) => n.reason === "n4")).toBe(true);
      // 開いた件は必ず閉じて片付ける
      expect(w.closed).toEqual(w.opened.map((_, i) => `probe-${i + 1}`));
      expect(w.cleaned).toEqual(w.closed);
      if (check.startsWith("E")) expect(w.opened).toHaveLength(0);
    });
  }

  it("F1: P3 fails when the state stays busy after sentence 3 (never back to idle)", async () => {
    const w = world(dir);
    await w.store.load();
    const [, , s3] = probeSentences(R);
    const base = w.ports.readState;
    w.ports.readState = async (c) => {
      const s = await base(c);
      return w.sent.includes(s3) && s.state ? { ...s, state: { ...s.state, status: "busy" } } : s;
    };
    const result = await w.probe.request("t2");
    expect(result?.outcome).toBe("denied");
    expect(result?.failedCheck).toBe("P3");
    expect(w.store.isUsable(FP)).toBe(false);
  });

  it("F5: when setRunning throws, the probe is aborted, the case is cleaned up and the audit outcome is aborted", async () => {
    const w = world(dir);
    await w.store.load();
    w.store.setRunning = async () => {
      throw new Error("disk full");
    };
    const result = await w.probe.request("t2");
    expect(result?.outcome).toBe("aborted");
    expect(w.closed).toEqual(["probe-1"]);
    expect(w.cleaned).toEqual(["probe-1"]);
    expect(w.sent).toEqual([]);
    expect(w.audit.at(-1)).toMatchObject({ action: "caseClaudeVersionProbe", outcome: "aborted" });
    expect(w.store.isUsable(FP)).toBe(false);
  });

  it("P5: a status other than idle/busy while waiting is recorded as P5", async () => {
    const w = world(dir);
    await w.store.load();
    let calls = 0;
    const base = w.ports.readState;
    w.ports.readState = async (c) => {
      calls += 1;
      const s = await base(c);
      return calls === 3 && s.state ? { ...s, state: { ...s.state, status: "waiting" } } : s;
    };
    const r = await w.probe.request("t2");
    expect(r?.failedCheck).toBe("P5");
  });

  it("P5: taking more than the total time is P5", async () => {
    const { result } = await run({ totalMs: 500, status: "busy" });
    expect(result?.failedCheck).toBe("P5");
  });

  it("E4: no fingerprint opens no case and notifies n4 (nothing to key the record by)", async () => {
    const { w, result } = await run({ fp: null });
    expect(result).toBeUndefined();
    expect(w.opened).toHaveLength(0);
    expect(w.notices.map((n) => n.reason)).toEqual(["n4"]);
  });
});

describe("K51/K52: the probe is the server's own and only one at a time", () => {
  it("recordTool refuses when no probe is running; only one probe runs for the same time", async () => {
    const w = world(dir);
    await w.store.load();
    expect(w.probe.recordTool({ hook_event_name: "PreToolUse", tool_name: "Write" })).toBe(false);
    const a = w.probe.request("t1");
    const b = w.probe.request("t2");
    await Promise.all([a, b]);
    expect(w.opened).toHaveLength(1);
  });

  it("isProbing is true for the fingerprint only while its probe runs", async () => {
    const w = world(dir);
    await w.store.load();
    const during: boolean[] = [];
    w.onSleep(() => during.push(w.probe.isProbing(FP.sha256)));
    await w.probe.request("t2");
    expect(during.length).toBeGreaterThan(0);
    expect(during.every(Boolean)).toBe(true);
    expect(w.probe.isProbing(FP.sha256)).toBe(false);
  });

  it("a record written to the probe endpoint while running is counted (the case id check is the endpoint's)", async () => {
    const w = world(dir);
    await w.store.load();
    let runningId: string | undefined;
    w.onSleep(() => { runningId = w.probe.runningCaseId(); });
    await w.probe.request("t2");
    expect(runningId).toBe("probe-1");
    expect(runningId).not.toBe(PO_CASE_ID);
  });

  it("does not start when fewer than 2 slots are free; starts later when kicked with room", async () => {
    const w = world(dir, { freeSlots: false });
    await w.store.load();
    expect(await w.probe.request("t2")).toBeUndefined();
    expect(w.opened).toHaveLength(0);
    (w.ports as unknown as { hasFreeSlots: () => boolean }).hasFreeSlots = () => true;
    expect(await w.probe.kick()).toEqual({ outcome: "ok" });
    expect(w.opened).toHaveLength(1);
  });

  it("when the PO's case needs a slot, abort ends the probe as aborted: closed, cleaned, no failCount, not usable", async () => {
    const w = world(dir);
    await w.store.load();
    let n = 0;
    w.onSleep(() => { n += 1; if (n === 1) void w.probe.abort(); });
    const r = await w.probe.request("t2");
    expect(r).toEqual({ outcome: "aborted" });
    expect(w.closed).toEqual(["probe-1"]);
    expect(w.cleaned).toEqual(["probe-1"]);
    expect(w.store.entryOf(FP.sha256)).toMatchObject({ usable: false, lastResult: "aborted", failCount: 0 });
    expect(w.audit.at(-1)).toMatchObject({ outcome: "aborted" });
    expect(w.store.runningVersionProbe()).toBeUndefined();
  });
});

describe("K51: retry rules after a failure", () => {
  it("does not probe again within 24 hours, probes after it, and stops after 3 consecutive failures", async () => {
    const w = world(dir, { p1: "no" });
    await w.store.load();
    expect((await w.probe.request("t2"))?.outcome).toBe("denied");
    expect(await w.probe.request("t2")).toBeUndefined();
    expect(w.opened).toHaveLength(1);
    w.advance(25 * 3600 * 1000);
    expect((await w.probe.request("t2"))?.outcome).toBe("denied");
    expect(w.opened).toHaveLength(2);
    w.advance(25 * 3600 * 1000);
    expect((await w.probe.request("t2"))?.outcome).toBe("denied");
    expect(w.store.entryOf(FP.sha256)?.failCount).toBe(3);
    expect(w.notices.filter((n) => n.reason === "n4").at(-1)?.detail).toContain("設計者の確認が要る");
    w.advance(25 * 3600 * 1000);
    expect(await w.probe.request("t2")).toBeUndefined();
    expect(w.opened).toHaveLength(3);
  });
});

describe("K59: the record is kept (§14-14-6 の 9)", () => {
  it("an audit failure on an ok run raises n6, writes no usable entry, and records audit_failed", async () => {
    const { w, result } = await run({ auditFails: true });
    expect(result).toEqual({ outcome: "audit_failed" });
    expect(w.notices.map((n) => n.reason)).toContain("n6");
    expect(w.store.isUsable(FP)).toBe(false);
    expect(w.store.entryOf(FP.sha256)).toMatchObject({ usable: false, lastResult: "audit_failed", failCount: 0 });
  });

  it("ok, denied and aborted each append one caseClaudeVersionProbe row with every field", async () => {
    const fields = ["at", "action", "outcome", "callerSessionId", "claudeVersion", "startedAt", "endedAt", "sha16", "trigger", "probeCaseId", "counts", "paneSamples"];
    const ok = await run();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(os.tmpdir(), "ac-probe-"));
    const denied = await run({ p1: "no" });
    for (const row of [ok.w.audit.at(-1)!, denied.w.audit.at(-1)!]) for (const f of fields) expect(row, f).toHaveProperty(f);
    expect(denied.w.audit.at(-1)).toHaveProperty("failedCheck", "P1");
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(os.tmpdir(), "ac-probe-"));
    const w = world(dir);
    await w.store.load();
    let n = 0;
    w.onSleep(() => { n += 1; if (n === 1) void w.probe.abort(); });
    await w.probe.request("t1");
    const aborted = w.audit.at(-1)!;
    expect(aborted.outcome).toBe("aborted");
    for (const f of fields) expect(aborted, f).toHaveProperty(f);
  });
});
