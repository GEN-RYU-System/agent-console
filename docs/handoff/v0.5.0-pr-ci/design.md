# 設計: v0.5.0 PR と自動検査（CI）の状態をアプリで見る

- 状態: 設計者（Opus）が作成。Fable の設計審査で APPROVE（条件つき）。条件（MEDIUM 3件）と LOW を反映済み（§9）。
- PO 承認（2026-10-12）:
  - 段階3の4機能を「1つずつ 設計→作る→確認→反映」で進めることに「y」。本書は2番目。
  - 同日、離席中に「このセッションだけで最後まで（PR マージ・デプロイまで）完結させる」と指示。
- 調査: docs/handoff/v0.5.0-pr-ci/recon.md（調査担当の Sonnet が作成）
- 対象ADR: ADR-067（デザイントークン）、ADR-144（UI ガバナンス・金型を優先する）
- 前提の設計: docs/handoff/v0.4.0-diff-comments/design.md（作業場所の照合、タブ構成）

## 0. 事実
- gh は /opt/homebrew/bin/gh、版は 2.85.0。shingo-cc の名義で認証済みで、scope に repo がある（recon B）。
- サーバーは launchd から起動し、PATH に /opt/homebrew/bin を含む（recon B）。
- launchd から起動した処理でも、gh は認証を読めた。
  - 2026-10-12 に設計者が実測した。`launchctl submit` で一回きりの処理を作り、`/usr/bin/env PATH=/opt/homebrew/bin:/usr/bin:/bin HOME=… gh -R shingo-cc/agent-console pr view 16 --json number,state` を実行した。
  - 標準出力は `{"number":16,"state":"MERGED"}`、標準エラーは空だった。
  - 記録は scratchpad/gh-probe/out.txt。scratchpad = /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad。
- PR の状態の取得（recon C）:
  - `gh pr view <branch>` は、PR が無いと exit 1 になる。リポジトリが無い場合も exit 1 なので、stderr の文言でしか区別できない。
  - `gh pr list --head <branch>` は、PR が無くても exit 0 で空の配列を返す。
- 検査の取得（recon C）:
  - `gh pr checks <n> --json` は使える。項目は name, state, bucket, link, workflow, startedAt, completedAt など。
  - bucket は pass, fail, pending, skipping, cancel のどれか。
  - --json を付ければ、失敗があっても exit 0。
  - CheckRun と StatusContext の2種類を、同じ形にそろえて返す。
- 実測の量（recon C）:
  - salesanchor の PR 1件には 43〜45件の検査がある。
  - pr checks は 1.27秒。open の PR 5件を list で取ると約 72KB、2.3秒。
  - PR 系のコマンドは graphql の使用量として数えられ、上限は 5000/時。
  - `pr list` の mergeStateStatus は UNKNOWN になることがある。`pr view` で個別に引くと値が出た。
