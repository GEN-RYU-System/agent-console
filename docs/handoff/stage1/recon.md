# agent-console 調査記録（recon）

調査日: 2026-10-11。調査: Claude Sonnet（読み取り・検証）、確認: Claude Opus（主要箇所を再確認したものに【Opus確認】）。生出力の一時保存先: `/tmp/CC報告ファイル/orca-selfbuilt/`（端末再起動で消えるため、要点をここに転記）。

## §M Orca のメモリ要因（stablyai/orca HEAD eaf5dbed9e5f, v1.4.214）

| 要因 | 根拠 file:line | 確認 |
|---|---|---|
| 内蔵ブラウザは 1タブ=1 `<webview>`。公式 docs「browser tabs are the biggest RAM users」 | src/main/window/createMainWindow.ts:136（`webviewTag: true`）、docs/site/content/docs/troubleshooting.mdx:53 | 【Opus確認】 |
| renderer ヒープ上限を物理 7.5GiB 以上の機で 4096MB に引上げ | src/main/.../renderer-heap-headroom.ts:12-24 | 【Opus確認】 |
| 端末 scrollback 既定 5,000 行・上限 50,000 行 | terminal-scrollback-policy.ts:1-3 | 【Opus確認】 |
| 非表示ペイン 1 つ 約2.5MB（5k 行）/約19MB（50k 行）、非表示ワークツリー最大 4・15 分保持 | terminal-hidden-worktree-retention.ts:14-33 | 【Opus確認】 |
| 端末 daemon は fork・detached（Orca 終了後も残る） | daemon-launched-child-spawn.ts:67-81 | 【Opus確認】 |
| ファイル監視子プロセス最大 8 | parcel-watcher-child-registry.ts:3 | 【Opus確認】 |
| 起動直後に managed hooks を自動インストール（既定 `agentStatusHooksEnabled: true`）、`~/.claude.json` へワークスペース信頼を自動付与（既定 true） | managed-agent-hook-controls.ts:53-57、default-global-settings.ts:224-225 | 【Opus確認】 |
| 公開実測: 待機 1.07GB RSS（Discussion #16993）／daemon 3 本 private 計 1.08GB（#12728, Windows 14.8GB）／10 タブで GPU 約4GB→修正後約1.5GB（#19116）／main 17GB 膨張は不具合（#19768） | 各 issue 本文 | 担当報告 |

### §M-3 Orca 実機計測
- 隔離起動（偽 HOME＋`--user-data-dir`＋テレメトリ無効）は Claude Code の権限判定で拒否（`[Code from External]`）。迂回しない。
- 取得物の検証: v1.4.224 arm64 DMG、公式 digest sha256 7382f5e0…baae1 と一致。Orca.app は Developer ID（Lovecast LLC, 6CX3WHS9HZ）署名・公証済み。
- 起動前後の原状比較: 「~/.claude/settings.json」 ハッシュと hooks キー `["PostToolUse","PreToolUse","Stop","UserPromptSubmit"]` は不変。
- PO 自身が実行する計測スクリプトを用意（削除処理なし、30 秒後に実ホーム照合し変化で即中断）。

## §A Claude Code 2.1.296

- `claude agents --json`: TTY 不要。実測キー `cwd, kind, name, pid, sessionId, startedAt, status`（interactive）。`status` は busy / waiting / idle。bg セッションのみ `id, state, waitingFor`。（agent-view 文書・実測 9 件 exit 0）
- pty 経由で実行すると JSON に `\r\n` と末尾 `\e[?25h` が付く（実測）。→ サーバーでは pty を使わず子プロセス（パイプ）で実行する。
- `claude --bg`: 新規ディレクトリでは「Workspace not trusted. Run `claude` in … once and accept the trust prompt」で exit 1（実測）。
- ccopusgo: `~/.claude/shell/ccopusgo.zsh:63-76` で本店へ cd し `claude --model opus --effort … --permission-mode auto --append-system-prompt "<prompts 2 ファイル連結>"`。

## §B 端末

- tmux 未導入、brew あり。Xcode CLT あり、node v24.12.0 arm64。
- node-pty 1.1.0 は prebuilt（prebuilds/darwin-arm64）で install 成功。`spawn-helper` が `-rw-r--r--` で `posix_spawnp failed` → `chmod +x` 後に zsh 起動・入出力・終了まで成功。node プロセス RSS 46.5MB（実測）。
- @xterm/xterm 6.0.0、@xterm/addon-fit 0.11.0（npm view）。

## §C Sales Anchor（origin/main）

- トークン SSOT: `frontend/src/tokens.css`（色以外, 608 行）と `frontend/src/index.css`（色, `:root` ライト / `:root.force-dark` ダーク, 438 行, `./tokens.css` と `./components/field-size.css` を @import）。ADR-067:21,38-43。ダーク切替は `<html class="force-dark">`（ADR-033）。
- 金型ルール: ADR-144:31-48,59-64、docs/CC_UI_GOVERNANCE.md:9-15,26-27（金型が無ければ止めて報告、「Xxx.tsx」＋`Xxx.css`（var() のみ）＋stories）。
- 台帳: 「.claude-pipeline/active-work.d/<セーフ形>.md」（1 行目 `branch: …` ＋表、4 列目が状態）。窓口 `scripts/ledger-lookup.sh <branch>`（本店の active-work.d → active-work.md の順に検索、exit 0/1/2）。docs/specs/ledger-guard/design-phase2.md:12。
- `scripts/new-worktree.sh <branch>`（`--claude` なしで非対話）: reaper 実行→fetch→`git worktree add -b <branch> ~/worktrees/<repo>/<branch の / を ->` origin/main→台帳へ IN_PROGRESS 登録。push なし。exit 1=引数なし/上限超過。
- reaper（「scripts/reaper-worktree.sh:4-8」）: 使用中・未保存・IN_PROGRESS 未マージは消さない。

## §V-4 金型の外部利用（実験）

- origin/main の `frontend/src` を `git archive` でプロジェクト内 `.sa-cache/` に展開し、Button/Card/Tabs/Badge＋index.css を import → `vite build` 成功（追加依存なし）。プロジェクト外に置くと `react/jsx-runtime` を解決できず失敗。
- Modal/Drawer/Toast は react-i18next・i18next・@heroicons/react の追加で build 成功。実行時は i18n 初期化と `common.close` 等の翻訳キーが必要。
- Button は 「loading/index.ts」 経由で loading 配下を全て取り込む。
- 依存版（SA frontend/package.json）: react/react-dom ^18.3.1、vite ^8.0.14、@vitejs/plugin-react ^6.0.2、typescript ^5.7.3、i18next ^26.1.0、react-i18next ^17.0.7、@heroicons/react ^2.2.0、lucide-react ^1.14.0。

## §D GitHub

- 作業アカウント shingo-cc。shingo-ops は個人アカウント（type=User）。shingo-ops 配下へのリポジトリ作成（別アカウントのトークン使用）は権限判定で拒否 → `shingo-cc/agent-console`（private）を作成。
