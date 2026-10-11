// Usage: node ops/launcher/icon/render.mjs <output.png>
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) {
  console.error('usage: node render.mjs <output.png>');
  process.exit(2);
}
const svgPath = join(dirname(fileURLToPath(import.meta.url)), 'agent-console-icon.svg');
const svg = readFileSync(svgPath, 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`,
  );
  await page.screenshot({ path: resolve(out), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
} finally {
  await browser.close();
}
console.log(`wrote ${resolve(out)}`);
