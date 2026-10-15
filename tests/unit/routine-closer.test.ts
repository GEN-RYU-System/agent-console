import { describe, expect, it } from "vitest";
import type { SessionState } from "../../server/agents.ts";
import { CLOSE_IDLE_MS, KEEP_WAITING_MS, RoutineCloser, SUMMARY_CHARS, gapLimitMsFor } from "../../server/routine-closer.ts";
import type { RoutineAuditEntry } from "../../server/routine-audit.ts";

const MIN = 60_000;
const SID = "app-1";
const CID = "cccccccc-1111-4111-8111-111111111111";

interface Rig { closer: RoutineCloser; closed: string[]; records: Record<string, unknown>[]; audits: Omit<RoutineAuditEntry, "at">[]; set: (o: { reply?: string | null; running?: number; exited?: boolean }) => void; sample: (state: SessionState | null, at: number) => Promise<void> }
function rig(gapLimitMs = Number.POSITIVE_INFINITY): Rig {
  let reply: string | null = "完了しました";
  let running = 0;
  let exited = false;
  const closed: string[] = [];
  const records: Record<string, unknown>[] = [];
  const audits: Omit<RoutineAuditEntry, "at">[] = [];
  const closer = new RoutineCloser({
    session: () => ({ claudeSessionId: CID, exited }),
    lastReply: () => reply,
    runningCount: () => running,
    close: async (id) => { closed.push(id); },
    record: async (routineId, event) => { records.push({ routineId, ...event }); },
    audit: async (entry) => { audits.push(entry); },
  }, CLOSE_IDLE_MS, KEEP_WAITING_MS, gapLimitMs);
  closer.track({ routineId: "R1", createdBy: "agent", slot: "2026-10-14T09:00+09:00", sessionId: SID, sessionName: "朝 10-14 09:00", sentAt: 0 });
  return {
    closer, closed, records, audits,
    set: (o) => { if ("reply" in o) reply = o.reply ?? null; if (o.running !== undefined) running = o.running; if (o.exited !== undefined) exited = o.exited; },
    sample: (state, at) => closer.sample(state === null ? null : new Map([[SID, state]]), at),
  };
}

describe("S6 idle が連続して累計 10 分で閉じる", () => {
  it("10 分に届くまでは閉じず、届いたら 1 回閉じて closed を履歴と監査に残す（返答の先頭 500 字・token や指示文は入らない）", async () => {
    const r = rig();
    r.set({ reply: "あ".repeat(800) });
    for (let t = 0; t < CLOSE_IDLE_MS; t += MIN) await r.sample("idle", t);
    expect(r.closed).toEqual([]);
    await r.sample("idle", CLOSE_IDLE_MS);
    expect(r.closed).toEqual([SID]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ routineId: "R1", outcome: "closed", sessionId: SID });
    expect(Array.from(String(r.records[0].summary))).toHaveLength(SUMMARY_CHARS);
    expect(r.audits).toEqual([{ action: "closed", outcome: "ok", routineId: "R1", targetCreatedBy: "agent", callerSessionId: null, closeReason: "idle" }]);
    // もう見張りから外れている
    await r.sample("idle", CLOSE_IDLE_MS + 20 * MIN);
    expect(r.closed).toHaveLength(1);
    expect(r.closer.size()).toBe(0);
  });

  it("途中で busy / waiting / unknown / 取得失敗 / 担当が動いている標本が 1 回でも入ると 0 からやり直す", async () => {
    for (const reset of ["working", "waiting", "unknown", null, "running"] as const) {
      const r = rig();
      await r.sample("idle", 0);
      await r.sample("idle", 9 * MIN);
      if (reset === "running") { r.set({ running: 1 }); await r.sample("idle", 9 * MIN + 30_000); r.set({ running: 0 }); } else await r.sample(reset, 9 * MIN + 30_000);
      await r.sample("idle", 10 * MIN);
      await r.sample("idle", 19 * MIN);
      expect(r.closed, String(reset)).toEqual([]);
      await r.sample("idle", 10 * MIN + 10 * MIN + 1);
      expect(r.closed, String(reset)).toEqual([SID]);
    }
  });

  it("セッションが先に終わっていたら何もせず見張りから外す", async () => {
    const r = rig();
    r.set({ exited: true });
    await r.sample("idle", 0);
    await r.sample("idle", 20 * MIN);
    expect(r.closed).toEqual([]);
    expect(r.records).toEqual([]);
    expect(r.closer.size()).toBe(0);
  });
});

