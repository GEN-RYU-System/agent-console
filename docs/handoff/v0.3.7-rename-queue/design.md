# 設計: v0.3.7 名前のダブルクリック変更と、作業中の名前変更の予約

- 状態: 設計者（Opus）が作成。
- PO の承認（2026-10-12）:
  - 「ダブルクリックで名前を変えられる形にする」
  - 「鉛筆も残す」
  - 作業中・許可待ちのときは、名前を予約して、待機になったら自動で変える案に「y」
- 調査: docs/handoff/v0.3.7-rename-queue/recon.md（実装担当の Sonnet が作成）
- 対象ADR: ADR-067（デザイントークン）、ADR-144（UI ガバナンス・金型を優先する）
- 前提の設計: docs/handoff/stage2/design.md:35-38（名前の正本と /rename を送る条件）

## 0. 実機の事実（2026-10-12、Claude 2.1.296、試験用に立てた Claude で実測。記録は scratchpad の exp/）
- 作業中（status busy。ツールの実行中と、文章の生成中の両方）に `/rename x\r` を書き込んだ。
  - 名前は約3秒で変わった。
  - 元の作業は最後まで終わった。
  - 会話の入力として入り込むことはなかった。
- 許可待ち（waiting、waitingFor "permission prompt"）に `/rename x\r` を書き込んだ。
  - 名前は変わらなかった。
  - Enter が許可プロンプトの既定「1. Yes」を押し、コマンドが実行された。
- 現在の作りでは、判定（checkInput、recon (a) hub.ts:109-114）と書き込み（http.ts:221）の間に `await` を1回挟む。この間に busy から waiting へ変わる恐れはゼロにできない。そこで、busy の間にすぐ送ることはせず、予約して idle になってから送る（PO が y で選んだ案）。

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 名前の文字をダブルクリックすると「名前を変える」画面（今と同じ Modal）が開く。1回のクリックは今までどおりセッションを選ぶだけ|SessionList の単体試験（dblclick で onRename が呼ばれる）＋ e2e（dblclick → rename-form が見える）|
|K2 鉛筆は止まったセッションを除いて常に押せる（作業中・許可待ち・状態不明でも押せる）|単体試験＋e2e（working で enabled）|
|K3 Claude が待機中（idle かつ waitingFor 無し）なら、今までどおりすぐ `/rename` を送り `{mode:"claude"}` を返す。Claude のいないシェルは今までどおりアプリの名前を変えて `{mode:"app"}` を返す|統合試験（既存のケースを維持）|
|K4 作業中・許可待ち・状態不明のときは、端末に何も書かずに予約し、`{mode:"queued"}` を返す。一覧のその行には予約中の名前が出る|統合試験（ring に /rename が無い、view.pendingName が入る）＋ e2e|
|K5 予約は、定期取得のたびに要求時と同じ取り直し判定（checkInput）をしてから送る。ok かつ hasClaude なら `/rename <名前>\r` を送り、ok かつ Claude が無ければアプリの名前を変え、予約を消す。ok でなければ予約を残す。許可待ちの間には絶対に送らない|統合試験（busy → waiting → idle の順に取得させて、idle になった後にだけ ring に /rename が1回入る）|
|K6 予約中にもう一度名前を変えた場合は、新しい名前で上書きする（送るのは最後の1回だけ）。待機中にすぐ変えた場合は予約を消す。セッションが止まったら、または一覧から外したら予約を捨てる|統合試験|
|K7 名前の検証（1〜40字、制御文字は不可）は予約するときも今までどおり。止まったセッションは 409|統合試験|
|K8 文言は i18n（ja.json）で書く。「作業中は変えられません」の文言は、「予約して、待機になったら変わります」の内容に置き換える|単体試験|
|K9 デザイン検査（npm run lint）と、既存の試験・CI（両 OS）が通る。見た目の値は SA のトークンと金型だけ|CI|

## 2. 対象と対象外
- 対象:
  - server/hub.ts（予約の保持・発火・掃除、SessionView.pendingName）
  - server/http.ts（rename API）
  - src/types.ts（pendingName）
  - src/api.ts（mode に "queued" を追加）
  - SessionList.tsx/.css（dblclick、鉛筆の disabled の条件、予約中の表示）
  - RenameForm.tsx（blocked の条件と、案内の文言）
  - ConsolePage.tsx（queued のときは10秒の確認タイマーを付けない）
  - ja.json
  - 試験（単体・統合・e2e）
  - 版 0.3.7、CHANGELOG、README の名前変更の説明
- 対象外:
  - 行の中で名前を直接書き換える編集（今と同じ Modal を開く）
  - よく使う指示の送信条件（canInput は変えない）
  - en.json の新設（このリポジトリには無い。recon (f)）
  - 予約の永続化（メモリだけ。サーバーを再起動すると予約は消える。tracker と同じ扱い、recon (c)）

## 3. 仕組み
### 3-1 サーバー
- hub に `pendingRenames: Map<sessionId, name>` を持つ。正本はここだけにする。画面は snapshot で受け取るだけ。
- `hub.requestRename(id, name)` を新設する。http.ts:215-228 はこれを呼ぶだけにする。
  1. `validateName` を通す。
  2. `checkInput(id)` で判定し直す。
  3. session.exited の場合は SessionConflictError（409、今と同じ）。
  4. verdict.ok かつ hasClaude の場合は `sessions.write(session, "/rename " + name + "\r")`。予約を消して `"claude"` を返す。
  5. verdict.ok かつ hasClaude でない場合は `sessions.rename(id, name)`。予約を消して `"app"` を返す。
  6. それ以外（busy・waiting・waitingFor あり・状態不明）の場合は、`pendingRenames.set(id, name)` をして publish し、`"queued"` を返す。
