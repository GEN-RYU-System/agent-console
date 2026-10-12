# recon: セッション一覧の「CI 失敗」が出続ける件

基準: origin/main b15c1be（v0.7.0）。調査日 2026-10-13。製品コードは変更していない。

## A. server/pr-status.ts と hub.ts

【事実】ブランチの取り方（`server/pr-status.ts:182-196` resolveTarget）
- origin URL を `git remote get-url origin` で取り、GitHub でなければ `notGitHub` を即返す（183-185）。
- ブランチは `git -C <dir> rev-parse --abbrev-ref HEAD`（188）。失敗は `ghFailed`、`HEAD` は `detached`、安全でない名前は `noPr`（189-194）。
- 既定ブランチ（origin/HEAD）を見る処理は無い。どのブランチ名でも `{repo, branch}` を返す（195）。

【事実】PR の選び方
- `server/pr-status.ts:255-259`: `gh pr list -R <repo> --head <branch> --state all --limit 5 --json number,title,state,isDraft,url,updatedAt`。
- `server/pr-status.ts:229-232` choosePr: OPEN があればその中で updatedAt 最新、無ければ全体で updatedAt 最新（gh の並び順に依存しない）。
- 行が無ければ `noPr`（262）。OPEN のときだけ `pr view` で mergeStateStatus を取る（264）。checks は state に関係なく `pr checks <number>` を取る（265）。

【事実】ciOf（`server/pr-status.ts:154-158`）: fail>0 または cancel>0 なら "fail"、pending>0 なら "pending"、pass+skipping>0 なら "pass"、0 件なら null。PR の state は見ない。

【事実】isSettled（`server/pr-status.ts:161-163`）: status が ok で、pr.state が OPEN でなく、pending が 0 のとき true。pollPrs はこれが true の写しを取り直さない（`server/hub.ts:303-304`）。

【事実】hub.ts
- `server/hub.ts:241-251` locatePr: resolveTarget の結果から key=`repo#branch` を作り、`prKeyOfSession`（hub.ts:65）に入れる。immediate のときは null。
- `server/hub.ts:290-316` pollPrs: 生きているセッションごとに locatePr し、key ごとに 1 回だけ fetchPrOnce。写しの掃除は、どのセッションにも紐づかない key だけ（308-314）。
- `server/hub.ts:318-322` ciOfSession: key の写しが status=="ok" のときだけ `ciOf(counts)`。PR の state は見ない。
- `server/hub.ts:329,343` snapshot: ci が undefined でなければ SessionView に載せる。型は `server/hub.ts:30`。
- `server/hub.ts:254-258` getPr / `261-270` refreshPr も同じ locatePr を通る（PrPane の表示元）。

## B. 既定のブランチの実測（生出力）

```
== /Users/tanizawashingo/salesanchor
origin/main
exit=0
== /Users/tanizawashingo/agent-console
fatal: ref refs/remotes/origin/HEAD is not a symbolic ref
exit=128
== /Users/tanizawashingo/agent-console-wt/ci-badge
fatal: ref refs/remotes/origin/HEAD is not a symbolic ref
exit=128
== 一時ディレクトリ（git init + remote add origin のみ）
fatal: ref refs/remotes/origin/HEAD is not a symbolic ref
exit=128
```

【事実】
- salesanchor 本店は `origin/main`（exit 0）。agent-console 本店と、その worktree（`/Users/tanizawashingo/agent-console-wt/ci-badge`）は origin/HEAD が無く exit 128。つまり origin/HEAD 無しの clone は実在する。
- origin/HEAD 無しの終了コードは 128、stderr は `fatal: ref refs/remotes/origin/HEAD is not a symbolic ref`。
- worktree から実行しても結果は本店と同じ（refs/remotes は共有）。salesanchor の worktree からの実測はしていない。【未確認】
- 一時ディレクトリで `git init` 直後（コミット無し）に `rev-parse --abbrev-ref HEAD` は exit 128（`ambiguous argument 'HEAD'`）。
- テストの harness は `git init -q`（`tests/unit/helpers/harness.ts:114`）で remote は `git remote add origin`（`tests/unit/pr.integration.test.ts:94`）だけ。origin/HEAD は無い。e2e は `git init -q -b main`（`tests/fixtures/e2e-env.ts:56`）。

## C. 拾われている PR の再現（生出力）

