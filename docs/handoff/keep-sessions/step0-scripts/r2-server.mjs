// 工程0 R2/R5/K1/K11: launchd の job として動く「アプリのサーバー役」。
// tmux にセッションを作り、node-pty で attach だけをつなぐ。SIGTERM を受けたら attach だけを終わらせて終了する（本番の shutdown と同じ）。
// 使い方: node r2-server.mjs <socket> <conf> <outDir> <repoDir>
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [socket, conf, outDir, repoDir] = process.argv.slice(2);
const require = createRequire(path.join(repoDir, "package.json"));
const pty = require("node-pty");
const log = (m) => appendFileSync(path.join(outDir, "server.log"), `${new Date().toISOString()} ${m}\n`);

// 秘密を入れた「汚れた環境」から、本番と同じ除外をして tmux を起こす
const BLOCK = new Set(["AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_AUTH", "AC_SECURITY", "AC_STUB_LOG"]);
const env = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && !BLOCK.has(k)) env[k] = v;
env.TERM = "xterm-256color";
env.LANG = "ja_JP.UTF-8";
log(`parent env has AGENT_CONSOLE_TOKEN=${"AGENT_CONSOLE_TOKEN" in process.env}`);

const tmux = (...args) => execFileSync("/opt/homebrew/bin/tmux", ["-u", "-L", socket, "-f", conf, ...args], { env, encoding: "utf8" });
const name = "ac-step0-r2";
tmux("new-session", "-d", "-s", name, "-x", "100", "-y", "30", "-c", outDir, "-e", "AC_RESUME_ID=demo-resume", "--", "/bin/sh", "-c", "echo READY id=[$AC_RESUME_ID] token=[$AGENT_CONSOLE_TOKEN]; exec sleep 900");
const panePid = tmux("display", "-p", "-t", `=${name}:`, "#{pane_pid}").trim();
writeFileSync(path.join(outDir, "pane-pid.txt"), panePid);
log(`pane_pid=${panePid} server_pid=${process.pid}`);

const term = pty.spawn("/opt/homebrew/bin/tmux", ["-u", "-L", socket, "-f", conf, "attach-session", "-E", "-t", `=${name}`], { name: "xterm-256color", cols: 100, rows: 30, env });
let out = "";
term.onData((d) => { out += d; });
term.onExit((e) => log(`attach exited ${JSON.stringify(e)}`));
log(`attach pid=${term.pid}`);

const shutdown = () => {
  writeFileSync(path.join(outDir, "attach-output.txt"), out);
  log("SIGTERM: killing attach only");
  try { term.kill(); } catch { /* */ }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => undefined, 1000);
