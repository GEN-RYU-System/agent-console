import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCommand } from "../../hooks/ac-reserve.mjs";
import { RESERVE_TOKEN, startHarness, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000 });

let h: Harness;
let dataDir: string;
const writeToken = (dir: string, value: unknown): void => writeFileSync(path.join(dir, "reserve-token"), typeof value === "string" ? value : JSON.stringify(value));
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), "ac-reserve-cmd-"));
const date = new Date(Date.now() + 3 * 24 * 60 * 60_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const entry = (over: Record<string, unknown> = {}): string => JSON.stringify({ name: "m", roleId: "echo", cwd: h.config.salesanchorRoot, date, time: "10:00", promptText: "hi", purpose: "measure", measureNote: "効果を測る", ...over });

beforeAll(async () => {
  h = await startHarness();
  dataDir = tmp();
  writeToken(dataDir, { port: h.port, token: RESERVE_TOKEN });
});
afterAll(async () => { await h.close(); });

describe("ac-reserve command", () => {
  it("R12 add, list and cancel go through the server and never print the token", async () => {
    const added = await runCommand({ argv: ["add"], stdinText: entry(), dataDir });
    expect(added.code).toBe(0);
    const id = (JSON.parse(added.stdout) as { id: string }).id;
    expect(h.reservations.list().some((r) => r.id === id && r.createdBy === "agent")).toBe(true);
    const listed = await runCommand({ argv: ["list"], dataDir });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(id);
    const cancelled = await runCommand({ argv: ["cancel", id], dataDir });
    expect(cancelled.code).toBe(0);
    expect(h.reservations.list().find((r) => r.id === id)?.status).toBe("cancelled");
    for (const r of [added, listed, cancelled]) { expect(r.stdout).not.toContain(RESERVE_TOKEN); expect(r.stderr).not.toContain(RESERVE_TOKEN); }
  });

  it("R12 failures exit with code 1 and a reason on stderr", async () => {
    const noPurpose = await runCommand({ argv: ["add"], stdinText: entry({ purpose: "other" }), dataDir });
    expect(noPurpose).toMatchObject({ code: 1, stdout: "" });
    expect(noPurpose.stderr).toContain("400");
    expect((await runCommand({ argv: ["add"], stdinText: "not json", dataDir })).code).toBe(1);
    expect((await runCommand({ argv: ["cancel", "missing-id"], dataDir })).code).toBe(1);
    expect((await runCommand({ argv: ["bogus"], dataDir })).code).toBe(1);
    expect((await runCommand({ argv: ["add"], stdinText: "x".repeat(70 * 1024), dataDir })).code).toBe(1);
    const wrong = tmp(); writeToken(wrong, { port: h.port, token: "0".repeat(64) });
    const denied = await runCommand({ argv: ["list"], dataDir: wrong });
    expect(denied.code).toBe(1);
    expect(denied.stderr).not.toContain("0".repeat(64));
  });

  it("R12 exits 1 when reserve-token is missing or broken", async () => {
    const missing = await runCommand({ argv: ["list"], dataDir: tmp() });
    expect(missing.code).toBe(1);
    for (const bad of ["not json", { port: h.port }, { port: "x", token: RESERVE_TOKEN }, { port: h.port, token: "short" }]) {
      const d = tmp(); writeToken(d, bad);
      expect((await runCommand({ argv: ["list"], dataDir: d })).code).toBe(1);
    }
  });

  it("R12 sends only to the port written in reserve-token", async () => {
    const hits: string[] = [];
    const other = http.createServer((req, res) => { hits.push(req.url ?? ""); res.statusCode = 200; res.end("{}"); });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherPort = (other.address() as { port: number }).port;
    const d = tmp(); writeToken(d, { port: otherPort, token: RESERVE_TOKEN });
    const before = h.reservations.list().length;
    const r = await runCommand({ argv: ["add"], stdinText: entry(), dataDir: d });
    await new Promise<void>((resolve) => other.close(() => resolve()));
    expect(r.code).toBe(0);
    expect(hits).toEqual(["/api/agent/reservations"]);
    expect(h.reservations.list()).toHaveLength(before);
  });
});
