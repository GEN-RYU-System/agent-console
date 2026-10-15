// K4: WebGL を失っても使えるか（実 Chrome の loseContext）と、セッションを 20 回切り替えたときの警告・描き方。
// 使い方: AC_RUN_DIR=<runDir> node k4.mjs <evidenceDir>
import { writeFileSync, mkdirSync } from "node:fs";
import { launch, openPage, openSession, api, GET_TERM_SRC } from "./lib.mjs";
const OUT = process.argv[2];
mkdirSync(`${OUT}/k4`, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launch();
const result = { chrome: browser.version() };
const { ctx, page, port } = await openPage(browser, "webgl");
const consoleMsgs = [];
page.on("console", (m) => consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 300), t: Date.now() }));
const snap = () => page.evaluate(`(() => ({ renderer: document.querySelector('[data-testid="terminal"]').dataset.renderer, domRows: document.querySelectorAll('.xterm-rows > div').length, canvases: document.querySelectorAll('.xterm-screen canvas').length }))()`);

// 1. loseContext
const id1 = await openSession(page, port, "echo", `k4-a-${Date.now()}`);
await page.waitForFunction(`(() => { const t = ${GET_TERM_SRC}; return t && Array.from({length: t.rows}, (_, i) => t.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\\n").includes("READY"); })()`, null, { timeout: 30000 });
await sleep(1500);
result.before = await snap();
const lost = await page.evaluate(() => {
  const c = document.querySelector(".xterm-screen canvas");
  const gl = [...document.querySelectorAll(".xterm-screen canvas")].map((cv) => cv.getContext("webgl2")).find(Boolean);
  const ext = gl && gl.getExtension("WEBGL_lose_context");
  if (!ext) return { ok: false, canvas: !!c };
  ext.loseContext();
  return { ok: true, isLost: gl.isContextLost() };
});
result.loseContextCall = lost;
await sleep(5000);
result.after5s = await snap();
await page.locator(".xterm-screen").click();
const typed = `back${Date.now()}`;
await page.keyboard.type(typed);
await sleep(1500);
result.typedEchoed = await page.evaluate(`((s) => (document.querySelector('[data-testid="terminal"]').innerText || "").includes(s))(${JSON.stringify(typed)})`);
result.pass1 = lost.ok && result.after5s.domRows >= 1 && result.after5s.canvases === 0 && result.after5s.renderer === "dom" && result.typedEchoed;

// 2. 20 回切り替え（新しいページで、描き方が webgl の状態から）
const p2 = await openPage(browser, "webgl");
const msgs2 = [];
p2.page.on("console", (m) => msgs2.push({ type: m.type(), text: m.text().slice(0, 300) }));
const idA = await openSession(p2.page, p2.port, "echo", `k4-sw-a-${Date.now()}`);
const idB = (await api(p2.port, "POST", "/api/sessions", { name: `k4-sw-b-${Date.now()}`, roleId: "echo" })).json.id;
const rendererNow = () => p2.page.evaluate(() => document.querySelector('[data-testid="terminal"]').dataset.renderer);
const seq = [];
for (let i = 0; i < 20; i++) {
  const id = i % 2 === 0 ? idB : idA;
  await p2.page.locator(`[data-testid="session-row"][data-session-id="${id}"]`).click();
  await sleep(700);
  seq.push(await rendererNow());
}
result.switch = { renderersPerSwitch: seq, finalRenderer: await rendererNow(), tooMany: msgs2.filter((m) => /Too many active WebGL contexts/i.test(m.text)), webglMessages: msgs2.filter((m) => /webgl/i.test(m.text)), allWarnErr: msgs2.filter((m) => ["warning", "error"].includes(m.type)) };
result.pass2 = result.switch.tooMany.length === 0 && result.switch.finalRenderer === "webgl" && seq.every((s) => s === "webgl");
result.pass = result.pass1 && result.pass2;
result.consoleFirstPage = consoleMsgs.filter((m) => ["warning", "error"].includes(m.type));
await browser.close();
writeFileSync(`${OUT}/k4/k4-raw.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
