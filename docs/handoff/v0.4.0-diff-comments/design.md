# 設計: v0.4.0 変更内容（diff）の表示と、行ごとのコメントを Claude に渡す

- 状態: 設計者（Opus）が作成。Fable の審査で APPROVE（条件つき）を受け、条件を反映済み（§9）。PO の実装承認を待っている。
- PO 承認（2026-10-12）:
  - 段階3の4機能を「1つずつ 設計→作る→確認→反映」で進めることに「y」。
  - 本書はその1番目。
- 調査: docs/handoff/v0.4.0-diff-comments/recon.md（実装担当の Sonnet が作成）
- 対象ADR: ADR-067（デザイントークン）、ADR-144（UI ガバナンス・金型を優先する）
- 前提の設計:
  - docs/handoff/v0.3.8-session-restore/design.md（保存の作法と作業場所の照合）
  - docs/handoff/v0.3.7-rename-queue/design.md（入力できる時だけ端末に入れる判定）

## 0. 事実（recon と設計者の実測より）
- セッションの cwd は snapshot に入っている（recon A-3、server/hub.ts:222）。cwd が本店か worktree かは classifyCwd で照合できる（recon A-5、server/resume-targets.ts:43-51）。
- サーバーが git diff を呼ぶ箇所は無い。git の呼び方はすべて execFile＋引数配列で、シェルを通さない（recon C）。
- 端末に文章を入れる既存の型は「サーバーは本文を返すだけ、画面が xterm の paste() で入れて Enter」（recon A-6、server/http.ts:226、src/components/TerminalPane/TerminalPane.tsx:35-41）。
- 入力してよい判定は inputVerdict（idle かつ waitingFor なし。recon A-6、server/agents.ts:80-88）。
- 複数行の文章をブラケットペースト（括弧付き貼り付け）で本物の claude に貼り、**2秒待ってから** Enter を送ると、1つの貼り付け（`[Pasted text #N]`）として扱われ、1回の応答が返った（2026-10-12、PO が実行した拡張機能の試験。手順は scratchpad/ext-probe/claude-paste.exp:27-29、判定は scratchpad/ext-probe/out/claude-verdict.json の `pasteCollapsedTag:true`・`ready7:true`・`paste:"PASS"`。scratchpad = /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad）。
  - 先に書いた probe-extension.md はこの試験より前の文書で、そこでは未実施と書かれている。根拠は上の判定ファイルの方。
  - 【未確認】待たずに Enter を送る今の pasteAndEnter（TerminalPane.tsx:39-40）で同じ結果になるか。Orca は貼り付けの後に待ち時間を置いてから Enter を送る（recon-orca.md:60）。