- 発火: `pollAgents` の detectBreaks の後、publish の前に `flushPendingRenames()` を呼ぶ。
  - 予約ごとに、まず session の状態を見る。session が無い、または exited なら予約を消す。
  - 次に、定期取得の結果で `inputVerdict(...).ok` を確かめる。true のときだけ `checkInput(id)` で取り直し、ok なら 3-1 の 4 または 5 と同じ送り方をして予約を消す。
  - 取り直しで ok でなければ、何もせず予約を残す。
  - 予約は1件ずつ順番に処理する。poll.ts は前の回が終わってから次の回を予約するので、二重には走らない（recon (a) poll.ts:1-12）。
  - 1件で例外が出ても、他の予約と通知は止めない。onPollError と同じ経路でログに出す。
- 掃除: `sessions.onRemoved` のリスナー（hub.ts:52）で、予約も消す。
- SessionView に `pendingName?: string` を足す（予約があるときだけ入れる）。サーバー側と src/types.ts の両方に足す。

### 3-2 画面
- SessionList:
  - 選択ボタンに `onDoubleClick={() => { if (s.state !== "stopped") onRename(s.id); }}` を付ける。SA の Button は rest を `<button>` に渡す（recon (h)）。
  - 鉛筆の `disabled={!s.canInput}` は外す（止まったセッションでは、もともと鉛筆を出さない）。
  - pendingName があるときは、2行目の役割の後ろに、i18n の `ac.rename.pendingLine`（例「予約: {{name}}」）を出す。トークンだけで書き、はみ出す部分は省略記号にする。
- RenameForm:
  - blocked の条件を `session.state === "stopped"` に変える。
  - `!session.canInput` かつ止まっていないときは、Callout（info）で `ac.rename.queueTitle` と `ac.rename.queueBody` を出す。
  - helperText の hintClaude の文言を直す。
- ConsolePage handleRename:
  - mode が "queued" のときは Modal を閉じるだけにする。10秒の未反映の案内は "claude" のときだけにする（今と同じ）。
- api.ts: 戻り値の型を `{ mode: "claude" | "app" | "queued" }` にする。

### 3-3 文言（ja.json）
- hintClaude: 「Claude に /rename を送って名前を変えます。作業中や許可待ちのときは予約して、待機になったら送ります。」
- busyTitle と busyBody は削除し、次の2つに置き換える。
  - queueTitle: 「いまは予約になります」
  - queueBody: 「Claude が作業中か許可待ちです。名前は予約しておき、待機になったら自動で変えます。」
- pendingLine: 「予約: {{name}}」
- 使わなくなったキーは残さない。

## 4. SSOT
- 名前の正本は、今と同じく Claude 起動中は `claude agents --json` の name、それ以外はアプリの名前（stage2/design.md:36）。
- 予約は、その正本に反映するまでの間だけ、hub のメモリ1か所に持つ。画面には状態を持たせない。

## 5. 安全
- 自動で送るときも、人が押したときと同じ判定（要求時に取り直した idle、かつ waitingFor 無し）を通してから送る。許可待ちのときは送らない。
- 判定と書き込みの間の時間差は、今の人の経路と同じ大きさで、stage2/design.md:95 の受け入れ済みの制約と同じ種類のもの。busy の間にすぐ送る経路は作らない。
- 送る文字列は `/rename ` に、validateName を通した名前（制御文字なし）を付けたものだけ。
- stage2/design.md:37 の「人が押したときのみ」という前提は、「人が押した予約を、条件を満たしたときに1回だけ送る」に変わる。この設計書を正本とし、CHANGELOG に記す。

## 6. 代替案
- 作業中（busy）なら、すぐに送る: 判定と書き込みの間に waiting へ変わると、許可を勝手に「Yes」にする恐れがある → PO が n を選ばなかった（不採用）。
- 予約を画面側に持つ: 画面を閉じると消えるうえ、SSOT が分かれる → 不採用。
- 行の中で直接書き換える: button の中に input は置けず、行の作りを大きく変える必要がある → 今回は Modal を使い回す。

## 7. リスクと対処
- 待機にならないまま止まる、あるいは外される: 予約を捨てる（K6）。
- 予約を送った後、Claude が /rename を受け付けない: 送ってから10秒たっても名前が変わらないときの案内は、今は人が押した経路だけにある。予約経路では出さず、行に予約の表示が消えることで分かるようにする。
- サーバーを再起動すると予約が消える: 更新は開いているセッションが無いときにだけ行う運用なので、影響はない。

## 外部・過去事例の参照と我々への応用
- Claude Code の公式文書 commands（https://code.claude.com/docs/en/commands、Context7 /websites/code_claude、2026-10-12 取得）: 「If you send a command while Claude is responding, Claude Code queues it and runs it after the current turn finishes.」Claude の本体も、作業中のコマンドを待たせる設計になっている。我々はこれをアプリ側で、許可待ちを避ける形で行う。
- macOS の Finder は、名前の変更を選択とは別の操作に分けている（ダブルクリックではなく、Return キーや名前の再クリック）。今回のダブルクリックは PO の指定による。1回のクリックは選択のままにして、選択と名前の変更を分ける考え方だけを取り入れた。
- 過去事例: v0.3.6 の確認で、鉛筆が押せない理由が画面に出ず、PO が故障と区別できなかった（2026-10-12 の報告）。今回は押せない状態そのものを無くす。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K5 の統合試験（busy → waiting → idle で、idle の後に1回だけ送る）で「許可待ちには送らない」を固定する。