- mergeStateStatus の値は8つ（GitHub GraphQL 公式 docs.github.com/en/graphql/reference/pulls、Context7 /websites/github_en_graphql、2026-10-12 取得）: BEHIND, BLOCKED, CLEAN, DIRTY, DRAFT, HAS_HOOKS, UNKNOWN, UNSTABLE。DRAFT は isDraft を使うよう案内がある。
- 作業場所から repo を決めるには `git -C <dir> remote get-url origin` を使う。値は https://github.com/<owner>/<name>.git の形（recon C）。
- 今のアプリには、PR と CI を出しているところが無い。台帳の見出しに PR# の列はあるが、読んでいない（recon D、server/ledger.ts:45）。
- 定期処理は、hub の agents（3000ms）と ledger（60000ms）。仕組みは server/poll.ts の startPolling（recon D）。
- 偽物への差し替えは、config の claudeBin（agent-console.config.json:7、server/config.ts:46,68）と同じ作法でできる（recon F）。
- SA の Badge の variant は neutral, info, success, warning, danger。DataTable も金型にある（recon E）。

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 端末の上のタブに「PR」が加わる（端末・変更・PR）。「PR」を押すと、選んでいるセッションの作業場所の今のブランチの PR が出る：番号・題名・状態（下書き／オープン／マージ済み／クローズ）・マージできるか・GitHub へのリンク|統合試験（偽 gh）＋e2e|
|K2 PR の下に、検査の集計（成功・失敗・実行中・スキップ・取り消しの件数）が出る。失敗・取り消し・実行中の検査は、名前とリンクを1件ずつ出す|統合試験＋単体試験＋e2e|
|K3 左のセッション一覧の各行に、PR があるときだけ小さな印を出す：失敗か取り消しが1件でもあれば「CI 失敗」（danger）、なければ実行中があれば「CI 実行中」（info）、すべて成功かスキップなら「CI 成功」（success）|単体試験＋e2e|
|K4 ブランチに PR が無いときは「このブランチの PR はありません」と出す。GitHub のリポジトリでない作業場所では「GitHub のリポジトリではありません」と出す。作業場所が本店でも worktree でもないときは、v0.4.0 と同じく git も gh も実行しない|統合試験|
|K5 状態は、サーバーが一定の間隔（`prPollMs`、既定 120000、config のみ）で取り直す。PR タブの「更新」ボタンで、すぐに取り直せる。マージ済みかクローズで、かつ実行中の検査が無い PR は、その後は自動では取り直さない|統合試験（偽 gh の呼び出し回数）|
|K6 gh が失敗したとき（見つからない、認証切れ、時間切れ、利用の上限）は、PR タブに「GitHub の状態を取得できませんでした」と理由を出す。認証切れのときは「GitHub の認証が切れています。ターミナルで gh auth login を実行してください」と出す。利用の上限に当たったら、その回の取り直しはやめて、次の間隔まで待つ。アプリは止まらない|統合試験（偽 gh で、見つからない・exit 4・時間切れ・上限・その他の5通り）|
|K7 アプリは読むだけで、GitHub に書き込まない。使う gh のコマンドは `pr list`、`pr view`、`pr checks` だけ|コードの確認（gh を呼ぶのは server/pr-status.ts の1か所だけで、引数の先頭が `pr` かつ2つ目が list・view・checks のどれか）＋単体試験|
|K8 リンクは https://github.com/ で始まるものだけを出す。それ以外は文字だけ出して、リンクにしない|単体試験|
|K9 文言は i18n。見た目は SA の金型（Tabs, Badge, Button, Callout, EmptyState）とトークンだけ。lint と既存の試験・CI（両 OS）が通る|CI|
|K10（導入後に実測）PO が、開いている PR があるセッションで「PR」タブを開くと、GitHub の画面と同じ番号・状態・検査の件数が出る|PO の目視|

## 2. 対象と対象外
- 対象:
  - 新設:
    - server/pr-status.ts（gh を呼んで形を整える）
    - server/pr-routes.ts（API）
    - src/components/PrPane/（PR タブ）
    - tests/fixtures/gh-stub.sh（偽 gh）
  - 変更:
    - server/workplace.ts を新設し、diff-routes.ts の resolveWorkplace をここへ移して export する。引数は `{sessions, config}` にして、hub からも呼べる形にする。diff-routes.ts と pr-status.ts（hub 経由）の両方がこれを使う。照合を2か所に書かない（SSOT）
    - server/diff-routes.ts（上の移動に合わせて import を変えるだけ。動作は変えない）
    - server/hub.ts（定期の取り直しと、snapshot に CI の要約を載せる）
    - server/http.ts（ルートの接続）
    - server/config.ts と agent-console.config.json（`ghBin` 既定 "gh"、`prPollMs` 既定 120000、`prRefreshMinMs` 既定 10000。3つとも省略できる。diffBaseRef などと同じ個別の parse の作法（server/config.ts:130-148）で検査する）
    - src/pages/ConsolePage.tsx（タブを3つにする）
    - src/components/SessionList（CI の印）
    - src/api.ts、src/types.ts、src/locales/ja.json
    - tests/fixtures/e2e-env.ts（偽 gh と、一時リポジトリの origin）
    - 試験、版 0.5.0、CHANGELOG、README
- 対象外:
  - PR の作成・マージ・承認・コメントなど、GitHub に書き込む操作（K7）
  - リポジトリ全体の PR 一覧（今回はセッションごと）
  - 失敗した検査のログの中身の表示（リンクで GitHub に飛ぶ）
  - 台帳の PR# 列の利用（台帳は台帳のまま。PR の正本は GitHub）