- 本店のリポジトリで、名前を変えたファイルがあると、`git diff --numstat -z` は別の形で出力する（追加・削除の数の後ろに空のパス、続いて旧名と新名）。`--no-renames` を付けると、どのファイルも同じ3つ組で出る（2026-10-12、Fable の審査で git 2.39.3 を使って実測）。
- 端末の大きさ合わせ（fit）は、親の要素の幅と高さから列数と行数を計算する。幅と高さが数値として取れない（display:none）ときは何もしない。0 に近いときは 2列×1行 として pty に送る（TerminalPane.tsx:62-72、@xterm/addon-fit、server/sessions.ts:65-67,296-298。Fable の審査で確認）。
- diff の大きさは、agent-console の1リリース分で 2,086行・約127KB。salesanchor の worktree では中央値 158行、p90 2,150行、最大 446,699行（19.5MB）（recon G）。
- この Mac の git は 2.39.3。`git diff --merge-base origin/main` が使える（2026-10-12 設計者が実行して確認）。この形では、まだ追加されていないファイル（untracked）は出ず、別に `git ls-files --others --exclude-standard` で取る必要がある（同日に実測）。
- diff 専用の金型は SA に無い（recon B-3）。追加行と削除行に使える色のトークンは SA にある：`--color-success-bg`・`--color-error-bg`（明るい画面は .sa-cache/frontend/src/tokens.css:556,559、暗い画面は :601,604）。
- Orca の方式：行ごとにコメントを書き、まとめて「File／Line／コメント」の形で端末に貼る（recon D、recon-orca.md:48-62）。

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 端末の上に「端末」と「変更」の2つのタブがある。「変更」を押すと、選んでいるセッションの作業場所で、基準（origin/main）から変わったファイルの一覧が出る（ファイル名・追加行数・削除行数）。まだ追加されていないファイルは「新しいファイル（未追加）」として出る|統合試験（一時の git リポジトリで、コミット済み・未コミット・未追加の3種類が一覧に出る）＋e2e|
|K2 一覧でファイルを押すと、そのファイルの変更が行番号つきで出る。追加行は緑、削除行は赤の背景（SA のトークン）|e2e＋目視（PO）|
|K3 変更の行を押すとコメント欄が開き、書いて「保存」を押すと、その行にコメントの印がつく。コメントは編集と削除ができる|e2e|
|K4 コメントはサーバーを再起動しても残る。worktree が消えたら、その作業場所のコメントは消える|統合試験|
|K5 「Claude に送る（N件）」を押すと、未送信のコメントがまとめて1つの文章になって端末に入り、Enter が送られる。送ったコメントには「送信済み」の印がつく|e2e（偽の claude で、受け取った文章の形を確かめる）|
|K6 Claude が作業中か、許可の確認を待っている間は、「Claude に送る」を押せない。押せない理由は、ボタンの横に文章で常に表示する（マウスを乗せなくても見える）|単体試験＋e2e|
|K7 作業場所が本店でも worktree でもないセッションでは、変更タブに「この作業場所の変更は表示できません」と出て、git を実行しない|統合試験|
|K8 1つのファイルの変更が上限（既定 1MiB、config のみ）を超えるときは、本文を出さず「大きすぎるため表示しません」と出す。バイナリのファイルは「バイナリのため表示しません」と出す|統合試験|
|K9 画面から渡すファイル名は、サーバーがその時点で作った一覧に含まれるものだけを受け付ける。1ファイルの diff の取得と、コメントの追加・編集の両方で照合する。それ以外は 400 になる|統合試験（`../` を含む名前、一覧に無い名前。diff の取得とコメントの追加の両方）|
|K10 文言は i18n。見た目は SA の金型とトークンだけ。lint と既存の試験・CI（両 OS）が通る|CI|
|K11（導入後に実測）(a) PO が本物のセッションで1行にコメントを書いて送ると、Claude がそのファイルの、その行についての依頼として受け取る。(b)「変更」タブを開いたまま別のセッションを選び、「端末」タブに戻ったとき、端末の文字が崩れずに表示される|PO の目視|
|K12 「変更」タブを開いてから「端末」タブに戻っても、端末の列数と行数は変わらない|e2e。tests/fixtures に、SIGWINCH を受けるたびに `SIZE <cols>x<rows>` を出す役割を1つ足す。タブの往復の前後で、画面に出た最後の SIZE の文字列を比べる（今の e2e 部品には大きさを観測する経路が無い：tests/fixtures/role.mjs:2-3）|
|K13 名前を変えたファイルがあっても、一覧の数とファイル名はずれない|統合試験（git mv したファイルを含む一時リポジトリ）|
|K14 2秒待っている間に別のセッションへ切り替えたら、Enter は送らず、送信済みにもしない。「貼り付けましたが送っていません。そのセッションの端末で Enter を押してください」と出す。送っている間は「Claude に送る」を押せない|単体試験（待ちの間に sessionId を変える）|

## 2. 対象と対象外
- 対象:
  - server/diff.ts を新設する（一覧と1ファイルの diff を取る。行の解析もここ）
  - server/diff-comments.ts を新設する（コメントの保存。session-store.ts と同じ作法）
  - server/diff-comments-format.ts を新設する（送る文章を作る）
  - server/http.ts（§3-4 の API）
  - server/config.ts と agent-console.config.json（`diffBaseRef`、`diffMaxFileBytes`、`diffSendMaxBytes`、`pasteSubmitDelayMs`）
  - src/components/TerminalPane/TerminalPane.tsx（待ち時間つきの貼り付けの関数を足す。大きさが 0 のときは送らない）
  - tests/fixtures/e2e-env.ts（一時リポジトリに `git update-ref refs/remotes/origin/main HEAD` を足す。今は init と commit だけで origin/main が無い：e2e-env.ts:56-58）
  - 画面: src/components/DiffPane/ を新設する（一覧、1ファイルの表示、コメント欄）。ConsolePage の中央を、SA の Tabs で「端末」と「変更」に分ける
  - src/api.ts、src/types.ts、src/locales/ja.json、試験、版 0.4.0、CHANGELOG、README
