# ボタン1つで次のセッションへ引き継ぐ・名前が英語に戻る不具合（session-relay）設計 第1版

- 状態: 設計案（Opus 作成）。審査前。PO の実装承認は無い。
- 調査: recon.md（同じフォルダ）。行番号は recon の S1〜S7 を指す。

## 1 目的（PO の言葉は recon.md の冒頭）
- A（不具合）: アプリで名前を付けて開いたセッションが、Claude が立ち上がった後も、その名前のまま一覧に出る。
- B（新機能）: 一覧のボタン1つで、今のセッションに引き継ぎ書を書かせ、名前の末尾の数字を1つ増やした新しいセッションを開き、引き継ぎ書を読ませて続きに着手させ、画面を新しいセッションに切り替える。

## 2 対象と対象外
- 対象: server/sessions.ts、server/hub.ts、server/launch.ts、新規 server/relay.ts、server/http.ts、server/config.ts、src/components/SessionList/SessionList.tsx、src/pages/ConsolePage.tsx、src/types.ts、src/api.ts、src/locales/ja.json・en.json、試験。
- 対象外（触らない）: 役割のシェル関数（ccopusgo など、`-n` は足さない）、hooks/ac-statusline.mjs、会話の量（%）の表示（次の版で検討。今回は PO が自分で押す時を決める）、古いセッションを自動で閉じること、resume()（再開の選択リスト。名前は選んだ会話の物を尊重する）、アカウント切り替えの端末。

## 3 A: 初回の名前合わせ
### 変更前
- 起動直後の Claude は自動名（例 "work-06"）を持ち、server/hub.ts:553 で Claude 側の名前が優先されるので、アプリの名前が負ける（recon S1）。
### 変更後
- Session に `initialName?: string` を持たせる。spawnSession の呼び出し元のうち create()（sessions.ts:262）と restore()（:320）で、渡された名前を入れる。resume() とアカウント切り替えでは入れない。
- restore() の入力に `manualInitialName?: boolean` を足す。true のときは initialName を入れない（launchAndSend と引き継ぎが自分で送るため。§3 の競合の項）。
- hub の定期取得（:158 の flushPendingRenames の直後）に flushInitialNames を足す。各 initialName について:
  1. セッションが無い・終了 → initialName を消す。
  2. pendingRenames に同じ id がある（PO が後から改名した）→ initialName を消す（PO の新しい指示を優先）。
  3. 作成から 10 分過ぎても入力待ちにならない → 消す（送らない）。
  4. flushPendingRenames と同じ取り直し判定（polled → checkInput）で ok かつ hasClaude のとき、Claude 側の名前が initialName と違えば `/rename <initialName>\r` を 1 回書き、initialName を消す。同じなら書かずに消す。
- 競合: 指示の自動送信（launchAndSend の submitText は「貼り付け → 待つ → \r」の2回に分けて書く、hub.ts:393-401）の途中に `/rename …\r` が割り込むと入力が壊れる。そのため launchAndSend と引き継ぎは manualInitialName=true で開き、次の順に自分で送る: waitReady → hub.sendName(id, name)（`/rename` を書く）→ waitName（Claude 側の名前が name になるまで 3 秒ごと・最大 15 秒。超えても次へ進む）→ waitReady → submitText。
- routines・reservations のセッション名（sessionNameFor、launch.ts:58-62）もこれで Claude 側に入る。
### 受入
- K1: 名前「テスト5」で新しいセッションを作る → Claude の入力待ちから 30 秒以内に一覧の名前が「テスト5」になり、指示を1回送った後も「テスト5」のまま（実機、K11 と同時）。
- K2: 単体試験で、initialName があり pendingRenames もあるとき、`/rename` は予約の名前で 1 回だけ書かれる。
- K3: 単体試験で、ok かつ hasClaude になるまで書かれない。名前が同じなら書かれない。10 分で消える。
- K4: 単体試験で、launchAndSend の書き込み順が「/rename → 指示の貼り付け → \r」で、間に別の書き込みが入らない（manualInitialName で定期取得が送らない）。

