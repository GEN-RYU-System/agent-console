import { expect, test } from "@playwright/test";
import { E2E_PORT } from "../fixtures/e2e-env";
import { newPairingCode } from "../fixtures/e2e-pairing";

// 予約タブ（v0.21.0。v0.22.0 で作業場所は入力欄をやめ、本店型の役割は「本店で動きます」の一文）。画面で予約を作り、「これから」に出て、取消すと「済み」に「取消」で出るまでを通す。
// 予約日時は実行日の 2 日後（日本時間）なので、この試験の間に送信は起きない。
const BASE = `http://127.0.0.1:${E2E_PORT}`;

const dayAfterTomorrowJst = (): string => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

test("R15: 画面で予約を作ると「これから」に出て、取消すと「済み」に「取消」で出る", async ({ page }) => {
  const name = `resv-${Date.now().toString(36)}`;
  const date = dayAfterTomorrowJst();
  await page.goto(`${BASE}/pair?code=${await newPairingCode()}`);
  await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /予約/ }).click();
  await expect(page.getByTestId("reservations-pane")).toBeVisible();

  await page.getByRole("button", { name: "予約を登録", exact: true }).click();
  await page.getByLabel("名前").fill(name);
  await expect(page.getByText("本店（いつもの作業場所）で動きます")).toBeVisible();
  await page.getByLabel("日付").fill(date);
  await page.getByLabel("時刻").fill("10:00");
  await page.getByLabel("Claude に送る指示").fill("予約の試験です");
  await page.getByRole("button", { name: "予約する", exact: true }).click();

  const row = page.getByTestId("reservation-row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`${date.replaceAll("-", "/")} 10:00 JST`);
  await expect(row).toContainText("待機中");
  const upcoming = page.locator(".ac-reservations__section").filter({ hasText: "これから" }).first();
  await expect(upcoming.getByTestId("reservation-row").filter({ hasText: name })).toHaveCount(1);

  await row.getByRole("button", { name: "取消", exact: true }).click();
  const finished = page.locator(".ac-reservations__section").filter({ hasText: "済み" }).first();
  const done = finished.getByTestId("reservation-row").filter({ hasText: name });
  await expect(done).toHaveCount(1);
  await expect(done).toContainText("取消");
  await expect(upcoming.getByTestId("reservation-row").filter({ hasText: name })).toHaveCount(0);
});
