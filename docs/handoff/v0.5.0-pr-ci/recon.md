# v0.5.0 段階3 機能2「PR と自動検査（CI）の一覧」 recon

調査日 2026-10-12 / 基準 origin/main 838507f（v0.4.0）/ 製品コード変更なし / 設計提案なし
生出力の保存先（本リポジトリ外）: /tmp/CC報告ファイル/pr-ci-raw/ （c1.txt c1b.txt c2.txt s1.txt s2.txt ne.err nr.err）。salesanchor の PR タイトルを含むため、リポジトリには入れていない。

## A. 外部事例（Orca）

出典（本リポジトリ外）: /tmp/CC報告ファイル/orca-selfbuilt/stage3/recon-orca.md と recon-self.md。Orca のパスは同 recon の記述をそのまま引用（今回 Orca ソースは再確認していない）。

【事実】recon-orca.md の記述
- :14 PR/CI 一覧は gh CLI を子プロセス実行（gh pr view / gh api / gh api graphql）。保存はメモリ上キャッシュのみ。「Fix broken checks」で失敗チェック名とリンクをエージェントへ渡す。
- :20 gh の認証をそのまま使うだけで Orca 独自の認証は持たない。
- :121 サイドバーのワークツリーカードに PR 状態。更新 60 秒（HOSTED_REVIEW_CARD_REFRESH_INTERVAL_MS = 60_000、worktree-card-model.ts:92）。
- :123 公式: 「Linked reviews show up in the sidebar with status so you can tell whether the branch is still open, merged, or closed.」「Failed GitHub Actions checks show up as a red chip on the worktree.」
- :129 gh の実行は GH_PROMPT_DISABLED=1 を付けて子プロセス実行（gh-exec-file.ts:53-58）。
- :130 ブランチから PR を引く: gh pr view <branch> --json（pr-branch-lookup.ts:150）。
- :131 CI: gh api --cache 60s repos/<owner>/<repo>/commits/<sha>/check-runs?per_page=100（get-pr-checks.ts:48-53）、フォールバック gh pr checks <n> --json name,state,link（:149）。GraphQL 版は statusCheckRollup（pr-checks-graphql-query.ts:9）。
- :135 複数アカウント時のみ gh auth token で取ったトークンを子プロセスにだけ GH_TOKEN で渡す（gh-account-token.ts:1-8,20-23、TTL 正5分／負30秒）。
- :140-144 更新間隔: 選択中 60 秒／非選択 120 秒／closed 15 分／merged でチェック完了は停止／レビュー無し 選択中 60 秒・非選択 15 分（review-refresh-policy.ts:4-24）。冷却 10 秒。バックグラウンドは 5 分窓で最大 20 件・最小間隔 10 秒、アクティブは 30 秒窓で最大 3 件（pr-refresh-pacing.ts:3-7）。
- :145 レート制限: 呼ぶ前に残量確認（get-pr-checks.ts:38）、ブレーカー、一時エラー再試行。公式 github-errors.mdx:23「shared hourly budget. Every tool on that account shares it」、REST core 5,000/時（:29）。
- :148 永続化は確認範囲では無し【未確認】。
- 表示項目（Orca）: PR の open/merged/closed、チェックの成否（赤チップ）、失敗ジョブ詳細（名前・リンク）。recon-orca.md :122-124。

【事実】recon-self.md の記述（agent-console の v0.3 時点の現在地）
- :12 画面側の定期取得は ConsolePage の LEDGER_POLL_MS=60000（本 recon の D で現行値を再確認）。
- :24 hub は agents(3000ms) と ledger(60000ms) の 2 本の定期取得。
- :27 【推測：当時の設計案】新しい定期取得は hub.start() に足し、「取得→メモリ保持→GET API」の型に乗せられる。
- :40 【事実】LaunchAgent の環境は PATH と AGENT_CONSOLE_AUTH=keychain だけ。【未確認】とされていた2点（PATH に /opt/homebrew/bin が入るか／keyring の認証が LaunchAgent から使えるか）は B で確認した。

## B. gh CLI の実物