## 4 B: 引き継ぎ
### 4-1 入口と条件（server/http.ts）
- `POST /api/sessions/:id/relay` → 202 `{ relayId }`。本文は受けない（名前・文は server が決める。画面の文字列をコマンドに入れない）。
- 409 の条件: セッションが無い・終了／hasClaude でない／checkInput が ok でない（待機中でない）／役割が config.roles に無い・アカウント切り替え／同じセッションの引き継ぎが進行中／hasCapacity が false。
### 4-2 新しい名前（server/relay.ts の nextRelayName、純関数）
- 今の表示名（snapshot の name）の末尾の半角数字を 1 増やす。桁数は元の桁数を下回らないよう 0 で埋める。例: "Agent Console2"→"Agent Console3"、"v9"→"v10"、"x009"→"x010"。
- 末尾に半角数字が無ければ "2" を付ける。例: "設計"→"設計2"。全角数字は数字として扱わない。
- 40 字（UTF-16 の長さ、launch.ts:8）を超えるときは、数字より前の部分をコードポイント単位で後ろから縮める。
### 4-3 引き継ぎ書の置き場所
- config に `relayDir`（既定 `~/CC報告ファイル-keep/relay`、`~` は home に展開）を足す。試験は一時フォルダを渡す。
- 1回ごとのフォルダ `<relayDir>/<YYYYMMDD-HHmmss JST>-<古いセッション id の先頭 8 字>/`（700）を server が先に作る。中の `HANDOFF.md` を Claude に書かせる。
### 4-4 流れ（server/relay.ts の RelayManager、進行は server 側。画面を閉じても続く）
1. phase "handoff": 古いセッションに submitText で次の決まった文を送る（`<パス>` は 4-3 の絶対パス）。
   「このセッションの作業を次のセッションに引き継ぎます。<パス> に Markdown で引き継ぎ書を書いてください。書く項目: 目的と PO の言葉の原文／決まったこと／今の状態（作業場所・ブランチ・PR・動いている担当）／終わっていない作業と次の一手（順番つき）／注意点と守るルール／読むべきファイルのパス。書き終えたら、そのパスだけを返答してください。新しい作業は始めないでください。」
2. 3 秒ごとに見る。完了の条件は「HANDOFF.md が有り大きさが 0 より大きい」かつ「送った後に一度 ok でない状態を見た」かつ「今 ok」。許可待ち（waiting）は PO が古いセッションで許可すれば続く。30 分（config `relayHandoffTimeoutMs`）を超えたら failed "handoff_timeout"。古いセッションが終了したら failed "gone"。
3. phase "launching": hasCapacity を見直す（false なら failed "full"）。sessions.restore({ role: 古い役割, name: 新しい名前, cwd: 古い cwd, branch: 古い branch, manualInitialName: true })。worktree は新しく作らない（sessions.ts:320-327）。claudeSessionId は渡さない（新しい会話）。
4. waitReady（launch.ts:70-79 を export して使う。120 秒）。だめなら failed "not_ready"（開いたセッションは残す）。
5. phase "sending": sendName → waitName → waitReady → submitText で次の文を送る。
   「前のセッション「<古い名前>」からの引き継ぎです。<パス> を読み、書かれた次の一手から続きに着手してください。」
