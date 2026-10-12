import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const NAME_FILE = process.env.AC_E2E_NAME_FILE as string;
const SLOW_FILE = process.env.AC_E2E_SLOW_FILE as string;
const OSASCRIPT_LOG = process.env.AC_E2E_OSASCRIPT_LOG as string;
const DATA_DIR = process.env.AC_E2E_DATA_DIR as string;
const SHOT_DIR = process.env.AC_SHOT_DIR;
const MAX_SERVER_RSS_MB = 150;
const MAX_JS_HEAP_MB = 80;
const STATE_DEADLINE_MS = 5000;
/** 機械が混んでいても状態の判定（claude agents の取得）が間に合うよう、v0.4.0 の試験だけ長く待つ */
const SLOW_STATE_DEADLINE_MS = 20000;

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
  // 既定の絞り込み（作業中・レビュー・WIP、直近 30 日）ではなく、すべてを表示して件数を突き合わせる
  await page.addInitScript(() => window.localStorage.setItem("ac.ledgerFilter", JSON.stringify({ period: "all", state: "all", query: "" })));
  await openPaired(page);
  await page.getByRole("button", { name: "更新", exact: true }).click();
  for (const [column, count] of Object.entries(expected)) {
    await expect(page.getByTestId(`ledger-col-${column}`)).toHaveAttribute("data-count", String(count));
  }
  // seed-a・seed-b・seed-old・seed-baddate と K2 で作ったブランチ分（IN_PROGRESS）が含まれていること
  expect(expected.IN_PROGRESS).toBe(5);
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

// ---- 段階2（毎日の使い勝手）。サーバーを共有するので、既存の試験より後ろに置く ----

/** AC_SHOT_DIR を指定したときだけ、1440x900 でライト・ダークの画面を保存する（CI では保存しない）。 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-light.png`) });
  await page.evaluate(() => document.documentElement.classList.add("force-dark"));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}-dark.png`) });
  await page.evaluate(() => document.documentElement.classList.remove("force-dark"));
}

const rowOf = (page: Page, id: string) => page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);

// v0.3.6 左のセッション一覧のコンパクト化（設計 §1 K1・K2・K4）。セッション数に上限（16）があるので、新しいセッションは作らず既存の行を測る。
const COMPACT_ROW_MAX_PX = 64;

/** K1: すべての行の高さが 64px 以下（ライト・ダーク）。K2: 名前は1行で省略記号。 */
async function expectCompactRows(page: Page): Promise<void> {
  const rows = await page.getByTestId("session-row").all();
  const heights: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => document.documentElement.classList.toggle("force-dark", t === "dark"), theme);
    for (const row of rows) {
      const box = await row.boundingBox();
      const unread = (await row.getAttribute("data-unread")) !== "0" ? "unread" : "read";
      heights.push(`${theme}/${unread}=${box?.height}`);
      expect(box?.height as number).toBeLessThanOrEqual(COMPACT_ROW_MAX_PX);
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove("force-dark"));
  console.log(`K1 heights(px): ${heights.join(" ")}`);
  const cut = await rows[0].getByTestId("session-name").evaluate((el) => ({ overflow: getComputedStyle(el).textOverflow, ws: getComputedStyle(el).whiteSpace, hidden: getComputedStyle(el).overflow }));
  expect(cut).toEqual({ overflow: "ellipsis", ws: "nowrap", hidden: "hidden" });
}