【事実】
- which gh → /opt/homebrew/bin/gh
- gh --version → gh version 2.85.0 (2026-01-14)
- gh auth status（トークン値は伏せ、名義と scope のみ）:
  - shingo-cc: Active account: true、keyring、scopes 'gist', 'read:org', 'repo', 'workflow'
  - highlifejpn-debug: Active false、keyring（scope 表示なし）
  - shingo-ops: Active false、keyring、scopes 'gist', 'read:org', 'repo', 'workflow'
- gh の設定ディレクトリ（HOME 配下の .config の gh）: config.yml と hosts.yml が存在（権限 -rw-------）。hosts.yml の中身は user: shingo-cc と users の 3 名義のみ。oauth_token 行なし（トークンは keyring）。
- LaunchAgent の plist（EnvironmentVariables）:
  - AGENT_CONSOLE_AUTH = keychain
  - PATH = /usr/local/bin:/Users/tanizawashingo/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
  - HOME は plist に無い。
  - 秘密値なし（伏せた行なし）。
- 稼働中サーバー（launchctl list で pid 43692、起動 月 10/12 12:42:10）の実環境を ps eww で確認: AGENT_CONSOLE_AUTH=keychain、PATH は plist と同一、HOME=/Users/tanizawashingo。つまり HOME は launchd が補っており、gh の設定ディレクトリには辿れる。
- plist と同じ PATH・HOME だけを渡した空環境（env -i）で実測: command -v gh → /opt/homebrew/bin/gh、gh auth status → shingo-cc Active、scopes 'gist','read:org','repo','workflow'（上と同じ 3 名義）。
- 対照: PATH を /usr/bin:/bin だけにすると「env: gh: No such file or directory」。
- サーバーが子プロセスに渡す環境の作り方:
  - pty（端末）用: `server/sessions.ts:74-86` buildChildEnv。process.env のうち CHILD_ENV_BLOCKLIST（`server/config.ts:154` = AGENT_CONSOLE_TOKEN / AGENT_CONSOLE_AUTH / AC_SECURITY / AC_STUB_LOG）を除き、terminalEnv を重ね、TERM を固定。pty の起動は `server/sessions.ts:251`。
  - その他の子プロセス（claude agents、git、ledger-lookup）は env を指定せず process.env を継承: `server/agents.ts:105`（execFile、timeout 15000）、`server/diff.ts:35`（git、timeout は GIT_TIMEOUT_MS = 15000、:6）、`server/ledger.ts:113`（bash でスクリプト、timeout 30000）。
  - 指示にあった child-env.ts は無い（実体は `tests/unit/child-env.test.ts:1` が sessions.ts の buildChildEnv を試験）。
- 注意: 本 recon を実行したシェルは Claude Code の Bash 経由であり、LaunchAgent 自身の子プロセスではない。

【未確認】
- LaunchAgent（launchd 子孫）から実際に gh を起動した場合に keyring の読み取りが許可されるか（macOS の keychain はプロセス単位の許可が絡む可能性）。上の実測は launchd 子孫ではなく、サーバーのプロセスから gh を実行して確かめてはいない。確かめるには製品コード側の変更（または launchd ジョブの新規作成）が要るため今回は行っていない。
- gh が keyring を読めなかった場合の stderr の形。

## C. gh の出力形（読み取りのみ・実リポジトリで実測）

repo の決め方【事実】
- git -C <worktree> remote get-url origin:
  - agent-console の worktree → https://github.com/shingo-cc/agent-console.git
  - salesanchor 本店 → https://github.com/shingo-ops/salesanchor.git
- 本店の remote 一覧: origin（上記 URL）に加え frontend-worktree（URL がローカルパス /Users/tanizawashingo/salesanchor/.claude/worktrees/agent-a91ac105）が存在。remote 名 origin だけを使えば GitHub URL になる。
- URL は https 形式。末尾の .git の有無・ssh 形式（git@github.com:）は今回の 2 リポジトリでは https のみ【未確認：ssh 形式の remote を持つ作業場所の有無】。

