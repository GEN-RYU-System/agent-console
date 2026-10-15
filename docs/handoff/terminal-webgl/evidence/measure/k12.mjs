// K1（ホイールでの描き直し）と K2（IME 確定から描画まで）の測定。
// 使い方: AC_RUN_DIR=<runDir> node k12.mjs smoke|k1|k2 <outDir>
// まとめ方（LPW: 組ごとに中央値を出し、その 4 つの中央値を取る）は evidence/README.md の冒頭に書いた。
import { writeFileSync, mkdirSync } from "node:fs";
import { launch, openPage, openSession, GET_TERM_SRC, median, loadAvg, memPressure } from "./lib.mjs";

const [mode, outDir = "."] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTCHES = 30, INTERVAL = 30, PAIRS = 4, IME_TRIALS = 12;

async function gpuInfo(page) {
  return page.evaluate(() => { const c = document.createElement("canvas"); const g = c.getContext("webgl2"); const e = g.getExtension("WEBGL_debug_renderer_info"); return { renderer: g.getParameter(e.UNMASKED_RENDERER_WEBGL), vendor: g.getParameter(e.UNMASKED_VENDOR_WEBGL) }; });
}
const rendererCpu = async (cdp) => {
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  const sum = (t) => processInfo.filter((p) => p.type === t).reduce((a, p) => a + p.cpuTime, 0);
  return { renderer: sum("renderer"), gpu: sum("GPU"), nRenderer: processInfo.filter((p) => p.type === "renderer").length };
};

async function k1Trial(browser, variant) {
  const { ctx, page, port } = await openPage(browser, variant);
  try {
    await openSession(page, port, "redraw", `k1-${variant}-${Date.now()}`);
    await page.waitForFunction(`(() => { const t = ${GET_TERM_SRC}; return t && /SIG:0/.test(t.buffer.active.getLine(0)?.translateToString(true) ?? ""); })()`, null, { timeout: 30000 });
    await sleep(2000);
    const env = await page.evaluate(`(() => { const t = ${GET_TERM_SRC}; return { renderer: document.querySelector('[data-testid="terminal"]').dataset.renderer, cols: t.cols, rows: t.rows, canvases: document.querySelectorAll('.xterm-screen canvas').length, domRows: document.querySelectorAll('.xterm-rows > div').length }; })()`);
    await page.evaluate(`(() => {
      const t = ${GET_TERM_SRC};
      const m = (window.__m = { frames: [], longtasks: [], renders: [], w0: null });
      const loop = (now) => { m.frames.push(now); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      new PerformanceObserver((l) => { for (const e of l.getEntries()) m.longtasks.push([e.startTime, e.duration]); }).observe({ entryTypes: ["longtask"] });
      t.onRender(() => { const h = t.buffer.active.getLine(0)?.translateToString(true) ?? ""; const x = /SIG:(\\d+)/.exec(h); m.renders.push([performance.now(), x ? Number(x[1]) : -1]); });
      window.addEventListener("wheel", () => { if (m.w0 === null) m.w0 = performance.now(); }, { capture: true, passive: true });
    })()`);
    const box = await page.locator(".xterm-screen").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(500);
    const cdp = await browser.newBrowserCDPSession();
    const cpu0 = await rendererCpu(cdp);
    const t0 = performance.now();
    for (let i = 0; i < NOTCHES; i++) {
      const target = t0 + i * INTERVAL;
      const wait = target - performance.now();
      if (wait > 0) await sleep(wait);
      await page.mouse.wheel(0, 100);
    }
    // 信号の総数が 1.5 秒変わらなくなるまで待つ
    let last = -2, since = Date.now();
    for (;;) {
      await sleep(100);
      const cur = await page.evaluate(`(() => { const t = ${GET_TERM_SRC}; const x = /SIG:(\\d+)/.exec(t.buffer.active.getLine(0)?.translateToString(true) ?? ""); return x ? Number(x[1]) : -1; })()`);
      if (cur !== last) { last = cur; since = Date.now(); }
      if (Date.now() - since > 1500 && last > 0) break;
      if (Date.now() - t0 > 60000) break;
    }
    const cpu1 = await rendererCpu(cdp);
    const m = await page.evaluate(() => window.__m);
    const final = last;
    const endRender = m.renders.find((r) => r[1] === final);
    const tEnd = endRender ? endRender[0] : null;
    const span = tEnd !== null ? tEnd - m.w0 : null;
    const win = m.frames.filter((f) => f >= m.w0 && f <= tEnd);
    const deltas = win.slice(1).map((f, i) => f - win[i]);
    const over33 = deltas.filter((d) => d > 33.4).length;
    const lt = m.longtasks.filter(([s]) => s >= m.w0 - 50 && s <= tEnd);
    const cpuRenderer = cpu1.renderer - cpu0.renderer;
    return { variant, env, signals: final, rows: env.rows, spanMs: span, framesOver33: over33, framesInWindow: deltas.length, rendererCpuSec: cpuRenderer, gpuCpuSec: cpu1.gpu - cpu0.gpu, nRenderer: cpu1.nRenderer, cpuPerRowMs: (cpuRenderer * 1000) / (final * env.rows), longtaskMaxMs: lt.length ? Math.max(...lt.map((x) => x[1])) : 0, longtaskCount: lt.length, maxFrameDeltaMs: deltas.length ? Math.max(...deltas) : 0 };
  } finally { await ctx.close(); }
}

