import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clientProof, serverProof } from "../../server/pair-proof.ts";
import { freePort } from "./helpers/ac-env.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

const LAUNCH = path.join(process.cwd(), "ops", "launcher", "launch.sh");
const TEST_TIMEOUT = 40000;

const servers: Server[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.closeAllConnections?.(), s.close();
  for (const h of harnesses.splice(0)) await h.close();
});

function stub(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

interface Fixture {
  dir: string;
  log: string;
  env: Record<string, string>;
}

/** launcher の外部コマンド（security・curl・open・launchctl）をスタブにする。curl だけは実物を呼び、引数を記録する。 */
function fixture(port: number, options: { secret?: string; securityBody?: string } = {}): Fixture {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-launch-")));
  const log = path.join(dir, "calls.log");
  writeFileSync(log, "");
  const secret = options.secret ?? TOKEN;
  const security = stub(dir, "security", options.securityBody ?? `echo "security $*" >> "${log}"\necho "${secret}"`);
  const curl = stub(dir, "curl", `echo "curl $*" >> "${log}"\nexec /usr/bin/curl "$@"`);
  const open = stub(dir, "open", `echo "open $*" >> "${log}"`);
  const launchctl = stub(dir, "launchctl", `echo "launchctl $*" >> "${log}"\ntouch "${dir}/kicked"`);
  return {
    dir,
    log,
    env: {
      ...(process.env as Record<string, string>),
      AC_STUB_LOG: log,
      AC_SECURITY: security,
      AC_CURL: curl,
      AC_OPEN: open,
      AC_LAUNCHCTL: launchctl,
      AC_PORT: String(port),
      AC_UID: "501",
      AC_HEALTH_WAIT_SEC: "20",
      AC_LAUNCHER_NODE: process.execPath,
    },
  };
}

function run(f: Fixture, onTick?: () => void): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [LAUNCH], { env: f.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setInterval(() => onTick?.(), 50);
    child.on("exit", (status) => {
      clearInterval(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function realServer(): Promise<Harness> {
  const h = await startHarness();
  harnesses.push(h);
  return h;
}

interface Seen {
  method: string;
  url: string;
  body: string;
}

/** 4319 を先に待ち受けた偽サーバー。/healthz には 200 を返し、チャレンジに対する証明は proofSecret で作る。 */
async function impostor(proofSecret: string, port?: number): Promise<{ port: number; seen: Seen[] }> {
  const p = port ?? (await freePort());
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      if (req.url === "/healthz") return void res.end("ok");
      if (req.url === "/api/pair/challenge") {
        const { cnonce } = JSON.parse(body) as { cnonce: string };
        const snonce = "ee".repeat(32);
        return void res.end(JSON.stringify({ snonce, proof: serverProof(proofSecret, cnonce, snonce) }));
      }
      // 偽サーバーが /api/pair まで来てしまったら、後で「来てはいけない」と検出できるよう記録だけして 401
      res.writeHead(401).end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(p, "127.0.0.1", resolve));
  return { port: p, seen };
}

describe("ops/launcher/launch.sh (mutual authentication against the real server)", () => {
  it("verifies the server, gets a one-time code, and opens a Chrome app window; the code really redeems", async () => {
    const h = await realServer();
    const f = fixture(h.port);
    const r = await run(f);
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(f.log, "utf8");
    expect(calls).toContain("security find-generic-password -s agent-console -a server -w");
    const opened = /open -na Google Chrome --args --app=http:\/\/127\.0\.0\.1:\d+\/pair\?code=([0-9a-f]{64})/.exec(calls);
    expect(opened).not.toBeNull();
    // 開いた URL のコードは実際に引換えられる（1 回だけ）
    const origin = h.base;
    const redeem = () =>
      fetch(`${origin}/api/pair/redeem`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ code: opened?.[1] }) });
    expect((await redeem()).status).toBe(200);
    expect((await redeem()).status).toBe(401);
    // 長期秘密はどこにも出ない: curl・open の引数、標準出力・標準エラー
    expect(calls).not.toContain(TOKEN);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    // 送ったのは cnonce / snonce / HMAC（秘密そのものではない）
    expect(calls).toMatch(/curl .*\/api\/pair\/challenge/);
    expect(calls).toMatch(/curl .*\/api\/pair\n/);
    expect(calls).not.toContain("kickstart");
  }, TEST_TIMEOUT);

  it("ABORTS against an impostor that answers /healthz 200 but cannot prove it knows the secret: no secret, no client proof, nothing opened", async () => {
    const imp = await impostor("some-other-secret");
    const f = fixture(imp.port);
    const r = await run(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("偽のサーバー");
    const calls = readFileSync(f.log, "utf8");
    expect(calls).not.toContain("open ");
    // 偽サーバーが受け取ったのは healthz とチャレンジ（cnonce のみ）だけ。/api/pair（クライアント証明）は来ていない
    expect(imp.seen.map((s) => s.url)).toEqual(["/healthz", "/api/pair/challenge"]);
    const everything = JSON.stringify(imp.seen) + calls + r.stdout + r.stderr;
    expect(everything).not.toContain(TOKEN);
    // クライアント証明（秘密から作る HMAC）も、どの snonce・cnonce の組でも漏れていない
    const cnonce = (JSON.parse(imp.seen[1].body) as { cnonce: string }).cnonce;
    expect(everything).not.toContain(clientProof(TOKEN, cnonce, "ee".repeat(32)));
  }, TEST_TIMEOUT);

  it("ABORTS when the keychain secret differs from the server's (wrong server or stale secret)", async () => {
    const h = await realServer();
    const f = fixture(h.port, { secret: "w".repeat(40) });
    const r = await run(f);
    expect(r.status).not.toBe(0);
    expect(readFileSync(f.log, "utf8")).not.toContain("open ");
    expect(r.stderr).toContain("サーバーの証明が一致しません");
  }, TEST_TIMEOUT);

  it("starts the service with launchctl kickstart when the server is down, then waits for /healthz", async () => {
    const port = await freePort();
    const f = fixture(port);
    let h: Harness | null = null;
    let starting = false;
    const r = await run(f, () => {
      if (!starting && existsSync(path.join(f.dir, "kicked"))) {
        starting = true;
        // 同じポートで本物のサーバーを起動する（launchctl kickstart による起動の代わり）
        void startHarness({ port }).then((started) => {
          h = started;
          harnesses.push(started);
        });
      }
    });
    expect(r.status, r.stderr).toBe(0);
    expect(h).not.toBeNull();
    expect(readFileSync(f.log, "utf8")).toContain("launchctl kickstart gui/501/local.agent-console.server");
    expect(readFileSync(f.log, "utf8")).toContain("open -na Google Chrome");
  }, TEST_TIMEOUT);

  it("fails without opening anything when the keychain secret cannot be read", async () => {
    const h = await realServer();
    const f = fixture(h.port, { securityBody: "exit 44" });
    const r = await run(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("キーチェーン");
    expect(readFileSync(f.log, "utf8")).not.toContain("open ");
  }, TEST_TIMEOUT);

  it("fails when the server never becomes healthy", async () => {
    const f = fixture(await freePort());
    f.env.AC_HEALTH_WAIT_SEC = "2";
    const r = await run(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("起動しませんでした");
    expect(readFileSync(f.log, "utf8")).not.toContain("open ");
  }, TEST_TIMEOUT);
});