1) pr list（agent-console、--state open）— 生出力と所要
```
[]
gh -R $R pr list --state open --json  --limit 5  0.03s user 0.01s system 8% cpu 0.488 total
```
agent-console に open の PR は 0 件。

2) pr list（agent-console、--state all --limit 3 の先頭 1 件・同じ項目）— 生出力の一部
```
[{"headRefName":"release/diff-comments","isDraft":false,"mergeStateStatus":"UNKNOWN","number":16,"state":"MERGED","statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-10-12T09:23:42Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/shingo-cc/agent-console/actions/runs/38229087481/job/114743813571","name":"check (ubuntu-latest)","startedAt":"2026-10-12T09:18:58Z","status":"COMPLETED","workflowName":"ci"},{"__typename":"CheckRun", ...
```

3) pr view 16（agent-console）— 生出力（全文 941 バイト）と所要 0.597 秒
```
{"headRefName":"release/diff-comments","mergeStateStatus":"UNKNOWN","number":16,"state":"MERGED","statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-10-12T09:23:42Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/shingo-cc/agent-console/actions/runs/38229087481/job/114743813571","name":"check (ubuntu-latest)","startedAt":"2026-10-12T09:18:58Z","status":"COMPLETED","workflowName":"ci"},{"__typename":"CheckRun","completedAt":"2026-10-12T09:22:51Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/shingo-cc/agent-console/actions/runs/38229087481/job/114743813210","name":"check (macos-latest)","startedAt":"2026-10-12T09:19:00Z","status":"COMPLETED","workflowName":"ci"}],"title":"feat: v0.4.0 変更内容（diff）の表示と、行ごとのコメントを Claude に渡す","url":"https://github.com/shingo-cc/agent-console/pull/16"}
```
【事実】merged の PR でも mergeStateStatus は UNKNOWN。

4) pr list（salesanchor、--state open --limit 5、同じ項目）— exit=0、stderr 0 バイト、stdout 71,730 バイト、所要 2.285 秒（5 件で）。先頭 1 件の先頭部分（生）:
```
[{"headRefName":"release/v102-same-post-rows","isDraft":false,"mergeStateStatus":"UNKNOWN","number":4169,"statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-10-12T08:21:12Z","conclusion":"FAILURE","detailsUrl":"https://github.com/shingo-ops/salesanchor/actions/runs/38223020520/job/114723627917","name":"process-artifacts gate","startedAt":"2026-10-12T08:20:59Z","status":"COMPLETED","workflowName":"Process Artifacts Gate"},{"__typename":"CheckRun","completedAt":"2026-10-12T08:20:56Z","conclusion":"SKIPPED", ...
```
5 件の集計（python で数えた結果の生出力。番号・ブランチ・isDraft・mergeStateStatus・statusCheckRollup 件数・状態の組）:
```
4169 release/v102-same-post-rows False UNKNOWN 45 {('COMPLETED', 'FAILURE', None), ('COMPLETED', 'SKIPPED', None), (None, None, 'SUCCESS'), ('COMPLETED', 'SUCCESS', None)} {'StatusContext', 'CheckRun'}
4021 release/tenant-template-parity True UNKNOWN 44 {... 'FAILURE' ... 'SKIPPED' ... (None, None, 'SUCCESS') ...} {'StatusContext', 'CheckRun'}
4020 release/migration-ledger True UNKNOWN 45 {... 'FAILURE' ... 'SKIPPED' ... (None, None, 'ERROR') ...} {'StatusContext', 'CheckRun'}
4003 release/line-auto-export-notify False UNKNOWN 44 {... 'FAILURE' ... 'SKIPPED' ... (None, None, 'SUCCESS') ...} {'StatusContext', 'CheckRun'}
3976 release/product-code-pm5-adr False UNKNOWN 43 {('COMPLETED','SKIPPED',None), (None,None,'SUCCESS'), ('COMPLETED','SUCCESS',None)} {'StatusContext', 'CheckRun'}
```
【事実】
- statusCheckRollup には 2 種類の要素が混ざる。CheckRun（status / conclusion / name / detailsUrl / startedAt / completedAt / workflowName）と StatusContext（state / context / targetUrl / startedAt。status・conclusion は無い）。StatusContext の生出力: {"__typename": "StatusContext", "context": "guard-authoring/evaluation", "startedAt": "2026-10-12T08:21:11Z", "state": "SUCCESS", "targetUrl": "https://github.com/shingo-ops/salesanchor/actions/runs/38223018151"}
- StatusContext の state には ERROR が実在（4020）。CheckRun の conclusion には FAILURE / SKIPPED / SUCCESS が実在。
- salesanchor の 1 PR あたりのチェック数は 43〜45。statusCheckRollup を一覧に含めると 5 件で約 72KB。
- 一覧（list）の mergeStateStatus は 5 件すべて UNKNOWN。ところが pr view で個別に引いた release/migration-ledger（#4020）は DIRTY（下の 6）。list では値が計算されていない。

