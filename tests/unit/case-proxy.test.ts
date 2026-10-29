import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CASE_ROOM_MACOS_FILE,
  caseRoomMacosAccepted,
  normalizeConnectTarget,
  readLstart,
  singleOtherPid,
  startCaseProxy,
  type CaseProxy,
  type LookupPid,
  type MainProcess,
} from "../../server/case-proxy.ts";
import { caseProxyDomains } from "../../server/case-sandbox.ts";
import type { RoutineAuditEntry } from "../../server/routine-audit.ts";

vi.setConfig({ testTimeout: 30000 });

const CASE_ID = "11111111-2222-4333-8444-555555555555";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** 受け取った物をそのまま返す相手（TLS の代わり） */
async function echoServer(): Promise<number> {
  const open = new Set<net.Socket>();
  const s = net.createServer((c) => {
    open.add(c);
    c.on("close", () => open.delete(c));
    c.on("data", (d) => c.write(`echo:${d.toString()}`));
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const c of open) c.destroy();
    s.close(() => resolve());
  }));
  return (s.address() as net.AddressInfo).port;
}

interface Rig {
  proxy: CaseProxy;
  port: number;
  audit: RoutineAuditEntry[];
  dialed: Array<{ host: string; port: number }>;
}

async function start(over: { mainOf?: () => ReadonlyMap<string, MainProcess>; lookupPid?: LookupPid; env?: Record<string, string>; port?: number } = {}): Promise<Rig> {
  const port = over.port ?? (await freePort());
  const upstream = await echoServer();
  const audit: RoutineAuditEntry[] = [];
  const dialed: Array<{ host: string; port: number }> = [];
  const proxy = startCaseProxy({
    port,
    domains: caseProxyDomains(),
    mainOf: over.mainOf ?? (() => new Map()),
    audit: (e) => void audit.push(e),
    ...(over.lookupPid !== undefined ? { lookupPid: over.lookupPid } : {}),
    env: over.env ?? {},
    dial: (host, p) => {
      dialed.push({ host, port: p });
      return net.connect(upstream, "127.0.0.1");
    },
  });
  cleanups.push(() => proxy.close());
  await proxy.ready;
  return { proxy, port, audit, dialed };
}

