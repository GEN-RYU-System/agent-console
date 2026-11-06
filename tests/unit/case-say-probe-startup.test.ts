import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupCaseVersionService } from "../../server/case-say-probe-wiring.ts";
import { CaseSayVersionStore, type VersionEntry } from "../../server/case-say-versions.ts";
import type { Config } from "../../server/config.ts";
import { Hub } from "../../server/hub.ts";
import type { RoutineAuditEntry } from "../../server/routine-audit.ts";
import type { SessionManager } from "../../server/sessions.ts";

const OLD_PROBE = "aaaaaaaa-1111-4222-8333-444444444444";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ac-startup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function binary(name: string, body: string): { real: string; sha256: string; size: number } {
  const real = path.join(dir, name);
  writeFileSync(real, body, { mode: 0o755 });
  return { real, sha256: createHash("sha256").update(body).digest("hex"), size: Buffer.byteLength(body) };
}

const entry = (b: { real: string; sha256: string; size: number }, over: Partial<Omit<VersionEntry, "mac">> = {}): Omit<VersionEntry, "mac"> => ({
  sha256: b.sha256, size: b.size, claudeVersion: path.basename(b.real), real: b.real, verifiedAt: "2026-11-06T00:00:00.000Z", probeCaseId: "c", checks: {},
  usable: true, lastProbeAt: "2026-11-06T00:00:00.000Z", lastResult: "ok", failCount: 0, ...over,
});

function rig(claudeBin: string) {
  const calls: string[] = [];
  const audit: RoutineAuditEntry[] = [];
  const notices: Array<{ reason: string; claudeVersion: string; detail?: string }> = [];
  const R = path.join(dir, "R", OLD_PROBE);
  const W = path.join(dir, "H", "worktrees", OLD_PROBE);
  let opened = 0;
  const sessions = {
    maxSessionCount: () => 4,
    occupiedCount: () => 0,
    onChange: () => undefined,
    setCaseOpenedListener: () => undefined,
    setVersionProbeAborter: () => undefined,
    killSweptSession: (name: string) => (calls.push(`kill:${name}`), true),
    caseCleanupPaths: (id: string) => ({ D: dir, R, W, H: path.join(dir, "H"), tmpRoot: dir, id }),
    openVersionProbe: async () => { opened += 1; throw new Error("not in this test"); },
    get: () => undefined,
  } as unknown as SessionManager;
  const hub = {
    addCaseVersionNotice: (n: { reason: string; claudeVersion: string; detail?: string }) => notices.push(n),
    setCaseVersions: () => undefined,
    probeSend: async () => false,
  } as unknown as Hub;
  const config = { dataDir: dir, claudeBin } as unknown as Config;
  const svc = setupCaseVersionService({ config, sessions, hub, activity: {} as never, audit: async (e) => { calls.push(`audit:${e.action}:${e.outcome}`); audit.push(e); } });
  return { svc, calls, audit, notices, opened: () => opened, R, W };
}