5) pr view（ブランチ名で引く）
- agent-console: gh pr view release/diff-comments -R shingo-cc/agent-console --json number,state,headRefName,mergeStateStatus,url →（exit=0）
```
{"headRefName":"release/diff-comments","mergeStateStatus":"UNKNOWN","number":16,"state":"MERGED","url":"https://github.com/shingo-cc/agent-console/pull/16"}
```
- salesanchor（open の draft）:（exit=0、所要 0.588 秒）
```
{"headRefName":"release/migration-ledger","isDraft":true,"mergeStateStatus":"DIRTY","number":4020,"state":"OPEN","url":"https://github.com/shingo-ops/salesanchor/pull/4020"}
```
- 実在しないブランチ（release/no-such-branch-xyz）: exit=1、stdout 空、stderr は
```
no pull requests found for branch "release/no-such-branch-xyz"
```
- 実在するが PR の無いブランチ main: exit=1、stderr は
```
no pull requests found for branch "main"
```
- 実在しないリポジトリ: exit=1、stderr は
```
GraphQL: Could not resolve to a Repository with the name 'shingo-cc/no-such-repo-xyz'. (repository)
```
- pr list の絞り込み: --head <branch> が使える（gh pr list --help の FLAGS で確認）。gh pr list -R shingo-cc/agent-console --head release/diff-comments --state all --json number,state,headRefName → exit=0、[{"headRefName":"release/diff-comments","number":16,"state":"MERGED"}]。
- 【事実】「PR 無し」と「その他の失敗」はどちらも exit=1。区別は stderr の文言（no pull requests found for branch）のみ。終了コードでは区別できない。
- 【未確認】同じブランチ名に複数の PR（過去に merged／closed と現在 open）があるとき、pr view <branch> がどれを返すか。

6) pr checks --json（agent-console #16）— exit=0、生出力:
```
[{"bucket":"pass","completedAt":"2026-10-12T09:22:51Z","link":"https://github.com/shingo-cc/agent-console/actions/runs/38229087481/job/114743813210","name":"check (macos-latest)","startedAt":"2026-10-12T09:19:00Z","state":"SUCCESS"},{"bucket":"pass","completedAt":"2026-10-12T09:23:42Z","link":"https://github.com/shingo-cc/agent-console/actions/runs/38229087481/job/114743813571","name":"check (ubuntu-latest)","startedAt":"2026-10-12T09:18:58Z","state":"SUCCESS"}]
```
- --json は使える。指定できる項目（gh pr checks --json を項目なしで実行した出力）: bucket, completedAt, description, event, link, name, startedAt, state, workflow。
- gh pr checks --help の記述: 「--json を使うと state を pass / fail / pending / skipping / cancel に分類した bucket が付く」「Additional exit codes: 8: Checks pending」。
- salesanchor #4169（失敗あり）: exit=0（--json 指定時）、44 件、bucket と state の集計の生出力:
```
44 Counter({('pass', 'SUCCESS'): 34, ('skipping', 'SKIPPED'): 8, ('fail', 'FAILURE'): 2})
{"bucket": "fail", "completedAt": "2026-10-12T08:28:22Z", "link": "https://github.com/shingo-ops/salesanchor/actions/runs/38223020618/job/114726090417", "name": "pytest (SQLite + PostgreSQL RLS)", "startedAt": "2026-10-12T08:28:20Z", "state": "FAILURE"}
```
- 同じ #4169 を --json なしで実行 → exit=1（失敗があるため）。--json 付きは失敗があっても exit=0。したがって JSON 取得時は終了コードを成否に使えない（bucket を見る）。
- pr checks の bucket pending 時の実出力は今回【未確認】（pending の PR が無かった）。exit 8 は gh のヘルプ記述に依る。
- pr checks は pr view の statusCheckRollup と違い、CheckRun と StatusContext を同じ形（name / state / bucket / link）にそろえて返す。