test("段階2 K1: busy→idle で未読の印・窓タイトル・macOS 通知が出て、行を選ぶと未読が消える", async ({ page }) => {
  const id = await apiCreate("notify-target", "e2e-plain");
  await openPaired(page);
  const row = rowOf(page, id);
  writeFileSync(STATUS_FILE, "idle");
  await expect(row.getByTestId("status")).toHaveAttribute("data-state", "idle", { timeout: STATE_DEADLINE_MS });
  await expect(row.getByTestId("unread-badge")).toHaveCount(0);
  writeFileSync(STATUS_FILE, "busy");
  await expect(row.getByTestId("status")).toHaveAttribute("data-state", "working", { timeout: STATE_DEADLINE_MS });
  const logBefore = readFileSync(OSASCRIPT_LOG, "utf8").split("\n").filter((l) => l.includes("notify-target")).length;

  writeFileSync(STATUS_FILE, "idle");
  await expect(row.getByTestId("unread-badge")).toBeVisible({ timeout: 6000 });
  await expect(row.getByTestId("unread-badge")).toContainText("未読 1 件");
  await expect(page).toHaveTitle(/^\(\d+\) Agent Console$/);
  await expect
    .poll(() => readFileSync(OSASCRIPT_LOG, "utf8").split("\n").filter((l) => l.includes("notify-target")).length, { timeout: 6000 })
    .toBe(logBefore + 1);
  const line = readFileSync(OSASCRIPT_LOG, "utf8").split("\n").filter((l) => l.includes("notify-target")).pop() as string;
  expect(line).toContain('display notification "notify-target: 待機" with title "Agent Console"');
  await expect(page.getByTestId("notify-help")).toContainText("Claude 公式");
  await shoot(page, "01-session-list-unread");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("unread-badge")).not.toHaveCount(0);
  await expectCompactRows(page);

  await row.click();
  // K4: 選択中の行は背景色と枠色が他の行と違う
  const paint = (r: typeof row) => r.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopColor }));
  const others = page.locator('[data-testid="session-row"]:not([data-session-id="' + id + '"])');
  if ((await others.count()) > 0) {
    const selectedPaint = await paint(row);
    const otherPaint = await paint(others.first());
    expect(selectedPaint.bg).not.toBe(otherPaint.bg);
    expect(selectedPaint.border).not.toBe(otherPaint.border);
  }
  await expect(row.getByTestId("unread-badge")).toHaveCount(0);
  // 他のセッションの未読も読んで、後続の試験に残さない
  for (const other of await page.getByTestId("session-row").all()) await other.click();
  await expect(page.getByTestId("unread-badge")).toHaveCount(0);
  await expect(page).toHaveTitle("Agent Console");
});

test("段階2 K2: 名前を変えると /rename が端末に送られ、Claude 側の名前が変われば表示も変わる。作業中は予約され、待機になってから送られる", async ({ page }) => {
  const id = await apiCreate("rename-target", "e2e-plain");
  await openPaired(page);
  const row = rowOf(page, id);
  const pencil = row.getByRole("button", { name: "名前を変える", exact: true });
  const form = page.getByTestId("rename-form");
  // K1: 1 回のクリックは選択だけ。名前のダブルクリックで名前を変える画面が開く
  await row.getByTestId("session-name").click();
  await expect(form).toHaveCount(0);
  await row.getByTestId("session-name").dblclick();
  await expect(form).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  writeFileSync(STATUS_FILE, "busy");
  await expect(row.getByTestId("status")).toHaveAttribute("data-state", "working", { timeout: STATE_DEADLINE_MS });
  // 作業中でも鉛筆は押せる
  await expect(pencil).toBeEnabled();
  await row.click();
  await expect(page.getByTestId("terminal")).toContainText("READY");
  await pencil.click();
  await form.getByLabel("新しい名前", { exact: false }).fill("queued-by-ui");
  await form.getByRole("button", { name: "変更", exact: true }).click();
  // 予約: 行に予約中の名前が出て、端末にはまだ /rename が無い
  await expect(row.getByTestId("pending-name")).toContainText("queued-by-ui");
  await expect(page.getByTestId("terminal")).not.toContainText("/rename");
  writeFileSync(STATUS_FILE, "waiting");
  await expect(row.getByTestId("status")).toHaveAttribute("data-state", "waiting", { timeout: STATE_DEADLINE_MS });
  await expect(page.getByTestId("terminal")).not.toContainText("/rename");
  await expect(pencil).toBeEnabled();
  // 待機になったら、予約した名前が 1 回送られ、予約表示が消える
  writeFileSync(STATUS_FILE, "idle");
  await expect(page.getByTestId("terminal")).toContainText("/rename queued-by-ui", { timeout: STATE_DEADLINE_MS });
  await expect(row.getByTestId("pending-name")).toHaveCount(0);

  // 待機中は今までどおりすぐ送る
  await pencil.click();
  await form.getByLabel("新しい名前", { exact: false }).fill("renamed-by-ui");
  await form.getByRole("button", { name: "変更", exact: true }).click();
  await expect(page.getByTestId("terminal")).toContainText("/rename renamed-by-ui");

  writeFileSync(NAME_FILE, "renamed-by-ui");
  await expect(row).toContainText("renamed-by-ui", { timeout: STATE_DEADLINE_MS });
  writeFileSync(NAME_FILE, "");
  await expect(row).toContainText("rename-target", { timeout: STATE_DEADLINE_MS });
});

