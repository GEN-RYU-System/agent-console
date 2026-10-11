import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freePort } from "./helpers/ac-env.ts";

const SECRET = "5ec0de".repeat(10) + "abcd";
const LAUNCH = path.join(process.cwd(), "ops", "launcher", "launch.sh");

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function stub(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

interface Fixture {
  dir: string;
  port: number;
  log: string;
  seenAuth: string[];
  env: Record<string, string>;
  startServer: () => Promise<void>;
}

async function fixture(options: { securityBody?: string } = {}): Promise<Fixture> {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-launch-")));
  const log = path.join(dir, "calls.log");
  writeFileSync(log, "");
  const port = await freePort();
  const seenAuth: string[] = [];
  const code = "ab".repeat(32);
  const startServer = (): Promise<void> =>
    new Promise((resolve) => {
      const s = createServer((req, res) => {
        if (req.url === "/healthz") return void res.end("ok");
        if (req.url === "/api/pair" && req.method === "POST") {
          seenAuth.push(String(req.headers.authorization));
          if (req.headers.authorization !== `Bearer ${SECRET}`) return void res.writeHead(401).end("{}");
          return void res.end(JSON.stringify({ code, expiresInSec: 30 }));
        }
        res.writeHead(404).end();
      });
      servers.push(s);
      s.listen(port, "127.0.0.1", resolve);
    });
  const security = stub(dir, "security", options.securityBody ?? `echo "security $*" >> "${log}"\necho "${SECRET}"`);
  const curl = stub(dir, "curl", `echo "curl $*" >> "${log}"\nexec /usr/bin/curl "$@"`);
  const open = stub(dir, "open", `echo "open $*" >> "${log}"`);
  const launchctl = stub(dir, "launchctl", `echo "launchctl $*" >> "${log}"\ntouch "${dir}/kicked"`);
  return {
    dir,
    port,
    log,
    seenAuth,
    startServer,
    env: {
      ...(process.env as Record<string, string>),
      AC_SECURITY: security,
      AC_CURL: curl,
      AC_OPEN: open,
      AC_LAUNCHCTL: launchctl,
      AC_PORT: String(port),
      AC_UID: "501",
      AC_HEALTH_WAIT_SEC: "8",
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

describe("ops/launcher/launch.sh", () => {
  it("reads the secret from the keychain, gets a one-time code and opens a Chrome app window on /pair?code=", async () => {
    const f = await fixture();
    await f.startServer();
    const r = await run(f);
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(f.log, "utf8");
    expect(calls).toContain("security find-generic-password -s agent-console -a server -w");
    expect(calls).toContain(`open -na Google Chrome --args --app=http://127.0.0.1:${f.port}/pair?code=${"ab".repeat(32)}`);
    expect(f.seenAuth).toEqual([`Bearer ${SECRET}`]);
    // 長期秘密は引数（curl・open）にも標準出力・標準エラーにも出ない
    expect(calls).not.toContain(SECRET);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    // サーバーが起動済みなら kickstart しない
    expect(calls).not.toContain("kickstart");
  });

  it("starts the service with launchctl kickstart when the server is down, then waits for /healthz", async () => {
    const f = await fixture();
    let started = false;
    const r = await run(f, () => {
      if (!started && existsSync(path.join(f.dir, "kicked"))) {
        started = true;
        void f.startServer();
      }
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(f.log, "utf8")).toContain("launchctl kickstart gui/501/local.agent-console.server");
    expect(readFileSync(f.log, "utf8")).toContain("open -na Google Chrome");
  });

  it("fails without opening anything when the keychain secret cannot be read", async () => {
    const f = await fixture({ securityBody: "exit 44" });
    await f.startServer();
    const r = await run(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("キーチェーン");
    expect(readFileSync(f.log, "utf8")).not.toContain("open ");
  });

  it("fails when the server never becomes healthy", async () => {
    const f = await fixture();
    f.env.AC_HEALTH_WAIT_SEC = "2";
    const r = await run(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("起動しませんでした");
    expect(readFileSync(f.log, "utf8")).not.toContain("open ");
  }, 20000);

  it("fails when the server rejects the secret", async () => {
    const f = await fixture({ securityBody: 'echo "wrong-secret"' });
    await f.startServer();
    const r = await run(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ペアリングコードを取得できません");
  });
});
