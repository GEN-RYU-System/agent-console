import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../fixtures/e2e-env";
import { newPairingCode } from "../fixtures/e2e-pairing";

// チャット画面（v0.11.0）。本物の hook（dataDir/hooks/activity-hook.mjs）に Claude の入力の形の JSON を流し、
// アプリのサーバーが記録を読んで、チャットに出るまでを通す。送るときは、本物の画面から本物の端末（役割 e2e-plain）へ貼る。
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const BEARER = { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" };
const DATA_DIR = process.env.AC_E2E_DATA_DIR as string;
const STATUS_FILE = process.env.AC_E2E_STATUS_FILE as string;
const UUID_FILE = process.env.AC_E2E_UUID_FILE as string;
const HOOK = path.join(DATA_DIR, "hooks", "activity-hook.mjs");
/** 値が落ち着くまで待つ上限。サーバーは記録を 2 秒ごとに読み、画面は合図で取り直す */
const SETTLE_MS = 20000;
const STATE_DEADLINE_MS = 20000;

// 本物の hook を何十回も起動する試験があり、混み合った機械では 30 秒（既定）を超えることがある
test.describe.configure({ mode: "serial", timeout: 120000 });

/** 後の試験（console.spec.ts）が一覧の件数・よく使う指示の件数を数えるので、この試験で作ったものは片づける */
const createdSessions: string[] = [];
const createdPrompts: string[] = [];

test.beforeAll(() => {
  writeFileSync(UUID_FILE, "uuid");
  writeFileSync(STATUS_FILE, "busy");
});
test.afterAll(async () => {
  writeFileSync(UUID_FILE, "");
  writeFileSync(STATUS_FILE, "busy");
  for (const id of createdPrompts) await fetch(`${BASE}/api/quick-prompts/${id}`, { method: "DELETE", headers: BEARER });
  for (const id of createdSessions) await fetch(`${BASE}/api/sessions/${id}/close`, { method: "POST", headers: BEARER, body: "{}" });
});

async function openPairedOnChat(page: Page): Promise<void> {
  await page.goto(`${BASE}/pair?code=${await newPairingCode()}`);
  await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
}

interface Made {
  id: string;
  name: string;
  claudeSessionId: string;
}
/** セッションを作り、Claude の sessionId（UUID）が分かるまで待つ（claude agents --json を 1 秒ごとに取る） */
async function makeSession(roleId: string, label: string): Promise<Made> {
  const name = `${label}-${Date.now().toString(36)}`;
  const res = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: BEARER, body: JSON.stringify({ name, roleId }) });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
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
    .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return { id, name, claudeSessionId };
}

/** Claude が hook に渡す入力と同じ形の JSON を、本物の hook に流す */
function fireHook(input: Record<string, unknown>): void {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("");
}

const rowOf = (page: Page, name: string): Locator => page.getByTestId("session-row").filter({ hasText: name });
const tab = (page: Page, name: RegExp): Locator => page.getByRole("tab", { name });
const bubbles = (page: Page): Locator => page.getByTestId("chat-bubble");

