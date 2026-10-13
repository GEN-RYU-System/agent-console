# 実装カード: keep-sessions（tmux control mode）

- 設計: docs/handoff/keep-sessions/design.md 第4版（Fable APPROVE・PO 承認 2026-10-14）。設計書が正。カードと設計書が食い違ったら止めて報告する。
- 担当: Sonnet（実装）。審査: Fable。マージ・タグ・本番反映: Opus。
- 版: 0.20.0（実装時点の origin/main が 0.19.0 のため。違っていたら次の minor にして報告）。

## 0. 始める前（必ずこの順）
1. すべての Bash は `cd /Users/tanizawashingo/agent-console-wt/keep-sessions && …` で始める（cwd は毎回 salesanchor に戻る）。gh は `-R GEN-RYU-System/agent-console` を付ける。
2. `git fetch origin`。ブランチ release/keep-sessions は古い土台（4b86c9b）で、未追跡の docs/handoff/keep-sessions/ と ops/tmux/ だけがある。`git checkout -B release/keep-sessions origin/main` で最新の main に載せ替える（未追跡ファイルは残る）。リモートに同名ブランチがあれば、載せ替える前に止めて報告。
3. 設計 §0 の前提は 8f45eb7。`git diff 8f45eb7 origin/main --stat` と、server/sessions.ts・server/hub.ts・server/restore.ts・server/routines.ts・server/ws.ts の差分を /tmp/CC報告ファイル/keep-sessions/impl/drift.txt に保存。端末の入出力・pid・停止・復元の流れが変わっていたら、実装せず NEEDS_DECISION で返す。行番号がずれただけなら続けてよい（報告に書く）。
4. 最初のコミットは docs だけ: docs/handoff/keep-sessions/ の recon.md・design.md・design-v2.md・step0*.md・card.md（と同フォルダの既存ファイル）。

## 1. 作る物（設計書の節に従う）
- §3-1 ops/tmux/agent-console.tmux.conf（未追跡の物を元に、smcup/rmcup の行と `@ac_conf_version` の行を除き、history-limit 2000、exit-empty on）。
- §3-2 server/terminal-host/（TerminalHandle 型、direct 実装、TmuxControlTerminal、名前・target・stderr 振り分け・先入れ組み立ての純関数）。
- §3-3 保存リストの id、起動時のつなぎ直し、件数ログ。
- §3-4・§11 scripts の切戻し（held への退避、順番、合わせ直し、注意文、判定の印）。
- §3-5 知らせ2つ（t()＋src/locales/ja.json、SA の金型とトークン。check-design-governance.mjs を通す）。
- §3-6 .github/workflows/ci.yml に tmux を入れる手順と `tmux -V`。
- 設定: `terminalHost`（既定 "tmux"）、`tmuxPath`。加えて試験用に `tmuxSocket`（既定 "agent-console"）を設定に持たせ、試験は必ず `ac-test-<pid>-<乱数>` のソケットを使う。本番の `-L agent-console` と既定ソケットには、試験でも手作業でも触らない。
- README（tmux の版が合わない時の直し方、切戻し中の見方）、docs/CHANGELOG.md、版の4か所（package.json、package-lock.json の2か所、extension/manifest.json）。

## 2. 進め方
- 試験を先に書く（設計 §9 工程1）。単体 → 統合（本物の tmux。命令は cat・sh・node の小さな受信器など。claude は使わない）。
- 統合試験で K1・K2・K4〜K13・K17・§7 の SIGKILL・spawnSync 12 件 1 秒以内 を確かめる。K1 は「サーバー役の node プロセスを kill して起こし直す」形で試験にしてよい（launchctl は使わない）。
- 試験の後片付け: 各試験で kill-server、ソケットファイルも消す。終わったら `ls /private/tmp/tmux-501/` を報告に貼る。
- 手元で全部: `npm run typecheck`、lint、`npx vitest run`、build、e2e（README の手順）。生出力は /tmp/CC報告ファイル/keep-sessions/impl/ に保存。

## 3. 止まる条件（迷ったら止める）
- 設計書に無い判断が要る、設計どおりだと試験が通らない、§7 のリスクが実際に起きた（境目の重なり・SIGKILL で本体が消える・12 件で 1 秒超など）→ NEEDS_DECISION。
- フックに止められた → 言い換えて再試行しない。BLOCKED で返す。
- 本番の agent-console（launchctl の local.agent-console.server、~/Library/Application Support/agent-console/）に触る必要が出た → 止める。

## 4. 終わり方
- コミットは意味の単位で分ける。push して PR を作る（`gh pr create -R GEN-RYU-System/agent-console --base main`、本文に設計書のパス・K の対応表・試験結果・触ったファイル一覧）。pr-body-guard のため、gh pr create は worktree の中で実行する。
- CI の完了は待たない。PR の URL を返す。
- マージ・タグ・更新ジョブは Opus がやるので触らない。
- 最終報告の1行目は DONE / BLOCKED: / NEEDS_DECISION: のどれか。結論ではなく、生出力のパスと観測値を返す。
