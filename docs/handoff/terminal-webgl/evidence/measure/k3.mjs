// K3: 同じ画面を DOM と WebGL、ライトとダークで撮る。表示したままライト→ダークに切り替えた後の 1 枚も撮る。
// 使い方: AC_RUN_DIR=<runDir> node k3.mjs <evidenceDir>
import { writeFileSync, mkdirSync } from "node:fs";
import { launch, openPage, openSession, GET_TERM_SRC } from "./lib.mjs";

const OUT = process.argv[2];
mkdirSync(`${OUT}/k3`, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launch();
const result = { chrome: browser.version(), shots: [] };

async function ready(page) {
  await page.waitForFunction(`(() => { const t = ${GET_TERM_SRC}; return t && Array.from({length: t.rows}, (_, i) => t.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\\n").includes("VISUAL-DONE"); })()`, null, { timeout: 40000 });
  await sleep(2000);
}
const state = (page) => page.evaluate(`(() => { const t = ${GET_TERM_SRC}; const host = document.querySelector('[data-testid="terminal"]'); return { dataRenderer: host.dataset.renderer, cols: t.cols, rows: t.rows, canvases: document.querySelectorAll('.xterm-screen canvas').length, domRows: document.querySelectorAll('.xterm-rows > div').length, dark: document.documentElement.classList.contains('force-dark'), bg: t.options.theme.background, fg: t.options.theme.foreground, text: Array.from({length: 17}, (_, i) => t.buffer.active.getLine(i)?.translateToString(true)) }; })()`);
async function shot(page, name, extra) {
  await page.mouse.move(5, 5);
  const st = await state(page);
  const file = `${OUT}/k3/${name}.png`;
  await page.getByTestId("terminal").screenshot({ path: file });
  result.shots.push({ name, file, ...st, ...extra });
}

for (const variant of ["dom", "webgl"]) {
  for (const theme of ["light", "dark"]) {
    const { ctx, page, port } = await openPage(browser, variant, { theme });
    await openSession(page, port, "visual", `k3-${variant}-${theme}-${Date.now()}`);
    await ready(page);
    await shot(page, `${variant}-${theme}`, { variant, theme, kind: "static" });
    await ctx.close();
  }
  // 表示したまま ライト → ダーク
  const { ctx, page, port } = await openPage(browser, variant, { theme: "light" });
  await openSession(page, port, "visual", `k3-${variant}-switch-${Date.now()}`);
  await ready(page);
  const btn = page.locator("footer button[aria-pressed], [aria-pressed]").filter({ has: page.locator("svg, img") }).first();
  const label = await btn.getAttribute("aria-label");
  await btn.click();
  await sleep(1500);
  await shot(page, `${variant}-light-to-dark`, { variant, theme: "light->dark", kind: "switched", toggleLabel: label });
  await ctx.close();
}
await browser.close();
writeFileSync(`${OUT}/k3/k3-raw.json`, JSON.stringify(result, null, 2));
console.log(result.shots.map((s) => `${s.name}: renderer=${s.dataRenderer} cols=${s.cols} rows=${s.rows} dark=${s.dark} canvases=${s.canvases} domRows=${s.domRows}`).join("\n"));
