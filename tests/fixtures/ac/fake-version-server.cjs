// スクリプトのテスト用: 各「版」の dist-server/server/index.js の代わりになる偽サーバー。
// /healthz に ok、/version に版を返す。FAKE_* で失敗を再現する。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
const tag = pkg.version;
const port = Number(process.env.AGENT_CONSOLE_PORT);

if ((process.env.FAKE_BAD_TAGS || "").split(",").includes(tag)) {
  console.error("fake server: this version is broken");
  process.exit(1);
}
// 本番ポートでだけ失敗する版（自己診断は通るが、切替後の起動確認で失敗する）
if (process.env.FAKE_MAIN === "1" && (process.env.FAKE_FAIL_MAIN_TAGS || "").split(",").includes(tag)) {
  console.error("fake server: fails on the main port");
  process.exit(1);
}

http
  .createServer((req, res) => {
    if (req.url === "/healthz") return res.end("ok");
    if (req.url === "/version") return res.end(tag);
    res.statusCode = 404;
    res.end();
  })
  .listen(port, "127.0.0.1");
