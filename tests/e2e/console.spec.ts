import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import WebSocket from "ws";
import { E2E_PORT, E2E_TOKEN } from "../fixtures/e2e-env";

const ROOT = process.env.AC_E2E_ROOT as string;
const STATUS_FILE = process.env.AC_E2E_STATUS_FILE as string;
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const PAGE_URL = `${BASE}/?t=${E2E_TOKEN}`;

const MAX_SERVER_RSS_MB = 150;
const MAX_JS_HEAP_MB = 80;
const STATE_DEADLINE_MS = 5000;

function sha256OrNull(file: string): string | null {
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
}

// ロケーターは exact で、フォーム内に限定する（一覧の状態ラベル「Claude 未起動」などと衝突させない）
const openForm = async (page: Page) => {
  await page.getByRole("button", { name: "新しいセッション", exact: true }).click();
  return page.getByTestId("new-session-form");
};

async function createViaUi(page: Page, name: string, role: "e2e-plain" | "e2e-wt", branch?: string): Promise<void> {
  const form = await openForm(page);
  await form.getByLabel("名前", { exact: false }).fill(name);
  await form.getByLabel("役割", { exact: false }).selectOption(role);
  if (branch) await form.getByLabel("ブランチ名", { exact: false }).fill(branch);
  await form.getByRole("button", { name: "起動", exact: true }).click();
}

async function apiCreate(name: string, roleId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, roleId }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const settingsHashBefore = sha256OrNull(path.join(os.homedir(), ".claude", "settings.json"));
const claudeJsonHashBefore = sha256OrNull(path.join(os.homedir(), ".claude.json"));

test.describe.configure({ mode: "serial" });

test("K2: 新しいセッション -> ワークツリー作成 -> 役割コマンドが端末に出て入力できる", async ({ page }) => {
  await page.goto(PAGE_URL);
  await createViaUi(page, "wt-session", "e2e-wt", "release/e2e-one");
  const terminal = page.getByTestId("terminal");
  await expect(terminal).toContainText("READY");
  await expect(terminal).toContainText("repo-wt/release-e2e-one");
  await terminal.click();
  await page.keyboard.type("hello-from-e2e");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("hello-from-e2e");
  const branches = execFileSync("git", ["-C", ROOT, "branch", "--list", "release/e2e-one"], { encoding: "utf8" });
  expect(branches).toContain("release/e2e-one");
});

