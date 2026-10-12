# 工程0 の記録（v0.5.0 PR と CI）

実測日 2026-10-12。読み取りだけ（gh pr list / pr view / pr checks）。GitHub への書き込みなし。業務の中身（題名など）は書かない。

## (b) 実行中の検査があるときの bucket
- 対象: shingo-ops/salesanchor の open の PR 30 件（`gh pr list --state open --limit 30`）と shingo-cc/agent-console の open の PR 0 件。
- 30 件すべてに `gh pr checks <n> --json bucket,state` を実行した。
- 観測した (bucket, state) の組は次の5つだけ: (pass, SUCCESS) / (skipping, SKIPPED) / (fail, FAILURE) / (fail, ERROR)。実行中 (pending) は 0 件。cancel も 0 件。
- 結果: 実行中の検査を持つ PR がその時点で無かった。bucket の pending と cancel の実値は【未確認】。
- 対応（設計 §3-2 のとおり）: 試験は公式の bucket の値 `pending` と `cancel` を使う（`gh pr checks --help` の記述: pass / fail / pending / skipping / cancel）。想定と違う形は観測されていない。
- 追加で観測: StatusContext 由来の ERROR は bucket が fail になる（#4020, #3893）。

## 再確認 1: 検査 0 件
`gh pr checks 1 -R shingo-cc/agent-console --json name,bucket`
- exit=1
- stdout 0 バイト
- stderr: `no checks reported on the 'design/stage1' branch`

## 再確認 2: 存在しないブランチ
`gh pr list -R shingo-cc/agent-console --head release/no-such-branch-xyz --state all --limit 5 --json number,title,state,isDraft,url,updatedAt`
- stdout: `[]`
- exit=0

## 再確認 3: 項目名（試験の偽物の形に固定）
- pr list の項目: isDraft, number, state, title, updatedAt, url
- pr view の項目: headRefName, isDraft, mergeStateStatus, number, state, title, url（マージ済み #16 は state=MERGED、mergeStateStatus=UNKNOWN）
