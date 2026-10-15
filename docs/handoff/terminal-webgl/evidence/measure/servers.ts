// 測定用サーバーの起動・停止（ポート 4392=DOM / 4393=WebGL。本番 4319・本番 dataDir・本番 tmux には触れない）。
// 使い方: npx tsx servers.ts start <runDir> | stop <runDir>
// 2 つのサーバーは同じビルド（dist / dist-server）から起動し、違いは config の terminalRenderer だけ。
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { prepareE2eEnv, E2E_TOKEN } from "../../../../../tests/fixtures/e2e-env.ts";

const [cmd, runDir] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const wtRoot = path.resolve(here, "../../../../..");
const VARIANTS = [
  { name: "dom", port: 4392, renderer: "dom" },
  { name: "webgl", port: 4393, renderer: "webgl" },
] as const;

if (cmd === "start") {
  mkdirSync(runDir, { recursive: true });
  prepareE2eEnv();
  const base = JSON.parse(readFileSync(process.env.AC_E2E_CONFIG as string, "utf8"));
  const roleScript = path.join(wtRoot, "tests/fixtures/role.mjs");
  const marker = "agent-console-e2e-role";
  const info: Record<string, unknown> = { token: E2E_TOKEN };
  for (const v of VARIANTS) {
    const cfg = {
      ...base,
      port: v.port,
      dataDir: path.join(runDir, `data-${v.name}`),
      claudeSettingsPath: path.join(runDir, `claude-home-${v.name}`, ".claude", "settings.json"),
      terminalHost: "direct",
      terminalRenderer: v.renderer,
      roles: [
        { id: "echo", labelKey: "role.shell", command: [process.execPath, roleScript, marker], needsWorktree: false },
        { id: "redraw", labelKey: "role.shell", command: [process.execPath, path.join(here, "redraw-role.mjs"), marker], needsWorktree: false },
        { id: "visual", labelKey: "role.shell", command: [process.execPath, path.join(here, "visual-role.mjs"), marker], needsWorktree: false },
      ],
    };
    mkdirSync(path.dirname(cfg.claudeSettingsPath), { recursive: true });
    const cfgFile = path.join(runDir, `config-${v.name}.json`);
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    const log = path.join(runDir, `server-${v.name}.log`);
    const out = (await import("node:fs")).openSync(log, "a");
    const child = spawn(process.execPath, ["dist-server/server/index.js"], {
      cwd: wtRoot,
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...(process.env as Record<string, string>),
        AGENT_CONSOLE_PORT: String(v.port), // 「本番ではない」扱い（拡張の合言葉・引き継ぎ置き場に実ホームを使わない）
        AGENT_CONSOLE_CONFIG: cfgFile,
        AGENT_CONSOLE_TOKEN: E2E_TOKEN,
        STUB_STATUS_FILE: process.env.AC_E2E_STATUS_FILE as string,
        STUB_NAME_FILE: process.env.AC_E2E_NAME_FILE as string,
        STUB_SLOW_FILE: process.env.AC_E2E_SLOW_FILE as string,
        STUB_OSASCRIPT_LOG: process.env.AC_E2E_OSASCRIPT_LOG as string,
        STUB_GH_DIR: process.env.AC_E2E_GH_DIR as string,
        STUB_GH_LOG: process.env.AC_E2E_GH_LOG as string,
        STUB_UUID_FILE: process.env.AC_E2E_UUID_FILE as string,
      },
    });
    child.unref();
    info[v.name] = { port: v.port, pid: child.pid, config: cfgFile, log };
  }
  writeFileSync(path.join(runDir, "servers.json"), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info, null, 2).replace(E2E_TOKEN, "<token>"));
} else if (cmd === "stop") {
  const f = path.join(runDir, "servers.json");
  if (existsSync(f)) {
    const info = JSON.parse(readFileSync(f, "utf8"));
    for (const v of VARIANTS) {
      try { process.kill(-info[v.name].pid, "SIGTERM"); } catch { try { process.kill(info[v.name].pid, "SIGTERM"); } catch { /* 既に無い */ } }
    }
  }
  console.log("stopped");
}
void copyFileSync;
