// scroll2 測定: 1ノッチ／30ノッチ／高速回転の真似を、(a) redraw 役 (b) 本物の claude で測る。
// 使い方: AC_RUN_DIR=/tmp/ac-scroll2/run node measure.mjs <role: redraw|claude> <outJson>
// 4 つの時刻（すべて同じページの performance.now()）:
//   wheel = window の wheel（capture）／send = WebSocket.send（input）／recv = WebSocket の message／render = term.onRender
import { writeFileSync } from "node:fs";
import { launch, pairCode, api, PORTS, GET_TERM_SRC, loadAvg, memPressure } from "./lib.mjs";

const [role, outFile] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spinUntil = async (target) => { for (;;) { const w = target - performance.now(); if (w <= 0) return; if (w > 3) await sleep(w - 2); } };

const INIT = `(() => {
  const R = (window.__rec = { wheel: [], send: [], recv: [], render: [], raf: [], on: false });
  window.__reset = () => { R.wheel = []; R.send = []; R.recv = []; R.render = []; R.raf = []; };
  const now = () => performance.now();
  const NativeWS = window.WebSocket;
  const te = new TextEncoder();
  window.WebSocket = class extends NativeWS {
    constructor(...a) {
      super(...a);
      if (String(a[0]).includes("/ws/term")) {
        this.addEventListener("message", (e) => { const t = now(); const s = typeof e.data === "string" ? e.data : ""; const m = /SIG:(\\d+)/.exec(s); R.recv.push({ t, bytes: te.encode(s).length, sig: m ? Number(m[1]) : null }); });
      }
    }
    send(d) {
      if (String(this.url).includes("/ws/term") && typeof d === "string") { const n = (d.match(/\\[<6[45];/g) || []).length; R.send.push({ t: now(), n, len: d.length }); }
      return super.send(d);
    }
  };
  window.addEventListener("wheel", (e) => { R.wheel.push({ t: now(), ts: e.timeStamp, trusted: e.isTrusted, dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, wdy: e.wheelDeltaY }); }, { capture: true, passive: true });
  const loop = (t) => { R.raf.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
})()`;

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2, bypassCSP: true });
await ctx.addInitScript(INIT);
await ctx.addInitScript(() => { try { localStorage.setItem("theme", "light"); } catch {} });
const page = await ctx.newPage();
const pwWs = { sent: 0, recv: 0 };
page.on("websocket", (ws) => { if (!ws.url().includes("/ws/term")) return; ws.on("framesent", (f) => { if (/\[<6[45];/.test(String(f.payload))) pwWs.sent += (String(f.payload).match(/\[<6[45];/g) || []).length; }); ws.on("framereceived", () => { pwWs.recv += 1; }); });
const port = PORTS.webgl;
await page.goto(`http://127.0.0.1:${port}/pair?code=${await pairCode(port)}`);
const r = await api(port, "POST", "/api/sessions", { name: `s2-${role}-${Date.now()}`, roleId: role });
if (r.status !== 201) throw new Error("create failed " + r.status);
await page.locator(`[data-testid="session-row"][data-session-id="${r.json.id}"]`).click();
await page.getByRole("tab", { name: /端末/ }).click();
await page.getByTestId("terminal").waitFor();
// 試験用フォルダの「信頼しますか」に Yes で答える（PO の設定ファイルは書き換えない）。WebGL は文字が DOM に無いので端末の中身を読む
const TXT = `(() => { const t = ${GET_TERM_SRC}; if (!t) return ""; const b = t.buffer.active; let s = ""; for (let i = 0; i < b.length; i++) s += (b.getLine(i)?.translateToString(true) ?? "") + "\\n"; return s; })()`;
for (let k = 0; k < 40; k++) { const txt = await page.evaluate(TXT); if (txt.includes("trust this folder")) { await page.locator(".xterm-screen").click(); await page.keyboard.press("ArrowDown"); await page.waitForTimeout(300); await page.keyboard.press("Enter"); console.log("trust answered"); break; } if (txt.includes("回答 ")) break; await page.waitForTimeout(500); }
await page.waitForFunction(`(() => { const t = ${GET_TERM_SRC}; return t && t.modes.mouseTrackingMode !== "none" && t.buffer.active.type === "alternate"; })()`, null, { timeout: 60000 }).catch(async (e) => { await page.screenshot({ path: outFile + ".fail.png" }); const st = await page.evaluate(`(() => { const t = ${GET_TERM_SRC}; return t ? { mode: t.modes.mouseTrackingMode, buf: t.buffer.active.type } : "no-term"; })()`); console.log("FAIL state", JSON.stringify(st)); throw e; });
await sleep(3000);
const env = await page.evaluate(`(() => { const t = ${GET_TERM_SRC}; const s = document.querySelector(".xterm-screen"); return { renderer: document.querySelector('[data-testid="terminal"]').dataset.renderer, cols: t.cols, rows: t.rows, cellH: s.clientHeight / t.rows, mode: t.modes.mouseTrackingMode, smooth: t.options.smoothScrollDuration, dpr: devicePixelRatio, chrome: navigator.userAgent }; })()`);
await page.evaluate(`(() => { const t = ${GET_TERM_SRC}; t.onRender(() => { window.__rec.render.push({ t: performance.now() }); }); })()`);
const box = await page.locator(".xterm-screen").boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await sleep(500);

async function run(name, plan, { settleMs = 1200, maxMs = 40000 } = {}) {
  await page.evaluate(() => window.__reset());
  const pre = { load: loadAvg(), mem: memPressure() };
  const t0 = performance.now() + 30;
  // 待たずに連続で投げる（await すると 1 件ごとに Chrome の応答待ちで約 33ms かかり、8ms 間隔にならない。実機の入力は OS から Chrome 本体のキューへ待たずに入る）
  const pend = [];
  for (const ev of plan) { await spinUntil(t0 + ev.at); pend.push(page.mouse.wheel(0, ev.dy)); }
  await Promise.all(pend);
  const tEnd = performance.now();
  // 送りも受けも描画も 1.2 秒止まったら終わり
  for (;;) {
    await sleep(150);
    const last = await page.evaluate(() => { const R = window.__rec; const a = [R.send.at(-1)?.t ?? 0, R.recv.at(-1)?.t ?? 0, R.render.at(-1)?.t ?? 0, R.wheel.at(-1)?.t ?? 0]; return { last: Math.max(...a), now: performance.now() }; });
    if (last.now - last.last > settleMs) break;
    if (performance.now() - tEnd > maxMs) break;
  }
  const rec = await page.evaluate(() => { const R = window.__rec; return { wheel: R.wheel, send: R.send, recv: R.recv, render: R.render, raf: R.raf }; });
  const smoothAfter = await page.evaluate(`(() => ${GET_TERM_SRC}.options.smoothScrollDuration)()`);
  const post = { load: loadAvg(), mem: memPressure() };
  console.log(`${role} ${name}: wheel=${rec.wheel.length} send=${rec.send.reduce((a, s) => a + s.n, 0)} recv=${rec.recv.length} render=${rec.render.length}`);
  return { name, planLen: plan.length, pre, post, smoothAfter, ...rec };
}

const mk = (n, interval, dy) => Array.from({ length: n }, (_, i) => ({ at: i * interval, dy }));
const oneLineDy = Math.round(env.cellH * 1.2);
const out = { role, env, startedAt: new Date().toISOString(), oneLineDy, scenarios: [] };
const S = out.scenarios;
const gap = async (ms) => sleep(ms);

// I: 何もしない 10 秒を 2 回（Mac の重さだけで Chrome のこま送りが乱れるかを見る）
for (let i = 0; i < 2; i++) { await page.evaluate(() => window.__reset()); const pre = { load: loadAvg(), mem: memPressure() }; await sleep(10000); const raf = await page.evaluate(() => window.__rec.raf); S.push({ group: "I-idle", name: "I-idle", pre, raf, wheel: [], send: [], recv: [], render: [] }); console.log(`idle raf=${raf.length}`); }
// A: 1行ぶん（信号1つ）を 12 回。上→下。信号1つあたりの出力回数・バイトを見る
for (const dir of [-1, 1]) for (let i = 0; i < 6; i++) { S.push({ group: "A-oneline", dir, ...(await run("A-oneline", mk(1, 0, dir * oneLineDy), { settleMs: 700 })) }); }
// B: 1ノッチ（dy=100）を 8 回。上下交互
for (let i = 0; i < 8; i++) { const dir = i % 2 === 0 ? -1 : 1; S.push({ group: "B-1notch", dir, ...(await run("B-1notch", mk(1, 0, dir * 100))) }); await gap(500); }
// C: 30ノッチ（dy=100、30ms 間隔）を 4 回。上下交互
for (let i = 0; i < 4; i++) { const dir = i % 2 === 0 ? -1 : 1; S.push({ group: "C-30notch", dir, ...(await run("C-30notch", mk(30, 30, dir * 100))) }); await gap(800); }
// D は時間短縮のため省いた（便0b）
out.pwWs = pwWs;
out.finishedAt = new Date().toISOString();
writeFileSync(outFile, JSON.stringify(out));
await browser.close();
console.log("saved", outFile);
