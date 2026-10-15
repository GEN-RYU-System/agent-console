// 測定の共通部品。Playwright は作業場所の node_modules から読む。
import { chromium } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

export const RUN = process.env.AC_RUN_DIR;
export const servers = () => JSON.parse(readFileSync(`${RUN}/servers.json`, "utf8"));
export const TOKEN = () => servers().token;
export const PORTS = { dom: 4392, webgl: 4393 };
const proofC = (s, c, n) => createHmac("sha256", s).update(`client|${n}|${c}`).digest("hex");

export async function pairCode(port) {
  const B = `http://127.0.0.1:${port}`, cnonce = "ab".repeat(16);
  const ch = await (await fetch(`${B}/api/pair/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cnonce }) })).json();
  const r = await (await fetch(`${B}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cnonce, snonce: ch.snonce, proof: proofC(TOKEN(), cnonce, ch.snonce) }) })).json();
  return r.code;
}
export const api = async (port, method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
export const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
export const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
export const loadAvg = () => sh("uptime").replace(/.*load averages?: /, "");
export const memPressure = () => sh("memory_pressure | tail -1");

export async function launch() {
  return chromium.launch({ channel: "chrome", headless: false, args: ["--ignore-gpu-blocklist"] });
}

/** 新しい文脈とページを作り、ペアリングして端末タブを開く */
export async function openPage(browser, variant, { theme = "light", dpr = 2 } = {}) {
  const port = PORTS[variant];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr, bypassCSP: true });
  await ctx.addInitScript((th) => { try { localStorage.setItem("theme", th); } catch { /* 無視 */ } }, theme);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/pair?code=${await pairCode(port)}`);
  await page.getByRole("tab", { name: /端末/ }).click();
  return { ctx, page, port };
}

/** セッションを作って開き、画面に出るまで待つ。名前でクリックする */
export async function openSession(page, port, roleId, name) {
  const r = await api(port, "POST", "/api/sessions", { name, roleId });
  if (r.status !== 201) throw new Error(`create session failed ${r.status}`);
  await page.locator(`[data-testid="session-row"][data-session-id="${r.json.id}"]`).click();
  await page.getByTestId("terminal").waitFor();
  return r.json.id;
}

/** React の fiber をたどって TerminalPane の term を取る（本番コードに公開用の口は足さない）。evaluate の中で実行する関数 */
export const GET_TERM_SRC = `(() => {
  const host = document.querySelector('[data-testid="terminal"]');
  if (!host) return null;
  const key = Object.keys(host).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return null;
  for (let f = host[key]; f; f = f.return) {
    for (let h = f.memoizedState; h && typeof h === "object"; h = h.next) {
      const v = h.memoizedState;
      if (v && typeof v === "object" && v.current && v.current.term && v.current.sessionId) return v.current.term;
    }
  }
  return null;
})()`;
