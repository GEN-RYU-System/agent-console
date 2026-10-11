import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
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
    expect(app).not.toContain("__AC_HOME__");

    // 導入結果の出力（K3 の根拠）
    expect(r.stdout).toContain("state = running");
    expect(r.stdout).toContain("healthz: 200 ok");
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

  it("never runs a recursive forced delete (scripts contain no such command)", () => {
    for (const file of ["scripts/ac-install.sh", "scripts/ac-update.sh", "scripts/ac-rollback.sh", "scripts/ac-uninstall.sh", "scripts/lib/ac-common.sh", "ops/launcher/launch.sh"]) {
      const text = readFileSync(path.join(REPO, file), "utf8");
      expect(text, file).not.toMatch(/\brm\s+-[a-zA-Z]*r/);
      expect(text, file).not.toMatch(/\brm\s+--recursive/);
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
  it("refuses to run while another operation holds the lock", async () => {
    const e = await fresh();
    mkdirSync(path.join(e.home, "lock"), { recursive: true });
    writeFileSync(path.join(e.home, "lock", "pid"), `${process.pid}\n`);
    const r = e.run("ac-install.sh", ["v1.0.0"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("実行中");
    expect(existsSync(path.join(e.home, "current"))).toBe(false);
  });

  it("recovers from a stale lock left by a dead process and releases the lock afterwards", async () => {
    const e = await fresh();
    mkdirSync(path.join(e.home, "lock"), { recursive: true });
    const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(path.join(e.home, "lock", "pid"), `${dead}\n`);
    const r = e.run("ac-install.sh", ["v1.0.0"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(path.join(e.home, "lock"))).toBe(false);
  }, 60000);

  it("releases the lock when a step fails", async () => {
    const e = await fresh();
    e.run("ac-install.sh", ["v9.9.9"], { FAKE_BAD_TAGS: "v9.9.9" });
    expect(existsSync(path.join(e.home, "lock"))).toBe(false);
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

describe("shell syntax", () => {
  it.each(["scripts/ac-install.sh", "scripts/ac-update.sh", "scripts/ac-rollback.sh", "scripts/ac-uninstall.sh", "scripts/lib/ac-common.sh", "ops/launcher/launch.sh"])(
    "bash -n %s",
    (file) => {
      expect(spawnSync("bash", ["-n", path.join(REPO, file)]).status).toBe(0);
    },
  );
});