## 3. 仕組み
### 3-1 作業場所・ブランチ・repo の決め方（server/pr-status.ts）
- 作業場所は、diff-routes.ts の resolveWorkplace と同じ照合を使う。外れたら 409 で、git も gh も実行しない（K4）。
- ブランチは `git -C <dir> rev-parse --abbrev-ref HEAD` で、その時点の値を取る。SessionView.branch は使わない。再開したセッションでは null になるため（recon D）。正本は git。
  - 値が `HEAD`（どのブランチにもいない状態）なら `detached` とし、「ブランチにいないため PR を確認できません」と出す。
- repo は `git -C <dir> remote get-url origin` から取る。
  - 受け付ける形は2つだけ: `^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(\.git)?$` と、`^git@github\.com:([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(\.git)?$`。
  - 合わなければ `notGitHub` とする（K4）。
- ブランチ名は `^[A-Za-z0-9._/-]+$` で、`-` で始まらないものだけ gh に渡す。合わなければ「PR はありません」とする。

### 3-2 gh の呼び方
- execFile と引数配列を使い、シェルは通さない。timeout は 15000、maxBuffer は 4MiB。cwd は照合済みの作業場所。
- gh の子プロセスの環境には `GH_PROMPT_DISABLED=1` と `GH_NO_UPDATE_NOTIFIER=1` を足す（`gh help environment` に記載。問い合わせで止まらないように、更新の通知が stderr に混じらないように）。
- PR を探す: `gh pr list -R <owner>/<name> --head <branch> --state all --limit 5 --json number,title,state,isDraft,url,updatedAt`
  - 結果が空なら `noPr`。
  - open のものがあれば、その中で updatedAt が一番新しいものを選ぶ。無ければ、全体で updatedAt が一番新しいものを選ぶ。選び方はサーバーのコードで決め、gh の並び順には頼らない。
- 選んだ PR の詳細: state が OPEN のときだけ `gh pr view <number> -R <repo> --json number,title,state,isDraft,url,mergeStateStatus,headRefName` を呼ぶ。list では mergeStateStatus が UNKNOWN になるため（§0）。マージ済みとクローズの PR では呼ばない（意味のある値が無いため）。
- 本店のセッション（ブランチ main）でも、同じく `pr list --head main` を呼ぶ。普通は空になり「PR はありません」と出る。
- 検査: `gh pr checks <number> -R <repo> --json name,state,bucket,link,workflow,completedAt`
- gh を呼ぶ関数は1つだけにする。引数の先頭が `pr` で、2つ目が list・view・checks のどれかでなければ、例外にする（K7）。
- 失敗の扱い（K6）:
  - ENOENT は `ghMissing`。
  - 時間切れは `timeout`。判定は execFile の失敗の `killed === true`。
  - exit code が 4 なら `authRequired`。exit 4 でなくても、stderr に `gh auth login` を含めば `authRequired`（設計審査で実測: 認証の無い環境では exit 4、stderr に `gh auth login`）。
  - stderr に `rate limit` か `RATE_LIMITED` を含む（大文字小文字は区別しない）ものは `rateLimited`。gh の実際の文言は【未確認】。
  - それ以外は `ghFailed` で、stderr の先頭 300文字をサーバーの記録に残す。画面には理由の種類だけを出す。
- 検査が1件も無い PR: 設計審査で実測した。`gh pr checks 1 -R shingo-cc/agent-console --json name,bucket` は exit 1、標準出力は空、stderr は `no checks reported on the 'design/stage1' branch`。
  - stderr が `no checks reported` で始まるときは「検査0件」として扱う。ブランチ名が文に入るため、前方一致で判定する。
- 存在しないブランチの `pr list --head` は `[]`、exit 0（設計審査で実測）。
- 工程0（実装の最初）: 実行中の検査があるときの bucket（(b)）を、実リポジトリへの読み取りで実測し、上の2つの再確認とあわせて docs/handoff/v0.5.0-pr-ci/step0.md に記録する。実行中の PR がその時点で無ければ、その事実を記録し、試験は公式の bucket の値 pending を使う。
  - 想定と違う形が出たら、実装を止めて設計者に戻す。