test("K2: 不正なブランチ名は作成されずエラーが画面に出る", async ({ page }) => {
  await page.goto(PAGE_URL);
  const form = await openForm(page);
  await form.getByLabel("名前", { exact: false }).fill("bad");
  await form.getByLabel("役割", { exact: false }).selectOption("e2e-wt");
  await form.getByLabel("ブランチ名", { exact: false }).fill("release/Bad;rm");
  await form.getByRole("button", { name: "起動", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("branch");
  await expect(page.getByTestId("session-row")).toHaveCount(1);
});

test("K3: タブを開き直しても同じセッションの直近出力が戻る", async ({ page }) => {
  await page.goto(PAGE_URL);
  const row = page.getByTestId("session-row").first();
  await expect(row).toBeVisible();
  await page.reload();
  await page.getByTestId("session-row").first().click();
  const terminal = page.getByTestId("terminal");
  await expect(terminal).toContainText("READY");
  await expect(terminal).toContainText("hello-from-e2e");
});

test("K1: 一覧の状態が claude agents --json の status と 5 秒以内に一致する", async ({ page }) => {
  await page.goto(PAGE_URL);
  const state = page.getByTestId("session-row").first().getByTestId("status");
  writeFileSync(STATUS_FILE, "busy");
  await expect(state).toHaveAttribute("data-state", "working", { timeout: STATE_DEADLINE_MS });
  writeFileSync(STATUS_FILE, "waiting");
  await expect(state).toHaveAttribute("data-state", "waiting", { timeout: STATE_DEADLINE_MS });
  writeFileSync(STATUS_FILE, "idle");
  await expect(state).toHaveAttribute("data-state", "idle", { timeout: STATE_DEADLINE_MS });
});

test("K4: 台帳ボードの件数が ledger-lookup.sh で引いた値と一致する", async ({ page }) => {
  const dir = path.join(ROOT, ".claude-pipeline", "active-work.d");
  const expected: Record<string, number> = { IN_PROGRESS: 0, REVIEW: 0, DONE: 0, OTHER: 0, UNREGISTERED: 0 };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const branch = readFileSync(path.join(dir, file), "utf8").split("\n")[0].replace("branch: ", "").trim();
    let state: string;
    try {
      const out = execFileSync("bash", [path.join(ROOT, "scripts/ledger-lookup.sh"), branch], { cwd: ROOT, encoding: "utf8" });
      state = out.split("|").map((c) => c.trim()).filter((_, i) => i !== 0 || out.split("|")[0].trim() !== "")[3];
    } catch {
      state = "UNREGISTERED";
    }
    const column = ["IN_PROGRESS", "REVIEW", "DONE", "UNREGISTERED"].includes(state) ? state : "OTHER";
    expected[column] += 1;
  }
  await page.goto(PAGE_URL);
  await page.getByRole("button", { name: "更新", exact: true }).click();
  for (const [column, count] of Object.entries(expected)) {
    await expect(page.getByTestId(`ledger-col-${column}`)).toHaveAttribute("data-count", String(count));
  }
  // K2 で作ったブランチ分（IN_PROGRESS）が含まれていること
  expect(expected.IN_PROGRESS).toBe(3);
});

test("停止したセッションは「停止」と表示され、一覧から外せる", async ({ page }) => {
  await apiCreate("short-lived", "e2e-short");
  await page.goto(PAGE_URL);
  const row = page.getByTestId("session-row").filter({ hasText: "short-lived" });
  await expect(row.getByTestId("status")).toHaveAttribute("data-state", "stopped", { timeout: STATE_DEADLINE_MS });
  await expect(row.getByText("停止", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "一覧から外す", exact: true }).click();
  await expect(page.getByTestId("session-row").filter({ hasText: "short-lived" })).toHaveCount(0);
  // 実行中のセッションには外すボタンが無い
  await expect(page.getByRole("button", { name: "一覧から外す", exact: true })).toHaveCount(0);
});

test.fixme("端末の文字間隔が正常（xterm の letter-spacing が 1px 未満）— 等幅フォントの指定方法が NEEDS_DECISION（総称名 monospace では xterm の計測がずれる）", async ({ page }) => {
  await page.goto(PAGE_URL);
  await page.getByTestId("session-row").first().click();
  await expect(page.getByTestId("terminal")).toContainText("READY");
  const spacing = await page.evaluate(() =>
    Math.max(...[...document.querySelectorAll(".xterm-rows > div > span")].map((s) => Math.abs(parseFloat((s as HTMLElement).style.letterSpacing || "0")))),
  );
  expect(spacing).toBeLessThan(1);
});

test("K8: 不正トークンは 401、不正 Origin の WebSocket は 403、待受は 127.0.0.1 のみ", async () => {
  const bad = await fetch(`${BASE}/api/state?t=wrong`);
  expect(bad.status).toBe(401);
  const none = await fetch(`${BASE}/api/state`);
  expect(none.status).toBe(401);
  const ok = await fetch(`${BASE}/api/state`, { headers: { Authorization: `Bearer ${E2E_TOKEN}` } });
  expect(ok.status).toBe(200);

  const wsStatus = (url: string, origin?: string): Promise<number> =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, { headers: origin ? { Origin: origin } : {} });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => {
        ws.close();
        resolve(101);
      });
      ws.on("error", () => undefined);
    });
  const wsBase = `ws://127.0.0.1:${E2E_PORT}/ws/events`;
  expect(await wsStatus(`${wsBase}?t=wrong`, BASE)).toBe(401);
  expect(await wsStatus(`${wsBase}?t=${E2E_TOKEN}`, "http://evil.example")).toBe(403);
  expect(await wsStatus(`${wsBase}?t=${E2E_TOKEN}`)).toBe(403);
  expect(await wsStatus(`${wsBase}?t=${E2E_TOKEN}`, BASE)).toBe(101);

  const listeners = execFileSync("lsof", ["-nP", `-iTCP:${E2E_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  const addresses = listeners.split("\n").slice(1).filter(Boolean).map((l) => l.split(/\s+/).slice(-2)[0]);
  expect(addresses.length).toBeGreaterThan(0);
  for (const addr of addresses) expect(addr).toBe(`127.0.0.1:${E2E_PORT}`);
});

test("K7: ダミーセッション 3 本で サーバー RSS <= 150MB かつ ブラウザ JS ヒープ <= 80MB", async ({ page }) => {
  const existing = await (await fetch(`${BASE}/api/state`, { headers: { Authorization: `Bearer ${E2E_TOKEN}` } })).json();
  const need = Math.max(0, 3 - (existing as { sessions: unknown[] }).sessions.length);
  for (let i = 0; i < need; i++) await apiCreate(`mem-${i}`, "e2e-plain");

  await page.goto(PAGE_URL);
  await expect(page.getByTestId("session-row")).toHaveCount(3);
  await page.getByTestId("session-row").nth(2).click();
  await expect(page.getByTestId("terminal")).toContainText("READY");

  const pid = execFileSync("lsof", ["-ti", `tcp:${E2E_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
  const rssMb = Number(execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" }).trim()) / 1024;

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
  const heapMb = (metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? Number.NaN) / 1024 / 1024;

  console.log(`K7 server_rss_mb=${rssMb.toFixed(1)} (limit ${MAX_SERVER_RSS_MB}) js_heap_used_mb=${heapMb.toFixed(1)} (limit ${MAX_JS_HEAP_MB})`);
  expect(rssMb).toBeLessThanOrEqual(MAX_SERVER_RSS_MB);
  expect(heapMb).toBeLessThanOrEqual(MAX_JS_HEAP_MB);
});

test("K5: テスト前後で ~/.claude/settings.json と ~/.claude.json のハッシュが変わらない", async () => {
  const settingsAfter = sha256OrNull(path.join(os.homedir(), ".claude", "settings.json"));
  const claudeJsonAfter = sha256OrNull(path.join(os.homedir(), ".claude.json"));
  test.skip(settingsHashBefore === null && claudeJsonHashBefore === null, "~/.claude/settings.json と ~/.claude.json が存在しない環境のためスキップ");
  expect(settingsAfter).toBe(settingsHashBefore);
  expect(claudeJsonAfter).toBe(claudeJsonHashBefore);
});

test("フッターに Sales Anchor 展開元 SHA と claude --version が出る", async ({ page }) => {
  await page.goto(PAGE_URL);
  const sha = readFileSync(path.join(process.cwd(), ".sa-cache", "SOURCE"), "utf8").trim();
  await expect(page.getByTestId("sa-source")).toContainText(sha.slice(0, 12));
  await expect(page.getByTestId("claude-version")).toContainText("0.0.0-stub");
});
