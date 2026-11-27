// 試験サーバー（ポート 4394 のみ。本番 4319・本番 dataDir・本番 tmux（-L agent-console）には触れない）。
// 使い方: npx tsx servers.ts start <runDir> | stop <runDir>   ※ cwd は worktree（~/agent-console-wt/scroll2）
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import { prepareE2eEnv, E2E_TOKEN } from "/private/tmp/ac-smooth0b/fixtures/e2e-env.ts";

const [cmd, runDir] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const wtRoot = process.env.AC_WTROOT ?? "/private/tmp/ac-smooth0b/v056copy";
const PORT = 4395;
const SOCKET = "ac-smooth0b-test";
const SID = process.env.AC_SMOOTH0B_SID ?? "";

if (cmd === "start") {
  mkdirSync(runDir, { recursive: true });
  prepareE2eEnv();
  const base = JSON.parse(readFileSync(process.env.AC_E2E_CONFIG as string, "utf8"));
  const marker = "agent-console-e2e-role";
  const cfg = {
    ...base,
    port: PORT,
    dataDir: path.join(runDir, "data"),
    claudeSettingsPath: path.join(runDir, "claude-home", ".claude", "settings.json"),
    terminalHost: "tmux",
    tmuxSocket: SOCKET,
    terminalRenderer: "webgl",
    terminalSmoothScrollMs: 125,
    roles: [
      { id: "redraw", labelKey: "role.shell", command: [process.execPath, path.join(here, "redraw-role.mjs"), marker], needsWorktree: false },
      { id: "claude", labelKey: "role.shell", command: ["/bin/sh", "-c", `cd /private/tmp/ac-smooth0b/proj && exec claude --resume ${SID}`], needsWorktree: false },
    ],
  };
  mkdirSync(path.dirname(cfg.claudeSettingsPath), { recursive: true });
  const cfgFile = path.join(runDir, "config.json");
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const log = path.join(runDir, "server.log");
  const out = openSync(log, "a");
  const child = spawn(process.execPath, ["dist-server/server/index.js"], {
    cwd: wtRoot, detached: true, stdio: ["ignore", out, out],
    env: {
      ...(process.env as Record<string, string>),
      AGENT_CONSOLE_PORT: String(PORT), AC_TRACE_FILE: path.join(runDir, "trace.txt"),
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
  writeFileSync(path.join(runDir, "servers.json"), JSON.stringify({ token: E2E_TOKEN, webgl: { port: PORT, pid: child.pid, config: cfgFile, log }, socket: SOCKET }, null, 2));
  console.log(`started pid=${child.pid} port=${PORT} socket=${SOCKET}`);
} else if (cmd === "stop") {
  const f = path.join(runDir, "servers.json");
  if (existsSync(f)) {
    const info = JSON.parse(readFileSync(f, "utf8"));
    try { process.kill(-info.webgl.pid, "SIGTERM"); } catch { try { process.kill(info.webgl.pid, "SIGTERM"); } catch { /* 既に無い */ } }
  }
  console.log("stopped");
}