- 対象外:
  - 基準（origin/main）を最新にするための git fetch。アプリは参照を書き換えない。表示する基準は「最後に取得した origin/main」で、画面にそう書く
  - 行の範囲（複数行）へのコメント。1行ずつだけ
  - 変更の編集・元に戻す（stage、revert など）
  - ファイル全体を表示する（変更の前後3行だけを出す。git の既定）
  - 未追加のファイルの中身の表示（名前だけ。コメントはファイル全体に1つ付けられる）
  - コメントの位置を、後からの編集に合わせて動かす（Orca にある行の追従）。代わりに、行の中身が変わったら「ずれた可能性」と表示する

## 3. 仕組み
### 3-1 作業場所の確認
- 変更の API はすべて、最初にセッションの cwd を classifyCwd で照合する。本店か worktree でなければ 409 を返して、git を実行しない（K7）。
- git は照合で通った実パスを `-C` に渡す。

### 3-2 一覧（server/diff.ts）
- まず `git -C <dir> rev-parse --verify --quiet <diffBaseRef>` を実行する。0 以外で終わったら `{error:"noBase"}` を返す（下に書く）。
- 次の2つを実行して合わせる。
  - `git -C <dir> diff --merge-base <diffBaseRef> --no-renames --no-ext-diff --no-textconv --numstat -z`：コミット済み・ステージ済み・未ステージの変更を、基準との分岐点から数える。名前の変更は、削除と追加として数える（K13）。`--no-ext-diff --no-textconv` は、リポジトリの設定で外部の命令が動かないようにするため（1ファイルの diff と同じ。Fable のコード審査 MEDIUM-1）。
  - `git -C <dir> ls-files --others --exclude-standard -z`：未追加のファイル。
- execFile、timeout 15000、maxBuffer 8MiB。`-z` で区切るので、名前に空白があっても崩れない。
- 返す形は `{baseRef, files:[{path, added, removed, binary, untracked}]}`。numstat の「-」はバイナリとして扱う。
- 基準が無い（origin/main が無い）リポジトリでは、`{error:"noBase"}` を返し、画面に「基準（origin/main）が見つかりません」と出す。
- それ以外の git の失敗（時間切れ、git のリポジトリでない等）は 500 にして、理由をサーバーの記録に残す。画面には「変更を取得できませんでした」と出す。
- config の `diffBaseRef` は、読み込むときに `^[A-Za-z0-9_./][A-Za-z0-9_./-]*$`（`-` で始まらない）で確かめる。合わなければ起動を止める。

### 3-3 1ファイルの diff
- 画面からは path を受け取る。サーバーは一覧をその場で作り直し、path が完全に一致する項目があるときだけ続ける。無ければ 400（K9）。
- `git -C <dir> diff --merge-base <diffBaseRef> --no-renames --no-color --no-ext-diff -- <path>` を実行する。maxBuffer は `diffMaxFileBytes`。execFile の失敗の code が `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` のときだけ `{tooLarge:true}` を返し（K8）、それ以外の失敗は §3-2 と同じく 500 にする。
- unified diff を行の配列に直して返す：`{kind:"hunk"|"add"|"del"|"ctx", oldLine?, newLine?, text}`。

### 3-4 API（server/http.ts、既存の認証の内側）
- `GET /api/sessions/:id/diff` → 一覧
- `GET /api/sessions/:id/diff/file?path=<path>` → 1ファイル
- `GET /api/sessions/:id/diff-comments` → その作業場所のコメント
- `POST /api/sessions/:id/diff-comments`（追加）・`PUT …/:cid`（編集）・`DELETE …/:cid`（削除）
- `POST /api/sessions/:id/diff-comments/send-check` → 未送信のコメントの文章と、その id の一覧 `{text, ids, submitDelayMs}` を返す。入力できない時は 409 と理由（K6）
- `POST /api/sessions/:id/diff-comments/mark-sent`（本文 `{ids}`）→ 画面が貼り付けに成功した後に、その id を送信済みにする
- コメントの追加・編集では、その場で一覧を作り直し、path が一覧の項目と完全に一致するときだけ受け付ける。side が "new" か "old" のときは、line が 1 以上の整数であることを確かめる。"file" のときは line を持たない。合わなければ 400（K9）
- GET には Origin の検査が無いが、認証は sessionStorage のトークンを Authorization ヘッダーで送る方式で、Cookie を使わない（recon A-2）。よその画面から勝手に読まれることはない。