test("K1: 最初に開くタブはチャット。端末は隠れた状態で開いていて、端末タブを押すと見える（大きさが見えたときに合う）", async ({ page }) => {
  const s = await makeSession("e2e-size", "chat-first");
  await openPairedOnChat(page);
  const labels = await page.locator(".ac-center-tabs [role=tab]").allTextContents();
  expect(labels.map((l) => l.replace(/\d+$/, ""))).toEqual(["チャット", "端末", "変更", "ファイル", "PR", "部品", "定期実行", "予約"]);
  await expect(tab(page, /チャット/)).toHaveAttribute("aria-selected", "true");
  await rowOf(page, s.name).click();
  await expect(page.getByTestId("chat-pane")).toBeVisible();
  // 端末は DOM にあり（接続は保たれる）、見えていない
  await expect(page.getByTestId("terminal")).toBeAttached();
  await expect(page.getByTestId("terminal")).toBeHidden();
  await tab(page, /端末/).click();
  await expect(page.getByTestId("terminal")).toBeVisible();
  await expect(page.getByTestId("chat-pane")).toBeHidden();
  // 見えたときに大きさが合う: 最後の SIZE が、起動時の既定（120x30）でも 2 列でもなく、落ち着いた値になる
  const lastSize = async (): Promise<string> => {
    const text = await page.getByTestId("terminal").innerText();
    return text.split("\n").filter((l) => l.startsWith("SIZE")).at(-1) ?? "";
  };
  let before = "";
  await expect
    .poll(
      async () => {
        const now = await lastSize();
        const settled = now !== "" && now === before;
        before = now;
        return settled;
      },
      { timeout: 15000, intervals: [1000] },
    )
    .toBe(true);
  const m = /^SIZE (\d+)x(\d+)$/.exec(await lastSize());
  expect(m).not.toBeNull();
  expect(Number(m?.[1])).toBeGreaterThan(40);
  expect(`${m?.[1]}x${m?.[2]}`).not.toBe("120x30");
  expect(await page.getByTestId("terminal").innerText()).not.toMatch(/SIZE 2x1\b/);
  // チャットに戻っても、端末へ戻っても、そのまま使える
  await tab(page, /チャット/).click();
  await expect(page.getByTestId("chat-pane")).toBeVisible();
  await tab(page, /端末/).click();
  await expect(page.getByTestId("terminal")).toContainText("READY");
});

test("K2/K3/K4: 本物の hook に流した記録が、右に自分・左に Claude の吹き出しで出る。包み・担当の報告の戻りは出ず、HTML は描画されない", async ({ page }) => {
  const s = await makeSession("e2e-plain", "chat-view");
  const base = { session_id: s.claudeSessionId, transcript_path: "/not/kept/transcript.jsonl", cwd: "/not/kept" };
  fireHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "ログ画面の遅さを調べてください\n二行目です" });
  fireHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: '<agent-message from="adb7">\n[Subagent hand-back] 担当の報告の戻りは出さない' });
  fireHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: '\n\n<pasted_content id="0995">\n貼った1行目\n貼った2行目\n貼った3行目\n貼った4行目\n</pasted_content id="0995">\n' });
  fireHook({
    ...base,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: [
      "## 調べた結果",
      "",
      "- **原因**は一覧の再描画です",
      "- 直し方は `memo` を使うことです",
      "",
      "| 名前 | 値 |",
      "| --- | --- |",
      "| a | 1 |",
      "",
      "[公式](https://example.com/docs) と [危ない](javascript:alert(1))",
      "",
      "<script>window.__pwned = 1</script>",
      "",
      "```ts",
      "const a = 1;",
      "```",
    ].join("\n"),
  });
  fireHook({ ...base, hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "API Error: Rate limit reached" });
  // 1 回の入力に Stop が何回か来た（stop_hook_active）→ その数だけ吹き出しが出る
  fireHook({ ...base, hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "続きの返事です" });

  await openPairedOnChat(page);
  await rowOf(page, s.name).click();
  await expect(bubbles(page)).toHaveCount(4, { timeout: SETTLE_MS });
  // 順番: 入力 → 貼り付けの入力 → 返事 → 返事（エラーの案内は、吹き出しではなく別の表示）
  await expect(bubbles(page).nth(0)).toHaveText("ログ画面の遅さを調べてください\n二行目です");
  await expect(bubbles(page).nth(1)).toHaveText("貼った1行目\n貼った2行目\n貼った3行目\n貼った4行目");
  await expect(page.getByTestId("chat-pane")).not.toContainText("pasted_content");
  await expect(page.getByTestId("chat-pane")).not.toContainText("担当の報告の戻りは出さない");
  await expect(page.getByTestId("chat-error")).toContainText("利用の上限");
  const reply = bubbles(page).nth(2);
  await expect(reply.locator("h2")).toHaveText("調べた結果");
  await expect(reply.locator("li").first()).toContainText("原因");
  await expect(reply.locator("li strong")).toHaveText("原因");
  await expect(reply.locator("li code")).toHaveText("memo");
  await expect(reply.locator("th")).toHaveText(["名前", "値"]);
  await expect(reply.locator("pre code")).toContainText("const a = 1;");
  await expect(bubbles(page).nth(3)).toHaveText("続きの返事です");
  // K4: HTML は描画されない。javascript: のリンクは作られない。ふつうのリンクは別のタブで開く
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(reply.locator("script")).toHaveCount(0);
  const hrefs = await reply.locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toEqual(["https://example.com/docs"]);
  await expect(reply.locator("a")).toHaveAttribute("target", "_blank");
  await expect(reply.locator("a")).toHaveAttribute("rel", "noopener noreferrer");
  await expect(reply).toContainText("危ない");
  // 右寄せ（自分）と左寄せ（Claude）
  const list = (await page.getByTestId("chat-list").boundingBox()) as { x: number; width: number };
  const mine = (await bubbles(page).nth(0).boundingBox()) as { x: number; width: number };
  const theirs = (await reply.boundingBox()) as { x: number; width: number };
  const mid = list.x + list.width / 2;
  expect(mine.x + mine.width / 2).toBeGreaterThan(mid);
  expect(theirs.x + theirs.width / 2).toBeLessThan(mid);
  expect(list.x + list.width - (mine.x + mine.width)).toBeLessThan(80);
  expect(theirs.x - list.x).toBeLessThan(80);
  // 色は SA の吹き出しのトークン（右 = outbound、左 = inbound）
  const colors = await page.evaluate(() => {
    const probe = (v: string): string => {
      const el = document.createElement("div");
      el.style.background = `var(${v})`;
      document.body.appendChild(el);
      const c = getComputedStyle(el).backgroundColor;
      el.remove();
      return c;
    };
    const rows = [...document.querySelectorAll("[data-testid=chat-bubble]")];
    return { out: probe("--bubble-outbound-bg"), inn: probe("--bubble-inbound-bg"), mine: getComputedStyle(rows[0]).backgroundColor, theirs: getComputedStyle(rows[2]).backgroundColor };
  });
  expect(colors.mine).toBe(colors.out);
  expect(colors.theirs).toBe(colors.inn);
});