test("段階2 K2: /rename を送っても Claude 側の名前が 10 秒変わらなければ案内が出る", async ({ page }) => {
  test.setTimeout(40000);
  const id = await apiCreate("rename-silent", "e2e-plain");
  await openPaired(page);
  const row = rowOf(page, id);
  writeFileSync(STATUS_FILE, "idle");
  await expect(row.getByTestId("status")).toHaveAttribute("data-state", "idle", { timeout: STATE_DEADLINE_MS });
  await row.getByRole("button", { name: "名前を変える", exact: true }).click();
  await page.getByTestId("rename-form").getByLabel("新しい名前", { exact: false }).fill("never-applied");
  await page.getByTestId("rename-form").getByRole("button", { name: "変更", exact: true }).click();
  await expect(page.getByText("名前がまだ反映されていません")).toBeVisible({ timeout: 15000 });
});

test("段階2 K3: よく使う指示を登録・編集・削除でき、ボタン 1 回で選択中の端末に送られ、再読込後も残る（保存は 1 ファイル・権限 600）", async ({ page }) => {
  const id = await apiCreate("quick-target", "e2e-plain");
  await openPaired(page);
  await page.getByRole("button", { name: "指示を編集", exact: true }).click();
  const form = page.getByTestId("quick-prompt-form");
  await form.getByLabel("ボタンの名前", { exact: false }).fill("テスト実行");
  await form.getByLabel("送る文章", { exact: false }).fill("echo-quick-prompt");
  await form.getByRole("button", { name: "追加", exact: true }).click();
  await expect(page.getByTestId("quick-prompt-item")).toHaveCount(1);
  await shoot(page, "03-quick-prompt-editor");
  await page.getByTestId("quick-prompt-item").getByRole("button", { name: "編集", exact: true }).click();
  await form.getByLabel("送る文章", { exact: false }).fill("echo-quick-prompt-v2");
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await page.keyboard.press("Escape");

  const bar = page.getByTestId("quick-prompt-bar");
  await expect(bar.getByRole("button", { name: "テスト実行", exact: true })).toBeDisabled();
  await rowOf(page, id).click();
  await expect(page.getByTestId("terminal")).toContainText("READY");
  // Claude が作業中・許可待ちの間は送れない（ボタンは無効、サーバーも 409）。idle になってから送る
  writeFileSync(STATUS_FILE, "busy");
  await expect(rowOf(page, id).getByTestId("status")).toHaveAttribute("data-state", "working", { timeout: STATE_DEADLINE_MS });
  await expect(bar.getByRole("button", { name: "テスト実行", exact: true })).toBeDisabled();
  const promptId = ((JSON.parse(readFileSync(path.join(DATA_DIR, "quick-prompts.json"), "utf8")) as { items: Array<{ id: string }> }).items[0]).id;
  const check = (): Promise<Response> =>
    fetch(`${BASE}/api/sessions/${id}/send-check`, { method: "POST", headers: { ...BEARER, "Content-Type": "application/json" }, body: JSON.stringify({ promptId }) });
  expect((await check()).status).toBe(409);
  writeFileSync(STATUS_FILE, "waiting");
  await expect(rowOf(page, id).getByTestId("status")).toHaveAttribute("data-state", "waiting", { timeout: STATE_DEADLINE_MS });
  expect((await check()).status).toBe(409);
  await expect(page.getByTestId("terminal")).not.toContainText("echo-quick-prompt-v2");
  writeFileSync(STATUS_FILE, "idle");
  await expect(rowOf(page, id).getByTestId("status")).toHaveAttribute("data-state", "idle", { timeout: STATE_DEADLINE_MS });
  await bar.getByRole("button", { name: "テスト実行", exact: true }).click();
  await expect(page.getByTestId("terminal")).toContainText("echo-quick-prompt-v2");

  const file = path.join(DATA_DIR, "quick-prompts.json");
  // 保存先は 2 ファイルだけ（よく使う指示と、v0.3.8 の復元リスト）
  expect(readdirSync(DATA_DIR).sort()).toEqual(["open-sessions.json", "quick-prompts.json"]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  await page.reload();
  await expect(page.getByTestId("quick-prompt-bar").getByRole("button", { name: "テスト実行", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "指示を編集", exact: true }).click();
  await page.getByTestId("quick-prompt-item").getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByTestId("quick-prompt-item")).toHaveCount(0);
  const saved = JSON.parse(readFileSync(file, "utf8")) as { version: number; items: unknown[] };
  expect(saved).toEqual({ version: 1, items: [] });
});

test("v0.3.4 K4: 「↑」「↓」で指示を並べ替えると、編集画面と上部のボタン列が新しい順になり、保存ファイルの順も変わる", async ({ page }) => {
  for (const label of ["並び一", "並び二"]) {
    await fetch(`${BASE}/api/quick-prompts`, {
      method: "POST",
      headers: { ...BEARER, "Content-Type": "application/json" },
      body: JSON.stringify({ label, text: `echo-${label}` }),
    });
  }
  await openPaired(page);
  const bar = page.getByTestId("quick-prompt-bar");
  await expect(bar.getByRole("button")).toHaveText(["並び一", "並び二", "指示を編集"]);
  await page.getByRole("button", { name: "指示を編集", exact: true }).click();
  const items = page.getByTestId("quick-prompt-item");
  await expect(items.first().getByRole("button", { name: "上へ", exact: true })).toBeDisabled();
  await expect(items.last().getByRole("button", { name: "下へ", exact: true })).toBeDisabled();
  await items.last().getByRole("button", { name: "上へ", exact: true }).click();
  await expect(items.first()).toContainText("並び二");
  await page.keyboard.press("Escape");
  await expect(bar.getByRole("button")).toHaveText(["並び二", "並び一", "指示を編集"]);
  const saved = JSON.parse(readFileSync(path.join(DATA_DIR, "quick-prompts.json"), "utf8")) as { items: Array<{ id: string; label: string }> };
  expect(saved.items.map((i) => i.label)).toEqual(["並び二", "並び一"]);
  for (const item of saved.items) await fetch(`${BASE}/api/quick-prompts/${item.id}`, { method: "DELETE", headers: BEARER });
});

test("段階2 K3: 複数行の指示は、括弧付き貼付モードの端末へ ESC[200~ ... ESC[201~ で包まれて入り、その直後に Enter が届く", async ({ page }) => {
  const id = await apiCreate("bracketed-target", "e2e-bracketed");
  const created = await fetch(`${BASE}/api/quick-prompts`, {
    method: "POST",
    headers: { ...BEARER, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "複数行", text: "first-line\nsecond-line" }),
  });
  const { id: promptId } = (await created.json()) as { id: string };
  writeFileSync(STATUS_FILE, "idle");
  await openPaired(page);
  await rowOf(page, id).click();
  await expect(page.getByTestId("terminal")).toContainText("READY");
  await expect(rowOf(page, id).getByTestId("status")).toHaveAttribute("data-state", "idle", { timeout: STATE_DEADLINE_MS });
  await page.getByTestId("quick-prompt-bar").getByRole("button", { name: "複数行", exact: true }).click();
  const terminal = page.getByTestId("terminal");
  await expect(terminal).toContainText('ALL:"\\u001b[200~first-line');
  // 届いたバイト列の全体（読み取りの区切りは問わない）で、本文は括弧で包まれ（改行は \r）、閉じ括弧のすぐ後に Enter（\r）が来る。間に他の入力は無い
  await expect(terminal).toContainText('first-line\\rsecond-line\\u001b[201~\\r"');
  await fetch(`${BASE}/api/quick-prompts/${promptId}`, { method: "DELETE", headers: BEARER });
});