### 3-3 取り直しと置き場所（server/hub.ts）
- 結果はメモリだけに置く。ファイルや DB には書かない。PR の正本は GitHub（§4）。
- 定期と「更新」が同時に走るときは、(repo, branch) ごとに実行中の取得を1本にまとめる（refreshLedger、server/hub.ts:198-205 と同じ作法）。
- hub に、取り直しの仕組みを1本足す（startPolling、間隔は `prPollMs`）。
  - 毎回、動いているセッションの作業場所を照合し、(repo, branch) ごとに1回だけ gh を呼ぶ。同じ作業場所のセッションが2つあっても、呼ぶのは1回。
  - 前回の結果が「マージ済みかクローズ」で、実行中の検査が無いものは、取り直さない（K5）。ブランチが変わったら取り直す。
  - `rateLimited` を受けたら、その回の残りをやめる（K6）。
- PR タブの「更新」は `POST /api/sessions/:id/pr/refresh`。そのセッションの分だけを、すぐに取り直す。連打を防ぐため、前回から 10秒以内なら取り直さず、今の結果を返す（10秒は config の `prRefreshMinMs`）。
- snapshot の SessionView に `ci?: "fail" | "pending" | "pass"` を足す（K3。PR が無いときは無し）。
  - 計算: fail と cancel のどちらかが1件でもあれば fail。そうでなく pending があれば pending。そうでなく、1件以上あって、すべて pass か skipping なら pass。検査が0件なら無し。

### 3-4 API
- `GET /api/sessions/:id/pr` は、メモリの写しを返すだけで gh は呼ばない。写しが無い（起動直後・新しいセッション）ときは `{status:"loading"}` を返し、画面は「確認中です」と出す。新しいセッションの分は、次の定期の回か「更新」で取る。
- 返す形: `{status:"ok", pr:{number,title,state,isDraft,url,mergeStateStatus}, checks:{counts:{pass,fail,pending,skipping,cancel}, items:[{name,bucket,link,workflow}]}, fetchedAt}`、または `{status:"loading"|"noPr"|"notGitHub"|"detached"|"ghMissing"|"authRequired"|"timeout"|"rateLimited"|"ghFailed", fetchedAt?}`。
  - items には fail・cancel・pending だけを入れる。pass と skipping は件数だけにする。
- `POST /api/sessions/:id/pr/refresh` → 同じ形
- どちらも既存の認証の内側に置く。作業場所の照合に外れたら 409。

### 3-5 画面
- タブ: 「端末」「変更（N）」「PR」。隠し方は v0.4.0 と同じ hidden 属性にする（端末の大きさを保つため）。
- PR タブ（src/components/PrPane/）:
  - 上の段: 「#番号 題名」をリンクにする（K8）。状態の Badge（下書き=neutral、オープン=info、マージ済み=success、クローズ=neutral）。マージできるかの短い文。「更新」の Button。取得した時刻。
  - mergeStateStatus の表示（ja.json）:
    - CLEAN「マージできます」
    - HAS_HOOKS「マージできます」
    - UNSTABLE「検査に失敗がありますがマージは可能です」
    - BLOCKED「条件を満たしていないためマージできません」
    - BEHIND「main より古いため更新が必要です」
    - DIRTY「競合があります」
    - DRAFT「下書きです」
    - UNKNOWN「確認中です」
    - これ以外の値は「確認中です」にする。
  - 検査の集計: 5つの Badge（成功 success、失敗 danger、実行中 info、スキップ neutral、取り消し warning）に件数を出す。
  - その下に、失敗・取り消し・実行中の検査を1行ずつ出す（名前と workflow。リンクがあれば「開く」）。
  - 状態ごとの文言は EmptyState か Callout（info）で出す（K4・K6）。
- セッション一覧: 各行の名前の横に、`ci` があるときだけ Badge（sm）を出す（K3）。
- リンクは `<a target="_blank" rel="noopener noreferrer">`。url が `https://github.com/` で始まらなければ、リンクにしない（K8。サーバー側でも同じ検査をして、合わない url は空にする）。
- 色・余白は SA の var(--…) と金型だけを使い、新しいトークンは足さない。

