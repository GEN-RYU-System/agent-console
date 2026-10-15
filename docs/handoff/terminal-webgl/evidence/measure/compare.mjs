// 左右に並べた比較画像（上にラベル）を作る。使い方: node compare.mjs <evidenceDir>
import { chromium } from "@playwright/test";
import { writeFileSync, readFileSync } from "node:fs";
const OUT = process.argv[2];
const raw = JSON.parse(readFileSync(`${OUT}/k3/k3-raw.json`, "utf8"));
const colsOf = (n) => raw.shots.find((s) => s.name === n);
const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const key of ["light", "dark", "light-to-dark"]) {
  const d = colsOf(`dom-${key}`), g = colsOf(`webgl-${key}`);
  const b64 = (f) => readFileSync(f).toString("base64");
  const html = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#888;font:600 28px sans-serif;color:#000"><div style="display:flex;gap:16px;padding:16px">
  <div><div style="background:#fff;padding:8px 12px">今の描き方（DOM）: ${d.cols} 列 x ${d.rows} 行 / ${key}</div><img style="width:1624px;display:block" src="data:image/png;base64,${b64(d.file)}"></div>
  <div><div style="background:#fff;padding:8px 12px">GPU の描き方（WebGL）: ${g.cols} 列 x ${g.rows} 行 / ${key}</div><img style="width:1624px;display:block" src="data:image/png;base64,${b64(g.file)}"></div></div>`;
  const page = await browser.newPage({ viewport: { width: 3300, height: 1000 } });
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/k3/compare-${key}.png`, fullPage: true });
  await page.close();
}
await browser.close();
