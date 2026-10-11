import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import WebSocket from "ws";
import { clientProof } from "../../server/pair-proof";
import { E2E_PORT, E2E_TOKEN } from "../fixtures/e2e-env";

const ROOT = process.env.AC_E2E_ROOT as string;
const STATUS_FILE = process.env.AC_E2E_STATUS_FILE as string;
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const BEARER = { Authorization: `Bearer ${E2E_TOKEN}` };

/** launcher と同じ相互認証（チャレンジ → サーバー証明の検証 → クライアント証明）で 1 回限りコードを発行する。 */
async function newPairingCode(): Promise<string> {
  const cnonce = "ab".repeat(16);
  const challenge = await fetch(`${BASE}/api/pair/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cnonce }) });
  expect(challenge.status).toBe(200);
  const { snonce } = (await challenge.json()) as { snonce: string };
  const res = await fetch(`${BASE}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cnonce, snonce, proof: clientProof(E2E_TOKEN, cnonce, snonce) }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

async function openPaired(page: Page): Promise<void> {
  await page.goto(`${BASE}/pair?code=${await newPairingCode()}`);
  await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
}

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
  await openPaired(page);
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
  await openPaired(page);
  const form = await openForm(page);
  await form.getByLabel("名前", { exact: false }).fill("bad");
  await form.getByLabel("役割", { exact: false }).selectOption("e2e-wt");
  await form.getByLabel("ブランチ名", { exact: false }).fill("release/Bad;rm");
  await form.getByRole("button", { name: "起動", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("branch");
  await expect(page.getByTestId("session-row")).toHaveCount(1);
});

test("K3: タブを開き直しても同じセッションの直近出力が戻る", async ({ page }) => {
  await openPaired(page);
  const row = page.getByTestId("session-row").first();
  await expect(row).toBeVisible();
  await page.reload();
  await page.getByTestId("session-row").first().click();
  const terminal = page.getByTestId("terminal");
  await expect(terminal).toContainText("READY");
  await expect(terminal).toContainText("hello-from-e2e");
});

test("K1: 一覧の状態が claude agents --json の status と 5 秒以内に一致する", async ({ page }) => {
  await openPaired(page);
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
  await openPaired(page);
  await page.getByRole("button", { name: "更新", exact: true }).click();
  for (const [column, count] of Object.entries(expected)) {
    await expect(page.getByTestId(`ledger-col-${column}`)).toHaveAttribute("data-count", String(count));
  }
  // K2 で作ったブランチ分（IN_PROGRESS）が含まれていること
  expect(expected.IN_PROGRESS).toBe(3);
});

test("停止したセッションは「停止」と表示され、一覧から外せる", async ({ page }) => {
  await apiCreate("short-lived", "e2e-short");
  await openPaired(page);
  const row = page.getByTestId("session-row").filter({ hasText: "short-lived" });
  await expect(row.getByTestId("status")).toHaveAttribute("data-state", "stopped", { timeout: STATE_DEADLINE_MS });
  await expect(row.getByText("停止", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "一覧から外す", exact: true }).click();
  await expect(page.getByTestId("session-row").filter({ hasText: "short-lived" })).toHaveCount(0);
  // 実行中のセッションには外すボタンが無い
  await expect(page.getByRole("button", { name: "一覧から外す", exact: true })).toHaveCount(0);
});

test("端末の文字間隔が正常（xterm の letter-spacing が 1px 未満）", async ({ page }) => {
  await openPaired(page);
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
  // ?t=（URL の秘密）は廃止: 正しい秘密を付けても 401
  expect((await fetch(`${BASE}/api/state?t=${E2E_TOKEN}`)).status).toBe(401);
  const none = await fetch(`${BASE}/api/state`);
  expect(none.status).toBe(401);
  const ok = await fetch(`${BASE}/api/state`, { headers: { Authorization: `Bearer ${E2E_TOKEN}` } });
  expect(ok.status).toBe(200);

  const wsStatus = (url: string, origin?: string, extra: Record<string, string> = {}): Promise<number> =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, { headers: { ...(origin ? { Origin: origin } : {}), ...extra } });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => {
        ws.close();
        resolve(101);
      });
      ws.on("error", () => undefined);
    });
  const wsBase = `ws://127.0.0.1:${E2E_PORT}/ws/events`;
  expect(await wsStatus(wsBase, BASE, { Authorization: "Bearer wrong" })).toBe(401);
  expect(await wsStatus(`${wsBase}?t=${E2E_TOKEN}`, BASE)).toBe(401);
  expect(await wsStatus(wsBase, "http://evil.example", BEARER)).toBe(403);
  expect(await wsStatus(wsBase, undefined, BEARER)).toBe(403);
  expect(await wsStatus(wsBase, BASE, BEARER)).toBe(101);

  const listeners = execFileSync("lsof", ["-nP", `-iTCP:${E2E_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  const addresses = listeners.split("\n").slice(1).filter(Boolean).map((l) => l.split(/\s+/).slice(-2)[0]);
  expect(addresses.length).toBeGreaterThan(0);
  for (const addr of addresses) expect(addr).toBe(`127.0.0.1:${E2E_PORT}`);
});

test("K7: ダミーセッション 3 本で サーバー RSS <= 150MB かつ ブラウザ JS ヒープ <= 80MB", async ({ page }) => {
  const existing = await (await fetch(`${BASE}/api/state`, { headers: { Authorization: `Bearer ${E2E_TOKEN}` } })).json();
  const need = Math.max(0, 3 - (existing as { sessions: unknown[] }).sessions.length);
  for (let i = 0; i < need; i++) await apiCreate(`mem-${i}`, "e2e-plain");

  await openPaired(page);
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
  await openPaired(page);
  const sha = readFileSync(path.join(process.cwd(), ".sa-cache", "SOURCE"), "utf8").trim();
  await expect(page.getByTestId("sa-source")).toContainText(sha.slice(0, 12));
  await expect(page.getByTestId("claude-version")).toContainText("0.0.0-stub");
  const { version } = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
  await expect(page.getByTestId("app-version")).toContainText(version);
  await expect(page.getByTestId("commit")).toContainText(
    execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim(),
  );
});

test("ペアリング: /pair?code で一覧が開き、URL に秘密もコードも残らず、トークンは sessionStorage のみ（Cookie 無し）", async ({ page, context }) => {
  const code = await newPairingCode();
  await page.goto(`${BASE}/pair?code=${code}`);
  await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
  const url = page.url();
  expect(url).toBe(`${BASE}/`);
  expect(url).not.toContain(code);
  expect(url).not.toContain(E2E_TOKEN);
  // セッショントークンはタブの sessionStorage にだけある。長期秘密ではない
  const stored = await page.evaluate(() => window.sessionStorage.getItem("ac.session"));
  expect(stored).toMatch(/^[0-9a-f]{64}$/);
  expect(stored).not.toBe(E2E_TOKEN);
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  // Cookie は一切無い（ポートで分離されないため使わない）
  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(() => document.cookie)).toBe("");
});

test("ペアリング: 使用済みコードは案内画面（Callout）になり、トークンは保存されない", async ({ page, browser }) => {
  const code = await newPairingCode();
  const first = await browser.newContext();
  const firstPage = await first.newPage();
  await firstPage.goto(`${BASE}/pair?code=${code}`);
  await expect(firstPage.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
  await first.close();

  await page.goto(`${BASE}/pair?code=${code}`);
  await expect(page.getByRole("alert")).toContainText("ペアリングできませんでした");
  expect(await page.evaluate(() => window.sessionStorage.getItem("ac.session"))).toBeNull();
});

test("未ログインで開くとログインが必要の案内（Callout）が出る", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByRole("alert")).toContainText("ログインが必要です");
});

test("ログアウト: サーバー側でセッションが失効し、画面はログインが必要になる", async ({ page }) => {
  await openPaired(page);
  const token = (await page.evaluate(() => window.sessionStorage.getItem("ac.session"))) as string;
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("ログインが必要です");
  expect(await page.evaluate(() => window.sessionStorage.getItem("ac.session"))).toBeNull();
  const res = await fetch(`${BASE}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(401);
});