describe("K52: startup cleanup and re-check", () => {
  it("kills only the running probe's tmux session, then removes its files, clears the record, audits aborted, in that order", async () => {
    const seed = new CaseSayVersionStore(dir);
    await seed.load();
    const b = binary("2.1.320", "claude-bytes");
    await seed.upsert(entry(b, { usable: false, lastResult: "P1", failCount: 1, probeCaseId: OLD_PROBE }));
    await seed.setRunning({ caseId: OLD_PROBE, startedAt: 1, sha256: b.sha256, claudeVersion: "2.1.320" });
    const r = rig(b.real);
    mkdirSync(r.R, { recursive: true });
    mkdirSync(r.W, { recursive: true });
    mkdirSync(path.join(dir, "cases", OLD_PROBE), { recursive: true });
    mkdirSync(path.join(dir, "H"), { recursive: true });
    await r.svc.startupCleanup();
    expect(r.calls.filter((c) => c.startsWith("kill:"))).toEqual([`kill:ac-${OLD_PROBE}`]);
    expect(existsSync(r.R)).toBe(false);
    expect(existsSync(path.join(dir, "cases", OLD_PROBE))).toBe(false);
    expect(r.calls.indexOf(`kill:ac-${OLD_PROBE}`)).toBeLessThan(r.calls.indexOf("audit:caseClaudeVersionProbe:aborted"));
    expect(r.svc.store.runningVersionProbe()).toBeUndefined();
    expect(r.svc.store.entryOf(b.sha256)).toMatchObject({ lastResult: "aborted", failCount: 1 });
    expect(r.audit.find((a) => a.action === "caseClaudeVersionProbe")).toMatchObject({ outcome: "aborted", probeCaseId: OLD_PROBE, sha16: b.sha256.slice(0, 16) });
  });

  it("F4: a running record whose caseId is not a UUID is not trusted: no kill, no cleanup, record cleared, n5 once, recheck still runs", async () => {
    const seed = new CaseSayVersionStore(dir);
    await seed.load();
    const b = binary("2.1.320", "claude-bytes");
    await seed.upsert(entry(b));
    await seed.setRunning({ caseId: "../../etc", startedAt: 1, sha256: b.sha256, claudeVersion: "2.1.320" });
    // recheck が呼ばれたことは、実体が変わった項目が使えなくなる（n3）ことで確かめる
    writeFileSync(b.real, "changed-bytes");
    const r = rig(b.real);
    mkdirSync(r.R, { recursive: true });
    await r.svc.startupCleanup();
    expect(r.calls.filter((x) => x.startsWith("kill:"))).toEqual([]);
    expect(existsSync(r.R)).toBe(true);
    expect(r.audit.filter((a) => a.action === "caseClaudeVersionProbe")).toEqual([]);
    expect(r.svc.store.runningVersionProbe()).toBeUndefined();
    expect(r.notices.filter((n) => n.reason === "n5")).toHaveLength(1);
    expect(r.notices.filter((n) => n.reason === "n3")).toHaveLength(1);
  });

  it("an entry whose binary changed or vanished becomes unusable, with n3 and an audit notice row for each", async () => {
    const seed = new CaseSayVersionStore(dir);
    await seed.load();
    const changed = binary("2.1.321", "before");
    const gone = binary("2.1.322", "gone");
    const fine = binary("2.1.323", "fine");
    for (const b of [changed, gone, fine]) await seed.upsert(entry(b));
    writeFileSync(changed.real, "after!");
    rmSync(gone.real);
    const r = rig(fine.real);
    await r.svc.startupCleanup();
    expect(r.notices.filter((n) => n.reason === "n3").map((n) => n.claudeVersion).sort()).toEqual(["2.1.321", "2.1.322"]);
    expect(r.audit.filter((a) => a.action === "caseClaudeVersionNotice" && a.reason === "n3")).toHaveLength(2);
    expect(r.svc.store.usableVersions()).toEqual(["2.1.323"]);
  });

  it("a broken record gives n5 and zero usable versions", async () => {
    writeFileSync(path.join(dir, "case-say-claude-versions.json"), "{ nope", { mode: 0o600 });
    const r = rig(binary("2.1.320", "x").real);
    await r.svc.startupCleanup();
    expect(r.notices.map((n) => n.reason)).toEqual(["n5"]);
    expect(r.svc.store.usableVersions()).toEqual([]);
  });

  it("start: an unrecorded PATH claude gives n2 and reserves one probe; an already usable fingerprint opens no window and no notice", async () => {
    const b = binary("2.1.320", "#!/bin/sh\necho 2.1.320\n");
    const r = rig(b.real);
    await r.svc.startupCleanup();
    await r.svc.start();
    await r.svc.probe.idle();
    expect(r.notices.map((n) => n.reason)).toContain("n2");
    expect(r.opened()).toBe(1);

    const seed = new CaseSayVersionStore(dir);
    await seed.load();
    const c = binary("2.1.330", "bytes-c");
    await seed.upsert(entry(c));
    const r2 = rig(c.real);
    await r2.svc.startupCleanup();
    await r2.svc.start();
    expect(r2.notices).toEqual([]);
    expect(r2.opened()).toBe(0);
  });
});

