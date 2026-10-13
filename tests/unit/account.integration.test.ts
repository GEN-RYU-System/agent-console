import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OPEN_SESSIONS_FILE } from "../../server/session-store.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

type Json = Record<string, unknown>;
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const REAL_JSON = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "who@example.com", orgId: "o-1", orgName: "O", subscriptionType: "pro" });

async function call(h: Harness, method: string, p: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${h.base}${p}`, { method, headers });
  return { status: res.status, json: (await res.json()) as Json };
}

describe("GET /api/account（K3）と POST /api/account/login（K6・K8）", () => {
  let h: Harness;
  let before: string[];
  beforeAll(async () => {
    h = await startHarness({ recorder: true, maxSessions: 2, accountLoginCommand: ["/bin/sh", "-c", "echo LOGIN_STARTED; cat"] });
    const bin = path.join(h.dir, "claude-fake.sh");
    writeFileSync(bin, `#!/bin/sh\necho '${REAL_JSON}'\n`);
    chmodSync(bin, 0o755);
    h.config.claudeBin = bin;
    before = existsSync(h.config.dataDir) ? readdirSync(h.config.dataDir) : [];
  });
  afterAll(async () => {
    await h.close();
  });

  it("認証が要る", async () => {
    expect((await fetch(`${h.base}/api/account`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/account/login`, { method: "POST" })).status).toBe(401);
  });

  it("K3: 応答のキーは status・loggedIn・email・subscriptionType だけ（orgId・orgName・authMethod は無い）", async () => {
    const { status, json } = await call(h, "GET", "/api/account");
    expect(status).toBe(200);
    expect(json).toEqual({ status: "ok", loggedIn: true, email: "who@example.com", subscriptionType: "pro" });
  });

  it("/api/state が accountSwitchEnabled:true を返す", async () => {
    const state = (await call(h, "GET", "/api/state")).json;
    expect(state.accountSwitchEnabled).toBe(true);
  });

  it("K6: login を押すと config 固定の命令で account-login の端末が 1 つ増え、動いている間はもう 1 つ作れない（409）", async () => {
    const first = await call(h, "POST", "/api/account/login");
    expect(first.status).toBe(201);
    const session = h.sessions.get(first.json.id as string);
    expect(session?.roleId).toBe("account-login");
    await vi.waitFor(() => expect(session?.ring.snapshot().includes("LOGIN_STARTED")).toBe(true));
    expect((await call(h, "POST", "/api/account/login")).status).toBe(409);
  });

  it("K8: account-login の端末は open-sessions.json に入らない", async () => {
    const echo = await fetch(`${h.base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ name: "ふつうの会話", roleId: "echo" }) });
    expect(echo.status).toBe(201);
    await h.recorder.sync();
    const file = path.join(h.config.dataDir, OPEN_SESSIONS_FILE);
    const items = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { items: Array<{ roleId: string }> }).items : [];
    expect(items.map((i) => i.roleId)).toEqual(["echo"]);
    expect(h.sessions.list().some((s) => s.roleId === "account-login" && !s.exited)).toBe(true);
  });

  it("K4: アカウント情報のファイルが dataDir に増えない", async () => {
    await call(h, "GET", "/api/account");
    const after = existsSync(h.config.dataDir) ? readdirSync(h.config.dataDir) : [];
    expect(after.filter((f) => !before.includes(f) && f !== OPEN_SESSIONS_FILE)).toEqual([]);
  });

  it("閉じた account-login の後は、また作れる。上限に達していれば 400", async () => {
    const running = h.sessions.list().find((s) => s.roleId === "account-login") as NonNullable<ReturnType<Harness["sessions"]["get"]>>;
    await h.sessions.close(running.id);
    expect((await call(h, "POST", "/api/account/login")).status).toBe(201);
    const running2 = h.sessions.list().find((s) => s.roleId === "account-login") as NonNullable<ReturnType<Harness["sessions"]["get"]>>;
    await h.sessions.close(running2.id);
    // 2 本目の echo の会話で上限（maxSessions 2）に達する
    const other = await fetch(`${h.base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ name: "もう一つ", roleId: "echo" }) });
    expect(other.status).toBe(201);
    expect((await call(h, "POST", "/api/account/login")).status).toBe(400);
  });
});

describe("accountLoginCommand が無いとき", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  it("POST /api/account/login は 404、/api/state は accountSwitchEnabled:false", async () => {
    expect((await call(h, "POST", "/api/account/login")).status).toBe(404);
    expect((await call(h, "GET", "/api/state")).json.accountSwitchEnabled).toBe(false);
  });
});