async function k2Trial(browser, variant) {
  const { ctx, page, port } = await openPage(browser, variant);
  const times = [];
  try {
    await openSession(page, port, "echo", `k2-${variant}-${Date.now()}`);
    await page.waitForFunction(`(() => { const t = ${GET_TERM_SRC}; return t && /READY/.test(Array.from({length: t.rows}, (_, i) => t.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\\n")); })()`, null, { timeout: 30000 });
    await sleep(1500);
    const env = await page.evaluate(`(() => { const t = ${GET_TERM_SRC}; return { renderer: document.querySelector('[data-testid="terminal"]').dataset.renderer, cols: t.cols, rows: t.rows }; })()`);
    await page.locator(".xterm-screen").click();
    const cdp = await ctx.newCDPSession(page);
    for (let i = 0; i < IME_TRIALS; i++) {
      const marker = `試験${String.fromCharCode(65 + i)}${i}`;
      await page.evaluate(`(() => {
        const t = ${GET_TERM_SRC};
        const k = (window.__k2 = { t0: null, t1: null, marker: ${JSON.stringify(marker)}, sub: null });
        const ta = t.textarea;
        const onEnd = () => { k.t0 = performance.now(); ta.removeEventListener("compositionend", onEnd, true); };
        ta.addEventListener("compositionend", onEnd, true);
        k.sub = t.onRender(() => {
          if (k.t0 === null || k.t1 !== null) return;
          for (let r = 0; r < t.rows; r++) { if ((t.buffer.active.getLine(r)?.translateToString(true) ?? "").includes(k.marker)) { k.t1 = performance.now(); break; } }
        });
      })()`);
      await cdp.send("Input.imeSetComposition", { text: "しけん", selectionStart: 3, selectionEnd: 3 });
      await sleep(80);
      await cdp.send("Input.insertText", { text: marker });
      await page.waitForFunction(() => window.__k2.t1 !== null, null, { timeout: 15000 }).catch(() => {});
      const r = await page.evaluate(() => { window.__k2.sub.dispose(); return { t0: window.__k2.t0, t1: window.__k2.t1 }; });
      times.push(r.t0 !== null && r.t1 !== null ? r.t1 - r.t0 : null);
      await sleep(400);
    }
    return { variant, env, commitToRenderMs: times };
  } finally { await ctx.close(); }
}

const browser = await launch();
const out = { chrome: browser.version(), startedAt: new Date().toISOString(), mode };
try {
  if (mode === "smoke") {
    const { ctx, page } = await openPage(browser, "webgl");
    out.gpu = await gpuInfo(page);
    await ctx.close();
    out.k1 = [await k1Trial(browser, "dom"), await k1Trial(browser, "webgl")];
    out.k2 = [await k2Trial(browser, "dom"), await k2Trial(browser, "webgl")];
  } else {
    const { ctx, page } = await openPage(browser, "webgl");
    out.gpu = await gpuInfo(page);
    await ctx.close();
    out.pairs = [];
    for (let p = 1; p <= PAIRS; p++) {
      const pair = { pair: p, load: loadAvg(), mem: memPressure(), trials: {} };
      for (const v of ["dom", "webgl"]) pair.trials[v] = mode === "k1" ? await k1Trial(browser, v) : await k2Trial(browser, v);
      pair.loadAfter = loadAvg();
      out.pairs.push(pair);
      console.log(`pair ${p} done`);
    }
  }
} finally {
  await browser.close();
  out.finishedAt = new Date().toISOString();
  writeFileSync(`${outDir}/${mode}-raw.json`, JSON.stringify(out, null, 2));
}
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
