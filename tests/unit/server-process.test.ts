import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SECRET = "c0ffee".repeat(10) + "abcd";
const REPO = process.cwd();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

interface Proc {
  child: ChildProcess;
  port: number;
  dir: string;
  configFile: string;
  output: () => string;
  exited: Promise<number | null>;
}

const running: ChildProcess[] = [];
afterEach(() => {
  for (const c of running.splice(0)) c.kill("SIGKILL");
});

function makeDir(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-proc-")));
}

function writeStub(dir: string, name: string, body: string): string {
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/bin/bash\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

async function startServer(env: Record<string, string>, extraRoles: unknown[] = []): Promise<Proc> {
  const dir = makeDir();
  const root = path.join(dir, "root");
  mkdirSync(root);
  const port = await freePort();
  const config = {
    port,
    salesanchorRoot: root,
    salesanchorToolsRoot: root,
    newWorktreeScript: "scripts/new-worktree.sh",
    ledgerLookupScript: "scripts/ledger-lookup.sh",
    ledgerDir: "ledger",
    dataDir: path.join(dir, "data"),
    claudeBin: writeStub(dir, "claude-stub", 'echo "[]"'),
    agentsPollMs: 60000,
    ledgerPollMs: 60000,
    ringBufferBytes: 1048576,
    // 本番の tmux（-L agent-console）に触れないよう、この試験の子サーバーは direct で動かす
    terminalHost: "direct",
    roles: [{ id: "plain", labelKey: "role.shell", command: ["/bin/sh", "-c", "cat"], needsWorktree: false }, ...extraRoles],
    // 既定の routineManagerRoles（opus-designer）はこの試験の役割に無いので、plain を指定する
    routineManagerRoles: ["plain"],
  };
  const configFile = path.join(dir, "config.json");
  writeFileSync(configFile, JSON.stringify(config));
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: REPO,
    env: { ...process.env, AGENT_CONSOLE_CONFIG: configFile, AGENT_CONSOLE_AUTH: "", AGENT_CONSOLE_TOKEN: "", AGENT_CONSOLE_PORT: "", AGENT_CONSOLE_RESTORE: "off", AC_SECURITY: "", AC_STUB_LOG: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, port, dir, configFile, output: () => out, exited };
}

async function waitHealthy(p: Proc, ms = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${p.port}/healthz`);
      if (res.status === 200) return;
    } catch {
      /* まだ起動していない */
    }
    if (Date.now() - start > ms) throw new Error(`server did not become healthy. output:\n${p.output()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}`, "Content-Type": "application/json" });

describe("server process: no secrets in logs, argv or child env", () => {
  it("dev/fixed mode: the log holds only the one-time pairing URL, never the secret or the session", async () => {
    const p = await startServer({ AGENT_CONSOLE_TOKEN: SECRET });
    await waitHealthy(p);
    const logged = /http:\/\/127\.0\.0\.1:\d+\/pair\?code=([0-9a-f]{64})/.exec(p.output());
    expect(logged).not.toBeNull();

    // ログのコードを画面と同じ手順で引換える（1 回限り）→ セッショントークン。dist（ビルド済みの画面）が無くても通る API だけを使う
    const origin = `http://127.0.0.1:${p.port}`;
    const redeem = (code: string) =>
      fetch(`${origin}/api/pair/redeem`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ code }) });
    const paired = await redeem(logged?.[1] as string);
    expect(paired.status).toBe(200);
    expect(paired.headers.get("set-cookie")).toBeNull();
    const sessionValue = ((await paired.json()) as { token: string }).token;
    expect((await redeem(logged?.[1] as string)).status).toBe(401);

    // 認証あり/なし/不正の各種リクエスト（ログに値が出ないこと）
    await fetch(`${origin}/api/state`, { headers: { Authorization: `Bearer ${sessionValue}` } });
    await fetch(`${origin}/api/state`, { headers: bearer(SECRET) });
    await fetch(`${origin}/api/state?t=${SECRET}`);
    await fetch(`${origin}/api/sessions`, { method: "POST", headers: bearer(SECRET), body: "{bad" });

    const log = p.output();
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(sessionValue);
    expect(log).toContain("AGENT_CONSOLE_TOKEN で固定したトークン"); // 警告は出るが値は出ない
    // プロセス一覧（引数）に秘密が出ない
    const ps = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" });
    expect(ps).not.toContain(SECRET);
  }, 30000);

  it("keychain mode: reads the secret via the security stub, logs nothing sensitive, hides env from the pty child", async () => {
    const dir = makeDir();
    const argvLog = path.join(dir, "security-argv.log");
    const security = writeStub(dir, "security", `printf '%s\\n' "$*" >> '${argvLog}'\necho "${SECRET}"`);
    const childEnvFile = path.join(dir, "child-env.txt");
    const envRole = { id: "envdump", labelKey: "role.shell", command: ["/bin/sh", "-c", `env > '${childEnvFile}'; cat`], needsWorktree: false };
    const p = await startServer({ AGENT_CONSOLE_AUTH: "keychain", AC_SECURITY: security, AC_STUB_LOG: path.join(dir, "stub.log") }, [envRole]);
    await waitHealthy(p);

    expect(readFileSync(argvLog, "utf8").trim()).toBe("find-generic-password -s agent-console -a server -w");
    expect(p.output()).toContain("キーチェーン認証");
    expect(p.output()).not.toContain(SECRET);
    expect(p.output()).not.toMatch(/pair\?code=/); // 本番モードは URL を出さない

    // 秘密で API が使える・ログの外から秘密無しでは使えない
    const base = `http://127.0.0.1:${p.port}`;
    expect((await fetch(`${base}/api/state`, { headers: bearer(SECRET) })).status).toBe(200);
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    const health = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; version: string; commit: string };
    expect(health.ok).toBe(true);
    expect(health.version).toBe(JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version);
    expect(health.commit).toMatch(/^[0-9a-f]{40}$/);

    const created = await fetch(`${base}/api/sessions`, { method: "POST", headers: bearer(SECRET), body: JSON.stringify({ name: "e", roleId: "envdump" }) });
    expect(created.status).toBe(201);
    for (let i = 0; i < 50 && !existsSync(childEnvFile); i++) await new Promise((r) => setTimeout(r, 100));
    const childEnv = readFileSync(childEnvFile, "utf8");
    expect(childEnv).not.toContain(SECRET);
    expect(childEnv).not.toMatch(/^AGENT_CONSOLE_(TOKEN|AUTH)=/m);
    expect(childEnv).not.toMatch(/^AC_SECURITY=/m);
    expect(childEnv).not.toMatch(/^AC_STUB_LOG=/m);

    expect(p.output()).not.toContain(SECRET);
    const ps = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" });
    expect(ps).not.toContain(SECRET);
  }, 30000);

  it("keychain mode: aborts startup when the secret cannot be read", async () => {
    const dir = makeDir();
    const security = writeStub(dir, "security", `echo "partial-${SECRET}"; echo "denied" >&2; exit 44`);
    const p = await startServer({ AGENT_CONSOLE_AUTH: "keychain", AC_SECURITY: security, AC_STUB_LOG: path.join(dir, "stub.log") });
    const code = await p.exited;
    expect(code).not.toBe(0);
    expect(p.output()).toMatch(/keychain/i);
    expect(p.output()).not.toContain(SECRET);
    await expect(fetch(`http://127.0.0.1:${p.port}/healthz`)).rejects.toThrow();
  }, 30000);

  it("AGENT_CONSOLE_PORT overrides the configured port (self-check on another port)", async () => {
    const other = await freePort();
    const p = await startServer({ AGENT_CONSOLE_TOKEN: SECRET, AGENT_CONSOLE_PORT: String(other) });
    p.port = other;
    await waitHealthy(p);
    expect((await fetch(`http://127.0.0.1:${other}/healthz`)).status).toBe(200);
  }, 30000);

  it("never uses the production default dataDir: the child config points under its own temp directory and no restore list is written", async () => {
    const p = await startServer({ AGENT_CONSOLE_TOKEN: SECRET });
    await waitHealthy(p);
    const written = JSON.parse(readFileSync(p.configFile, "utf8")) as { dataDir?: string };
    expect(written.dataDir).toBe(path.join(p.dir, "data"));
    expect(path.relative(p.dir, written.dataDir as string).startsWith("..")).toBe(false);
    expect(existsSync(path.join(p.dir, "data", "open-sessions.json"))).toBe(false);
  }, 30000);
});
