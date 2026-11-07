import { describe, expect, it } from "vitest";
import { OPS_CONTROL_URL, readOpsHalt, type OpsFetchFn } from "../../server/ops-control.ts";

const KEY = "FAKE-KEY-MARKER-0123456789";
function fake(reply: { status?: number; body?: unknown; raw?: string; throws?: Error; hang?: boolean }): { fetch: OpsFetchFn; calls: { url: string; method: string; headers: Record<string, string> }[] } {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const f: OpsFetchFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    if (reply.throws) throw reply.throws;
    if (reply.hang) await new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("t", "TimeoutError"))));
    return { status: reply.status ?? 200, text: async () => reply.raw ?? JSON.stringify(reply.body) };
  };
  return { fetch: f, calls };
}

describe("readOpsHalt", () => {
  it("200 / halt_all false is running; true is halted", async () => {
    expect(await readOpsHalt(KEY, fake({ body: { halt_all: false, other: 1 } }).fetch)).toBe("running");
    expect(await readOpsHalt(KEY, fake({ body: { halt_all: true } }).fetch)).toBe("halted");
  });
  it("401, 500, a wrong shape, non-JSON, a thrown error and a timeout are unreadable", async () => {
    expect(await readOpsHalt(KEY, fake({ status: 401, body: {} }).fetch)).toBe("unreadable");
    expect(await readOpsHalt(KEY, fake({ status: 500, body: { halt_all: false } }).fetch)).toBe("unreadable");
    for (const body of [{ halt_all: "false" }, { halt_all: null }, {}, [], "x", null]) expect(await readOpsHalt(KEY, fake({ body }).fetch)).toBe("unreadable");
    expect(await readOpsHalt(KEY, fake({ raw: "not json" }).fetch)).toBe("unreadable");
    expect(await readOpsHalt(KEY, fake({ throws: new Error(`boom ${KEY}`) }).fetch)).toBe("unreadable");
    expect(await readOpsHalt(KEY, fake({ hang: true }).fetch, 20)).toBe("unreadable");
  });
  it("a null key does not call and is unreadable", async () => {
    const f = fake({ body: { halt_all: false } });
    expect(await readOpsHalt(null, f.fetch)).toBe("unreadable");
    expect(f.calls).toHaveLength(0);
  });
  it("GET to the control path with a Bearer header", async () => {
    const f = fake({ body: { halt_all: false } });
    await readOpsHalt(KEY, f.fetch);
    expect(f.calls[0]).toEqual({ url: OPS_CONTROL_URL, method: "GET", headers: { Authorization: `Bearer ${KEY}` } });
    expect(new URL(OPS_CONTROL_URL).pathname).toBe("/api/v1/ops/control");
  });
});
