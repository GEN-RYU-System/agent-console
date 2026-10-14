import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalHandle } from "../../server/terminal-host/types.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";

/** R1: pid が 0 の端末（unreachable でつなぎ直し中のもの）を閉じても、他のプロセスへ SIGKILL を送らない */
function fakeTerm(killCalls: { n: number }): TerminalHandle {
  return {
    pid: 0,
    onData: () => undefined,
    onExit: () => undefined,
    write: () => undefined,
    resize: () => undefined,
    kill: () => {
      killCalls.n += 1;
    },
    release: () => undefined,
  } as unknown as TerminalHandle;
}

describe("closing a session whose terminal pid is 0 (R1)", () => {
  const hosts: Harness[] = [];
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    for (const h of hosts) await h.close().catch(() => undefined);
  });

  it("never sends SIGKILL to any process and reports 'did not stop' when the session stays unreachable", async () => {
    const h = await startHarness({ closeGraceMs: 100 });
    hosts.push(h);
    const created = await h.sessions.create({ name: "pid0", roleId: "echo" });
    const session = h.sessions.get(created.id)!;
    const realTerm = session.term;
    const calls = { n: 0 };
    session.term = fakeTerm(calls);
    const real = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === "SIGKILL") return true;
      return real(pid, sig as NodeJS.Signals);
    }) as typeof process.kill);
    await expect(h.sessions.close(created.id)).rejects.toThrow(/did not stop/);
    expect(calls.n).toBe(1);
    expect(spy.mock.calls.filter((c) => c[1] === "SIGKILL")).toEqual([]);
    spy.mockRestore();
    session.term = realTerm;
    session.term.kill();
  });
});