test("file-viewer K1/K4: ファイルタブを開いたまま、本物の hook に Write を流すと名前が出る。押すと .md が整えた表示で出る", async ({ page }) => {
  const s = await makeSession("e2e-plain", "files-view");
  const dir = path.join(DATA_DIR, "e2e-files");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `報告-${Date.now().toString(36)}.md`);
  writeFileSync(file, "# 調べた結果\n\n- 原因は **memo**\n\n[外](https://example.com/x) [相対](./a.md)\n");

  await openPairedOnChat(page);
  await rowOf(page, s.name).click();
  await tab(page, /^ファイル/).click();
  await expect(page.getByText("このセッションが書いたファイルはまだありません")).toBeVisible({ timeout: SETTLE_MS });
  // タブを開いたまま、hook に記録を流す（K1: 取り直しの操作なしで出る）
  fireHook({ session_id: s.claudeSessionId, transcript_path: "/not/kept/transcript.jsonl", cwd: dir, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file, content: "x" }, tool_response: {} });
  const name = path.basename(file);
  // K1: 5 秒以内（サーバーは記録を 2 秒ごとに読み、画面は rev の合図で取り直す）
  await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: new RegExp(name) }).click();
  const view = page.locator(".ac-files__view .ac-md");
  await expect(view.locator("h1")).toHaveText("調べた結果");
  await expect(view.locator("li strong")).toHaveText("memo");
  const hrefs = await view.locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toEqual(["https://example.com/x"]);
});

