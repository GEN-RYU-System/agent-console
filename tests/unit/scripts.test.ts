import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { makeAcEnv, type AcEnv } from "./helpers/ac-env.ts";

const REPO = process.cwd();
const isDarwin = process.platform === "darwin";
const envs: AcEnv[] = [];

afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});

async function fresh(): Promise<AcEnv> {
  const e = await makeAcEnv();
  envs.push(e);
  return e;
}

async function version(e: AcEnv): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${e.port}/version`);
  return res.text();
}

const currentTag = (e: AcEnv): string => path.basename(readlinkSync(path.join(e.home, "current")));
const versionsDir = (e: AcEnv): string[] => readdirSync(path.join(e.home, "versions")).sort();

async function installed(tag = "v1.0.0"): Promise<AcEnv> {
  const e = await fresh();
  const r = e.run("ac-install.sh", [tag]);
  expect(r.status, r.stderr).toBe(0);
  return e;
}

describe("ac-install.sh", () => {
  it("installs a version, saves the secret via stdin, writes a linted plist, builds the launcher and reaches /healthz", async () => {
    const e = await fresh();
    const r = e.run("ac-install.sh", ["v1.0.0"]);
    expect(r.status, r.stderr).toBe(0);

    expect(existsSync(path.join(e.home, ".agent-console-home"))).toBe(true);
    expect(currentTag(e)).toBe("v1.0.0");
    expect(await version(e)).toBe("v1.0.0");
    expect(versionsDir(e)).toEqual(["v1.0.0"]);

    // 秘密: キーチェーンに保存され（スタブの保存先）、引数・標準出力・標準エラーには出ない
    const secret = e.secret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(e.log()).not.toContain(secret);
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(e.log()).toContain("security -i\n");
    // 起動アプリは一時ファイルを作らず osacompile の標準入力で渡す
    expect(e.log()).toMatch(/osacompile -o .*Agent Console\.app\n/);

    // plist: 雛形から生成・プレースホルダ無し・lint 実行
    const plist = readFileSync(path.join(e.agentsDir, "local.agent-console.server.plist"), "utf8");
    expect(plist).not.toMatch(/__[A-Z_]+__/);
    expect(plist).toContain("<string>local.agent-console.server</string>");
    expect(plist).toContain(`<string>${e.home}/current/dist-server/server/index.js</string>`);
    expect(plist).toContain(`<string>${process.execPath}</string>`);
    expect(plist).toContain("<key>AGENT_CONSOLE_AUTH</key>");
    expect(plist).toContain("<string>keychain</string>");
    expect(e.log()).toMatch(/plutil -lint .*local\.agent-console\.server\.plist/);

    // launchctl: bootstrap gui/<uid> <plist>
    expect(e.log()).toContain(`launchctl bootstrap gui/501 ${path.join(e.agentsDir, "local.agent-console.server.plist")}`);

    // 起動アプリ: AC_HOME が埋まる
    const app = readFileSync(path.join(e.appsDir, "Agent Console.app", "script.applescript"), "utf8");
    expect(app).toContain(`${e.home}/current/ops/launcher/launch.sh`);
    expect(app).toContain(`AC_LAUNCHER_NODE=" & quoted form of "${process.execPath}"`);
    expect(app).not.toContain("__AC_NODE__");
    expect(app).not.toContain("__AC_HOME__");

    // 導入結果の出力（K3 の根拠）
    expect(r.stdout).toContain("state = running");
    expect(r.stdout).toMatch(/healthz: 200 ok（version 1\.0\.0・commit [0-9a-f]{7} が一致）/);
  }, 60000);

  it("installs with --ignore-scripts, runs the repo's own postinstall explicitly, and prints the tag's commit SHA", async () => {
    const e = await fresh();
    const r = e.run("ac-install.sh", ["v1.0.0"]);
    expect(r.status, r.stderr).toBe(0);
    const log = e.log();
    expect(log).toContain("npm ci --ignore-scripts\n");
    expect(log).not.toMatch(/^npm ci$/m);
    expect(log).toContain("postinstall-ran");
    const sha = execFileSync("git", ["-C", path.join(e.home, "versions", "v1.0.0"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.stdout).toContain(`コミット: ${sha}`);
    expect(r.stderr).toContain(sha);
    // 取得 → 到達性確認（gh api compare）の順
    expect(log).toMatch(/gh repo clone[\s\S]*gh api repos\/shingo-cc\/agent-console\/compare\/main\.\.\.[0-9a-f]{40} --jq \.status/);
  }, 60000);

  it("aborts when the tag's commit is not reachable from origin/main (ahead / diverged)", async () => {
    for (const status of ["diverged", "ahead"]) {
      const e = await fresh();
      const r = e.run("ac-install.sh", ["v1.0.0"], { FAKE_COMPARE_STATUS: status });
      expect(r.status, status).not.toBe(0);
      expect(r.stderr).toContain("到達できません");
      expect(existsSync(path.join(e.home, "current"))).toBe(false);
      expect(versionsDir(e)).toEqual([]);
      expect(e.log()).not.toContain("npm ci");
      expect(e.trashed().some((n) => n.startsWith("agent-console-failed-v1.0.0-"))).toBe(true);
    }
  }, 60000);

  it("accepts a tag at the tip of main (identical)", async () => {
    const e = await fresh();
    const r = e.run("ac-install.sh", ["v1.0.0"], { FAKE_COMPARE_STATUS: "identical" });
    expect(r.status, r.stderr).toBe(0);
  }, 60000);

  it("does not recreate an existing keychain secret on re-install", async () => {
    const e = await installed();
    const first = e.secret();
    const r = e.run("ac-install.sh", ["v1.0.0"]);
    expect(r.status, r.stderr).toBe(0);
    expect(e.secret()).toBe(first);
    expect(e.log().match(/^security -i$/gm)?.length).toBe(1);
  }, 60000);

  it("rejects bad tags and leaves nothing behind", async () => {
    const e = await fresh();
    for (const bad of ["", "1.0.0", "v1.0", "main", "v1.0.0; touch x"]) {
      const r = e.run("ac-install.sh", bad === "" ? [] : [bad]);
      expect(r.status, bad).not.toBe(0);
    }
    expect(existsSync(e.home)).toBe(false);
  });

  it("does not switch current when the self-check fails", async () => {
    const e = await fresh();
    const r = e.run("ac-install.sh", ["v9.9.9"], { FAKE_BAD_TAGS: "v9.9.9" });
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(e.home, "current"))).toBe(false);
    expect(versionsDir(e)).toEqual([]);
    expect(existsSync(path.join(e.agentsDir, "local.agent-console.server.plist"))).toBe(false);
    // 失敗した版は削除せず Trash へ（元に戻せる）
    expect(e.trashed().some((n) => /^agent-console-failed-v9\.9\.9-\d{8}-\d{6}/.test(n))).toBe(true);
  }, 60000);

  it("moves the previous plist and launcher app to Trash (never deletes) when re-installing", async () => {
    const e = await installed();
    const r = e.run("ac-install.sh", ["v1.0.0"]);
    expect(r.status, r.stderr).toBe(0);
    const names = e.trashed();
    expect(names.some((n) => n.startsWith("agent-console-plist-"))).toBe(true);
    expect(names.some((n) => n.startsWith("agent-console-app-"))).toBe(true);
    const plistInTrash = names.find((n) => n.startsWith("agent-console-plist-")) as string;
    expect(readFileSync(path.join(e.trashDir, plistInTrash), "utf8")).toContain("local.agent-console.server");
    // 新しい plist とアプリは元の場所にある
    expect(existsSync(path.join(e.agentsDir, "local.agent-console.server.plist"))).toBe(true);
    expect(existsSync(path.join(e.appsDir, "Agent Console.app"))).toBe(true);
  }, 90000);
});

