import { describe, expect, it } from "vitest";
import type { ActivityStore } from "../../server/activity.ts";
import { realProbePorts } from "../../server/case-say-probe-wiring.ts";
import type { ProbeToolRecord } from "../../server/case-say-probe.ts";
import type { Config } from "../../server/config.ts";
import type { Hub } from "../../server/hub.ts";
import type { SessionManager } from "../../server/sessions.ts";

const CSID = "11111111-2222-4333-8444-555555555555";
const FILE = "/R/probe/probe-2.txt";
const c = { id: "probe-1", R: "/R/probe" };

const post = (over: Partial<ProbeToolRecord>): ProbeToolRecord => ({ ts: 100, phase: "post", agent_id: "", tool: "Write", tool_use_id: "u", permission_mode: "dontAsk", path: FILE, ...over });

/** lifecycle: agent_id → 開始・終了の数 */
function ports(lifecycle: Record<string, { starts: number; stops: number }>) {
  const sessions = { get: () => ({ claudeSessionId: CSID }) } as unknown as SessionManager;
  const activity = {
    refresh: async () => undefined,
    agentLifecycle: (sid: string, agentId: string) => (sid === CSID ? (lifecycle[agentId] ?? { starts: 0, stops: 0 }) : { starts: 0, stops: 0 }),
  } as unknown as ActivityStore;
  return realProbePorts({ config: {} as Config, sessions, hub: {} as Hub, activity, audit: async () => undefined }, () => undefined);
}
const judge = (e: { agentWrite: boolean; subagentStarts: number; subagentStops: number }): boolean => e.agentWrite && e.subagentStarts >= 1 && e.subagentStops >= 1;

describe("F2: agentEvidence through the real wiring (P2 evidence)", () => {
  it("(a) a subagent wrote probe-2.txt and the same agent_id has a start and a stop → ok", async () => {
    const e = await ports({ a1: { starts: 1, stops: 1 } }).agentEvidence(c, FILE, [post({ agent_id: "a1" })], 50);
    expect(judge(e)).toBe(true);
  });
  it("(b) only the main conversation (empty agent_id) wrote → not ok", async () => {
    const e = await ports({ a1: { starts: 1, stops: 1 } }).agentEvidence(c, FILE, [post({ agent_id: "" })], 50);
    expect(judge(e)).toBe(false);
  });
  it("(c) the writer's agent_id has no start/stop; only another agent_id does → not ok", async () => {
    const e = await ports({ a2: { starts: 1, stops: 1 } }).agentEvidence(c, FILE, [post({ agent_id: "a1" })], 50);
    expect(judge(e)).toBe(false);
  });
  it("a different path, a pre row, a non-Write tool, or a row before sentence 2 does not count", async () => {
    const p = ports({ a1: { starts: 1, stops: 1 } });
    for (const r of [post({ agent_id: "a1", path: "/R/probe/probe-2.txt.bak" }), post({ agent_id: "a1", phase: "pre" }), post({ agent_id: "a1", tool: "Edit" }), post({ agent_id: "a1", ts: 10 })]) {
      expect(judge(await p.agentEvidence(c, FILE, [r], 50))).toBe(false);
    }
  });
});