### 3-5 コメントの保存（server/diff-comments.ts）
- 場所は dataDir の diff-comments.json（権限 600）。書き込みは session-store.ts と同じ（serial、一時ファイル、chmod、rename）。壊れていたら上書きせず、画面に「コメントを読めませんでした」と出す。
- 形は `{version:1, byDir:{<作業場所の実パス>:{branch, items:[{id, path, side:"new"|"old"|"file", line?, lineText?, body, createdAt, sentAt?}]}}}`。
- branch は `git worktree list --porcelain` の値（server/worktree.ts:18-30）。読むときに、今の branch と違えば、その作業場所のコメントを捨てる（同じ場所に別のブランチの worktree が作り直された場合に、古いコメントが戻らないようにする）。
- 本文は 2000 文字まで。改行とタブ以外の制御文字は拒否する（quick-prompts.ts:26 と同じ）。
- 読むたびに、本店と今ある worktree の一覧に無い作業場所の項目を捨てて保存する（K4）。
- 編集したら sentAt を消して、未送信に戻す。
- 「ずれた可能性」の判定は、右側に開いているファイルの行だけで行う。保存した lineText と、今のその行の中身が違えば Badge を出す。一覧と送る文章では判定しない。送る文章には、保存したときの lineText をそのまま使う。

### 3-6 送る文章（server/diff-comments-format.ts）
```
差分へのレビューコメントです。各コメントの行を確認して対応してください。

File: server/http.ts
Line: 204（新しい側）
該当行: const m = url.pathname.match(...)
Comment: ここに close も入れてください

File: README.md
Scope: ファイル全体
Comment: …
```
- 該当行は 200 文字で切る。合計が `diffSendMaxBytes`（既定 16KiB）を超えたら、送らずに「コメントが長すぎます」と返す。
- 送る仕組みは、よく使う指示と同じにする。サーバーは文章を返すだけで、画面が TerminalPane で入れる。
  - 貼り付けてから Enter までの間に `submitDelayMs` だけ待つ。値は config の `pasteSubmitDelayMs` に置き、既定は 2000。2000 は、本物の claude で1つの依頼になったと確かめた値（§0）。
  - TerminalPane に、待ち時間を受け取る貼り付けの関数を足す。既存の pasteAndEnter（よく使う指示）の動きは変えない。
  - 貼り付けが成功（true）したときだけ、send-check で受け取った ids で mark-sent を呼ぶ。
  - 送る直前にセッションが切り替わったら（false）、入れずに mark-sent も呼ばない。案内は、よく使う指示と同じ文言（ac.quick.switched 相当）を出す（ConsolePage.tsx:169 と同じ）。
- 待ちの間にセッションが切り替わった場合（TerminalPane は sessionId が変わると xterm を片付ける：TerminalPane.tsx:92-100）:
  - 待ちの後、端末の sessionId が確認した id と違えば、Enter を送らずに false を返す。mark-sent は呼ばない。
  - 案内は「貼り付けましたが送っていません。そのセッションの端末で Enter を押してください」（新しい i18n キー）。
  - 送っている間（最大 `submitDelayMs`）は「Claude に送る」を押せなくし、二重の貼り付けを防ぐ（K14）。
- 実装の最初の工程（工程0）: 本物の claude を捨てディレクトリで起動し、この経路（2秒待ち）で3行の文章が `[Pasted text #N]` の1つの依頼として届くことを実測して、結果を docs/handoff/v0.4.0-diff-comments/ に記録する。届かなければ、実装を止めて設計者に戻す。
  - 確かめたことがあるのは、`--tools {} --permission-mode dontAsk` で起動した claude に、expect から直接入力した場合だけ（claude-paste.exp:10）。本番の起動コマンド（agent-console.config.json の ccopusgo、`claude --model sonnet`）と、xterm の paste() を通す経路はまだ測っていない。工程0は、アプリの経路（アプリの中のセッション）で測ってこの差を埋める。