test("段階2 K3: 状態確認中に別のセッションへ切り替えると、どちらの端末にも入らず案内が出る", async ({ page }) => {
  const a = await apiCreate("switch-a", "e2e-plain");
  const b = await apiCreate("switch-b", "e2e-plain");
  const created = await fetch(`${BASE}/api/quick-prompts`, {
    method: "POST",
    headers: { ...BEARER, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "切替確認", text: "must-not-appear-anywhere" }),
  });
  const { id: promptId } = (await created.json()) as { id: string };
  writeFileSync(STATUS_FILE, "idle");
  await openPaired(page);
  await rowOf(page, a).click();
  await expect(page.getByTestId("terminal")).toContainText("READY");
  await expect(rowOf(page, a).getByTestId("status")).toHaveAttribute("data-state", "idle", { timeout: STATE_DEADLINE_MS });
  const button = page.getByTestId("quick-prompt-bar").getByRole("button", { name: "切替確認", exact: true });
  await expect(button).toBeEnabled();

  // 状態確認（claude agents の取得）が 3 秒かかる間に、別の行を選ぶ
  writeFileSync(SLOW_FILE, "3");
  try {
    await button.click();
    await rowOf(page, b).click();
    await expect(page.getByText("別のセッションへ切り替わったため、指示は入れませんでした")).toBeVisible({ timeout: 10000 });
  } finally {
    writeFileSync(SLOW_FILE, "");
  }
  await expect(page.getByTestId("terminal")).toContainText("READY");
  await expect(page.getByTestId("terminal")).not.toContainText("must-not-appear-anywhere");
  await rowOf(page, a).click();
  await expect(page.getByTestId("terminal")).toContainText("READY");
  await expect(page.getByTestId("terminal")).not.toContainText("must-not-appear-anywhere");
  await fetch(`${BASE}/api/quick-prompts/${promptId}`, { method: "DELETE", headers: BEARER });
});