6. phase "done"、newSessionId を記録する。古いセッションは閉じない。
- 進行の記録はメモリだけ（server を再起動すると消える）。終わった記録は 10 分後に消す。
### 4-5 画面
- SessionView ではなく ConsoleState に `relays: RelayView[]`（relayId・oldSessionId・newName・phase・newSessionId?・reason?）を足し、snapshot で送る。
- 一覧の行（SessionList.tsx の閉じるボタンの左）に、`s.state === "idle" && s.hasClaude` のときだけ、引き継ぎのボタン（Button variant="ghost" size="sm" iconOnly、lucide の ArrowRightLeft、aria-label・title は t("ac.relay.open")、data-testid="relay-session"）。進行中の行には出さず、代わりに Badge（variant="info"、t("ac.relay.running")、data-testid="relay-badge"）。
- 押すと ConfirmModal（ConsolePage.tsx の閉じる確認と同じ部品）: 題 t("ac.relay.title")、本文 t("ac.relay.body", { name })「「{{name}}」に引き継ぎ書を書かせてから、名前の数字を1つ増やした新しいセッションを開いて続きを渡します。今のセッションは閉じずに残ります。」、確定 t("ac.relay.confirm")。
- done を受けたとき、選択中が古いセッションなら新しいセッションを選ぶ（同じ relayId で 1 回だけ）。
- failed は Callout variant="warning"（t("ac.relay.failed.<reason>", { name })）を一覧の上に出し、閉じるボタンで消せる（restoreNotices と同じ扱い）。
- 新しい色・余白の直値は書かない。既存の @sa 部品と CSS 変数だけを使う。
### 受入
- K5: ボタンは待機中かつ Claude ありの行だけに出る（単体の画面試験で working・waiting・no-claude・stopped では出ない）。
- K6: nextRelayName の単体試験（4-2 の例すべて、40 字の縮め、絵文字を途中で切らない）。
- K7: RelayManager の単体試験（偽の hub・sessions）で、4-4 の順に書かれ、HANDOFF.md 作成前は launching に進まず、新しいセッションは古い cwd・branch・役割・新しい名前・manualInitialName=true で開かれ、最後の文にパスが入る。
- K8: 失敗の単体試験: 待機中でない／空きなし → 409 でフォルダを作らない。30 分で handoff_timeout（新しいセッションを開かない）。古いセッションの終了で gone。
- K9: ポートを指定して起動したサーバー（e2e）は config の relayDir（一時フォルダ）にだけ書く。
- K10: typecheck・lint・単体・e2e が通る。ja.json と en.json のキーが同じ。
- K11: PO の目視。実際のセッションでボタンを押し、①古いセッションが引き継ぎ書を書く ②名前の数字が1つ増えた新しいセッションが開く ③新しいセッションが引き継ぎ書を読んで続きに着手する ④画面が新しいセッションに切り替わる ⑤古いセッションが残る、の5点が○。

## 5 代替案と選んだ理由
- 名前: 役割の command に `-n` を足す案は、シェル関数（ccopusgo など）の変更が要り、アプリの外の設定を触るので採らない。`/rename` は既存の改名（hub.ts:211-220）と同じ経路。
- 引き継ぎ書: 新しいセッションに古い会話を丸ごと渡す（--resume・/compact）案は、会話の量を減らすという目的に合わないので採らない。
- 完了の判定: 時間だけで待つ案は、書き終わる前に次へ進む恐れがあるので、ファイルの存在と状態の戻りの両方を見る。
- 進行を画面側で行う案は、画面を閉じると止まるので server 側にする。

## 6 リスクと対処
- 書き込みの許可待ち: relayDir が作業フォルダの外なので、Claude が許可を求める場合がある【未確認、工程0で確かめる】。許可待ちは失敗にせず 30 分まで待つ。
- 引き継ぎ書の質: Claude の書く中身はこの機能では保証しない。項目は 4-4 の決まった文で指定する。
- tmux の中での `/rename` の挙動【未確認、工程0】。
- 同時に複数押す: 同じセッションは 409。別々のセッションは、それぞれ空き（hasCapacity）を見る。

## 7 戻し方
- 版を戻す（前の版のタグで update-when-idle）。データの形は変えない（relays はメモリだけ、relayDir のファイルは残っても害が無い）。

## 8 維持する仕組み
- 単体試験 K2〜K4・K6〜K8 と e2e K9 を CI で毎回回す。

## 9 版
- マージ時点の次の空きのマイナー版。

## 10 工程
- 工程0（実機・Sonnet、コードは変えない）: アプリから tmux の中で開いたセッションで、(a) 入力待ちの直後に `/rename 名前` を送ると名前が変わり指示の後も保たれるか、(b) `~/CC報告ファイル-keep/relay/試験/HANDOFF.md` に書いてと頼むと許可を求めるか、を確かめ /tmp/CC報告ファイル/session-relay/stage0/ に生出力を残す。127.0.0.1:4319 の本番には操作しない（試験用ポートのサーバーを使う）。
- 工程1（server）: §3 と §4-1〜4-4、単体試験。
- 工程2（画面）: §4-5、i18n、画面試験、e2e。
- 工程3: 版上げ・CHANGELOG・README、PR。
