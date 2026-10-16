# recon: server-kill-guard の誤拒否（文中の例文）

基準: origin/main b60d678（v0.42.0）。生出力は /tmp/CC報告ファイル/server-kill-guard/。

## 事実
- Q1 2026-10-16 14:3x、Opus 本体の Bash 1 回が server-kill-guard に拒否された。中身は「記憶ファイルを `cat > file <<'EOF' … EOF` で書く」命令で、本文に事故の命令を逆引用符で囲んだ例文（`` `pkill -f "dist-server/server/index.js"` ``）を含んでいた。プロセスを止める命令は含まない
- Q2 判定は命令全体を `;` `&&` `||` `|` 改行 `$(` `` ` `` `(` `)` で分ける（`hooks/server-kill-guard.mjs` の `commandDenied` 先頭行）。引用符もヒアドキュメントも見ないため、本文の逆引用符の中が「先頭語が pkill の部分」になり R1 に当たる
- Q3 シェルの決まり（bash 仕様）: 区切りの `'EOF'` / `"EOF"` のように引用したヒアドキュメントの本文では、`$(` と逆引用符は展開されない（＝実行されない）。単一引用符の中も同じ。二重引用符の中では `$(` と逆引用符は実行され、`;` `|` `&&` 改行は文字のまま
- Q4 v0.42.0 の試験 `tests/unit/server-kill-guard.test.ts` は K1 16 形・K2 9 形。引用符・ヒアドキュメントを含む形は無い

## 推測しないこと
- 他セッションで同じ誤拒否がどれだけ起きているかは数えていない（hook は拒否を記録しない）

## 既存設計
- docs/handoff/server-kill-guard/design.md §6 R2「誤拒否が出たら形を K2 に足して直す」。本件はその実施