test("v0.3.3 K1-K4・K6: 過去の会話を再開は、本店の行と worktree の行を出し、押した場所で再開用の端末を開く", async ({ page }) => {
  // worktree は役割 e2e-wt の起動で作る
  const wtRes = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { ...BEARER, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "resume-wt", roleId: "e2e-wt", branch: "release/e2e-resume" }),
  });
  expect(wtRes.status).toBe(201);
  const state = (await (await fetch(`${BASE}/api/state`, { headers: BEARER })).json()) as { sessions: Array<{ id: string; cwd: string }> };
  const wtCwd = state.sessions.find((x) => x.cwd.endsWith("release-e2e-resume"))?.cwd as string;
  expect(wtCwd).toBeTruthy();
  await openPaired(page);
  await page.getByRole("button", { name: "過去の会話を再開", exact: true }).click();
  await expect(page.getByTestId("resume-guide")).toContainText("Ctrl+W");
  await expect(page.getByTestId("resume-guide")).toContainText("今動いている会話は選ばない");
  const mainRow = page.locator('[data-testid="resume-target"][data-kind="main"]');
  await expect(mainRow).toContainText("Opus 設計役（本店）");
  const wtRow = page.locator(`[data-testid="resume-target"][data-path="${wtCwd}"]`);
  await expect(wtRow).toContainText("Sonnet 実装役（release/e2e-resume）");
  await page.getByLabel("worktree を名前で絞り込む").fill("no-such-name");
  await expect(wtRow).toHaveCount(0);
  await expect(mainRow).toHaveCount(1);
  await page.getByLabel("worktree を名前で絞り込む").fill("e2e-resume");
  await shoot(page, "04-resume-picker");
  await wtRow.getByRole("button", { name: "再開", exact: true }).click();
  await expect(page.getByTestId("terminal")).toContainText("RESUMED_WT id=[]");
  await expect(page.getByTestId("terminal")).toContainText(`READY ${wtCwd}`);

  await page.getByRole("button", { name: "過去の会話を再開", exact: true }).click();
  await page.locator('[data-testid="resume-target"][data-kind="main"]').getByRole("button", { name: "再開", exact: true }).click();
  await expect(page.getByTestId("terminal")).toContainText("RESUMED_MAIN id=[]");
  await expect(page.getByTestId("terminal")).toContainText(`READY ${ROOT}`);

  // 範囲外（本店でも worktree 一覧にもない場所）はサーバーが拒否する
  for (const body of [{ kind: "worktree", path: "/" }, { kind: "worktree", path: "relative/dir" }, { kind: "main", path: wtCwd }]) {
    const r = await fetch(`${BASE}/api/sessions/resume`, { method: "POST", headers: { ...BEARER, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(r.status).toBe(400);
  }
});

test("段階2 K5: 台帳は既定で作業中・レビュー・WIP かつ直近 30 日だけを表示し、隠れた件数と日付不明を別に数え、絞り込みは再読込後も残る", async ({ page }) => {
  const dir = path.join(ROOT, ".claude-pipeline", "active-work.d");
  const total = readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  await openPaired(page);
  await page.getByRole("button", { name: "更新", exact: true }).click();
  const summary = page.getByTestId("ledger-summary");
  const nums = async (): Promise<{ shown: number; hidden: number; unknown: number }> => ({
    shown: Number(await summary.getAttribute("data-shown")),
    hidden: Number(await summary.getAttribute("data-hidden")),
    unknown: Number(await summary.getAttribute("data-unknown")),
  });
  // 既定: seed-a/b・seed-c(REVIEW)・seed-wip・K2 で作ったブランチは表示。seed-old・DONE・ABANDONED・未登録は隠れ、seed-baddate は日付不明
  // 更新の結果（ここまでに作られたブランチ分を含む）が出そろうまで待つ
  await expect.poll(async () => {
    const n = await nums();
    return n.shown + n.hidden + n.unknown;
  }).toBe(total);
  const initial = await nums();
  expect(initial.shown).toBeGreaterThanOrEqual(4);
  expect(initial.unknown).toBe(1);
  expect(initial.shown + initial.hidden + initial.unknown).toBe(total);
  await expect(page.getByTestId("ledger-unknown-date")).toContainText("1 件");
  await expect(page.getByTestId("ledger-card").filter({ hasText: "seed-old" })).toHaveCount(0);
  await expect(page.getByTestId("ledger-card").filter({ hasText: "seed-a" })).toHaveCount(1);
  await shoot(page, "05-ledger-filter");

  await page.getByTestId("ledger-filters").getByLabel("期間", { exact: false }).selectOption("all");
  await page.getByTestId("ledger-filters").getByLabel("状態", { exact: false }).selectOption("all");
  await expect(summary).toHaveAttribute("data-shown", String(total));
  await expect(summary).toHaveAttribute("data-hidden", "0");
  await expect(summary).toHaveAttribute("data-unknown", "0");

  await page.getByTestId("ledger-filters").getByLabel("ブランチ名で検索", { exact: false }).fill("SEED-OLD");
  await expect(page.getByTestId("ledger-card")).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId("ledger-filters").getByLabel("ブランチ名で検索", { exact: false })).toHaveValue("SEED-OLD");
  await expect(page.getByTestId("ledger-card")).toHaveCount(1);
});

