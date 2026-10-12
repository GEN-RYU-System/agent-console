import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../fixtures/e2e-env";
import { newPairingCode } from "../fixtures/e2e-pairing";

// 右の欄「このセッション」（v0.8.0）。本物の hook（dataDir/hooks/activity-hook.mjs）に Claude の入力の形の JSON を流し、
// アプリのサーバーが記録を読んで、画面に出すまでを通す。設定の足し込みは本物の scripts/ac-hooks.mjs で、一時の場所にだけ行う。
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const BEARER = { Authorization: `Bearer ${E2E_TOKEN}` };
const DATA_DIR = process.env.AC_E2E_DATA_DIR as string;
const CLAUDE_SETTINGS = process.env.AC_E2E_CLAUDE_SETTINGS as string;
const UUID_FILE = process.env.AC_E2E_UUID_FILE as string;
const HOOK = path.join(DATA_DIR, "hooks", "activity-hook.mjs");
const CLI = path.join(process.cwd(), "scripts", "ac-hooks.mjs");
/** 値が落ち着くまで待つ上限。サーバーは記録を 2 秒ごとに読み、画面は合図で取り直す */
const SETTLE_MS = 20000;
const OTHER_SESSION = "99999999-2222-4333-8444-555555555555";

const realSettings = path.join(os.homedir(), ".claude", "settings.json");
const sha256OrNull = (file: string): string | null => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);
const realSettingsHashBefore = sha256OrNull(realSettings);

test.describe.configure({ mode: "serial" });

let claudeSessionId = "";
let sessionName = "";

async function openPaired(page: Page): Promise<void> {
  await page.goto(`${BASE}/pair?code=${await newPairingCode()}`);
  await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
}

/** Claude が hook に渡す入力と同じ形の JSON を、本物の hook に流す */
function fireHook(input: Record<string, unknown>): void {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("");
}

const rightTab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

test.beforeAll(() => {
  writeFileSync(UUID_FILE, "uuid");
});
test.afterAll(() => {
  writeFileSync(UUID_FILE, "");
});

test("K1: セッションを選ぶ前は右の欄に「台帳」だけ。選ぶと「このセッション」が先に開く", async ({ page }) => {
  await openPaired(page);
  await expect(page.getByRole("tab", { name: "台帳", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "このセッション", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("ledger-filters")).toBeVisible();

  sessionName = `act-${Date.now().toString(36)}`;
  const res = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { ...BEARER, "Content-Type": "application/json" }, body: JSON.stringify({ name: sessionName, roleId: "e2e-plain" }) });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };

  // Claude の sessionId（UUID）が分かるまで待つ（agents --json を 1 秒ごとに取る）
  await expect
    .poll(
      async () => {
        const state = (await (await fetch(`${BASE}/api/state`, { headers: BEARER })).json()) as { sessions: Array<{ id: string; claudeSessionId?: string }> };
        return state.sessions.find((s) => s.id === id)?.claudeSessionId ?? "";
      },
      { timeout: SETTLE_MS },
    )
    .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const state = (await (await fetch(`${BASE}/api/state`, { headers: BEARER })).json()) as { sessions: Array<{ id: string; claudeSessionId?: string }> };
  claudeSessionId = state.sessions.find((s) => s.id === id)?.claudeSessionId ?? "";

  await page.reload();
  await page.getByTestId("session-row").filter({ hasText: sessionName }).click();
  await expect(rightTab(page, "このセッション")).toHaveAttribute("aria-selected", "true");
  await expect(rightTab(page, "台帳")).toHaveAttribute("aria-selected", "false");
  await expect(page.getByTestId("activity-pane")).toBeVisible();
  await expect(page.getByTestId("ledger-filters")).toHaveCount(0);

  // 「台帳」に替えると台帳が出る。別のセッションの行を選ぶと、また「このセッション」が先に開く
  await rightTab(page, "台帳").click();
  await expect(page.getByTestId("ledger-filters")).toBeVisible();
  const otherName = `${sessionName}-b`;
  const other = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { ...BEARER, "Content-Type": "application/json" }, body: JSON.stringify({ name: otherName, roleId: "e2e-plain" }) });
  expect(other.status).toBe(201);
  await page.getByTestId("session-row").filter({ hasText: otherName }).click();
  await expect(rightTab(page, "このセッション")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("ledger-filters")).toHaveCount(0);
});

test("K8: 記録の仕組みが外れているとき（settings.json に handler が無い）は、案内を出す。足すと消える", async ({ page }) => {
  await openPaired(page);
  expect(existsSync(CLAUDE_SETTINGS)).toBe(false);
  await page.getByTestId("session-row").filter({ hasText: sessionName }).click();
  const warning = page.getByTestId("activity-hooks-warning");
  await expect(warning).toContainText("記録の仕組みが外れています", { timeout: SETTLE_MS });
  await expect(warning).toContainText("scripts/ac-hooks.mjs install");

  // 本物の道具で、一時の settings に足す（実際の ~/.claude には触れない）
  const out = execFileSync(process.execPath, [CLI, "install", "--settings", CLAUDE_SETTINGS, "--data-dir", DATA_DIR], { encoding: "utf8" });
  expect(out).toContain("足しました");
  const check = spawnSync(process.execPath, [CLI, "check", "--settings", CLAUDE_SETTINGS, "--data-dir", DATA_DIR], { encoding: "utf8" });
  expect(check.status).toBe(0);
  await expect(warning).toHaveCount(0, { timeout: SETTLE_MS });
});

