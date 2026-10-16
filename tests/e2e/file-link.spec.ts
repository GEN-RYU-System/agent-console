import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../fixtures/e2e-env";
import { newPairingCode } from "../fixtures/e2e-pairing";

// 端末に出たファイルのパス（v0.40.0）・ファイルタブの検索欄と「端末に戻る」（v0.41.0）を、実ブラウザ・実 PTY で通す。
// 役割 e2e-link（tests/fixtures/link-role.mjs）が Claude Code の端末の状態（マウス報告・別画面）の代役。
// 描画は dom と webgl の両方（webgl は /api/state の terminalRenderer だけを試験側で書き換える。data-renderer を必ず確かめる）。
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const BEARER = { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" };
const DATA_DIR = process.env.AC_E2E_DATA_DIR as string;
const STATUS_FILE = process.env.AC_E2E_STATUS_FILE as string;
const UUID_FILE = process.env.AC_E2E_UUID_FILE as string;
const HOOK = path.join(DATA_DIR, "hooks", "activity-hook.mjs");
const SETTLE_MS = 20000;

test.describe.configure({ mode: "serial", timeout: 90000 });

const uniq = Date.now().toString(36);
const createdSessions: string[] = [];
let dir = "";
let alphaFile = "";
let betaFile = "";
let unlistedFile = "";

test.beforeAll(() => {
  writeFileSync(UUID_FILE, "uuid");
  writeFileSync(STATUS_FILE, "busy");
  dir = mkdtempSync(path.join(os.tmpdir(), "ac-e2e-link-"));
  alphaFile = path.join(dir, `alpha-${uniq}.md`);
  betaFile = path.join(dir, `beta-${uniq}.txt`);
  unlistedFile = path.join(dir, `bash-made-${uniq}.md`);
  writeFileSync(alphaFile, "# alpha heading\n");
  writeFileSync(betaFile, "beta body\n");
  writeFileSync(unlistedFile, "# unlisted\n");
});

/** 試験ごとに新しいセッションを作る（役割のマウス報告・別画面の状態を次の試験に持ち越さないため）。alpha・beta だけを一覧に載せる */
async function makeSession(label: string): Promise<string> {
  const name = `file-link-${label}-${uniq}`;
  const res = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: BEARER, body: JSON.stringify({ name, roleId: "e2e-link" }) });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  createdSessions.push(id);
  let claudeSessionId = "";
  await expect
    .poll(
      async () => {
        const state = (await (await fetch(`${BASE}/api/state`, { headers: BEARER })).json()) as { sessions: Array<{ id: string; claudeSessionId?: string }> };
        claudeSessionId = state.sessions.find((s) => s.id === id)?.claudeSessionId ?? "";
        return claudeSessionId;
      },
      { timeout: SETTLE_MS },
    )
    .toMatch(/^[0-9a-f-]{36}$/);
  // 本物の hook に Write を流す（unlisted は Bash で作った扱いなので載せない）
  for (const file of [alphaFile, betaFile]) {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: claudeSessionId, transcript_path: "/not/kept/t.jsonl", cwd: dir, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file, content: "x" }, tool_response: {} }),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  }
  return name;
}
test.afterAll(async () => {
  writeFileSync(UUID_FILE, "");
  for (const id of createdSessions) await fetch(`${BASE}/api/sessions/${id}/close`, { method: "POST", headers: BEARER, body: "{}" });
});

const centerTab = (page: Page, name: RegExp) => page.getByRole("tab", { name });

/** 画面を開き、セッションを選び、一覧に alpha・beta が出てから端末タブへ。renderer が webgl なら /api/state を書き換える */
async function open(page: Page, renderer: "dom" | "webgl", label: string): Promise<void> {
  const sessionName = await makeSession(label);
  if (renderer === "webgl") {
    await page.route("**/api/state", async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...json, terminalRenderer: "webgl" } });
    });
  }
  await page.goto(`${BASE}/pair?code=${await newPairingCode()}`);
  await page.getByTestId("session-row").filter({ hasText: sessionName }).click();
  await centerTab(page, /^ファイル/).click();
  await expect(page.locator(".ac-files__name")).toHaveCount(2, { timeout: SETTLE_MS });
  await centerTab(page, /端末/).click();
  const term = page.getByTestId("terminal");
  await expect(term).toBeVisible();
  // 描画の種類を確かめる（GPU が無く dom に落ちたまま合格させない）
  await expect(term).toHaveAttribute("data-renderer", renderer, { timeout: 10000 });
  if (renderer === "dom") await expect(term).toContainText("READY", { timeout: SETTLE_MS });
  await page.waitForTimeout(renderer === "webgl" ? 1500 : 300);
}

/** 役割へ 1 行の命令を打つ */
async function send(page: Page, line: string): Promise<void> {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
}

async function pointerOn(page: Page): Promise<{ pointer: boolean; underlined: number }> {
  return page.evaluate(() => {
    const pointer = !!document.querySelector(".xterm.xterm-cursor-pointer, .xterm-cursor-pointer");
    const underlined = [...document.querySelectorAll(".xterm-rows span")].filter((s) => getComputedStyle(s as HTMLElement).textDecorationLine.includes("underline")).length;
    return { pointer, underlined };
  });
}