```
$ gh pr list -R shingo-ops/salesanchor --head main --state all --limit 5 --json number,state,headRefName,baseRefName,updatedAt
[{"baseRefName":"develop","headRefName":"main","number":2649,"state":"CLOSED","updatedAt":"2026-10-02T17:13:21Z"},
 {"baseRefName":"develop","headRefName":"main","number":2463,"state":"CLOSED","updatedAt":"2026-06-27T21:25:10Z"},
 {"baseRefName":"develop","headRefName":"main","number":2394,"state":"CLOSED","updatedAt":"2026-06-20T13:56:05Z"},
 {"baseRefName":"develop","headRefName":"main","number":2385,"state":"CLOSED","updatedAt":"2026-06-20T13:54:01Z"},
 {"baseRefName":"develop","headRefName":"main","number":2370,"state":"MERGED","updatedAt":"2026-06-19T16:19:16Z"}]
exit=0

$ gh pr checks 2649 の bucket 集計（60 件）
{'pass': 49, 'skipping': 3, 'fail': 8}

$ gh pr view 2649 --json number,state,headRefName,baseRefName,title,closedAt,mergedAt
{"baseRefName":"develop","closedAt":"2026-10-02T17:13:20Z","headRefName":"main","mergedAt":null,"number":2649,"state":"CLOSED","title":"chore: back-merge main → develop"}
```

【事実】OPEN は 0 件なので choosePr は全体で updatedAt 最新の #2649（CLOSED）を選ぶ。fail=8 なので ciOf は "fail"。#2649 は閉じているので isSettled が true になり、以降は取り直されず、印は固定。
【事実】salesanchor 本店は現在ブランチ main、origin は `https://github.com/shingo-ops/salesanchor.git`。
【推測】`--head main` は head ブランチ名だけで絞るため、main を head にした過去の back-merge PR（base=develop）が全て該当する。

## D. 画面

【事実】
- `src/components/SessionList/SessionList.tsx:12-14` CI_BADGES（fail=danger / pending=info / pass=success）。`61-67`: `s.ci !== undefined` のときだけ `data-testid="ci-badge"` の Badge を出す。文言キー `ac.ci.fail|pending|pass`（定義は同ファイル内を含め、このファイル以外に出現しない）。画面側は PR の state を知らない（SessionView に載るのは ci だけ。`server/hub.ts:30`）。
- `src/components/PrPane/PrPane.tsx:131-135` prState: MERGED=success「merged」、CLOSED=neutral「closed」、OPEN=draft か info。`154-158`: マージ状態は OPEN のときだけ。`137-143`: status=="ok" なら閉じた PR でも見出し・state バッジ・検査集計を出す。つまり PR タブは閉じた PR を「closed」と明示して表示する（今のまま）。
- `noPr` / `detached` / `notGitHub` は EmptyState（`PrPane.tsx:116-121`）。

## E. 既存の試験

【事実】
- `tests/unit/pr-status.test.ts:51-80`: summarizeChecks と ciOf の表（fail/cancel→fail、pending、pass+skipping、0 件→null）。isSettled と resolveTarget を直接試す試験は無い（grep 0 件）。
- `tests/unit/pr.integration.test.ts`
  - 75-78 ヘルパー ciOf（snapshot の ci）。
  - 219-239 K3: OPEN の PR 4 種で fail/fail/pending/pass、PR 無しは undefined。ブランチ名は全て `release/*`。
  - 206-216: 検査 0 件の OPEN は ci 無し。
  - 301-314 K5: 同じ作業場所の 2 セッションで `pr list` 1 回。
  - 316-355 K5: MERGED/CLOSED で pending 無しは取り直さない。CLOSED は `setPr(..., 93, "CLOSED", [check("fail","a")])`（341）で、取り直し停止だけを見ており、ci の期待は無い。
  - 168-189: 複数 PR の選び方（OPEN 優先・updatedAt）。
  - 241-298 K4: noPr / notGitHub / detached / 409 / 404 / 401。
  - ブランチ `main` のセッションを使う試験は無い。harness の root は origin/HEAD 無し（B 参照）。
- `src/components/SessionList/SessionList.test.tsx:136-150` K3: ci="fail"/"pending"/"pass" の行に `ci-badge` が出てテキストが「CI 失敗」「CI 実行中」「CI 成功」。ci 無しの行の扱いは同ファイル内で未精査【未確認】。
- 全体の試験実行はしていない【未確認】。

## 未確認一覧
- salesanchor の worktree からの `symbolic-ref origin/HEAD`。
- SessionList.test.tsx の ci 無し行の期待。
- 試験の実行結果。
