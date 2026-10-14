import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../fixtures/e2e-env";
import { newPairingCode } from "../fixtures/e2e-pairing";

// 引き継ぎ（v0.29.0）。画面のボタン → 確認 → 一時の relayDir の下にだけフォルダができ、古いセッションに文が送られ、
// 引き継ぎ書ができると新しい名前（数字 +1）のセッションが増える。古いセッションは残る。
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const RELAY_DIR = process.env.AC_E2E_RELAY_DIR as string;
const STATUS_FILE = process.env.AC_E2E_STATUS_FILE as string;
const NAME_FILE = process.env.AC_E2E_NAME_FILE as string;
const headers = { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" };

test("K11: 引き継ぎを押すと一時の置き場にだけフォルダができ、古いセッションに文が送られ、引き継ぎ書ができると名前の数字が 1 増えた新しいセッションが増える", async ({ page }) => {
  test.setTimeout(150000);
  const suffix = Date.now().toString(36).slice(-4);
  const oldName = `relay-${suffix}-1`;
  const newName = `relay-${suffix}-2`;
  writeFileSync(STATUS_FILE, "idle");
  writeFileSync(NAME_FILE, "");
  const created = await fetch(`${BASE}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ name: oldName, roleId: "e2e-plain" }) });
  expect(created.status).toBe(201);
  const { id: oldId } = (await created.json()) as { id: string };
  try {
    await page.goto(`${BASE}/pair?code=${await newPairingCode()}`);
    await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
    const oldRow = page.locator(`[data-testid="session-row"][data-session-id="${oldId}"]`);
    await expect(oldRow).toBeVisible();
    const button = oldRow.getByTestId("relay-session");
    await expect(button).toBeEnabled({ timeout: 15000 });
    expect(existsSync(RELAY_DIR) ? readdirSync(RELAY_DIR) : []).toEqual([]);
    await button.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(oldName);
    // 名前の合わせ待ちが長引かないよう、新しい名前を Claude 側の名前として先に出しておく
    writeFileSync(NAME_FILE, newName);
    await dialog.getByRole("button", { name: "引き継ぐ", exact: true }).click();
    // 一時の置き場にだけフォルダができる
    await expect.poll(() => (existsSync(RELAY_DIR) ? readdirSync(RELAY_DIR).length : 0), { timeout: 10000 }).toBe(1);
    const folder = path.join(RELAY_DIR, readdirSync(RELAY_DIR)[0]);
    // 古いセッションに引き継ぎ書を書かせる文が送られている（役割のスタブが入力をそのまま返す）
    await oldRow.click();
    await page.getByRole("tab", { name: /端末/ }).click();
    await expect(page.getByTestId("terminal")).toContainText("引き継ぎ書", { timeout: 15000 });
    // 書いている最中（作業中）→ 引き継ぎ書ができる → 入力待ちに戻る
    writeFileSync(STATUS_FILE, "busy");
    writeFileSync(path.join(folder, "HANDOFF.md"), "# 引き継ぎ\n試験用\n");
    await page.waitForTimeout(4000);
    writeFileSync(STATUS_FILE, "idle");
    const relays = async (): Promise<string> => JSON.stringify(((await (await page.request.get(`${BASE}/api/state`, { headers })).json()) as { relays?: unknown[] }).relays ?? []);
    await expect.poll(async () => (JSON.parse(await relays()) as Array<{ phase: string }>)[0]?.phase ?? (await relays()), { timeout: 110000 }).toBe("done");
    // stub の Claude 側の名前は 1 つなので、一覧の表示名では区別できない。新しい側は relays の newSessionId で見る
    const view = (JSON.parse(await relays()) as Array<{ oldSessionId: string; newSessionId?: string; newName: string }>)[0];
    expect(view.oldSessionId).toBe(oldId);
    expect(view.newName).toBe(newName);
    expect(view.newSessionId).toBeTruthy();
    expect(view.newSessionId).not.toBe(oldId);
    await expect(page.locator(`[data-testid="session-row"][data-session-id="${view.newSessionId}"]`)).toHaveCount(1);
    await expect(oldRow).toBeVisible();
    // 新しい側のアプリ上の名前は newName
    const state = (await (await page.request.get(`${BASE}/api/state`, { headers })).json()) as { sessions: Array<{ id: string; name: string }> };
    expect(state.sessions.find((x) => x.id === view.newSessionId)?.name).toBe(newName);
  } catch (err) {
    console.log(`RELAY-DIAG ${(await (await fetch(`${BASE}/api/state`, { headers })).text()).slice(0, 6000)}`);
    throw err;
  } finally {
    writeFileSync(NAME_FILE, "");
    writeFileSync(STATUS_FILE, "busy");
    const state = (await (await fetch(`${BASE}/api/state`, { headers })).json()) as { sessions: Array<{ id: string; name: string }> };
    for (const s of state.sessions) {
      if (s.id === oldId || s.name === newName) await fetch(`${BASE}/api/sessions/${s.id}/close`, { method: "POST", headers });
    }
  }
});