/**
 * 1 行目（左上）に出したリンクの上をマウスで横にたどり、リンク印が出る x を探す。見つかれば {x, y}、通り抜けたら null。
 * 描画が dom でも webgl でも同じ手順（webgl は文字が DOM に無いので座標を数えられない）。
 */
async function scanLink(page: Page): Promise<{ x: number; y: number; underlined: number } | null> {
  const box = await page.locator(".xterm-screen").boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + 4;
  await page.mouse.move(box!.x + 2, y);
  await page.waitForTimeout(400); // 一覧の取得（初回のみ）
  for (let x = box!.x + 50; x < box!.x + Math.min(box!.width - 10, 700); x += 25) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(120);
    const p = await pointerOn(page);
    if (p.pointer) return { x, y, underlined: p.underlined };
  }
  return null;
}

for (const renderer of ["dom", "webgl"] as const) {
  for (const mode of ["plain", "mouse+alt"] as const) {
    test(`E1/E2 ${renderer} ${mode}: 一覧にあるパスはホバーでリンク印、クリックでファイルタブにその中身が出る`, async ({ page }) => {
      await open(page, renderer, `${renderer}-${mode.replace("+", "")}`);
      if (mode === "mouse+alt") {
        await send(page, "mouse");
        await send(page, "alt");
        await expect(page.locator(".xterm")).toHaveClass(/enable-mouse-events/, { timeout: 5000 });
      }
      await send(page, `show ${alphaFile}`);
      const hit = await scanLink(page);
      expect(hit, "リンク印が出る位置が見つかる").not.toBeNull();
      if (renderer === "dom") expect(hit!.underlined).toBeGreaterThan(0);
      await page.mouse.down();
      await page.mouse.up();
      await expect(centerTab(page, /^ファイル/)).toHaveAttribute("aria-selected", "true", { timeout: 5000 });
      await expect(page.locator(".ac-files__content-path")).toHaveText(alphaFile);
      await expect(page.locator(".ac-files__view .ac-md h1")).toHaveText("alpha heading");
    });
  }
}

test("E6: 一覧に無いパス（Bash で作った扱い）はリンクにならない。同じ手順で一覧にあるパスはリンクになる（対照）", async ({ page }) => {
  await open(page, "dom", "e6");
  await send(page, `show ${betaFile}`);
  expect(await scanLink(page), "対照: 一覧にあるパスはリンクになる").not.toBeNull();
  await send(page, `show ${unlistedFile}`);
  await expect(page.getByTestId("terminal")).toContainText(path.basename(unlistedFile));
  expect(await scanLink(page), "一覧に無いパスはリンクにならない").toBeNull();
});

test("E3: 「端末に戻る」ボタンで端末タブになり、端末に入力の焦点がある", async ({ page }) => {
  await open(page, "dom", "e3");
  await centerTab(page, /^ファイル/).click();
  await expect(page.locator(".ac-files")).toBeVisible();
  await page.getByRole("button", { name: "端末に戻る" }).click();
  await expect(centerTab(page, /端末/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("terminal")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false)).toBe(true);
});

test("E4: ファイルタブ表示中の Esc で端末に戻る。検索欄に文字がある時の1回目は欄を空にするだけ", async ({ page }) => {
  await open(page, "dom", "e4");
  await centerTab(page, /^ファイル/).click();
  // タブを押しただけで、焦点は外枠にある（端末は hidden で焦点を失う）
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("ac-files") ?? false)).toBe(true);
  const box = page.getByLabel("ファイル名で絞り込み");
  await box.fill("alpha");
  await box.focus();
  await page.keyboard.press("Escape");
  await expect(box).toHaveValue("");
  await expect(centerTab(page, /^ファイル/)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(centerTab(page, /端末/)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false)).toBe(true);
  // 戻った端末にそのまま打てる
  await page.keyboard.type("show /x/typed-after-esc");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal")).toContainText("typed-after-esc");
});

test("E5: 検索欄に名前の一部を入れると絞られ件数が出る。当てはまらない語は該当なし。空にすると全件", async ({ page }) => {
  await open(page, "dom", "e5");
  await centerTab(page, /^ファイル/).click();
  const names = page.locator(".ac-files__name");
  await expect(names).toHaveCount(2);
  const box = page.getByLabel("ファイル名で絞り込み");
  await box.fill(`ALPHA-${uniq}`);
  await expect(names).toHaveText([path.basename(alphaFile)]);
  await expect(page.getByTestId("files-search-count")).toHaveText("1 / 2 件");
  await box.fill("zzz-no-such");
  await expect(page.getByText("当てはまるファイルはありません")).toBeVisible();
  await expect(page.getByTestId("files-search-count")).toHaveText("0 / 2 件");
  await box.fill("");
  await expect(names).toHaveCount(2);
  await expect(page.getByTestId("files-search-count")).toHaveCount(0);
});