test("K2/K3/K7: 本物の hook に流した記録が、選んだセッションの分だけ、非エンジニアに分かる言葉で出る", async ({ page }) => {
  expect(existsSync(HOOK)).toBe(true);
  await openPaired(page);
  await page.getByTestId("session-row").filter({ hasText: sessionName }).click();
  const pane = page.getByTestId("activity-pane");
  await expect(pane.getByTestId("activity-running")).toContainText("動いている担当はいません", { timeout: SETTLE_MS });

  const base = { session_id: claudeSessionId, transcript_path: "/not/kept/transcript.jsonl", cwd: "/not/kept" };
  // 担当を呼ぶ（Sonnet）。別のセッション（アプリの外）の記録も同じ場所に入る
  fireHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "toolu_e2e_1", tool_input: { description: "ログ画面の調べもの", prompt: "長い指示は残さない", subagent_type: "general-purpose", model: "sonnet" } });
  fireHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_e2e_1", tool_input: {}, tool_response: { status: "async_launched", agentId: "agent-e2e-1", resolvedModel: "claude-sonnet-5-5" } });
  fireHook({ session_id: OTHER_SESSION, hook_event_name: "TaskCreated", task_id: "1", task_subject: "アプリの外のセッションのやること" });
  fireHook({ ...base, hook_event_name: "TaskCreated", task_id: "1", task_subject: "ログ画面を調べる" });
  fireHook({ ...base, hook_event_name: "TaskCreated", task_id: "2", task_subject: "直し方をまとめる" });
  fireHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "ログ画面の遅さを調べてください" });

  const running = pane.getByTestId("activity-running");
  await expect(running.getByTestId("activity-agent")).toHaveCount(1, { timeout: SETTLE_MS });
  await expect(running).toContainText("Sonnet（調査・実装）");
  await expect(running).toContainText("ログ画面の調べもの");
  await expect(running).toContainText("動き始めて");
  // 技術の用語は出さない
  await expect(pane).not.toContainText(/worktree|ブランチ/i);
  await expect(pane.getByTestId("activity-finished")).toContainText("終わった担当はまだありません");
  const tasks = pane.getByTestId("activity-task");
  await expect(tasks).toHaveText(["ログ画面を調べる", "直し方をまとめる"]);
  await expect(tasks.first()).toHaveAttribute("data-done", "false");
  await expect(pane.getByTestId("activity-input").first()).toContainText("ログ画面の遅さを調べてください");
  // K7: 別のセッションの記録は出ない
  await expect(pane).not.toContainText("アプリの外のセッション");

  // 担当が報告して終わる → 終わった担当に移り、結果のひとことと時間が出る
  fireHook({ ...base, hook_event_name: "PreToolUse", tool_name: "SubagentHandback", agent_id: "agent-e2e-1", tool_input: { message: "原因は一覧の再描画でした" } });
  fireHook({ ...base, hook_event_name: "SubagentStop", agent_id: "agent-e2e-1", agent_type: "general-purpose" });
  fireHook({ ...base, hook_event_name: "TaskCompleted", task_id: "1", task_subject: "ログ画面を調べる" });
  const finished = pane.getByTestId("activity-finished");
  await expect(finished.getByTestId("activity-agent")).toHaveCount(1, { timeout: SETTLE_MS });
  await expect(finished).toContainText("Sonnet（調査・実装）");
  await expect(finished).toContainText("ログ画面の調べもの");
  await expect(finished).toContainText("原因は一覧の再描画でした");
  await expect(finished).toContainText("かかった");
  await expect(running).toContainText("動いている担当はいません");
  await expect(tasks.first()).toHaveAttribute("data-done", "true");
  await expect(tasks.nth(1)).toHaveAttribute("data-done", "false");

  // 記録は本物の hook が決めた項目だけ（会話の本文・transcript のパスは残らない）
  const events = readFileSync(path.join(DATA_DIR, "activity", readdirEvents()), "utf8");
  expect(events).not.toContain("長い指示は残さない");
  expect(events).not.toContain("/not/kept");
});

test("実際の ~/.claude/settings.json は変わらない", async () => {
  test.skip(realSettingsHashBefore === null, "~/.claude/settings.json が存在しない環境のためスキップ");
  expect(sha256OrNull(realSettings)).toBe(realSettingsHashBefore);
});

function readdirEvents(): string {
  const dir = path.join(DATA_DIR, "activity");
  const names = readdirSync(dir).filter((n) => /^events-\d{8}\.jsonl$/.test(n)).sort();
  expect(names.length).toBeGreaterThan(0);
  return names[names.length - 1];
}