test("K2/K8: 新しいものが来たら一番下まで動く。上を読んでいるときは動かさない。64KiB を超える返事は切り詰めて「（以下略）」", async ({ page }) => {
  const s = await makeSession("e2e-plain", "chat-scroll");
  const base = { session_id: s.claudeSessionId };
  // 画面を開くための問い合わせ（Node の fetch）は、hook を 60 回続けて起動して待たせる前に済ませる（待たせると、使い回している接続をサーバーが先に閉じる）
  await openPairedOnChat(page);
  for (let i = 0; i < 30; i++) {
    fireHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: `質問 ${i}\n${"あ".repeat(60)}` });
    fireHook({ ...base, hook_event_name: "Stop", last_assistant_message: `返事 ${i}\n\n- 一\n- 二\n- 三` });
  }
  await rowOf(page, s.name).click();
  await expect(bubbles(page)).toHaveCount(60, { timeout: SETTLE_MS });
  const list = page.getByTestId("chat-list");
  const gap = (): Promise<number> => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(gap, { timeout: 5000 }).toBeLessThanOrEqual(2);
  // 一番下にいるときに来たものは、一番下まで動く
  fireHook({ ...base, hook_event_name: "Stop", last_assistant_message: "一番下に来た返事" });
  await expect(bubbles(page)).toHaveCount(61, { timeout: SETTLE_MS });
  await expect(bubbles(page).last()).toContainText("一番下に来た返事");
  await expect.poll(gap, { timeout: 5000 }).toBeLessThanOrEqual(2);
  // 上を読んでいるとき（一番上まで戻した）に来たものは、動かさない
  await list.evaluate((el) => (el.scrollTop = 0));
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
  fireHook({ ...base, hook_event_name: "Stop", last_assistant_message: "上を読んでいる間に来た返事" });
  await expect(bubbles(page)).toHaveCount(62, { timeout: SETTLE_MS });
  await page.waitForTimeout(500);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  // 長すぎる返事（1 行 64KiB を超える）: 切り詰められて、末尾に「（以下略）」
  fireHook({ ...base, hook_event_name: "Stop", last_assistant_message: `長い返事の先頭\n${"あいうえお".repeat(20000)}` });
  await expect(bubbles(page)).toHaveCount(63, { timeout: SETTLE_MS });
  const lines = readFileSync(path.join(DATA_DIR, "activity", readdirSync(path.join(DATA_DIR, "activity")).filter((n) => /^events-\d{8}\.jsonl$/.test(n)).sort().at(-1) as string), "utf8").split("\n").filter(Boolean);
  const biggest = Math.max(...lines.map((l) => Buffer.byteLength(`${l}\n`)));
  expect(biggest).toBeLessThanOrEqual(64 * 1024);
  expect(biggest).toBeGreaterThan(60 * 1024);
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(bubbles(page).last()).toContainText("長い返事の先頭");
  await expect(bubbles(page).last()).toContainText("（以下略）");
});

