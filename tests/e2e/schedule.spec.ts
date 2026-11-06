import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../fixtures/e2e-env";
import { newPairingCode } from "../fixtures/e2e-pairing";

// 予定タブ（v0.52.0）。時間割の位置・日／週／月・足す／終わった／消す・重なりを、実ブラウザで通す。
// 画面の時計は 2026-11-04（水）09:00 日本時間に固定する。項目は API で作る（認証は file-link.spec.ts と同じ Bearer）。
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const BEARER = { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" };
const TODAY = "2026-11-04";
const TOMORROW = "2026-11-05";
const HOUR_PX = 48;
const TOLERANCE = 2;

test.use({ timezoneId: "Asia/Tokyo" });
test.describe.configure({ mode: "serial" });

interface Made { side?: "dev" | "secretary"; kind?: "todo" | "waiting" | "deadline"; title: string; date: string; start: string; end?: string }

async function clearAll(page: Page): Promise<void> {
  const res = await page.request.get(`${BASE}/api/schedule?from=2026-11-01&to=2026-12-12`, { headers: BEARER });
  const { items } = (await res.json()) as { items: Array<{ id: string }> };
  for (const i of items) await page.request.delete(`${BASE}/api/schedule/items/${i.id}`, { headers: BEARER });
}

async function make(page: Page, m: Made): Promise<void> {
  const res = await page.request.post(`${BASE}/api/schedule/items`, { headers: BEARER, data: { side: "secretary", kind: "todo", ...m } });
  expect(res.status()).toBe(201);
}

async function openSchedule(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date("2026-11-04T09:00:00+09:00"));
  await page.goto(`${BASE}/pair?code=${await newPairingCode()}`);
  await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "予定", exact: true }).click();
  await expect(page.getByTestId("schedule-pane")).toBeVisible();
}

const block = (page: Page, title: string): Locator => page.getByTestId("schedule-event").filter({ hasText: title });
async function box(loc: Locator) {
  await expect(loc).toHaveCount(1);
  const b = await loc.boundingBox();
  expect(b).not.toBeNull();
  return b as { x: number; y: number; width: number; height: number };
}
const near = (actual: number, expected: number): void => { expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOLERANCE); };

test.beforeEach(async ({ page }) => { await clearAll(page); });
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await clearAll(page);
  await page.close();
});

for (const side of ["secretary", "dev"] as const) {
  test(`K1: day view puts blocks at their time and length (${side})`, async ({ page }) => {
    const tag = `k1${side}`;
    for (const m of [
      { title: `${tag}-a`, date: TODAY, start: "08:00", end: "09:00" },
      { title: `${tag}-b`, date: TODAY, start: "10:00", end: "11:00" },
      { title: `${tag}-c`, date: TODAY, start: "12:00", end: "14:00" },
      { title: `${tag}-d`, date: TOMORROW, start: "15:00", end: "16:00" },
    ]) await make(page, { side, ...m });
    await openSchedule(page);
    if (side === "dev") await page.getByRole("tab", { name: "開発", exact: true }).click();
    const a = await box(block(page, `${tag}-a`));
    const b = await box(block(page, `${tag}-b`));
    const c = await box(block(page, `${tag}-c`));
    const d = await box(block(page, `${tag}-d`));
    near(b.y - a.y, 2 * HOUR_PX);
    near(d.y - b.y, 5 * HOUR_PX);
    near(c.height - b.height, HOUR_PX);
    expect(d.x).toBeGreaterThan(b.x);
  });
}

test("K1b: day, week and month show the same items on the same day", async ({ page }) => {
  for (const [title, date] of [["k1b-mon", "2026-11-02"], ["k1b-wed", "2026-11-04"], ["k1b-thu", "2026-11-05"]]) await make(page, { title, date, start: "14:00", end: "15:00" });
  await openSchedule(page);
  await expect(block(page, "k1b-wed")).toHaveCount(1);
  await expect(block(page, "k1b-thu")).toHaveCount(1);

  await page.getByRole("tab", { name: "週", exact: true }).click();
  const mon = await box(block(page, "k1b-mon"));
  const wed = await box(block(page, "k1b-wed"));
  const thu = await box(block(page, "k1b-thu"));
  expect(mon.x).toBeLessThan(wed.x);
  expect(wed.x).toBeLessThan(thu.x);

  await page.getByRole("tab", { name: "月", exact: true }).click();
  for (const title of ["k1b-mon", "k1b-wed", "k1b-thu"]) await expect(block(page, title)).toHaveCount(1);

  await page.getByTestId("schedule-pane").getByRole("link", { name: /11月4日/ }).click();
  await page.getByRole("tab", { name: "日", exact: true }).waitFor();
  await expect(block(page, "k1b-wed")).toHaveCount(1);
  await expect(block(page, "k1b-thu")).toHaveCount(1);
  await expect(block(page, "k1b-mon")).toHaveCount(0);
  const wed2 = await box(block(page, "k1b-wed"));
  const thu2 = await box(block(page, "k1b-thu"));
  expect(thu2.x).toBeGreaterThan(wed2.x);
});

test("K4: add from the screen, mark done, then remove; state survives a reload", async ({ page }) => {
  await openSchedule(page);
  await page.getByRole("button", { name: "やることを足す", exact: true }).click();
  await page.getByLabel("題名").fill("k4-task");
  await page.getByLabel("開始").fill("10:00");
  await page.getByLabel("終了").fill("11:00");
  await page.getByRole("button", { name: "足す", exact: true }).click();
  await expect(block(page, "k4-task")).toHaveCount(1);

  await block(page, "k4-task").click();
  await page.getByTestId("schedule-detail").getByRole("button", { name: "終わった", exact: true }).click();
  await expect(block(page, "k4-task").getByText("終わった", { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole("tab", { name: "予定", exact: true }).click();
  await expect(block(page, "k4-task").getByText("終わった", { exact: true })).toBeVisible();

  await block(page, "k4-task").click();
  await page.getByTestId("schedule-detail").getByRole("button", { name: "消す", exact: true }).click();
  await expect(block(page, "k4-task")).toHaveCount(0);
});

test("K7b: overlapping items sit side by side and both carry the overlap badge", async ({ page }) => {
  await make(page, { title: "k7-a", date: TODAY, start: "13:00", end: "14:15" });
  await make(page, { title: "k7-b", date: TODAY, start: "14:00", end: "15:00" });
  await make(page, { title: "k7-c", date: TODAY, start: "16:00", end: "17:00" });
  await openSchedule(page);
  const a = await box(block(page, "k7-a"));
  const b = await box(block(page, "k7-b"));
  const [left, right] = a.x < b.x ? [a, b] : [b, a];
  expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1);
  await expect(block(page, "k7-a").getByText("重なり", { exact: true })).toBeVisible();
  await expect(block(page, "k7-b").getByText("重なり", { exact: true })).toBeVisible();
  await expect(block(page, "k7-c").getByText("重なり", { exact: true })).toHaveCount(0);
  await expect(page.getByText("時間が重なっています", { exact: true })).toBeVisible();
  await expect(page.getByTestId("schedule-overlaps")).toContainText("k7-a と k7-b");
});