- 入力してよいかは、send-check の中で checkInput を取り直して決める（rename の予約と同じ判定、K6）。

### 3-7 画面（src/components/DiffPane/）
- 中央の端末の上に、SA の Tabs（underline、sm）を置き、「端末」と「変更（N）」を出す。端末は隠すだけで、外さない（xterm の接続を保つため）。
  - 隠し方は、端末の包みの要素に `hidden` 属性（display:none）を付ける方法だけにする。visibility:hidden や高さ 0 で隠すと、2列×1行の大きさが pty に送られて Claude の画面が崩れるため（§0）。
  - あわせて TerminalPane の大きさ合わせは、包みの clientWidth か clientHeight が 0 のときは送らないようにする（K12）。
  - ConsolePage.css に `.ac-page__terminal[hidden] { display: none; }` を1行置く。今の包みは display を指定していない（ConsolePage.css:23）。それでも、後で display を足したときに hidden が効かなくなるのを防ぐため。
- 変更タブは左右2つに分ける。左はファイルの一覧（SA の DataTable を使わず、Button の一覧。数は Badge）、右は選んだファイルの diff。
- diff の行は等幅（`--ac-font-mono`）。追加は `--color-success-bg`、削除は `--color-error-bg` の背景。行を押すと、その行の下にコメント欄（SA の Textarea と Button「保存」「やめる」）が開く。
- 上部に「Claude に送る（N件）」の Button。押せない時は、ボタンの横に `--text-muted` の短い文（例「Claude が作業中のため送れません」）を常に出す。Tooltip は使わない（押せないボタンの上でマウスの動きが拾えるかは保証されないため。SA の Tooltip.tsx:114-120）。
- 「変更」タブを開いている間は、よく使う指示のバー（QuickPromptBar）を出さない。端末が隠れていて貼り付けられないため（実装で追加。Fable のコード審査 LOW-5 で設計に追記）。
- 【未確認】「変更」タブを開いたまま別のセッションを選ぶと、端末は隠れた状態（大きさ 0）で作られる。表示に戻したときに文字の幅が正しく測られるかは、K11(b) で PO が確かめる。崩れた場合は、表示に戻った時点で大きさ合わせをやり直す修正を、次の版で設計する。
- 新しく足すトークンは無い。色・余白はすべて SA の var(--…) を使う。

## 4. SSOT
- 変更の正本は git（作業場所）。アプリは保存しない。開くたびに取り直す。
- コメントの正本は dataDir/diff-comments.json の1か所。画面はその写しを表示するだけ。
- 基準・上限は config だけに置く。コードには書かない。
- 送ったあとの会話の正本は Claude（~/.claude）。

## 5. 安全
- git にはシェルを通さず、引数配列で渡す。path は `--` の後ろにだけ置き、一覧に完全一致したものだけを使う（K9）。
- 作業場所は、毎回その時点の本店と worktree の一覧で照合する（K7）。
- アプリは git の参照も作業場所も書き換えない（fetch・stage・checkout をしない）。
- 端末に入れるのは、入力してよい時だけ（K6）。許可の確認を待っている間に入れると、Enter が許可として扱われるため。

## 6. 代替案
- 送る文章をファイルに書いて、Claude に「このファイルを読んで」と頼む：ファイルが残り、正本が2つになるので不採用。
- サーバーが直接端末に書く（rename の予約と同じ）：送った後に画面でセッションが切り替わる場合の扱いが増える。既にある「画面が貼る」型に揃えて不採用。
- 2点比較（`git diff origin/main`）：main が進んだ分の逆の変更が混ざる（recon D、recon-self.md:99-100）ため不採用。
- 外部の diff 表示ライブラリを入れる：依存が増え、SA のトークンと合わせ直す手間がかかる。必要な表示は行の色分けだけなので不採用。

## 7. リスクと対処
- 基準が古いと、関係のない変更が混ざる：基準の名前を画面に出す。fetch はしない（対象外）。
- 大きな diff で画面が重くなる：1ファイルずつ取り、上限で止める（K8）。一覧は numstat だけなので軽い（recon G：全履歴の --stat で 0.047秒）。
- コメントの行が後からずれる：lineText で照合して「ずれた可能性」を出す。
- 送った文章を Claude が読み違える：K11 で PO が実物で確かめる。