test("K1/K3/K4/K7/K8: 入力欄から送ると予約に入る。作業中でもすぐ端末に書かれ、受け取りの記録で消える。確認の待ちでは予約になり、取り消せ、手が空いたら書かれる。よく使う指示は入力欄に入る", async ({ page }) => {
  const s = await makeSession("e2e-plain", "chat-send");
  const promptRes = await fetch(`${BASE}/api/quick-prompts`, { method: "POST", headers: BEARER, body: JSON.stringify({ label: "テスト実行", text: "run the tests please" }) });
  expect(promptRes.status).toBe(201);
  createdPrompts.push(((await promptRes.json()) as { id: string }).id);

  writeFileSync(STATUS_FILE, "idle");
  await openPairedOnChat(page);
  await rowOf(page, s.name).click();
  await expect(rowOf(page, s.name).getByTestId("status")).toHaveAttribute("data-state", "idle", { timeout: STATE_DEADLINE_MS });
  const input = page.getByTestId("chat-input");
  const send = page.getByRole("button", { name: "送る", exact: true });
  const queueItems = page.getByTestId("chat-queue-item");
  await expect(send).toBeDisabled();

  // よく使う指示を押すと入力欄に入る（すぐには送らない）
  await page.getByTestId("quick-prompt-bar").getByRole("button", { name: "テスト実行", exact: true }).click();
  await expect(input).toHaveValue("run the tests please");
  await page.waitForTimeout(500);
  await expect(queueItems).toHaveCount(0);
  await input.fill("");

  // Shift+Enter は改行（送らない）／変換中（isComposing）の Enter では送らない
  await input.click();
  await page.keyboard.type("first-line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second-line");
  await expect(input).toHaveValue("first-line\nsecond-line");
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(500);
  await expect(queueItems).toHaveCount(0);
  await expect(input).toHaveValue("first-line\nsecond-line");

  // 手が空いているとき: Enter で予約に入り、入力欄は空になる。サーバーが端末に書き（「送信済み」）、受け取りの記録（hook）が届くと会話に出て、予約は消える
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(queueItems).toHaveCount(1);
  await expect(queueItems.first()).toHaveAttribute("data-state", "sent", { timeout: 15000 });
  await expect(queueItems.first()).toContainText("送信済み（受け取り待ち）");
  await tab(page, /端末/).click();
  await expect(page.getByTestId("terminal")).toContainText("first-line", { timeout: 15000 });
  await expect(page.getByTestId("terminal")).toContainText("second-line");
  await tab(page, /チャット/).click();
  fireHook({ session_id: s.claudeSessionId, hook_event_name: "UserPromptSubmit", prompt: "first-line\nsecond-line" });
  await expect(bubbles(page).last()).toHaveText("first-line\nsecond-line", { timeout: SETTLE_MS });
  await expect(queueItems).toHaveCount(0);

  // 作業中（待ちなし）: 予約の案内は出ず、送ると待たずに端末へ書かれる（Claude Code 本体の順番待ちに入る）。受け取りの記録（hook）が届くと予約は消えて会話に出る
  writeFileSync(STATUS_FILE, "busy");
  await expect(rowOf(page, s.name).getByTestId("status")).toHaveAttribute("data-state", "working", { timeout: STATE_DEADLINE_MS });
  await input.fill("queued-while-busy");
  await expect(send).toBeEnabled();
  await expect(page.getByTestId("chat-blocked")).toHaveCount(0);
  await input.press("Enter");
  await expect(queueItems).toHaveCount(1);
  await tab(page, /端末/).click();
  await expect(page.getByTestId("terminal")).toContainText("queued-while-busy", { timeout: 20000 });
  await tab(page, /チャット/).click();
  await expect(queueItems.first()).toHaveAttribute("data-state", "sent");
  fireHook({ session_id: s.claudeSessionId, hook_event_name: "UserPromptSubmit", prompt: "queued-while-busy" });
  await expect(queueItems).toHaveCount(0, { timeout: SETTLE_MS });
  await expect(bubbles(page).last()).toHaveText("queued-while-busy");

  // 確認の待ち: 案内と端末へ移る Button を出したまま、予約もできる
  writeFileSync(STATUS_FILE, "waiting");
  await expect(rowOf(page, s.name).getByTestId("status")).toHaveAttribute("data-state", "waiting", { timeout: STATE_DEADLINE_MS });
  await expect(page.getByTestId("chat-blocked")).toContainText("端末で確認が出ています");
  // 取り消せる（取り消した予約は、手が空いても書かれない）
  await input.fill("cancelled-while-waiting");
  await input.press("Enter");
  await expect(queueItems).toHaveCount(1);
  await expect(page.getByTestId("chat-queue-note")).toContainText("アプリを再起動すると予約は消えます");
  await queueItems.first().getByRole("button", { name: "取り消す", exact: true }).click();
  await expect(queueItems).toHaveCount(0);
  await input.fill("queued-while-waiting");
  await expect(send).toBeEnabled();
  await input.press("Enter");
  await expect(queueItems).toHaveCount(1);
  await expect(queueItems.first()).toHaveAttribute("data-state", "queued");
  await page.getByTestId("chat-blocked").getByRole("button", { name: "端末を開く", exact: true }).click();
  await expect(tab(page, /端末/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("terminal")).toBeVisible();
  await expect(page.getByTestId("terminal")).not.toContainText("queued-while-waiting");

  // 手が空くと、予約が端末に書かれる（作業中・確認の待ちの間は書かれていない）
  writeFileSync(STATUS_FILE, "idle");
  await expect(page.getByTestId("terminal")).toContainText("queued-while-waiting", { timeout: 20000 });
  await expect(page.getByTestId("terminal")).not.toContainText("cancelled-while-waiting");
  await tab(page, /チャット/).click();
  await expect(queueItems.first()).toHaveAttribute("data-state", "sent");
  fireHook({ session_id: s.claudeSessionId, hook_event_name: "UserPromptSubmit", prompt: "queued-while-waiting" });
  await expect(queueItems).toHaveCount(0, { timeout: SETTLE_MS });
  await expect(bubbles(page).last()).toHaveText("queued-while-waiting");
});