describe("S8 waiting のまま 60 分は kept を 1 回だけ残す", () => {
  it("60 分で kept(waiting) を 1 回だけ。閉じない。その後 idle が 10 分続いても閉じない（kept 後は見ない）", async () => {
    const r = rig();
    for (let t = 0; t <= KEEP_WAITING_MS + 30 * MIN; t += 5 * MIN) await r.sample("waiting", t);
    expect(r.closed).toEqual([]);
    expect(r.audits).toEqual([{ action: "kept", outcome: "ok", routineId: "R1", targetCreatedBy: "agent", callerSessionId: null, closeReason: "waiting" }]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ outcome: "kept" });
    const base = KEEP_WAITING_MS + 40 * MIN;
    await r.sample("idle", base);
    await r.sample("idle", base + CLOSE_IDLE_MS);
    expect(r.closed).toEqual([]);
    expect(r.audits).toHaveLength(1);
    expect(r.records).toHaveLength(1);
  });

  it("60 分に届く前に waiting が途切れたら数え直す", async () => {
    const r = rig();
    await r.sample("waiting", 0);
    await r.sample("waiting", 50 * MIN);
    await r.sample("working", 55 * MIN);
    await r.sample("waiting", 60 * MIN);
    await r.sample("waiting", 100 * MIN);
    expect(r.audits).toEqual([]);
    await r.sample("waiting", 121 * MIN);
    expect(r.audits).toHaveLength(1);
  });
});

describe("S7 返答の中身で閉じるか残すかを決める", () => {
  it.each([["NEEDS_DECISION: 方針を決めてください"], ["途中 BLOCKED: 権限がありません"]])("%s を含むと閉じずに kept(decision)", async (reply) => {
    const r = rig();
    r.set({ reply });
    await r.sample("idle", 0);
    await r.sample("idle", CLOSE_IDLE_MS);
    expect(r.closed).toEqual([]);
    expect(r.audits).toEqual([{ action: "kept", outcome: "ok", routineId: "R1", targetCreatedBy: "agent", callerSessionId: null, closeReason: "decision" }]);
    expect(r.closer.size()).toBe(0);
  });

  it("返答（Stop）が 1 件も無ければ閉じずに kept(no-reply)", async () => {
    const r = rig();
    r.set({ reply: null });
    await r.sample("idle", 0);
    await r.sample("idle", CLOSE_IDLE_MS);
    expect(r.closed).toEqual([]);
    expect(r.audits[0]).toMatchObject({ action: "kept", closeReason: "no-reply" });
  });

  it("画面で作った定期実行（createdBy なし）の監査は targetCreatedBy が ui", async () => {
    const r = rig();
    r.closer.track({ routineId: "R2", slot: "s", sessionId: "app-2", sentAt: 0 });
    await r.closer.sample(new Map<string, SessionState>([["app-2", "idle"]]), 0);
    await r.closer.sample(new Map<string, SessionState>([["app-2", "idle"]]), CLOSE_IDLE_MS);
    expect(r.audits.find((a) => a.routineId === "R2")).toMatchObject({ action: "closed", targetCreatedBy: "ui" });
  });
});

describe("B 標本の間が gapLimitMs を超えたら（Mac のスリープなど）0 から数え直す", () => {
  const HOUR = 60 * MIN;
  it("B1 idle が 9 分たまった後、次の標本が 2 時間後なら閉じない。そこから idle が 10 分続けば閉じる", async () => {
    const r = rig(60_000);
    for (let t = 0; t <= 9 * MIN; t += MIN) await r.sample("idle", t);
    const wake = 9 * MIN + 2 * HOUR;
    await r.sample("idle", wake);
    expect(r.closed).toEqual([]);
    // 跳んだ標本は unknown 扱い。次の idle の標本から数え直す
    for (let t = wake + MIN; t < wake + MIN + CLOSE_IDLE_MS; t += MIN) await r.sample("idle", t);
    expect(r.closed).toEqual([]);
    await r.sample("idle", wake + MIN + CLOSE_IDLE_MS);
    expect(r.closed).toEqual([SID]);
  });

  it("B2 waiting が 59 分の後、次の標本が 2 時間後なら kept を記録しない。そこから waiting が 60 分で kept", async () => {
    const r = rig(60_000);
    for (let t = 0; t <= 59 * MIN; t += MIN) await r.sample("waiting", t);
    const wake = 59 * MIN + 2 * HOUR;
    await r.sample("waiting", wake);
    expect(r.records).toEqual([]);
    for (let t = wake + MIN; t < wake + MIN + KEEP_WAITING_MS; t += MIN) await r.sample("waiting", t);
    expect(r.records).toEqual([]);
    await r.sample("waiting", wake + MIN + KEEP_WAITING_MS);
    expect(r.audits).toEqual([{ action: "kept", outcome: "ok", routineId: "R1", targetCreatedBy: "agent", callerSessionId: null, closeReason: "waiting" }]);
  });

  it("B3 間隔がちょうど gapLimitMs なら今どおり足す。gapLimitMs+1 なら数え直す", async () => {
    const exact = rig(CLOSE_IDLE_MS);
    await exact.sample("idle", 0);
    await exact.sample("idle", CLOSE_IDLE_MS);
    expect(exact.closed).toEqual([SID]);
    const over = rig(CLOSE_IDLE_MS);
    await over.sample("idle", 0);
    await over.sample("idle", CLOSE_IDLE_MS + 1);
    expect(over.closed).toEqual([]);
  });

  it("B4 gapLimitMsFor は agentsPollMs の 5 倍。ただし下限は 60 秒", () => {
    expect(gapLimitMsFor(3000)).toBe(60_000);
    expect(gapLimitMsFor(20_000)).toBe(100_000);
  });
});