7) 所要時間（time の生出力）
```
gh -R shingo-cc/agent-console pr list ... --limit 5   0.488 total
gh -R shingo-cc/agent-console pr view 16 ...           0.597 total
gh -R shingo-ops/salesanchor pr list ... --limit 5    2.285 total
gh pr checks 4169 -R shingo-ops/salesanchor --json     1.273 total
gh pr view release/migration-ledger -R shingo-ops/salesanchor ... 0.588 total
```

8) レート制限（gh api rate_limit --jq の生出力。実行は上のコマンドの後）
```
{"limit":5000,"remaining":5000,"reset":1791801621,"used":0}      ← core
{"limit":5000,"remaining":4998,"reset":1791801611,"used":2}      ← graphql
```
【事実】gh pr list / pr view / pr checks が数えられるのは graphql 側（上の実行後、graphql の used=2、core の used=0）。ただし graphql の「used」は 1 呼び出し=1 点ではなく、gh が発行したクエリのコスト換算【未確認：どの呼び出しが何点か。上の used=2 は rate_limit 取得の前に走らせた PR 系 gh 約 10 回の結果】。上限は 5000/時（core・graphql とも）。
【事実】Orca の公式記述（A :145）どおり、同一アカウントの利用は他のツールと共有される。

## D. agent-console の現在（v0.4.0）

タブ構成
- `src/pages/ConsolePage.tsx:45` type CenterTab = "terminal" | "changes"。:100 centerTab の状態、:101 diffCount の状態。
- `src/pages/ConsolePage.tsx:326-334` Tabs（variant underline、size sm）。items は terminal と changes（changes のみ count を付ける: :333）。
- 中央列の構成: :336 QuickPromptBar（terminal のみ）、:350 端末は hidden 属性で隠すだけ（xterm の接続を保つ）、:354-362 DiffPane は activeId があれば常に mount し active={centerTab === "changes"} を渡す。選択なしは EmptyState。
- 右列: :367 LedgerBoard（aside.ac-page__right）。左列は SessionList。
- DiffPane の props: `src/components/DiffPane/DiffPane.tsx:26,58`（sessionId / active / state / canInput / paste / onCountChange）。
- 文言は i18n（`src/locales/ja.json` と en.json。ac.tabs.terminal / ac.tabs.changes）。

サーバーのルート
- `server/diff-routes.ts:10` SESSION_PREFIX = /api/sessions/:id/(diff | diff/file | diff-comments...)。:45 handleDiff。
- `server/diff-routes.ts:20-33` resolveWorkplace: セッションを取得 → :24 listWorktreeEntries(salesanchorRoot) → :25 classifyCwd(session.cwd, root, worktree パス一覧) → 本店でも worktree でもなければ SessionConflictError（409）→ :28-31 各 worktree の realpath と branch（branchName(e.branch)）を known に詰める → { sessionId, dir: verdict.real, known } を返す。
- `server/resume-targets.ts:25` listWorktreeEntries（git worktree list の正本）、:43 classifyCwd、:58 branchName（refs/heads/ を外す）。
- 作業場所の branch の取り方は 2 通り: (a) セッション作成時の入力（`server/sessions.ts:163-170` の create。needsWorktree の役だけ branch を持ち、他は null）、(b) git worktree list（resolveWorkplace が known に持つ）。本店セッション（opus-designer など）は session.branch が null。
- hub の snapshot に branch: `server/hub.ts:15`（SessionView.branch: string | null）、:221（branch: s.branch、(a) の値）。

