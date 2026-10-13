# 設計: Claude の利用量（週・5時間）をアプリでバー表示する

- 状態: 設計者（Opus）が作成。Fable の設計審査（2026-10-13）は REVISE → 指摘を §10 に反映 → 再審査 APPROVE（LOW 2件は反映済み）。**§10 は §0〜§9 より優先する。** 実装は工程0(a) の結果しだい。
- 版の番号: マージの順で決める（0.13.0 は chat2 でマージ済み。board-tasks が 0.14.0 で実装中。この設計はその次の空き番号）。
- PO 承認（2026-10-13）
  - 要望の原文: 「claudeの週間の利用料も見える化してくれると制限が近いのかこのアプリ内で確認が完結するのだができるか？Tokenを無駄に消費しない仕組みで確認できる仕組みが出来ると助かる、プログレスバーで表示したい」
  - 設計者の y/n「週の利用量のバーのために、Claude Code の設定に『下の行の表示（ステータスライン）』の仕掛けを1つ足してよいですか？」に「y」。
- 調査: 設計者が Sonnet に委任した調査の報告（2026-10-13）。生データは本リポジトリ外の /tmp/CC報告ファイル/usage-meter/（索引は NOTES.txt）。
- 対象ADR: ADR-067、ADR-144

## 0. 事実（調査より）
- statusLine の命令は、入力の JSON の `rate_limits` に、使用率とリセットの時刻を受け取る。
  - 受け取る値: `five_hour.used_percentage`（0〜100）、`five_hour.resets_at`（Unix 秒）、`seven_day.used_percentage`、`seven_day.resets_at`。
  - 出典: https://code.claude.com/docs/en/statusline の Available data。
  - 出る条件: claude.ai の Pro・Max の契約で、セッションで最初の API 応答があった後に限る。各窓は、個別に欠けることがある。resets_at を過ぎた窓は落とされる。
- statusLine の命令が動くのは、新しい assistant のメッセージが来たとき、セッションの開始のときなど。300ms のまとめ待ちがある。値は、直近の API 応答のもの。
- hooks の入力にも、CLI のサブコマンドにも、使用率は無い。`/usage` は画面のコマンドで、状態を確かめるための要求を出すことがある（https://code.claude.com/docs/en/costs）。
- ~/.claude/settings.json に、今 statusLine は無い。
- 規約（Consumer Terms §3.7）に照らし、claude.ai の内部 API は使わない。公式の出力だけを使う。
- 【未確認】
  - この契約で、実際に rate_limits が来るか。
  - 複数のセッションの分を合算した値か（契約全体の値か）。
  - statusLine の命令の環境に、どの変数があるか。

## 1. 方針
- statusLine の命令として、アプリの小さな命令 `ac-statusline.mjs` を置く。
  - 入力の JSON から rate_limits だけを取り出し、dataDir/usage.json に書く。
  - Claude の画面の下の行に、「週 41% · 5時間 23%」を出す。
- アプリのサーバーは usage.json を読む。画面は2本のバー（週・5時間）を出す。
- トークンは使わない。Claude が返事をしたついでに渡される値を、書き写すだけ。

