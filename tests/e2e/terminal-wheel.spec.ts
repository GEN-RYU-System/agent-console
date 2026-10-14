import { expect, test, type Page } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../fixtures/e2e-env";
import { newPairingCode } from "../fixtures/e2e-pairing";

// 端末ページのホイール（terminal-wheel）。マウス追跡（1003h+1006h）を有効にした役割（tests/fixtures/mouse-role.mjs）の端末で、
// 本物の Chromium + xterm 6.0.0 の wheel が「行の数 × 1 信号」になって役割に届くことを確かめる。設計: docs/handoff/terminal-wheel/design.md
// helper は console.spec.ts のものを写した（export されていないため。activity.spec.ts と同じ流儀）。
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const BEARER = { Authorization: `Bearer ${E2E_TOKEN}` };

async function openPaired(page: Page): Promise<void> {
  await page.goto(`${BASE}/pair?code=${await newPairingCode()}`);
  await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /端末/ }).click();
  await expect(page.getByRole("tab", { name: /端末/ })).toHaveAttribute("aria-selected", "true");
}

async function apiCreate(name: string, roleId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { ...BEARER, "Content-Type": "application/json" },
    body: JSON.stringify({ name, roleId }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const rowOf = (page: Page, id: string) => page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);

/** セッション数の上限（16）に空きが無ければ、先頭から閉じて need 件の枠を作る。 */
async function ensureRoom(need: number): Promise<void> {
  const { sessions } = (await (await fetch(`${BASE}/api/state`, { headers: BEARER })).json()) as { sessions: Array<{ id: string }> };
  const surplus = sessions.length + need - 16;
  for (const s of sessions.slice(0, Math.max(0, surplus))) await fetch(`${BASE}/api/sessions/${s.id}/close`, { method: "POST", headers: BEARER });
}

test("terminal-wheel K4: 追跡中の端末で、wheel は行の数ぶんの信号になり、向きが変わると端数を捨てる", async ({ page }) => {
  await ensureRoom(1);
  const id = await apiCreate("mouse-target", "e2e-mouse");
  try {
    await openPaired(page);
    await rowOf(page, id).click();
    const terminal = page.getByTestId("terminal");
    await expect(terminal).toContainText("READY");

    // 行高 h は 1 行目の getBoundingClientRect().height（dpr=1 では整数で、xterm の .xterm-screen の高さ / rows と一致する）
    const h = await page.evaluate(() => (document.querySelector(".xterm-rows > div") as HTMLElement).getBoundingClientRect().height);
    expect(h).toBeGreaterThan(0);

    // 最後の WHEEL: 行を読む。全行を連結して読む（役割は data のたびに WHEEL:<下>:<上> を出す。
    // 1003 モードでは mouse.move の動き信号（ESC [ < 35 ; …）でも WHEEL: 行が増えるが、数えるのは 65; / 64; だけなので値は変わらない）
    const lastWheel = async (): Promise<string> => {
      const text = await page.locator(".xterm-rows > div").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).innerText).join("\n"));
      return [...text.matchAll(/WHEEL:(\d+:\d+)/g)].map((m) => m[1]).pop() ?? "";
    };

    const box = await page.locator(".xterm-screen").boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    // 下向き 5.5 行 → 5 信号（端数 0.5 は持ち越し）
    await page.mouse.wheel(0, h * 5.5);
    await expect.poll(lastWheel).toBe("5:0");
    // 向きが変わると端数を捨てる: 上向き 3.5 行 → 3 信号
    await page.mouse.wheel(0, -h * 3.5);
    await expect.poll(lastWheel).toBe("5:3");
  } finally {
    await fetch(`${BASE}/api/sessions/${id}/close`, { method: "POST", headers: BEARER });
  }
});