describe("ac-update.sh", () => {
  it("installs the new version, switches current, restarts and /healthz reports the new version", async () => {
    const e = await installed("v1.0.0");
    const r = e.run("ac-update.sh", ["v1.1.0"]);
    expect(r.status, r.stderr).toBe(0);
    expect(currentTag(e)).toBe("v1.1.0");
    expect(await version(e)).toBe("v1.1.0");
    expect(versionsDir(e)).toEqual(["v1.0.0", "v1.1.0"]);
    expect(e.log()).toContain("launchctl kickstart -k gui/501/local.agent-console.server");
    expect(r.stdout).toContain("v1.0.0 -> v1.1.0");
  }, 90000);

  it("keeps current (and no new version directory) when the self-check fails", async () => {
    const e = await installed("v1.0.0");
    const r = e.run("ac-update.sh", ["v9.9.9"], { FAKE_BAD_TAGS: "v9.9.9" });
    expect(r.status).not.toBe(0);
    expect(currentTag(e)).toBe("v1.0.0");
    expect(versionsDir(e)).toEqual(["v1.0.0"]);
    expect(await version(e)).toBe("v1.0.0");
    expect(e.trashed().some((n) => n.startsWith("agent-console-failed-v9.9.9-"))).toBe(true);
  }, 90000);

  it("keeps current when the download fails", async () => {
    const e = await installed("v1.0.0");
    const r = e.run("ac-update.sh", ["v1.5.0"], { FAKE_CLONE_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(currentTag(e)).toBe("v1.0.0");
    expect(versionsDir(e)).toEqual(["v1.0.0"]);
  }, 90000);

  it("reverts to the previous version when the new one fails to start on the real port", async () => {
    const e = await installed("v1.0.0");
    const r = e.run("ac-update.sh", ["v8.8.8"], { FAKE_FAIL_MAIN_TAGS: "v8.8.8" });
    expect(r.status).not.toBe(0);
    expect(currentTag(e)).toBe("v1.0.0");
    expect(await version(e)).toBe("v1.0.0");
  }, 90000);

  it("does not call an update successful when kickstart did nothing and the OLD process still answers 200", async () => {
    const e = await installed("v1.0.0");
    const r = e.run("ac-update.sh", ["v1.1.0"], { FAKE_NO_RESTART: "1", AC_HEALTH_WAIT_SEC: "3" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("版・コミットの一致");
    expect(currentTag(e)).toBe("v1.0.0");
    expect(await version(e)).toBe("v1.0.0");
  }, 90000);

  it("the self-check is not fooled by another process answering 200 on the diagnostic port", async () => {
    const e = await installed("v1.0.0");
    const impostor = createServer((_req, res) => res.end(JSON.stringify({ ok: true, version: "1.1.0", commit: "0".repeat(40) })));
    await new Promise<void>((resolve) => impostor.listen(e.diagPort, "127.0.0.1", resolve));
    try {
      const r = e.run("ac-update.sh", ["v1.1.0"]);
      expect(r.status).not.toBe(0);
      expect(currentTag(e)).toBe("v1.0.0");
    } finally {
      impostor.close();
    }
  }, 90000);

  it("prints the commit SHA of the new version", async () => {
    const e = await installed("v1.0.0");
    const r = e.run("ac-update.sh", ["v1.1.0"]);
    expect(r.status, r.stderr).toBe(0);
    const sha = execFileSync("git", ["-C", path.join(e.home, "versions", "v1.1.0"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(r.stdout).toContain(sha);
  }, 90000);

  it("refuses when nothing is installed", async () => {
    const e = await fresh();
    expect(e.run("ac-update.sh", ["v1.0.0"]).status).not.toBe(0);
  });
});

describe("ac-rollback.sh", () => {
  it("goes to the previous version in semver order (1.10.0 -> 1.2.0, not lexicographic)", async () => {
    const e = await installed("v1.0.0");
    for (const t of ["v1.2.0", "v1.10.0"]) expect(e.run("ac-update.sh", [t]).status).toBe(0);
    expect(currentTag(e)).toBe("v1.10.0");
    const r = e.run("ac-rollback.sh");
    expect(r.status, r.stderr).toBe(0);
    expect(currentTag(e)).toBe("v1.2.0");
    expect(await version(e)).toBe("v1.2.0");
    expect(r.stdout).toContain("v1.10.0 -> v1.2.0");
  }, 150000);

  it("fails and changes nothing when there is no earlier version", async () => {
    const e = await installed("v1.0.0");
    const r = e.run("ac-rollback.sh");
    expect(r.status).not.toBe(0);
    expect(currentTag(e)).toBe("v1.0.0");
  }, 60000);
});

describe("ac-uninstall.sh", () => {
  it("moves the plist and the launcher app to Trash (not deleted) and keeps versions and the keychain secret", async () => {
    const e = await installed();
    const secret = e.secret();
    const plist = path.join(e.agentsDir, "local.agent-console.server.plist");
    const app = path.join(e.appsDir, "Agent Console.app");
    const r = e.run("ac-uninstall.sh");
    expect(r.status, r.stderr).toBe(0);
    // 元の場所に無く、Trash に有る
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(app)).toBe(false);
    const names = e.trashed();
    const trashedPlist = names.find((n) => /^agent-console-plist-\d{8}-\d{6}/.test(n)) as string;
    const trashedApp = names.find((n) => /^agent-console-app-\d{8}-\d{6}/.test(n)) as string;
    expect(trashedPlist).toBeDefined();
    expect(trashedApp).toBeDefined();
    expect(readFileSync(path.join(e.trashDir, trashedPlist), "utf8")).toContain("local.agent-console.server");
    expect(existsSync(path.join(e.trashDir, trashedApp, "script.applescript"))).toBe(true);
    // 版と秘密は残る
    expect(existsSync(path.join(e.home, "versions", "v1.0.0"))).toBe(true);
    expect(e.secret()).toBe(secret);
    expect(e.log()).toContain("launchctl bootout gui/501/local.agent-console.server");
    expect(e.log()).not.toContain("delete-generic-password");
  }, 60000);

  it("--purge moves versions, current and logs to Trash and deletes the keychain item", async () => {
    const e = await installed();
    const r = e.run("ac-uninstall.sh", ["--purge"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(path.join(e.home, "versions"))).toBe(false);
    expect(() => lstatSync(path.join(e.home, "current"))).toThrow();
    expect(existsSync(path.join(e.home, "logs"))).toBe(false);
    const names = e.trashed();
    const trashedVersions = names.find((n) => /^agent-console-versions-/.test(n)) as string;
    expect(trashedVersions).toBeDefined();
    expect(existsSync(path.join(e.trashDir, trashedVersions, "v1.0.0", "package.json"))).toBe(true);
    expect(names.some((n) => /^agent-console-current-/.test(n))).toBe(true);
    expect(names.some((n) => /^agent-console-logs-/.test(n))).toBe(true);
    expect(e.log()).toContain("security delete-generic-password -s agent-console -a server");
  }, 60000);

  it("scripts contain no rm (in any form, including rm -f) and no unlink; single files go to Trash too", () => {
    for (const file of ["scripts/ac-install.sh", "scripts/ac-update.sh", "scripts/ac-rollback.sh", "scripts/ac-uninstall.sh", "scripts/lib/ac-common.sh", "ops/launcher/launch.sh"]) {
      const text = readFileSync(path.join(REPO, file), "utf8");
      // コメント行は除く。rmdir（空ディレクトリのみ）は許可
      const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      expect(code, file).not.toMatch(/(^|[^A-Za-z0-9_./-])rm(\s|$)/m);
      expect(code, file).not.toMatch(/\bunlink\b/);
      expect(code, file).not.toMatch(/-delete\b/);
    }
  });

  it("refuses to purge a directory without the Agent Console marker", async () => {
    const e = await fresh();
    mkdirSync(path.join(e.home, "versions", "v0.0.1"), { recursive: true });
    const r = e.run("ac-uninstall.sh", ["--purge"]);
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(e.home, "versions", "v0.0.1"))).toBe(true);
    expect(e.trashed()).toEqual([]);
  });

  it("only moves paths inside the allowed locations", async () => {
    const e = await installed();
    // マーカーを持たない別の場所の plist には触れない（AC_LAUNCH_AGENTS_DIR 配下だけが対象）
    const r = e.run("ac-uninstall.sh");
    expect(r.status, r.stderr).toBe(0);
    for (const n of e.trashed()) expect(n).toMatch(/^agent-console-(plist|app)-/);
  }, 60000);
});

describe("locking and guards", () => {
  const lockDir = (e: AcEnv) => path.join(e.home, "lock");
  const longAgo = (p: string) => spawnSync("touch", ["-t", "202001010000", p]);

  it("refuses to run while another live process holds the lock (pid-<n> directory)", async () => {
    const e = await fresh();
    mkdirSync(path.join(lockDir(e), `pid-${process.pid}`), { recursive: true });
    const r = e.run("ac-install.sh", ["v1.0.0"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("実行中");
    expect(existsSync(path.join(e.home, "current"))).toBe(false);
    expect(existsSync(path.join(lockDir(e), `pid-${process.pid}`))).toBe(true);
  });

  it("recovers from a lock left by a dead process and releases it afterwards", async () => {
    const e = await fresh();
    const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    mkdirSync(path.join(lockDir(e), `pid-${dead}`), { recursive: true });
    const r = e.run("ac-install.sh", ["v1.0.0"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(lockDir(e))).toBe(false);
  }, 60000);

  it("does not reclaim a fresh lock that has no holder record yet (mkdir just happened)", async () => {
    const e = await fresh();
    mkdirSync(lockDir(e), { recursive: true });
    const r = e.run("ac-install.sh", ["v1.0.0"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("実行中");
    expect(existsSync(lockDir(e))).toBe(true);
  });

  it("reclaims a lock with no holder record once it is older than 10 minutes", async () => {
    const e = await fresh();
    mkdirSync(lockDir(e), { recursive: true });
    longAgo(lockDir(e));
    const r = e.run("ac-install.sh", ["v1.0.0"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("回収");
    expect(existsSync(lockDir(e))).toBe(false);
  }, 60000);

  it("true concurrency: of two simultaneous acquirers exactly one wins", async () => {
    const e = await fresh();
    const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    mkdirSync(path.join(lockDir(e), `pid-${dead}`), { recursive: true });
    const script = `source "${REPO}/scripts/lib/ac-common.sh"; ac_acquire_lock && { echo ACQUIRED; sleep 3; }`;
    const spawnOne = () =>
      new Promise<{ out: string }>((resolve) => {
        const child = spawn("bash", ["-c", script], { env: e.env });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.on("exit", () => resolve({ out }));
      });
    const results = await Promise.all([spawnOne(), spawnOne()]);
    expect(results.filter((r) => r.out.includes("ACQUIRED")).length).toBe(1);
  }, 30000);

  it("releases the lock when a step fails", async () => {
    const e = await fresh();
    e.run("ac-install.sh", ["v9.9.9"], { FAKE_BAD_TAGS: "v9.9.9" });
    expect(existsSync(lockDir(e))).toBe(false);
  }, 60000);

  it("test mode refuses paths outside the temp directories (never touches the real environment)", async () => {
    const e = await fresh();
    const r = e.run("ac-install.sh", ["v1.0.0"], { AC_HOME: `${process.env.HOME}/Library/Application Support/agent-console` });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("一時ディレクトリ以外");
    expect(e.log()).toBe("");
    const t = e.run("ac-uninstall.sh", [], { AC_TRASH: `${process.env.HOME}/.Trash` });
    expect(t.status).not.toBe(0);
    expect(t.stderr).toContain("一時ディレクトリ以外");
  });
});

describe("ac_mtime (GNU and BSD stat differ)", () => {
  const run = (script: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", `source "${REPO}/scripts/lib/ac-common.sh"; ${script}`], { env: { PATH: process.env.PATH ?? "", HOME: "/tmp", ...env }, encoding: "utf8" });

  it("returns the epoch seconds of the directory's mtime as a plain number", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ac-mtime-"));
    spawnSync("touch", ["-t", "202001010000", dir]);
    const r = run(`ac_mtime "${dir}"`);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^[0-9]+$/);
    expect(Math.abs(Number(r.stdout) - Date.parse("2020-01-01T00:00:00") / 1000)).toBeLessThan(86400);
  });

  it("works when only a GNU-style stat exists (stat -f would print filesystem info: the bug seen on ubuntu)", () => {
    // GNU stat の挙動を再現するスタブ: -c %Y は秒を返し、-f は複数行の「ファイルシステム情報」を出して成功する
    const bin = mkdtempSync(path.join(os.tmpdir(), "ac-gnustat-"));
    writeFileSync(path.join(bin, "stat"), '#!/bin/bash\nif [ "$1" = -c ]; then echo 1577836800; exit 0; fi\nif [ "$1" = -f ]; then printf "  File: \\"x\\"\\n    ID: 0 Namelen: 255\\n"; exit 0; fi\nexit 1\n');
    chmodSync(path.join(bin, "stat"), 0o755);
    const r = run(`ac_mtime /whatever`, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(r.stdout).toBe("1577836800");
  });

  it("works when only a BSD-style stat exists (-c is an illegal option)", () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "ac-bsdstat-"));
    writeFileSync(path.join(bin, "stat"), '#!/bin/bash\nif [ "$1" = -c ]; then echo "stat: illegal option -- c" >&2; exit 1; fi\nif [ "$1" = -f ] && [ "$2" = %m ]; then echo 1577836800; exit 0; fi\nexit 1\n');
    chmodSync(path.join(bin, "stat"), 0o755);
    const r = run(`ac_mtime /whatever`, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(r.stdout).toBe("1577836800");
  });

  it("fails (so the lock is NOT reclaimed) when no usable stat output exists", () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "ac-nostat-"));
    writeFileSync(path.join(bin, "stat"), "#!/bin/bash\necho garbage\nexit 0\n");
    chmodSync(path.join(bin, "stat"), 0o755);
    expect(run(`ac_mtime /whatever`, { PATH: `${bin}:${process.env.PATH ?? ""}` }).status).not.toBe(0);
  });
});

describe("AC_* overrides are ignored outside test mode", () => {
  const probe = (env: Record<string, string>) =>
    spawnSync("bash", ["-c", `source "${REPO}/scripts/lib/ac-common.sh"; echo "$AC_GH|$AC_SECURITY|$AC_CURL|$AC_LAUNCHCTL|$AC_NPM|$AC_REPO|$AC_PORT|$AC_HOME"`], {
      env: { PATH: process.env.PATH ?? "", HOME: "/home/probe", ...env },
      encoding: "utf8",
    }).stdout.trim();

  it("falls back to the real defaults when AC_STUB_LOG is not set", () => {
    const out = probe({ AC_GH: "/evil/gh", AC_SECURITY: "/evil/security", AC_CURL: "/evil/curl", AC_LAUNCHCTL: "/evil/launchctl", AC_NPM: "/evil/npm", AC_REPO: "evil/repo", AC_PORT: "1", AC_HOME: "/evil/home" });
    expect(out).toBe("gh|security|curl|launchctl|npm|shingo-cc/agent-console|4319|/home/probe/Library/Application Support/agent-console");
  });

  it("honors the overrides in test mode", () => {
    const out = probe({ AC_STUB_LOG: "/tmp/x", AC_GH: "/stub/gh", AC_PORT: "5555" });
    expect(out.split("|")[0]).toBe("/stub/gh");
    expect(out.split("|")[6]).toBe("5555");
  });

  it("the launcher script has the same gate (static check; running it would touch the real keychain)", () => {
    const text = readFileSync(path.join(REPO, "ops", "launcher", "launch.sh"), "utf8");
    expect(text).toMatch(/if \[ -z "\$\{AC_STUB_LOG:-\}" \]; then\n\s+unset AC_SECURITY AC_CURL AC_LAUNCHCTL AC_OPEN/);
  });
});

describe("generated artifacts (macOS only)", () => {
  it.skipIf(!isDarwin)("plutil -lint passes for the generated plist (real plutil)", async () => {
    const e = await installed();
    const out = execFileSync("/usr/bin/plutil", ["-lint", path.join(e.agentsDir, "local.agent-console.server.plist")], { encoding: "utf8" });
    expect(out).toContain("OK");
  }, 60000);

  it.skipIf(!isDarwin)("the AppleScript template compiles with the real osacompile (into a temp dir)", async () => {
    const e = await fresh();
    const src = readFileSync(path.join(REPO, "ops", "launcher", "AgentConsole.applescript"), "utf8").replace("__AC_HOME__", e.home);
    const file = path.join(e.base, "AgentConsole.applescript");
    writeFileSync(file, src);
    const app = path.join(e.base, "Compiled.app");
    execFileSync("/usr/bin/osacompile", ["-o", app, file]);
    expect(existsSync(path.join(app, "Contents", "Resources", "Scripts", "main.scpt"))).toBe(true);
  }, 60000);
});

describe("shell portability", () => {
  it.each(["scripts/ac-install.sh", "scripts/ac-update.sh", "scripts/ac-rollback.sh", "scripts/ac-uninstall.sh", "scripts/lib/ac-common.sh", "ops/launcher/launch.sh"])(
    "%s has no $variable directly followed by a non-ASCII character (bash would read it as part of the name; set -u then aborts silently inside `if !`)",
    (file) => {
      const text = readFileSync(path.join(REPO, file), "utf8");
      expect(text).not.toMatch(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/);
    },
  );
});

describe("shell syntax", () => {
  it.each(["scripts/ac-install.sh", "scripts/ac-update.sh", "scripts/ac-rollback.sh", "scripts/ac-uninstall.sh", "scripts/lib/ac-common.sh", "ops/launcher/launch.sh"])(
    "bash -n %s",
    (file) => {
      expect(spawnSync("bash", ["-n", path.join(REPO, file)]).status).toBe(0);
    },
  );
});
