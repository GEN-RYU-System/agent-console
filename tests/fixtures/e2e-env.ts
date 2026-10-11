import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const E2E_PORT = 4329;
export const E2E_TOKEN = "e2e-token-0123456789abcdef0123456789abcdef";

const here = path.dirname(new URL(import.meta.url).pathname);

const LEDGER_SEED: ReadonlyArray<{ branch: string; state: string | null }> = [
  { branch: "release/seed-a", state: "IN_PROGRESS" },
  { branch: "release/seed-b", state: "IN_PROGRESS" },
  { branch: "release/seed-c", state: "REVIEW" },
  { branch: "release/seed-d", state: "DONE" },
  { branch: "release/seed-e", state: "ABANDONED" },
  { branch: "release/seed-f", state: null }, // ブランチ行だけで表の行が無い → 未登録
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
  for (const { branch, state } of LEDGER_SEED) {
    const safe = branch.replace(/\//g, "-");
    const row = state ? `| ${branch} | e2e | 2026-10-11 | ${state} | | | seed |\n` : "";
    writeFileSync(
      path.join(root, ".claude-pipeline", "active-work.d", `${safe}.md`),
      `branch: ${branch}\n\n| ブランチ名 | 担当機能エリア | 開始日時 | 状態 | PR# | main | 備考 |\n|---|---|---|---|---|---|---|\n${row}`,
    );
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "add", "-A");
  git(root, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "seed");

  const statusFile = path.join(base, "agent-status");
  writeFileSync(statusFile, "busy");
  const claudeBin = path.join(base, "claude-stub.sh");
  copyFileSync(path.join(here, "claude-stub.sh"), claudeBin);
  chmodSync(claudeBin, 0o755);

  const roleCommand = "echo READY $(pwd); cat";
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
    roles: [
      { id: "e2e-plain", labelKey: "role.shell", command: ["/bin/sh", "-c", roleCommand, "agent-console-e2e-role"], needsWorktree: false },
      { id: "e2e-wt", labelKey: "role.sonnetImpl", command: ["/bin/sh", "-c", roleCommand, "agent-console-e2e-role"], needsWorktree: true },
    ],
  };
  const configFile = path.join(base, "config.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2));

  process.env.AC_E2E_DIR = base;
  process.env.AC_E2E_ROOT = root;
  process.env.AC_E2E_CONFIG = configFile;
  process.env.AC_E2E_STATUS_FILE = statusFile;
}