## 2. 成功条件
|基準|検証方法|
|---|---|
|K1 `ac-statusline.mjs` は、標準入力の JSON から `rate_limits.five_hour` と `rate_limits.seven_day`（used_percentage と resets_at）だけを取り出す。dataDir/usage.json に `{version:1, observedAt, fiveHour?, sevenDay?}` を書く（一時ファイル→600→rename）|単体試験|
|K2 標準出力に1行出す。両方あれば「週 N% · 5時間 M%」、片方なら片方、無ければ空の行。i18n の文言は使わず、数字と記号だけにする（Claude の画面に出るため）|単体試験|
|K3 入力が壊れている、rate_limits が無い、値が範囲外（0〜100 の外、数でない）のときは、usage.json を書き換えない。標準出力は空の行にし、終了コード 0 で終わる（Claude の画面を止めない）|単体試験|
|K4 外部への通信をしない。書くのは dataDir/usage.json だけ。処理は 200ms 以内に終わる|単体試験（時間を測る）|
|K5 複数のセッションが同時に書いても、ファイルは壊れない（rename による原子的な置き換え）。新しい観測が古い観測で上書きされないよう、書く前に既存の observedAt と比べ、新しいときだけ書く|単体試験|
|K6 `GET /api/usage` は usage.json を読み、`{status:"none"}` か `{status:"ok", observedAt, fiveHour?, sevenDay?}` を返す。壊れていれば `{status:"invalid"}` を返す|単体試験＋統合試験|
|K7 画面の常に見える場所（下の帯 ConsolePage.tsx:421-443 の footer）に、2本の ProgressBar（週・5時間）と、「N%」「リセット M月D日 H:mm」「N分前の値」を出す。窓の resets_at を過ぎていたら、その窓は「リセット済み・次の返事を待っています」と出す。無いときは「まだ値がありません（Claude が返事をすると出ます）」と出す|単体試験＋e2e|
|K8 画面は60秒ごとに取り直す。サーバーは、ファイルを読むだけで、ほかの処理はしない|単体試験|
|K9 statusLine の設定は `node scripts/ac-hooks.mjs install` で足し、`uninstall` で外し、`check` で確かめる。足す前に控えを取る（今の作りのまま）。すでに別の statusLine があるときは、上書きしない。理由を出して、終了コード 1 で終える|単体試験|
|K10 命令の本体は dataDir/bin/ac-statusline.mjs に写す（ac-board と同じ作り。server/activity-setup.ts:42-45）|統合試験|
|K11 文言は i18n。見た目は SA の金型とトークンだけ。lint と既存の試験・CI（両 OS）が通る|CI|
|K12（導入後）PO が、アプリの下の帯で、週と5時間のバーを見られる|PO の目視|

## 3. 仕組み
### 3-1 命令（hooks/ac-statusline.mjs）
- 検査と書き込みの関数は、このファイルの1か所にまとめる。サーバーは、読み取りと検査の関数を import する（ac-board と同じ作り）。
- 値の検査:
  - used_percentage は 0〜100 の有限の数。
  - resets_at は正の整数。
- `observedAt` は、命令が書いた時刻（ms）。

### 3-2 設定（scripts/ac-hooks.mjs と server/activity-hooks.ts）
- install のときに、`statusLine: {type:"command", command:"<node>", args?:…}` を足す。
  - 形は、公式の statusLine の形に合わせる。args の形が使えるかは、工程0で確かめる。使えなければ、command の文字列にパスを引用符で入れる。
- uninstall は、自分の statusLine（命令のパスで見分ける）だけを外す。
- check は、自分の statusLine があるかを確かめる。

### 3-3 サーバーと画面
- server に `GET /api/usage` を足す（認証は今の API と同じ）。
- 画面の部品は `UsageMeter`。footer の中に置く。
  - ProgressBar（label なし）を2本と、文を出す。
  - 80% 以上は variant を warning にする。95% 以上は danger にする。ProgressBar の variant に何があるかは、工程0で .sa-cache を見て決める。
- 「N分前」は、observedAt と今の時刻の差から作る。

## 4. SSOT
- 利用量の正本は、Claude Code が渡す値。アプリの写しは dataDir/usage.json の1か所だけ。
- 書き手は ac-statusline.mjs だけ。読み手はサーバーだけ。

## 5. 安全
- トークンを使わない。外部へ通信しない。
- 設定を書き換える前に控えを取る。別の statusLine があれば、上書きしない。
- 戻し方: `node scripts/ac-hooks.mjs uninstall`、または控えの settings.json を戻す。

## 6. 代替案
- `/usage` を定期的に送る: 要求が出て、トークンを使うおそれがある。不採用。
- claude.ai の内部の API を読む: 規約（§3.7）に反するおそれがある。不採用。
- Agent SDK の usage_report: 形が experimental で、認証の条件がある。不採用。

## 7. リスク
- 値は、どれかの Claude が返事をしたときにだけ新しくなる。「N分前の値」で分かるようにする。
- この契約で rate_limits が来ない: 工程0で確かめる。来なければ、実装せずに止めて、PO に報告する。

## 8. 外部・過去事例の参照と我々への応用
- 公式の statusline の例（`jq -r '.rate_limits.seven_day.used_percentage // empty'`）と同じ値を使う。
- 過去事例: 作戦ボードの命令（ac-board）の、dataDir/bin への写しと、原子的な書き込み。
- 適用限界: 外部の事例は調べていない。

