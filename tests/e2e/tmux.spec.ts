import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { E2E_TMUX_PORT, E2E_TOKEN } from "../fixtures/e2e-env";
import { newPairingCode } from "../fixtures/e2e-pairing";

/** terminalHost "tmux"（試験用ソケット ac-test-<pid>-<乱数>）で、ブラウザ → xterm.js → サーバー → tmux を端から端まで通す 1 本 */
const BASE = `http://127.0.0.1:${E2E_TMUX_PORT}`;
const SOCKET = process.env.AC_E2E_TMUX_SOCKET as string;

function tmux(...args: string[]): string {
  const bin = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => {
    try {
      execFileSync(p, ["-V"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }) as string;
  return execFileSync(bin, ["-u", "-L", SOCKET, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

test("tmux: セッションが試験用ソケットの tmux の中に作られ、端末タブで入力が通り、閉じると tmux のセッションも消える", async ({ page }) => {
  expect(SOCKET.startsWith("ac-test-")).toBe(true);
  await page.goto(`${BASE}/pair?code=${await newPairingCode(E2E_TMUX_PORT)}`);
  await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
  const res = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "tmux-e2e", roleId: "e2e-plain" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect(tmux("list-sessions", "-F", "#{session_name}").trim()).toBe(`ac-${id}`);
  await page.getByRole("tab", { name: /端末/ }).click();
  await page.locator(`[data-testid="session-row"][data-session-id="${id}"]`).click();
  const terminal = page.getByTestId("terminal");
  await expect(terminal).toContainText("READY", { timeout: 15000 });
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("tmux-e2e-ok");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("tmux-e2e-ok", { timeout: 15000 });
  // tmux 側の画面にも同じ内容がある
  expect(tmux("capture-pane", "-p", "-t", `=ac-${id}:`)).toContain("tmux-e2e-ok");
  const del = await fetch(`${BASE}/api/sessions/${id}/close`, { method: "POST", headers: { Authorization: `Bearer ${E2E_TOKEN}` } });
  expect(del.status).toBe(200);
  await expect.poll(() => { try { return tmux("list-sessions", "-F", "#{session_name}").trim(); } catch { return ""; } }, { timeout: 10000 }).not.toContain(`ac-${id}`);
});

test("tmux: relayDir の無い設定（試験用ポート）では引き継ぎは 409 relay not configured で、フォルダも作られない", async () => {
  const create = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "tmux-relay-409", roleId: "e2e-plain" }),
  });
  expect(create.status).toBe(201);
  const { id } = (await create.json()) as { id: string };
  const res = await fetch(`${BASE}/api/sessions/${id}/relay`, { method: "POST", headers: { Authorization: `Bearer ${E2E_TOKEN}` } });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe("relay not configured");
  await fetch(`${BASE}/api/sessions/${id}/close`, { method: "POST", headers: { Authorization: `Bearer ${E2E_TOKEN}` } });
});
