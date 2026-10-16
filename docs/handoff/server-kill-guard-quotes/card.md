# 実装カード: server-kill-guard の誤拒否をなくす（v0.42.1）

設計: [design.md](design.md)（§2 Q-K1〜Q-K4・§3）。根拠: [recon.md](recon.md)。PO 承認: 2026-10-16 チャット「y」（誤拒否を直す）。
作業場所: `/Users/tanizawashingo/agent-console-wt/server-kill-guard-quotes`（ブランチ `release/server-kill-guard-quotes`、origin/main b60d678 起点）。

## 守ること
- 触ってよいのは §変更 のファイルだけ。`server/` 配下・ほかの hook・`scripts/` は触らない
- cd を使わない（`git -C`・`npm --prefix` 等で絶対パス指定）
- Bash の命令に `Application Support/agent-console` の文字列を書かない。`pkill` `killall` `kill` `launchctl` を実行しない。導入しない
- 試験の文字列（止める命令の例文）は Write/Edit でファイルに書く。Bash の heredoc で書かない（今の見張りに止められる。止められたら言い換えず BLOCKED:）
- 迷ったら全停止して `NEEDS_DECISION:`。報告は DONE / BLOCKED: / NEEDS_DECISION: で始め、生出力の保存パスを添える

## 変更
### 1. `hooks/server-kill-guard.mjs`
- 新しい関数 `stripQuotedHeredocs(command)`（export）: design §3-1 のとおり。引用符の外にある `<<-?\s*(['"])([A-Za-z0-9_]+)\1` を見つけ、その行の残りは残して、次の行から終端の行（`<<-` は行頭タブを外して比較）までを消す。終端が無ければ最後まで消す。繰り返す。引用符の外かどうかは 2 の走査と同じ規則で判定する
- 新しい関数 `splitParts(command)`（export）: design §3-2 の状態機械（外／単一引用符／二重引用符、`\` の次の 1 文字は区切らない）。戻り値は部分の文字列の配列（引用符は残す）
- `commandDenied` の先頭の `command.split(...)` を `splitParts(stripQuotedHeredocs(command))` に置き換える。それ以外（headOf・R1〜R4・保護語）は変えない
- 先頭コメントに「v0.42.1: 引用ヒアドキュメントの本文・単一引用符の中・二重引用符の中の ; | && 改行は区切りにしない（設計 docs/handoff/server-kill-guard-quotes/design.md）」を 1 行
- `hooks/server-kill-guard.d.mts` に 2 関数の型を足す

### 2. `tests/unit/server-kill-guard.test.ts`
- 既存の K1・K2 はそのまま（Q-K1・Q-K2）
- Q-K3 6 形を通過（`{ code: 0, stderr: "" }`）、Q-K4 5 形を拒否で `it.each` 追加。①の形は recon Q1 に合わせ、`cat > /tmp/x.md <<'EOF'` の本文に逆引用符で囲んだ `pkill -f "dist-server/server/index.js"` を含む行、`EOF`、`node b.mjs write <<'EOF'`、JSON 1 行、`EOF` を改行でつないだ文字列
- `splitParts`・`stripQuotedHeredocs` の単体を各 2〜3 本（終端なし・`<<-` のタブ・二重引用符の中の `$(`）

### 3. 版・文書
- `package.json`・`package-lock.json`（2 か所）・`extension/manifest.json` を 0.42.1
- `docs/CHANGELOG.md` 先頭に 0.42.1 の 1 行（誤拒否の修正・install 再実行は不要・戻し方 `bash scripts/ac-update.sh v0.42.0`・設計パス）
- `README.md` の「本番サーバーの停止の見張り」節の限界に 1 行: 引用ヒアドキュメントの本文と単一引用符の中は見ない（`bash <<'EOF'` で流す形は防げない）

## 完了の確認（生出力を /tmp/CC報告ファイル/server-kill-guard-quotes/ に保存）
1. `npm run typecheck`  2. `npm run lint`  3. `npx vitest run tests/unit/server-kill-guard.test.ts`  4. `npm test`  5. `git diff --stat origin/main...HEAD` が §変更 と docs/handoff/server-kill-guard-quotes/ だけ
6. コミット `fix: server-kill-guard が引用の中の例文で拒否しないように（v0.42.1）`（末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`）して push。PR は作らない

## 想定分岐
- 既存の K1/K2 のどれかが新しい分割で結果が変わったら、実装を直す（試験の期待値は変えない）。直せなければ NEEDS_DECISION:
- `npm test` で server-kill-guard 以外が落ちたら、その試験名と出力を添えて BLOCKED:（たまに落ちる auth.test.ts:328 の 1 件だけなら記して続行）