## 8. 外部・過去事例の参照と我々への応用
- Orca（recon-orca.md:32-62、2026-10-12 調査）：
  - 行ごとのコメントを書いて、まとめて「File／Line／コメント」の形で、入力待ちを待ってから端末に貼る。
  - この形を使い回す。
  - 適用限界：Orca の利用者数や効果の数値は観察していない。この設計の成否の根拠にはしない。成否は K11 で測る。
- 過去事例 v0.3.7（rename の予約）：許可の確認待ちに Enter を入れない判定を、そのまま使う。

## 9. 設計審査
### 9-1 第1回（Opus の自己審査、2026-10-12）
- APPROVE とした。ただし、根拠のファイルを取り違えていた（§0 の貼り付けの根拠を、試験より前の文書にしていた）。第2回で指摘を受けた。

### 9-2 第2回（Fable による審査、2026-10-12。PO の指示）
- 判定: REVISE。
- 指摘は CRITICAL 1件、HIGH 2件、MEDIUM 5件、LOW 4件。全文は /tmp/CC報告ファイル/orca-selfbuilt/stage3/review-fable-diff-comments.md に置いた。
- 反映:
  - CRITICAL-1 貼り付けの根拠：正しい判定ファイルを示し、2秒待つことを明記した。工程0で実測する（§0、§3-6）。
  - HIGH-1 名前の変更：`--no-renames` を付け、K13 を追加した。
  - HIGH-2 端末の隠し方：hidden 属性だけにし、大きさ 0 では送らないようにした。K12 を追加した。
  - MEDIUM-1 基準の有無：rev-parse で先に確かめる。
  - MEDIUM-2 コメントの path：一覧と照合する（K9 を広げた）。
  - MEDIUM-3 mark-sent：貼り付けが成功したときだけ呼ぶ。
  - MEDIUM-4 押せない理由：Tooltip をやめ、文で常に出す。
  - MEDIUM-5 ずれの判定：開いているファイルだけで行う。
  - LOW-1 branch を保存した。
  - LOW-2 diffBaseRef の形を確かめる。
  - LOW-3 tooLarge は maxBuffer の超過だけで返す。
  - LOW-4 e2e の一時リポジトリに origin/main を足す。
### 9-3 第3回（Fable による再審査、2026-10-12）
- 判定: APPROVE。条件は MEDIUM-A と MEDIUM-B の追記で、構造の変更は不要。
- 第2回の12件は、すべて反映されていることを実物で確認した。貼り付けの根拠も、試験の画面記録（claude-screen.txt:96 `Pasted text #1 +18 lines`、:188 `READY7`）で照合した。
- 反映:
  - MEDIUM-A 待ちの間にセッションを切り替えた場合：§3-6 と K14 に書いた。
  - MEDIUM-B K12 の観測方法：大きさを出す役割を足す（a）に決めた。
  - LOW-A `[hidden]` の CSS を1行足す。
  - LOW-B K の番号順を並べ直した。
  - 補足（本番の起動コマンドでは未実測）は、工程0の説明に書いた。
- 設計者の判断: 追記は指摘どおりで、構造は変えていない。そのため実装に進める状態とする。

### 9-4 コード審査（Fable、2026-10-12、PR #16）
- 判定: REVISE。HIGH 1件、MEDIUM 2件、LOW 6件。
- 反映:
  - HIGH-1 Linux で使えない stat の書き方で、CI の ubuntu が失敗していた → node の statSync に直す。
  - MEDIUM-1 一覧の取得にも `--no-ext-diff --no-textconv` を付ける（§3-2）。
  - MEDIUM-2 隠れた状態で作られた端末の表示を、K11(b) で確かめる（§3-7）。
  - LOW-1・2・3 を直す。LOW-5 は設計に追記した。
  - LOW-4（上限 2000 文字がサーバーと画面に重複している）と LOW-6（関数が長い）は許容とする。

### 実装の注意
  - worktree には .sa-cache が無い。実装の前に sa-sync を実行する。
  - CI のチェック名は gh で実測してから PR に書く（recon E は推測）。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K6（入力できない時は送らない）、K7（作業場所の照合）、K9（path の完全一致）を統合試験で固定する。
- git の版を上げたら、`--merge-base` の動きを試験で確かめる。