/** 生のソケットで要求を送り、最初の応答の行（と、つながったあとの socket）を返す */
function request(port: number, head: string): Promise<{ status: string; socket: net.Socket; rest: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buf = "";
    socket.on("error", reject);
    socket.on("data", function onData(d) {
      buf += d.toString();
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      resolve({ status: buf.slice(0, buf.indexOf("\r\n")), socket, rest: buf.slice(end + 4) });
    });
    socket.write(head);
    cleanups.push(() => void socket.destroy());
  });
}
const connect = (port: number, target: string): Promise<{ status: string; socket: net.Socket; rest: string }> => request(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

function child(): ChildProcess {
  const c = spawn("sleep", ["60"], { stdio: "ignore" });
  cleanups.push(() => void c.kill("SIGKILL"));
  return c;
}

describe("normalizeConnectTarget", () => {
  const domains = new Set(caseProxyDomains());
  it("lowercases, drops one trailing dot, and refuses IPs, non-ASCII names, empty hosts, ports other than 443 and names off the list", () => {
    expect(normalizeConnectTarget("GitHub.COM.:443", domains)).toEqual({ ok: true, host: "github.com" });
    expect(normalizeConnectTarget("api.anthropic.com:443", domains)).toEqual({ ok: true, host: "api.anthropic.com" });
    for (const bad of ["1.2.3.4:443", "[::1]:443", "[2001:db8::1]:443", "::1:443", "例え.jp:443", "xn--r8jz45g.jp:443", ":443", "", "github.com", "github.com:80", "github.com:8443", "github.com:0443", "evil.com:443", "github.com.evil.com:443", "github.com..:443", "api.github.com.evil:443", "localhost:443", "127.0.0.1:443"]) {
      expect(normalizeConnectTarget(bad, domains).ok, bad).toBe(false);
    }
  });
});

describe("singleOtherPid", () => {
  it("drops the server's own pid and needs exactly one left", () => {
    expect(singleOtherPid([process.pid, 4242])).toBe(4242);
    expect(singleOtherPid([4242, 4242, process.pid])).toBe(4242);
    expect(singleOtherPid([process.pid])).toBeNull();
    expect(singleOtherPid([])).toBeNull();
    expect(singleOtherPid([4242, 4343, process.pid])).toBeNull();
  });
});

describe("startCaseProxy", () => {
  it("answers 405 to anything but CONNECT", async () => {
    const { port, audit } = await start();
    const r = await request(port, "GET http://github.com/ HTTP/1.1\r\nHost: github.com\r\n\r\n");
    expect(r.status).toBe("HTTP/1.1 405 Method Not Allowed");
    const p = await request(port, "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");
    expect(p.status).toBe("HTTP/1.1 405 Method Not Allowed");
    expect(audit).toHaveLength(0);
  });

  it("answers 403 to IPs, IDN, empty hosts, ports other than 443 and names off the list, and records one denied line each", async () => {
    const { port, audit, dialed } = await start();
    const bad = ["1.2.3.4:443", "[::1]:443", "例え.jp:443", ":443", "github.com:80", "evil.com:443", "mcp-proxy.anthropic.com:443", "downloads.claude.ai:443"];
    for (const target of bad) {
      const r = await connect(port, target);
      expect(r.status, target).toBe("HTTP/1.1 403 Forbidden");
    }
    expect(dialed).toEqual([]);
    expect(audit).toHaveLength(bad.length);
    for (const e of audit) expect(e).toMatchObject({ action: "caseProxy", outcome: "denied", callerSessionId: null, main: false });
  });

  it("passes an allowed name (trailing dot and capitals fixed), tunnels both ways without opening TLS, and records one ok line", async () => {
    const { port, audit, dialed } = await start();
    for (const target of ["github.com:443", "GITHUB.com.:443", "api.github.com:443", "api.salesanchor.jp:443"]) {
      const r = await connect(port, target);
      expect(r.status, target).toBe("HTTP/1.1 200 Connection established");
      const reply = new Promise<string>((resolve) => r.socket.once("data", (d) => resolve(d.toString())));
      r.socket.write("hello");
      expect(await reply).toBe("echo:hello");
      r.socket.destroy();
    }
    expect(dialed.map((d) => d.host)).toEqual(["github.com", "github.com", "api.github.com", "api.salesanchor.jp"]);
    expect(dialed.every((d) => d.port === 443)).toBe(true);
    expect(audit.map((e) => [e.outcome, e.host, e.main])).toEqual([["ok", "github.com", false], ["ok", "github.com", false], ["ok", "api.github.com", false], ["ok", "api.salesanchor.jp", false]]);
    expect(audit.every((e) => e.action === "caseProxy" && e.callerSessionId === null && e.caseSessionId === undefined)).toBe(true);
  });

  describe("api.anthropic.com is for the case main process only", () => {
    const via = async (rig: Rig): Promise<string> => (await connect(rig.port, "api.anthropic.com:443")).status;

    it("passes when lsof gives exactly one pid besides the server's and it matches a main record (pid and start time)", async () => {
      const c = child();
      const lstart = (await readLstart(c.pid as number)) as string;
      const seenPorts: number[] = [];
      const rig = await start({
        mainOf: () => new Map([[CASE_ID, { pid: c.pid as number, lstart }]]),
        lookupPid: async (p) => (seenPorts.push(p), [process.pid, c.pid as number]),
      });
      const r = await connect(rig.port, "api.anthropic.com:443");
      expect(r.status).toBe("HTTP/1.1 200 Connection established");
      // lookupPid には、受けた接続の送り元の番号が渡る
      expect(seenPorts).toEqual([r.socket.localPort]);
      expect(rig.audit).toHaveLength(1);
      expect(rig.audit[0]).toMatchObject({ action: "caseProxy", outcome: "ok", callerSessionId: null, caseSessionId: CASE_ID, host: "api.anthropic.com", main: true });
    });

    it("refuses with 0 pids, 2 pids, a different pid, a different start time, or no main record, and records a denied line (no case id)", async () => {
      const a = child();
      const b = child();
      const lstart = (await readLstart(a.pid as number)) as string;
      const record = (pid: number, ls: string): (() => ReadonlyMap<string, MainProcess>) => () => new Map([[CASE_ID, { pid, lstart: ls }]]);
      const cases: Array<[string, Partial<Parameters<typeof start>[0]>]> = [
        ["no pid", { mainOf: record(a.pid as number, lstart), lookupPid: async () => [process.pid] }],
        ["lsof finds nothing", { mainOf: record(a.pid as number, lstart), lookupPid: async () => [] }],
        ["two pids", { mainOf: record(a.pid as number, lstart), lookupPid: async () => [process.pid, a.pid as number, b.pid as number] }],
        ["a different pid", { mainOf: record(a.pid as number, lstart), lookupPid: async () => [process.pid, b.pid as number] }],
        ["a different start time", { mainOf: record(a.pid as number, `${lstart} x`), lookupPid: async () => [process.pid, a.pid as number] }],
        ["no main record", { mainOf: () => new Map(), lookupPid: async () => [process.pid, a.pid as number] }],
      ];
      for (const [name, over] of cases) {
        const rig = await start(over);
        expect(await via(rig), name).toBe("HTTP/1.1 403 Forbidden");
        expect(rig.audit, name).toHaveLength(1);
        expect(rig.audit[0], name).toMatchObject({ action: "caseProxy", outcome: "denied", host: "api.anthropic.com", main: false });
        expect(rig.audit[0].caseSessionId, name).toBeUndefined();
        expect(rig.dialed, name).toEqual([]);
      }
    });

    it("does not walk up to a parent: a child of the main process is refused", async () => {
      const a = child();
      const lstart = (await readLstart(a.pid as number)) as string;
      const grandchild = child();
      const rig = await start({ mainOf: () => new Map([[CASE_ID, { pid: a.pid as number, lstart }]]), lookupPid: async () => [process.pid, grandchild.pid as number] });
      expect(await via(rig)).toBe("HTTP/1.1 403 Forbidden");
    });
  });

  it("does not start when AGENT_CONSOLE_PORT is set (the second server of a self-check): isListening is false and nothing listens", async () => {
    const port = await freePort();
    const rig = await start({ port, env: { AGENT_CONSOLE_PORT: "4400" } });
    expect(rig.proxy.isListening()).toBe(false);
    await expect(connect(port, "github.com:443")).rejects.toThrow();
    // 空の値は未設定として扱う
    const rig2 = await start({ env: { AGENT_CONSOLE_PORT: "" } });
    expect(rig2.proxy.isListening()).toBe(true);
  });

  it("when the port is in use, the server goes on: ready resolves, isListening stays false, one line goes to stderr, and the case would get 503 at check ⑨", async () => {
    const busy = net.createServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => busy.close(() => resolve())));
    const port = (busy.address() as net.AddressInfo).port;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rig = await start({ port });
    expect(rig.proxy.isListening()).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain(String(port));
  });

  it("stops listening on close(), and a failing audit write does not stop the proxy", async () => {
    const port = await freePort();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const upstream = await echoServer();
    const proxy = startCaseProxy({ port, domains: caseProxyDomains(), mainOf: () => new Map(), audit: () => Promise.reject(new Error("disk full")), env: {}, dial: () => net.connect(upstream, "127.0.0.1") });
    await proxy.ready;
    expect(proxy.isListening()).toBe(true);
    const r = await connect(port, "github.com:443");
    expect(r.status).toBe("HTTP/1.1 200 Connection established");
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    await proxy.close();
    expect(proxy.isListening()).toBe(false);
    await expect(connect(port, "github.com:443")).rejects.toThrow();
  });
});

describe("caseRoomMacosAccepted (check ⑪)", () => {
  it("is true only when the record's productVersion equals the version read at start", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ac-macos-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(caseRoomMacosAccepted(dir, "15.1.1")).toBe(false);
    writeFileSync(path.join(dir, CASE_ROOM_MACOS_FILE), JSON.stringify({ productVersion: "15.1.1", acceptedAt: "2026-10-29T00:00:00Z" }));
    expect(caseRoomMacosAccepted(dir, "15.1.1")).toBe(true);
    expect(caseRoomMacosAccepted(dir, "15.2")).toBe(false);
    expect(caseRoomMacosAccepted(dir, null)).toBe(false);
    writeFileSync(path.join(dir, CASE_ROOM_MACOS_FILE), "{ broken");
    expect(caseRoomMacosAccepted(dir, "15.1.1")).toBe(false);
    writeFileSync(path.join(dir, CASE_ROOM_MACOS_FILE), JSON.stringify(["15.1.1"]));
    expect(caseRoomMacosAccepted(dir, "15.1.1")).toBe(false);
    expect(caseRoomMacosAccepted(path.join(dir, "nope"), "15.1.1")).toBe(false);
    mkdirSync(path.join(dir, "d"));
  });
});
