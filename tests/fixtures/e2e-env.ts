import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const E2E_PORT = 4329;
export const E2E_TOKEN = "e2e-token-0123456789abcdef0123456789abcdef";

const here = path.dirname(new URL(import.meta.url).pathname);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const pad = (n: number): string => String(n).padStart(2, "0");
/** 台帳の開始日時の書式（YYYY-MM-DD HH:MM、ローカル時刻）。実行日からの相対にして、日が進んでも絞り込みの期待が変わらないようにする。 */
function ledgerDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * MS_PER_DAY);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LEDGER_SEED: ReadonlyArray<{ branch: string; state: string | null; started?: string }> = [
  { branch: "release/seed-a", state: "IN_PROGRESS", started: ledgerDate(1) },
  { branch: "release/seed-b", state: "IN_PROGRESS", started: ledgerDate(2) },
  { branch: "release/seed-c", state: "REVIEW", started: ledgerDate(3) },
  { branch: "release/seed-d", state: "DONE", started: ledgerDate(4) },
  { branch: "release/seed-e", state: "ABANDONED", started: ledgerDate(5) },
  { branch: "release/seed-f", state: null }, // ブランチ行だけで表の行が無い → 未登録
  { branch: "release/seed-old", state: "IN_PROGRESS", started: ledgerDate(60) }, // 30 日より古い
  { branch: "release/seed-baddate", state: "IN_PROGRESS", started: "20260920_010000" }, // 日付を読めない
  { branch: "release/seed-wip", state: "WIP", started: ledgerDate(6) },
];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** 一時 git リポジトリ（salesanchorRoot 役）・スタブ・設定ファイルを作り、設定ファイルのパスなどを環境変数で共有する。 */
export function prepareE2eEnv(): void {
  if (process.env.AC_E2E_DIR) return;
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-console-e2e-")));
  const root = path.join(base, "repo");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, ".claude-pipeline", "active-work.d"), { recursive: true });
  for (const name of ["new-worktree.sh", "ledger-lookup.sh"]) {
    copyFileSync(path.join(here, name), path.join(root, "scripts", name));
    chmodSync(path.join(root, "scripts", name), 0o755);
  }
  for (const { branch, state, started } of LEDGER_SEED) {
    const safe = branch.replace(/\//g, "-");
    const row = state ? `| ${branch} | e2e | ${started} | ${state} | | | seed |\n` : "";
    writeFileSync(
      path.join(root, ".claude-pipeline", "active-work.d", `${safe}.md`),
      `branch: ${branch}\n\n| ブランチ名 | 担当機能エリア | 開始日時 | 状態 | PR# | main | 備考 |\n|---|---|---|---|---|---|---|\n${row}`,
    );
  }
  // 変更タブの試験用の追跡ファイル（基準に入れておき、試験が書き換えて削除行と追加行を作る）
  writeFileSync(path.join(root, "e2e-diff-seed.txt"), "keep1\nold line\nkeep2\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "add", "-A");
  git(root, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "seed");
  // 変更タブの基準（origin/main）。一時リポジトリには remote が無いので、参照だけ作る
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  // PR タブの試験用。origin は GitHub の URL の形だけ（gh は偽物なので、ネットワークには出ない）
  git(root, "remote", "add", "origin", "https://github.com/example/repo.git");

  const statusFile = path.join(base, "agent-status");
  writeFileSync(statusFile, "busy");
  const claudeBin = path.join(base, "claude-stub.sh");
  copyFileSync(path.join(here, "claude-stub.sh"), claudeBin);
  chmodSync(claudeBin, 0o755);

  const nameFile = path.join(base, "agent-name");
  writeFileSync(nameFile, "");
  const slowFile = path.join(base, "agents-slow");
  writeFileSync(slowFile, "");
  const osascriptLog = path.join(base, "osascript.log");
  writeFileSync(osascriptLog, "");
  const osascriptBin = path.join(base, "osascript-stub.sh");
  copyFileSync(path.join(here, "osascript-stub.sh"), osascriptBin);
  chmodSync(osascriptBin, 0o755);
  // 偽 gh（出力は STUB_GH_DIR のファイルで切り替える。既定は「PR なし」）
  const ghBin = path.join(base, "gh-stub.sh");
  copyFileSync(path.join(here, "gh-stub.sh"), ghBin);
  chmodSync(ghBin, 0o755);
  const ghDir = path.join(base, "gh-fx");
  mkdirSync(ghDir);
  writeFileSync(path.join(ghDir, "list.out"), "[]");
  const ghLog = path.join(base, "gh.log");
  writeFileSync(ghLog, "");
  const dataDir = path.join(base, "data");
  // 右の欄の「記録の仕組み」の点検が読む Claude の設定（一時の場所。実際の ~/.claude には触れない）
  const claudeSettingsPath = path.join(base, "claude-home", ".claude", "settings.json");
  mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
  // 空でなければ、スタブの claude agents の sessionId が UUID の形になる
  const uuidFile = path.join(base, "agents-uuid");
  writeFileSync(uuidFile, "");

  const roleScript = path.join(here, "role.mjs");
  const bracketedScript = path.join(here, "bracketed-role.mjs");
  const sizeScript = path.join(here, "size-role.mjs");
  const punctScript = path.join(here, "punct-role.mjs");
  const marker = "agent-console-e2e-role";
  const config = {
    port: E2E_PORT,
    salesanchorRoot: root,
    newWorktreeScript: "scripts/new-worktree.sh",
    ledgerLookupScript: "scripts/ledger-lookup.sh",
    ledgerDir: ".claude-pipeline/active-work.d",
    claudeBin,
    agentsPollMs: 1000,
    ledgerPollMs: 60000,
    ringBufferBytes: 1048576,
    dataDir,
    notify: { macos: true, osascriptBin },
    ghBin,
    prPollMs: 1000,
    prRefreshMinMs: 1,
    pickMaxKeep: 50,
    pickSendMaxBytes: 16384,
    pickHtmlInPromptChars: 1500,
    activityKeepDays: 7,
    claudeSettingsPath,
    terminalSmoothScrollMs: 125,
    uploadMaxBytes: 5242880,
    uploadMaxKeep: 100,
    roles: [
      { id: "e2e-plain", labelKey: "role.shell", command: [process.execPath, roleScript, marker], needsWorktree: false },
      { id: "e2e-wt", labelKey: "role.sonnetImpl", command: [process.execPath, roleScript, marker], needsWorktree: true },
      {
        id: "e2e-resume",
        labelKey: "role.sonnetImpl",
        command: [process.execPath, roleScript, marker],
        needsWorktree: false,
        resumeScope: "worktree",
        resumeCommand: ["/bin/sh", "-c", `echo RESUMED_WT id=[$AC_RESUME_ID]; exec "${process.execPath}" "${roleScript}" ${marker}`],
      },
      {
        id: "e2e-resume-main",
        labelKey: "role.opusDesigner",
        command: [process.execPath, roleScript, marker],
        needsWorktree: false,
        resumeScope: "main",
        resumeCommand: ["/bin/sh", "-c", `echo RESUMED_MAIN id=[$AC_RESUME_ID]; exec "${process.execPath}" "${roleScript}" ${marker}`],
      },
      { id: "e2e-bracketed", labelKey: "role.shell", command: [process.execPath, bracketedScript, marker], needsWorktree: false },
      { id: "e2e-size", labelKey: "role.shell", command: [process.execPath, sizeScript, marker], needsWorktree: false },
      { id: "e2e-punct", labelKey: "role.shell", command: [process.execPath, punctScript, marker], needsWorktree: false },
      { id: "e2e-short", labelKey: "role.shell", command: [process.execPath, "-e", "console.log('bye')", marker], needsWorktree: false },
    ],
  };
  const configFile = path.join(base, "config.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2));

  process.env.AC_E2E_DIR = base;
  process.env.AC_E2E_ROOT = root;
  process.env.AC_E2E_CONFIG = configFile;
  process.env.AC_E2E_STATUS_FILE = statusFile;
  process.env.AC_E2E_NAME_FILE = nameFile;
  process.env.AC_E2E_SLOW_FILE = slowFile;
  process.env.AC_E2E_OSASCRIPT_LOG = osascriptLog;
  process.env.AC_E2E_DATA_DIR = dataDir;
  process.env.AC_E2E_CLAUDE_SETTINGS = claudeSettingsPath;
  process.env.AC_E2E_UUID_FILE = uuidFile;
  process.env.AC_E2E_GH_DIR = ghDir;
  process.env.AC_E2E_GH_LOG = ghLog;
}