定期処理
- `server/hub.ts:70-79` start(): startPolling で agents（config.agentsPollMs = 3000）と ledger（config.ledgerPollMs = 60000）の 2 本。
- `server/poll.ts:2-20` startPolling: 前回完了後に次を予約。多重起動なし、例外は onError に渡して継続。
- `server/hub.ts:198-206` refreshLedger: 同時呼び出しは 1 本に束ねる。結果はメモリ保持し getLedger()（:207）で返す。
- 画面側: `src/pages/ConsolePage.tsx:41` LEDGER_POLL_MS = 60000、:134 setInterval で GET /api/ledger。
- `agent-console.config.json:8-9` agentsPollMs 3000 / ledgerPollMs 60000。config の数値キーの検査は `server/config.ts:69` NUMBER_KEYS（port / agentsPollMs / ledgerPollMs / ringBufferBytes）。新しいキーは parse 側への追加が必要（diffBaseRef 等は個別の parse 関数: :133、:210-212）。

台帳との重複（SSOT）確認【事実】
- `server/ledger.ts:45-51` parseLedgerRow（定義 :45、呼び出し :114） は列 0（ブランチ名）・2（開始日時）・3（状態）だけを読む。PR# 列（5 列目）は読み捨て。同ファイルの外部呼び出しは bash でのスクリプト実行（:113）だけで、PR 取得処理（gh 呼び出し）は無い（grep -n -E "gh " の該当行なし。"pr" を含む行は IN_PROGRESS 等の状態名のみ）。
- 台帳ファイルの実物（本リポジトリ外）の見出しは「ブランチ名 | 担当機能エリア | 開始日時 | 状態 | PR# | main | 備考」。PR# 欄の値は実例（release-dashboard-tab-separation）で空。状態は pr-open などの文字列。
- `src/components/LedgerBoard/LedgerBoard.tsx` に PR・CI の表示は無い（grep -i の結果なし）。表示は状態 5 列（IN_PROGRESS / REVIEW / DONE / OTHER / UNREGISTERED）、Badge は件数表示のみ（:92）。
- 結論【事実】: 現状、PR 番号・PR 状態・CI 結果を出している箇所は agent-console 内にない。台帳の「状態」は人（実行役）が書く文字列で、GitHub の実状態とは別物。

## E. SA 金型（本店 .sa-cache、SOURCE=6c1c5e82418e3ba38c10702f2a74161fd24a7e80）

本リポジトリの worktree には .sa-cache が無い（gitignore。`scripts/sa-sync.mjs` で取得）。参照は本店 /Users/tanizawashingo/agent-console の .sa-cache（本リポジトリ外）。import は vite の alias で @sa（`vite.config.ts:5,9`）。

- Badge（frontend/src/components/Badge.tsx 内。本リポジトリ外）: variant = neutral / info / success / warning / danger（:19）、appearance = soft（既定）/ solid、size = sm / md、dot（先頭ドット）、icon、children（ラベル。業務ステータス→variant の対応は呼び出し側で定義と明記）、className。agent-console での使用: `src/components/LedgerBoard/LedgerBoard.tsx:3,92`。
- Callout（同 Callout.tsx）: variant = warning（role=alert）/ info（role=status）、title（必須）、children、className（:13-22）。agent-console での使用: `src/pages/ConsolePage.tsx:345`、`src/components/LedgerBoard/LedgerBoard.tsx:80`。
- DataTable（同 DataTable.tsx）: columns（key / header / width / sortable / renderCell）、data、rowKey、sortKey / sortDir / onSort、selectable、density（compact / default / relaxed）、emptyState、onRowClick（セル内ボタンでは発火しない）、page / hasNextPage / onPageChange（制御型ページ送り）、rowClassName、className（:29-86）。agent-console 内での使用実績は無し（src 配下の DataTable 検索結果なし）。
- StatusDot 相当: SA 金型には無い。agent-console 独自の `src/components/StatusDot/StatusDot.tsx`（セッション状態用。SessionState 6 種に固定、色は `src/components/StatusDot/StatusDot.css:16` の var(--color-success) など）。PR/CI の状態を出すなら Badge（dot 付き）が金型側の候補、という事実の列挙にとどめる。
- 状態色トークン:
  - tokens.css（frontend/src/tokens.css。本リポジトリ外）: --color-error :555（ダーク :600）、--color-success :558（ダーク :603）、--color-warning-bg :561、--color-warning-border :562。--color-warning（文字色）と --color-info 系は tokens.css に無い（grep 結果なし）。
  - Badge が使うのは tokens.css ではなく index.css（frontend/src/index.css）: --danger / --danger-bg / --danger-text :51-53、--warning-bg / --warning-text :54-55、--success-bg / --success-text :56-57、--info-bg / --info-text :109-110、--neutral-bg / --neutral-text / --neutral :113-115、--info :116、--warning :117、--success :143。ダークは :248 以降に再定義。Badge.css:58-62 で variant→これらのトークンに対応。