## 9. 工程
- 工程0（確かめる）:
  - (a) 捨ての設定（`--settings` の一時ファイル）に statusLine を入れた claude を1回だけ動かし、短い1問で返事をさせる。命令が受け取った JSON に rate_limits があるかを確かめる。トークンは、この1問だけ使う。
  - (b) statusLine の args の形が使えるか。
  - (c) ProgressBar の variant。
  - (d) footer の幅で、2本のバーが読めるか。
  - 結果は step0.md に書く。(a) が無ければ止める。
- 工程1: 試験を先に書く。
- 工程2: 実装。
- 工程3: CI。
- 工程4: Fable のコード審査。
- 導入: 導入の後に、更新の仕組みが `ac-hooks.mjs install` を実行する（今の update-when-idle.sh のまま）。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K3（壊れた入力で画面を止めない）と K5（同時の書き込みで壊れない）を、試験で固定する。

## 10. 設計審査（Fable REVISE）への対応（§0〜§9 より優先）

### 10-1 色と 100% の見せ方（HIGH-1）
- 【事実】SA の ProgressBar の variant は `'linear' | 'striped' | 'circular'` だけで、warning・danger は無い（salesanchor/frontend/src/components/loading/ProgressBar.tsx:4,9）。値が 100 以上だと完了の見た目（成功色とチェック）になる（同 :22,:42）。この事実は docs/handoff/board/step0.md:51 にも記録済み。
- 決め:
  - 棒は ProgressBar（variant は linear）をそのまま使い、色は変えない。色の直値と独自のクラスは使わない。ADR-144 の例外は要らない。
  - 注意の度合いは、棒の横の SA の Badge で出す。80% 以上は warning、95% 以上は danger。80% 未満は Badge を出さない。Badge の文言は i18n（例: 「上限に近い」「ほぼ上限」）。
  - 100% 以上のときは ProgressBar を出さない（完了の見た目を避ける）。代わりに danger の Badge「上限」と「N%」を出す。
  - §3-3 の「variant を warning・danger」と、§9 工程0(c) は取り消す。
- K7 に足す: 「used_percentage が 100 のとき、`usage-meter-bar-<窓>` が無く、`usage-meter-badge-<窓>` が danger で出る」「80・95 の境目で Badge が変わる」を単体試験で確かめる。

### 10-2 触るファイル・触らないファイル（HIGH-2）
- 実装は、最新の main（7d34553 以降。board-tasks が先にマージされたら、その後の main）から始める。行番号は、その main で取り直す。
- 触る:
  - `hooks/ac-statusline.mjs`（新規。検査・書き込み・読み取りの関数）と `hooks/ac-statusline.d.mts`（新規。型）
  - `scripts/copy-board-command.mjs`（dist-server/hooks へ写す対象に ac-statusline.mjs を足す。今は :9 で ac-board.mjs だけ）
  - `server/activity-setup.ts`（パスの関数と、dataDir/bin への写し）、`server/activity-start.ts`（起動時の写し。今の :44-49 の並び）
  - `server/activity-hooks.ts`（statusLine の add・remove・check。hooks の `Handler` 型（:41-46）は使わず、statusLine 用の型を別に作る）
  - `scripts/ac-hooks.mjs`（install・uninstall・check に statusLine の段を足す）
  - `server/usage-routes.ts`（新規。`GET /api/usage`）と `server/http.ts`（handleApi への登録）
  - `src/api.ts`、`src/types.ts`、`src/components/UsageMeter/`（新規。部品・CSS・試験）、`src/pages/ConsolePage.tsx`（footer に UsageMeter を置く1か所だけ）、`src/locales/ja.json`（この repo は ja.json だけ）
  - 試験: `tests/unit/` の新規ファイル（ac-statusline、usage-routes、activity-hooks の statusLine 分）、e2e は footer の表示1本
  - 文書: `README.md`、`docs/CHANGELOG.md`、`package.json` の version、この design.md と step0.md
- 触らない: `HOOK_SPECS` と既存の hooks の handler、ac-board の命令と口、chat の口、`server/activity.ts`、ConsolePage.tsx の footer 以外、StatusDot、SessionList、~/.claude/settings.json の statusLine 以外の鍵。

