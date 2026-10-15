# 実装カード: pc-meter（agent-console v0.38.0）
正: ~/CC報告ファイル-keep/pc-meter/design.md（§4・§8）。PO 実装承認 2026-10-15「y」。

## 作業場所
- ~/agent-console で git fetch → `git worktree add /Users/tanizawashingo/agent-console-wt/pc-meter -b release/pc-meter origin/main`。npm ci → npm run sa-sync。AGENT_CONSOLE_CONFIG は unset して試験。
- 段階A（今すぐ）: サーバー・hooks・試験のみ（§4.1・§4.2 のうちリポジトリ内）。src/pages/ConsolePage.tsx と footer の CSS には触らない。
- 段階B（Opus から「v0.37.0 マージ済み」の連絡後）: `git merge origin/main`（rebase・force push 禁止）→ §4.3 MacMeter と footer 配置、版 0.38.0（package.json・package-lock.json の version 2か所・extension/manifest.json）。
- 段階C（Opus の指示後）: リポジトリ外 ~/.claude/statusline.sh と ~/.claude/settings.json の変更（.bak を ~/CC報告ファイル-keep/pc-meter/ に保存してから）。導入後に行う。

## 実物点検（着手前に生出力保存）
1. `git grep -n readProcessTable\|PsRow\|descendantPids` の全呼び出し元。PsRow 追加で壊れる箇所の有無。
2. memory.ts・process-tree.ts・poll.ts・hub.ts の該当行、config の agentsPollMs 定義と既定値の場所。
3. ac-statusline.mjs の writeUsage と dataDir 解決方法（同じ方法で session-metrics.json を読む）。

## 想定分岐（該当したら止まって NEEDS_DECISION:）
- readProcessTable の呼び出し元が設計の想定（memory.ts・sessions.ts:525）以外にもあり、列追加で振る舞いが変わる。
- 定期計測をどこで起動するか（hub か index）で、セッション一覧の取得手段が無い。
- statfs が /System/Volumes/Data で失敗する、または値が r3/statfs_vs_df.txt と大きく（1pt超）違う。
- lint（check-design-governance）が設計に無い理由で落ちる。

## 規則
- 127.0.0.1:4319 と tmux ソケット agent-console に触らない。dataDir に触らない（試験は一時ディレクトリ）。秘密を書かない。zsh で echo ==== を使わない。df 空き 1GiB 未満で停止。
- px/rem/em 直値禁止。i18n ja/en 同一キー。既存 MemoryPanel 試験は変更しない（K10）。
- 生出力は /tmp/CC報告ファイル/pc-meter-impl/ と worktree の docs/handoff/pc-meter/evidence/。報告は事実のみ、DONE / BLOCKED: / NEEDS_DECISION: で開始。
- PR は段階B完了・K6〜K10 の証拠が揃ってから `gh pr create --base main`（shingo-cc 名義確認）。マージしない。