describe("K54: the places a notice goes to (Hub)", () => {
  function makeHub(sent: string[]) {
    const sessions = {
      onChange: () => undefined,
      onRemoved: () => undefined,
      list: () => [],
      get: () => undefined,
      terminalNotices: () => [],
      maxSessionCount: () => 4,
      openCount: () => 0,
    } as unknown as SessionManager;
    const config = { notify: { macos: true, osascriptBin: "osascript" }, caseSayClaudeVersions: [] } as unknown as Config;
    return new Hub(config, sessions, (body) => sent.push(body), {});
  }

  it("each scene adds one snapshot notice and one macOS notification; the same scene twice is not repeated", async () => {
    const sent: string[] = [];
    const hub = makeHub(sent);
    for (const reason of ["n1", "n2", "n3", "n4", "n5", "n6"] as const) hub.addCaseVersionNotice({ reason, claudeVersion: "2.1.320", sha16: "0123456789abcdef" });
    hub.addCaseVersionNotice({ reason: "n1", claudeVersion: "2.1.320", sha16: "0123456789abcdef" });
    expect(sent).toHaveLength(6);
    const snap = await hub.snapshot();
    expect(snap.caseVersionNotices?.map((n) => n.reason)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
    hub.stop();
  });

  it("caseSayVersions lists the usable versions and the probing ones", () => {
    const hub = makeHub([]);
    hub.setCaseVersions({ isUsable: () => false, usableVersions: () => ["2.1.320"] }, { isProbing: () => false, probingVersions: () => ["2.1.321"] });
    expect(hub.caseSayVersions()).toEqual({ usable: ["2.1.320"], probing: ["2.1.321"] });
    hub.stop();
  });

  it("the wiring writes one caseClaudeVersionNotice audit row per scene except n6", async () => {
    const r = rig(binary("2.1.320", "x").real);
    // 配線の notice は startupCleanup の n5 と同じ道。壊れた記録で n5 を 1 回起こす
    writeFileSync(path.join(dir, "case-say-claude-versions.json"), "{ nope", { mode: 0o600 });
    await r.svc.startupCleanup();
    const rows = r.audit.filter((a) => a.action === "caseClaudeVersionNotice");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "n5", outcome: "ok", callerSessionId: null });
    expect(readFileSync(path.join(dir, "case-say-claude-versions.json"), "utf8")).toBe("{ nope");
  });
});

describe("K51: every other input into a probe case is refused", () => {
  it("chat, submitText, rename and sendName do nothing to a probe session (0 writes)", async () => {
    let writes = 0;
    const probe = { id: "p1", name: "probe", exited: false, versionProbe: true, term: { write: () => (writes += 1) } };
    const sessions = {
      onChange: () => undefined,
      onRemoved: () => undefined,
      list: () => [probe],
      get: (id: string) => (id === "p1" ? probe : undefined),
      write: () => (writes += 1),
      isClosing: () => false,
    } as unknown as SessionManager;
    const hub = new Hub({ notify: { macos: false }, caseSayClaudeVersions: [] } as unknown as Config, sessions, null, {});
    expect(() => hub.enqueueChat("p1", "hello")).toThrow(/version probe/);
    expect(await hub.submitText("p1", "hello")).toBe(false);
    await expect(hub.requestRename("p1", "x")).rejects.toThrow(/version probe/);
    expect(hub.sendName("p1", "x")).toBe(false);
    expect(await hub.probeSend("not-a-probe", "x")).toBe(false);
    expect(writes).toBe(0);
    hub.stop();
  });
});