### 10-3 install・check の順と終了コード（MEDIUM-3）
- install は、今の hooks の段を先に済ませて書き込む。その後に、statusLine の段を別に判定する。
  - 別の statusLine が既にあるときは、上書きせず「statusLine: 別の設定があるので足していません」と別の行に出す。**終了コードは、hooks の段の結果で決める**（statusLine の段の見送りでは 1 にしない）。§2 の K9 の「終了コード 1」は取り消す。
  - statusLine の段の書き込みに失敗したとき（ファイルが書けない等）は、終了コード 1 にし、「hooks は入った・statusLine は入っていない」と分けて出す。
- check は、hooks の結果と statusLine の結果を、別の行で出す。statusLine が無い・別の物は「statusLine: 無い（または別の物）」と出し、終了コードは hooks の結果で決める。
- サーバーの1時間ごとの checkHooks（activity-start.ts:34-35）には、statusLine を含めない（警告の意味を変えない）。
- 戻し方（uninstall）は、自分の statusLine だけを外す（§3-2 のまま）。
- K9 の試験: 「別の statusLine がある → hooks は入り、statusLine は変わらず、終了コード 0、見送りの行が出る」「statusLine が無い → 足される」「uninstall で自分の物だけ外れ、別の物は残る」。

### 10-4 古い値の上書き（MEDIUM-4）
- 【事実】statusLine の命令は、API の応答のほか、権限モードの切り替え・vim の切り替え・再開でも動く。そのとき渡るのは、そのセッションが最後に受け取った値で、入力に API 応答の時刻は無い（/tmp/CC報告ファイル/usage-meter/statusline-doc-fetch.txt:142-154,190-205）。
- 決め: 鮮度は保証しない。既知の限界として受け入れる。
  - K5 の「observedAt を比べて新しいときだけ書く」は取り消す。K5 は「同時に書いても壊れない（一時ファイル→rename）」だけにする。
  - 画面の文言は「N分前に書かれた値」とし、「最新」とは書かない。
  - 「同じ窓の中で used_percentage が下がる書き込みを拒む」案は採らない（5時間の窓が rolling で、単調に増えるかが【未確認】のため）。
- §7 に足す: 「待っているセッションが、モードの切り替えなどで古い値を書くことがある。値は、どれかの Claude が次に返事をすれば直る」。

### 10-5 statusLine の設定の形（MEDIUM-5）
- 公式の設定は `command` の文字列だけが書かれている（statusline-doc-fetch.txt:41-50,69）。args の形は使わない。§3-2 と §9 工程0(b) の args の確認は取り消す。
- 形: `{"type":"command","command":"\"<nodeの絶対パス>\" \"<dataDir>/bin/ac-statusline.mjs\""}`。2つのパスを、どちらも二重引用符で囲む。パスに `"`・`$`・`` ` ``・`\`・改行が入っているときは、install をしないで理由を出す（引用の崩れを避ける）。このとき hooks の段は入り、statusLine の段だけ失敗として終了コード 1。
- dataDir を変えたときは、先に旧 dataDir で `ac-hooks.mjs uninstall` を実行する（または settings.json の statusLine を手で外す）。自分の物かは今の dataDir の引用符付きパスで見分けるため。
- 自分の物かは、command の文字列に `"<dataDir>/bin/ac-statusline.mjs"`（引用符を含む）がそのまま入っているかで見分ける。
- K9 の試験に、空白を含む dataDir（`.../Application Support/agent-console` の形）を入れる。CI の両方の OS で、その command が shell で動くことを確かめる。

### 10-6 根拠の弱い記述（LOW-7）と K4・K7 の測り方
- §0 の「hooks の入力にも使用率は無い」は【未確認】にする（hooks の文書は先頭の一部しか読んでいない）。採用した案は、これに依存しない。
- §0・§6 の「Consumer Terms §3.7」は【未確認】にする（原文の生データが無い）。採用した案は、これに依存しない。
- K4 の 200ms は、命令の関数（読み取り・検査・書き込み）を試験の中で呼んだときの時間で測る。node の起動は含めない。
- K7 の「読めるか」は、e2e で data-testid（`usage-meter`、`usage-meter-bar-week`、`usage-meter-bar-fiveHour`、`usage-meter-badge-<窓>`）と文言で判定する。幅の見た目は K12（PO の目視）で確かめる。

### 10-7 工程0 の残り
- (a) rate_limits が実際に来るか（来なければ止めて PO に報告）
- (d) footer の幅で2本が読めるか（読めなければ、文を短くするか、1本ずつ切り替える案を step0.md に書き、設計者が決める）
- (b)・(c) は 10-1・10-5 で決めたので行わない。