test("別のタブ（別の sessionStorage）にはセッションが共有されない", async ({ page, context }) => {
  await openPaired(page);
  const other = await context.newPage();
  await other.goto(`${BASE}/`);
  await expect(other.getByRole("alert")).toContainText("ログインが必要です");
});

test("CSP: 画面・端末・モーダルの操作で CSP 違反が 1 件も出ない（応答にも CSP ヘッダがある）", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/content security policy/i.test(msg.text())) violations.push(msg.text());
  });
  page.on("pageerror", (err) => {
    if (/content security policy/i.test(err.message)) violations.push(err.message);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  const response = await page.goto(`${BASE}/pair?code=${await newPairingCode()}`);
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
  // モーダル（SA 金型）と端末（xterm の style 要素・インライン style）を実際に使う
  await createViaUi(page, "csp-session", "e2e-plain");
  await expect(page.getByTestId("terminal")).toContainText("READY");
  await page.getByTestId("terminal").click();
  await page.keyboard.type("csp-check");
  await expect(page.getByTestId("terminal")).toContainText("csp-check");
  expect(violations).toEqual([]);
});

test("/healthz は認証なしで ok を返す", async () => {
  const res = await fetch(`${BASE}/healthz`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; version: string; commit: string };
  expect(body.ok).toBe(true);
  expect(body.version).toBe(JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version);
  expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
});

test("テーマ: フッターの切替で <html> が変わり、再読込でも保持され、端末の背景が --bg-surface のダーク値になる（Cookie は出さない）", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPaired(page);
  await createViaUi(page, "theme-session", "e2e-plain");
  await expect(page.getByTestId("terminal")).toContainText("READY");
  const html = page.locator("html");
  const surface = (): Promise<string> =>
    page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--bg-surface)";
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
  const terminalBackground = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.querySelector(".xterm-scrollable-element") as Element).backgroundColor);

  await expect(html).not.toHaveClass(/force-dark/);
  const lightSurface = await surface();
  await expect.poll(terminalBackground).toBe(lightSurface);
  await page.screenshot({ path: "/tmp/CC報告ファイル/orca-selfbuilt/v021/light-1440x900.png" });

  await page.getByRole("button", { name: "ダークモード", exact: true }).click();
  await expect(html).toHaveClass(/force-dark/);
  const darkSurface = await surface();
  expect(darkSurface).not.toBe(lightSurface);
  await expect.poll(terminalBackground).toBe(darkSurface);
  expect(await page.evaluate(() => window.localStorage.getItem("theme"))).toBe("dark");
  await page.screenshot({ path: "/tmp/CC報告ファイル/orca-selfbuilt/v021/dark-1440x900.png" });

  await page.reload();
  await expect(page.getByRole("button", { name: "ライトモード", exact: true })).toBeVisible();
  await expect(html).toHaveClass(/force-dark/);

  await page.getByRole("button", { name: "ライトモード", exact: true }).click();
  await expect(html).not.toHaveClass(/force-dark/);
  expect(await page.evaluate(() => window.localStorage.getItem("theme"))).toBe("light");

  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(() => document.cookie)).toBe("");
});