- 規約: `tests/unit/design-governance.test.ts:23-` と `scripts/check-design-governance.mjs` が、色の直値・生の form 要素（pages 配下）・TSX 内の日本語直書き・.sa-cache のコミットを検査（npm run lint）。

## F. 試験（偽物への差し替え）

【事実】
- config に bin 指定が既にある: claudeBin（`server/config.ts:46,68,201`、使用は `server/agents.ts:102,112`、`server/hub.ts:98,188`、`server/index.ts:62`）、notify.osascriptBin（`server/config.ts:27,30,108-115`、使用は `server/hub.ts:61`、`server/notify.ts:33-35`）。gh 用の bin 指定は無い（grep "ghBin" 等の該当なし）。
- 差し替えの作法: e2e では一時ディレクトリにスタブスクリプトを複製して chmod 755 し、config JSON に絶対パスを書く（`tests/fixtures/e2e-env.ts:62-65` claude-stub.sh、:73-76 osascript-stub.sh、:88-98 config に claudeBin / notify.osascriptBin）。
- スタブの挙動は環境変数のファイルで切り替え: `tests/fixtures/claude-stub.sh:5-26`（STUB_STATUS_FILE、STUB_SLOW_FILE、STUB_NAME_FILE を読む。--version と agents だけ処理、他は exit 1）。osascript-stub.sh は引数を STUB_OSASCRIPT_LOG へ追記（`tests/fixtures/osascript-stub.sh:3`）。
- 台帳側も同様に、ledgerLookupScript をスクリプト差し替え（`tests/fixtures/ledger-lookup.sh`、`tests/fixtures/e2e-env.ts:42-45`）。
- e2e が使う一時 git リポジトリ（salesanchorRoot 役）には remote が無い。origin/main は update-ref で作った参照だけ（`tests/fixtures/e2e-env.ts:59-60`）。つまり e2e の作業場所に対して git remote get-url origin は失敗する【事実：git init のみで remote add をしていない。実コマンドでの失敗は今回未実行＝【未確認】】。
- 単体側の差し替え: ListWorktrees 型を引数で受ける形（`server/resume-targets.ts:22,61`）。
- gh の出力の偽物（pass / fail / pending / ERROR など）を作るには、上記の作法に倣った bin 指定かスタブが必要という点までが事実。具体案は本 recon の範囲外。

## 推測・未確認の一覧

【推測】
- なし（設計提案はしていない。A の recon-self.md :27 の「設計案」は当時の推測として引用）。

【未確認】
1. launchd 子孫のプロセスから gh を実行したとき keyring が読めるか（B）。
2. 同じブランチ名に複数 PR があるとき pr view <branch> が返す PR（C-5）。
3. pending のチェックがあるときの pr checks の実出力と終了コード 8（C-6）。
4. graphql の rate limit が各 gh 呼び出しで何点減るか（C-8）。
5. ssh 形式の remote を持つ作業場所の有無（C 冒頭）。
6. e2e の一時リポジトリで git remote get-url origin が実際に失敗する形（F）。
7. Orca 側の記述は recon-orca.md の引用であり、今回 Orca ソースは再確認していない（A）。
