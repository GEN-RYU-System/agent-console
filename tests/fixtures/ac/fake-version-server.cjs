// スクリプトのテスト用: 各「版」の dist-server/server/index.js の代わりになる偽サーバー。
// /healthz に ok、/version に版を返す。FAKE_* で失敗を再現する。
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
const tag = pkg.version;
const port = Number(process.env.AGENT_CONSOLE_PORT);
// 環境変数のタグは v 付き（v9.9.9）でも無し（9.9.9）でもよい
const listed = (name) => (process.env[name] || "").split(",").some((t) => t === tag || t === `v${tag}`);

if (listed("FAKE_BAD_TAGS")) {
  console.error("fake server: this version is broken");
  process.exit(1);
}
// 本番ポートでだけ失敗する版（自己診断は通るが、切替後の起動確認で失敗する）
if (process.env.FAKE_MAIN === "1" && listed("FAKE_FAIL_MAIN_TAGS")) {
  console.error("fake server: fails on the main port");
  process.exit(1);
}

let commit = "";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
} catch {
  commit = "";
}

http
  .createServer((req, res) => {
    // 本物のサーバーと同じ形式（version は package.json の値）
    if (req.url === "/healthz") return res.end(JSON.stringify({ ok: true, version: tag, commit }));
    if (req.url === "/version") return res.end(`v${tag}`);
    res.statusCode = 404;
    res.end();
  })
  .listen(port, "127.0.0.1");