## 4. SSOT
- PR と検査の正本は GitHub。アプリは、メモリに一時の写しを持つだけで、保存しない。
- ブランチの正本は git（作業場所の HEAD）。repo の正本は git の origin。
- 間隔や gh の場所は config だけに置く。
- 台帳の PR# 列とは結び付けない（二重の正本を作らない）。

## 5. 安全
- 読み取りだけ（K7）。gh のコマンドを3種類に固定する。
- シェルを通さない。引数は配列で渡し、ブランチ名・repo 名は正規表現で検査してから渡す。
- 作業場所は毎回照合する（v0.4.0 と同じ）。
- リンクは github.com だけ（K8）。
- gh の認証はアプリが持たない。gh 自身の保存場所（キーチェーン）を、gh が読む。トークンをアプリの画面・記録・応答に出さない。

## 6. 代替案
- GitHub の API を、アプリがトークンで直接呼ぶ: トークンの置き場所が新たに増え、正本が分かれる。Orca と同じく gh に任せる（recon A）。
- 画面から直接 gh を呼ぶ: 画面はブラウザの中なので呼べない。サーバーで呼ぶ。
- `gh pr view <branch>` で探す: PR が無い場合とリポジトリが無い場合を stderr の文言でしか区別できない（§0）。`pr list --head` を使う。
- すべての PR の一覧を出す: 今回の目的は「今のセッションの作業がどうなっているか」なので、セッションごとにした。

## 7. リスクと対処
- 利用の上限: 120秒ごとに、セッション数×最大3回呼ぶ。上限 5000/時に対して、10セッションでも 900回/時。上限に当たったら止まる（K6）。
- 取り直しの遅れ: 最大 120秒遅れる。PR タブの「更新」ですぐに取り直せる。
- gh の版で出力の形が変わる: 工程0で実測して試験に固定する。gh の版を上げたら試験で確かめる。
- 1つのブランチに複数の PR がある: 選び方をサーバーで決める（§3-2）。
- クローズした PR を同じブランチで開き直した、または新しく作った場合は、自動では拾わない（K5 で止めているため）。PR タブの「更新」で取り直す。

## 外部・過去事例の参照と我々への応用
- Orca（recon-orca.md :127-145。recon A に引用、2026-10-12 調査）:
  - gh を子プロセスで呼び、独自の認証は持たない。
  - 選んでいるものは 60秒ごと、それ以外は 120秒ごとに取り直す。マージ済みで検査が終わったものは止める。
  - 呼ぶ前に、利用の上限を確かめる。
  - この形を使い回す。ただし間隔は、全セッションで 120秒の1本にして単純にする（更新ボタンで補う）。
- 適用限界: Orca の利用実績の数値は観察していない。成否は K10 で測る。

## 9. 設計審査（Fable、2026-10-12）
- 判定: APPROVE（条件つき。MEDIUM 3件の追記。構造の変更は不要で、追記後の再審査は不要）。
- §0 の事実は、実物と GitHub への読み取りで再現された。launchd からの gh の実測（out.txt）も照合された。
- 反映:
  - MEDIUM-1 認証切れ `authRequired`（exit 4 と `gh auth login`）を足した。
  - MEDIUM-2 GET は gh を呼ばない。`loading` を足した。同時に走る取得は1本にまとめる。
  - MEDIUM-3 照合を server/workplace.ts に移して共有する。
  - LOW-1 config の3キーと既定値、省略できること。
  - LOW-2 時間切れの判定、rate limit の文言、GH_PROMPT_DISABLED と GH_NO_UPDATE_NOTIFIER。
  - LOW-3 K2・K3 に取り消しを入れた。detached の文言。
  - LOW-4 OPEN のときだけ pr view を呼ぶ。本店の扱い。
  - LOW-5 開き直した PR は「更新」で拾う。
  - 審査で実測された値（検査0件の stderr、存在しないブランチは `[]`）を §3-2 に入れ、工程0は (b) だけにした。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K7（読み取りだけ）を単体試験で固定する（許されていない gh のコマンドは例外になる）。
- gh の版を上げたら、工程0と同じ3つの形を試験で確かめる。