test("段階2 K6: メモリ画面にセッションごと・サーバー・Mac 全体が MB と % で出て、10 秒ごとに更新される（値は OS の実出力と一致）", async ({ page }) => {
  test.setTimeout(45000);
  const id = await apiCreate("mem-view", "e2e-plain");
  await openPaired(page);
  await page.getByRole("button", { name: "メモリ", exact: true }).click();
  const serverBox = page.getByTestId("memory-server");
  await expect(serverBox).toContainText("MB");
  await expect(serverBox).toContainText("%");
  await expect(page.getByTestId(`memory-session-${id}`)).toContainText("MB");

  const serverPid = execFileSync("lsof", ["-ti", `tcp:${E2E_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
  const psRssMb = Number(execFileSync("ps", ["-o", "rss=", "-p", serverPid], { encoding: "utf8" }).trim()) / 1024;
  const shown = Number(/([\d.]+) MB/.exec((await serverBox.textContent()) ?? "")?.[1]);
  expect(Math.abs(shown - psRssMb)).toBeLessThan(40);
  const sessionMb = Number(await page.getByTestId(`memory-session-${id}`).getAttribute("data-rss-mb"));
  expect(sessionMb).toBeGreaterThan(0);
  expect(sessionMb).toBeLessThan(psRssMb + 200);

  if (process.platform === "darwin") {
    const totalMb = Number(execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).trim()) / 1024 / 1024;
    const detail = (await page.getByTestId("memory-system-detail").textContent()) ?? "";
    expect(detail).toContain(`物理メモリ ${Math.round(totalMb)} MB`);
    const pressure = execFileSync("memory_pressure", { encoding: "utf8" });
    const freeNow = Number(/free percentage: (\d+)%/.exec(pressure)?.[1]);
    const freeShown = Number(/空き率 (\d+) %/.exec(detail)?.[1]);
    expect(Math.abs(freeShown - freeNow)).toBeLessThanOrEqual(10);
  } else {
    await expect(page.getByTestId("memory-system")).toContainText("取得できません");
  }
  await shoot(page, "02-memory");

  // 開いている間は 10 秒ごとに読み直す
  const first = await page.waitForResponse((r) => r.url().endsWith("/api/memory"), { timeout: 15000 });
  const second = await page.waitForResponse((r) => r.url().endsWith("/api/memory"), { timeout: 15000 });
  expect(first.status()).toBe(200);
  expect(second.status()).toBe(200);
});

test("v0.3.8 K1: 閉じるボタン -> 確認画面 -> 「やめる」では何も起きず、「閉じる」で行が消えて端末のプロセスも終わる", async ({ page }) => {
  // これまでの試験でセッション数の上限（16）に達しているので、先頭の1件を閉じて枠を空ける
  const before = (await (await fetch(`${BASE}/api/state`, { headers: BEARER })).json()) as { sessions: Array<{ id: string }> };
  if (before.sessions.length >= 16) expect((await fetch(`${BASE}/api/sessions/${before.sessions[0].id}/close`, { method: "POST", headers: BEARER })).status).toBe(200);
  const id = await apiCreate("close-target", "e2e-plain");
  await openPaired(page);
  const row = rowOf(page, id);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "セッションを閉じる", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("close-target を閉じますか？");
  await dialog.getByRole("button", { name: "やめる", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "セッションを閉じる", exact: true }).click();
  await page.getByRole("dialog").locator("button.comp-btn--danger").click();
  await expect(row).toHaveCount(0);
  const state = await fetch(`${BASE}/api/state`, { headers: BEARER });
  const sessions = ((await state.json()) as { sessions: Array<{ id: string }> }).sessions;
  expect(sessions.some((s) => s.id === id)).toBe(false);
});

/** セッション数の上限（16）に空きが無ければ、先頭から閉じて need 件の枠を作る。 */
async function ensureRoom(need: number): Promise<void> {
  const { sessions } = (await (await fetch(`${BASE}/api/state`, { headers: BEARER })).json()) as { sessions: Array<{ id: string }> };
  const surplus = sessions.length + need - 16;
  for (const s of sessions.slice(0, Math.max(0, surplus))) await fetch(`${BASE}/api/sessions/${s.id}/close`, { method: "POST", headers: BEARER });
}

const gitRoot = (...args: string[]): void => void execFileSync("git", args, { cwd: ROOT, stdio: "ignore" });
const SEED_FILE = path.join(ROOT, "e2e-diff-seed.txt");
const DIFF_DIR = path.join(ROOT, "e2e-diff");

/** 変更タブの試験用の変更を作る: 追跡ファイルの書き換え（削除行＋追加行）、ステージ済みの新規、未追加。後で必ず戻す。 */
function makeChanges(): void {
  writeFileSync(SEED_FILE, "keep1\nnew line\nkeep2\n");
  mkdirSync(DIFF_DIR, { recursive: true });
  writeFileSync(path.join(DIFF_DIR, "staged.txt"), "s1\ns2\ns3\n");
  gitRoot("add", "e2e-diff/staged.txt");
  writeFileSync(path.join(DIFF_DIR, "untracked.txt"), "u\n");
}
function restoreChanges(): void {
  gitRoot("rm", "-f", "-q", "--cached", "--ignore-unmatch", "e2e-diff/staged.txt");
  gitRoot("checkout", "--", "e2e-diff-seed.txt");
  rmSync(DIFF_DIR, { recursive: true, force: true });
}

test("v0.4.0 K1〜K6: 変更タブ -> 一覧と色つき diff -> 行コメントの追加・編集・削除 -> Claude に送る（貼って2秒待って Enter）-> 送信済み、作業中は押せず理由が見える", async ({ page }) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(15000);
  await ensureRoom(1);
  const id = await apiCreate("diff-target", "e2e-bracketed");
  writeFileSync(STATUS_FILE, "idle");
  makeChanges();
  try {
    await openPaired(page);
    await rowOf(page, id).click();
    await expect(page.getByTestId("terminal")).toContainText("READY");
    await expect(rowOf(page, id).getByTestId("status")).toHaveAttribute("data-state", "idle", { timeout: SLOW_STATE_DEADLINE_MS });

    // K1: 件数つきのタブと、変わったファイルの一覧（未追加は「新しいファイル（未追加）」）
    const changesTab = page.getByRole("tab", { name: /変更/ });
    await changesTab.click();
    const pane = page.getByTestId("diff-pane");
    await expect(pane).toBeVisible();
    await expect(pane.getByRole("button", { name: /e2e-diff\/staged\.txt/ })).toContainText("+3");
    await expect(pane.getByRole("button", { name: /e2e-diff\/untracked\.txt/ })).toContainText("新しいファイル（未追加）");
    await expect(pane.getByRole("button", { name: /e2e-diff-seed\.txt/ })).toBeVisible();
    // タブの件数は一覧の行数と同じ（他の試験が残した変更があっても、数はずれない）
    const rows = await pane.getByRole("navigation", { name: "変更されたファイル" }).getByRole("button").count();
    expect(rows).toBeGreaterThanOrEqual(3);
    await expect(changesTab).toContainText(String(rows));
    await expect(pane).toContainText("origin/main");

    // K2: 行番号つきの diff。追加行は success、削除行は error の背景（SA のトークン。透明ではない）
    await pane.getByRole("button", { name: /e2e-diff-seed\.txt/ }).click();
    const added = pane.getByTestId("diff-line-add").first();
    const deleted = pane.getByTestId("diff-line-del").first();
    await expect(added).toContainText("new line");
    await expect(deleted).toContainText("old line");
    const bg = (el: typeof added) => el.evaluate((node) => getComputedStyle((node.parentElement as HTMLElement)).backgroundColor);
    const addBg = await bg(added);
    const delBg = await bg(deleted);
    expect(addBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(delBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(addBg).not.toBe(delBg);
    expect(await bg(pane.getByTestId("diff-line-ctx").first())).toBe("rgba(0, 0, 0, 0)");

    // K3: 追加行を押して書き、保存 -> 印がつく。編集 -> 削除
    await added.click();
    await pane.getByLabel("コメント").fill("ここを直してください");
    await pane.getByRole("button", { name: "保存", exact: true }).click();
    const box = pane.getByTestId("diff-comment");
    await expect(box).toContainText("ここを直してください");
    await expect(box).toContainText("2 行目（新しい側）");
    await box.getByRole("button", { name: "編集", exact: true }).click();
    await pane.getByLabel("コメント").fill("ここに close も入れてください");
    await pane.getByRole("button", { name: "保存", exact: true }).click();
    await expect(pane.getByTestId("diff-comment")).toContainText("close も入れてください");
    await pane.getByTestId("diff-comment").getByRole("button", { name: "削除", exact: true }).click();
    await expect(pane.getByTestId("diff-comment")).toHaveCount(0);
    await added.click();
    await pane.getByLabel("コメント").fill("ここに close も入れてください");
    await pane.getByRole("button", { name: "保存", exact: true }).click();
    await expect(pane.getByTestId("diff-comment")).toHaveCount(1);

    // K5: 「Claude に送る（1件）」-> 端末に括弧付きで貼られ、その後に Enter。送信済みの印がつく
    const send = pane.getByRole("button", { name: /Claude に送る/ });
    await expect(send).toContainText("1件");
    await expect(send).toBeEnabled();
    await send.click();
    await page.getByRole("tab", { name: /端末/ }).click();
    const terminal = page.getByTestId("terminal");
    await expect(terminal).toContainText('ALL:"\\u001b[200~差分へのレビューコメントです。');
    await expect(terminal).toContainText("File: e2e-diff-seed.txt");
    await expect(terminal).toContainText("Comment: ここに close も入れてください");
    // 閉じ括弧のすぐ後に Enter（待ち時間のあと）。間に他の入力は無い
    await expect(terminal).toContainText('\\u001b[201~\\r"', { timeout: 10000 });
    await changesTab.click();
    await expect(pane.getByTestId("diff-comment")).toContainText("送信済み");
    await expect(pane.getByText("送るコメントがありません")).toBeVisible();

    // K6: Claude が作業中の間は押せず、理由が（マウスを乗せなくても）見える
    await pane.getByTestId("diff-line-add").first().click();
    await pane.getByLabel("コメント").fill("二つ目");
    await pane.getByRole("button", { name: "保存", exact: true }).click();
    await expect(pane.getByTestId("diff-comment")).toHaveCount(2);
    writeFileSync(STATUS_FILE, "busy");
    await expect(rowOf(page, id).getByTestId("status")).toHaveAttribute("data-state", "working", { timeout: SLOW_STATE_DEADLINE_MS });
    await expect(send).toBeDisabled();
    await expect(pane.getByTestId("send-reason")).toBeVisible();
    await expect(pane.getByTestId("send-reason")).toHaveText("Claude が作業中のため送れません");
  } finally {
    writeFileSync(STATUS_FILE, "idle");
    const list = (await (await fetch(`${BASE}/api/sessions/${id}/diff-comments`, { headers: BEARER })).json()) as { items?: Array<{ id: string }> };
    for (const c of list.items ?? []) await fetch(`${BASE}/api/sessions/${id}/diff-comments/${c.id}`, { method: "DELETE", headers: BEARER });
    restoreChanges();
  }
});

test("v0.4.0 K12: 変更タブを開いてから端末タブに戻っても、端末の列数と行数は変わらない（隠している間に 2x1 などが pty に送られない）", async ({ page }) => {
  await ensureRoom(1);
  const id = await apiCreate("size-target", "e2e-size");
  await openPaired(page);
  await rowOf(page, id).click();
  const terminal = page.getByTestId("terminal");
  await expect(terminal).toContainText("SIZE");
  const lastSize = async (): Promise<string> => {
    const text = await terminal.innerText();
    return [...text.matchAll(/SIZE (\d+x\d+)/g)].map((m) => m[1]).pop() ?? "";
  };
  // 画面の大きさに合わせた最終の大きさに落ち着くまで待つ（初期の 80x24 のままではない）
  await expect.poll(lastSize, { timeout: 10000 }).not.toBe("80x24");
  const before = await lastSize();
  expect(before).not.toBe("");

  await page.getByRole("tab", { name: /変更/ }).click();
  await expect(page.getByTestId("diff-pane")).toBeVisible();
  // 端末の包みは hidden 属性で隠れているだけ（外れていない）
  await expect(terminal).toBeHidden();
  await page.waitForTimeout(1500);
  await page.getByRole("tab", { name: /端末/ }).click();
  await expect(terminal).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await lastSize()).toBe(before);
  expect(await terminal.innerText()).not.toMatch(/SIZE 2x1\b/);
});
