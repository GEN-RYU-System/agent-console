// Sales Anchor の origin/main の frontend/src を .sa-cache/ へ展開する（読み取りのみ: fetch / archive / rev-parse）。
// 失敗したら起動中止（フォールバックなし）。
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const cwd = process.cwd();
const configFile = process.env.AGENT_CONSOLE_CONFIG ?? path.join(cwd, "agent-console.config.json");
const cacheDir = path.join(cwd, ".sa-cache");

function expandHome(p) {
  if (p === "~") return os.homedir();
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function fail(message) {
  console.error(`sa-sync: ${message}`);
  process.exit(1);
}

let root;
try {
  root = expandHome(JSON.parse(readFileSync(configFile, "utf8")).salesanchorRoot);
} catch (err) {
  fail(`設定を読めません (${configFile}): ${err.message}`);
}

try {
  execFileSync("git", ["-C", root, "fetch", "origin", "main"], { stdio: "inherit" });
  const sha = execFileSync("git", ["-C", root, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  mkdirSync(cacheDir, { recursive: true });

  await new Promise((resolve, reject) => {
    const archive = spawn("git", ["-C", root, "archive", "origin/main", "frontend/src"], { stdio: ["ignore", "pipe", "inherit"] });
    const tar = spawn("tar", ["-x", "-C", cacheDir], { stdio: ["pipe", "inherit", "inherit"] });
    archive.stdout.pipe(tar.stdin);
    let archiveCode = null;
    let tarCode = null;
    const done = () => {
      if (archiveCode === null || tarCode === null) return;
      if (archiveCode === 0 && tarCode === 0) resolve();
      else reject(new Error(`git archive exit=${archiveCode}, tar exit=${tarCode}`));
    };
    archive.on("error", reject);
    tar.on("error", reject);
    archive.on("close", (c) => { archiveCode = c; done(); });
    tar.on("close", (c) => { tarCode = c; done(); });
  });

  writeFileSync(path.join(cacheDir, "SOURCE"), `${sha}\n`);
  console.log(`sa-sync: ${sha}`);
} catch (err) {
  fail(err.message);
}
