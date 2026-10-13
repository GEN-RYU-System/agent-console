# 設計: チャットは作業中でもすぐ送る（確認待ち・状態不明だけ予約）

- 現在地: 基準 origin/main df660d0（0.17.0）。調査の生出力は /tmp/CC報告ファイル/agent-console-busy-send/（agents.ts.txt, hub.ts.txt, grep2.txt, tests.txt, chat2-design.txt, chat2-recon.txt, pr32.diff）。要点は [recon.md](recon.md)。
- 状態: 設計審査済み（Fable 2回目 APPROVE、2026-10-14）。PO 決定（2026-10-13）: ①作業中に送れるようにする「y」②確認待ちの間もすぐ送るか「n」＝確認待ち・状態不明だけ予約。
- 版: 0.19.0（#32 が 0.18.0 を使用中）。#32 が hub.ts:379 直後に追記し本件は :342-380 を書き換えるため、#32 がマージ済みならその main に rebase してから実装する。未マージなら 0.19.0 のまま本件を先に進め、後から来た側が rebase する。版の4点セットの実体（CHANGELOG の場所を含む）は実装者が README の版節と `git ls-files | grep -i changelog` で確かめて列挙する（審査で docs/CHANGELOG.md の有無の報告が食い違ったため）。

## 1. 目的と見える変化
- 変更前: Claude が作業中（busy）だと、チャットの文は「予約中」になり、作業（ターン）が終わるまで届かない（chat2 K2）。
- 変更後: busy のときは次の状態取得（3秒ごと）と取り直し1回（1〜11秒、recon D）の後に端末へ貼って Enter し、Claude Code 本体の順番待ちに入る。作業の区切りで Claude に届く（端末で打つのと同じ）。確認待ち（waiting・waitingFor あり）と状態不明（unknown）のときだけ今までどおり予約する。

## 2. 対象と対象外
- 対象: server/agents.ts（チャット専用の判定 `chatVerdict` を新設）、server/hub.ts flushChatQueueOnce（:342-380）と chatSentGuard（:90, :314-318, :355, :368）、snapshot に `canChat` を追加（:532 付近）、src/components/ChatPane/chatLogic.ts（:31-42）・ChatPane.tsx（:103）、src/locales/ja.json（:406, :407, :413）、README v0.13.0 節（:56-62）、版4点セット＋CHANGELOG、試験。
- 対象外: `inputVerdict` / `checkInput` の既存の判定（名前変更・変更・部品・よく使う指示・定期実行 routines.ts:75・#32 が依存）。不具合B（再開時のピッカー表示中にチャットが「状態不明」になる件）は別件。

## 3. 変更前後
- agents.ts: `chatVerdict(info, rows)` = inputVerdict と同じだが、status が "busy" かつ waitingFor 無しも ok（`mode: "busy"` を返す）。idle は `mode: "idle"`。
- hub.ts :358-360: inputVerdict/checkInput → chatVerdict（ポーリング値と取り直し値の両方）。
- chatSentGuard: `{sentSeq, sentWhile: "idle"|"busy"}`。sentWhile=idle は従来どおり。sentWhile=busy は :355 の busy 観測では解除しない。解除は ①sentSeq 以降の user 記録（:314-318）②idle を観測 ③取り消し・dropChatState。→ busy 中も1件ずつ順に届く。
  - 根拠（実測 M1・M2、recon §順番待ちの実測）: 順番待ちの文でも UserPromptSubmit hook は Enter の約0.04〜0.07秒後に1件ずつ発火し、prompt は送った文そのもの。よって ① で次の1件へ進み、sent 項目も :302-306 で消える。transcript では role:user 行ではなく queued_command として残るが、hub の user 記録は hook 由来（server/activity.ts:314, :386）なので影響しない。
  - sentSeq が null（hub.ts:365: chatSource なし、または claudeSessionId 未確定）のときは ① が使えず、idle 観測まで次を送らない（現行と同じ扱い）。
- Enter 直前の再確認は入れない（審査1回目 指摘2: 2秒待ちの間 poll 値は更新されず（server/poll.ts:2-13、hub.ts:156 で await）効果がない。queued に戻すと下書きが残っていた場合に二重貼りになる）。busy→waiting 競合は R1 として PO 承知のリスクで受ける。
- 送信可否の確認（send-check、chat-routes.ts:62）は触らない（ChatPane の送信は queueChat、ChatPane.tsx:119）。
- 画面: `src/types.ts:14` の SessionView に `canChat: boolean` を追加し、hub.ts:532 付近の snapshot で chatVerdict(...).ok を入れる。`src/pages/ConsolePage.tsx:416` で ChatPane に渡す値を canInput → canChat に差し替える（DiffPane :431・PicksPane :445・RenameForm は canInput のまま）。chatLogic の queueNoticeKey は canChat を受け取る。busy で canChat=true なら案内を出さない。ja.json :406 を「確認待ち・状態不明の間に送った文章は予約され、確認が終わってから届きます。…」、:407 を「予約中（確認が終わったら送ります）」に改める。

## 4. 代替案
- A（採用）: チャット専用判定（chatVerdict）。Enter 直前の再確認は入れない（§3）。
- B: inputVerdict 自体を緩める。他の5経路と #32 の定期実行の挙動が変わる。不採用。
- C: 確認待ちも即送信（端末と完全同一）。PO が n。不採用。

## 5. リスクと対処
- R1 busy→waiting の切り替わり競合（chat2 recon C-4: 検出は1〜4秒遅れ得る）。再確認は入れない。危ない窓は poll 周期（3秒）＋checkInput の所要（1〜11秒、recon D）。PO は「ごくまれに確認へ Yes が押される恐れ」を承知で y（2026-10-13）。
- R2 連続送信: sentWhile=busy の guard で1件ずつ。
- R3 他経路への波及: inputVerdict を変えないことで回避。`git diff` で agents.ts の inputVerdict 本体が不変であることを確認。

## 6. 受入条件
|基準|検証方法|
|---|---|
|K1 busy・待ちなしで予約の文が端末に貼られ Enter が送られる|chat-queue.integration.test.ts に新規 it: rows を busy にして queue("b1") → until(written.length>=2) → `written(s.id)` が `[pasted("b1"), "\r"]`、queued が `[["b1","sent"]]`|
|K2 waiting・idle+waitingFor・unknown（not json）では書かれない|同 :99-122 の K2 を改訂: rows 配列から busy を外し、残り3種で書かれないことは現行どおり。試験名から「busy・」を消す|
|K3 busy 中に2件予約→1件目の user 記録が届くまで2件目は書かれない|新規 it（:165-179 と同型）: busy で queue("b1"),("b2") → written が b1 の2要素だけ（1秒待っても増えない）→ stub で UserPromptSubmit("b1") を書く → b2 が書かれ、b1 は queued から消える|
|K3b user 記録なしでも idle 観測で次へ進む|新規 it: busy で b1・b2 → b1 書込 → 記録なしで rows を idle → b2 が書かれる。sentSeq null（newSession(false)）でも同じ|
|K4 busy の canInput は変わらない（他経路に波及しない）|tests/unit/daily-use.integration.test.ts・routines.test.ts を無改変で成功。`git diff origin/main -- server/agents.ts` で inputVerdict（:80-88）の本体が不変|
|K5 画面: busy（canChat:true）で予約の案内が出ない／waiting・unknown では出る|ChatPane.test.tsx:310-320 の it.each から working を外し、`state:"working", canChat:true` で `chat-blocked` が無い it を追加。chatLogic.test.ts:43-47 の引数名を canChat に。ja.json :413（working 案内）は busy+waitingFor のときだけ出るので残し、`state:"working", canChat:false` の期待文を固定|
|K6 e2e: busy 中に送ると端末に届く、waiting では届かない|tests/e2e/chat.spec.ts:294-307 を `toContainText("queued-while-busy")` に改訂し、fireHook 後に予約行が消えることを確認。:315-326（waiting で届かない）は維持。e2e は hook を偽装するため実機の発火は recon 実測 M1・M2 が根拠|
|K7 文言|ja.json :406・:407 と README v0.13.0 節が §3 のとおり|
|K8 CI|macOS・Ubuntu で成功|

## 7. 外部・過去事例の参照と我々への応用
- 不要。根拠は Claude Code 公式 interactive-mode（作業中の Enter は順番待ちに入り同ターン内で渡される。/tmp/CC報告ファイル/agent-console-bugs-20261013/9-interactive-mode.md:357-372）と chat2 recon C-1 の実測。

## 審査の記録
- 1回目（Fable、2026-10-14）: REVISE。①順番待ちの文で UserPromptSubmit hook（user 記録）が発火するか未確認（chat2 recon C-1 の未確認を引き継いでいない）。guard 解除と sent 項目の消去が依存 ②Enter 直前の再確認は効果が薄く二重貼りの恐れ ③types.ts:14・ConsolePage.tsx:416 の記載漏れ ④受入条件の期待値・版・#32 との順序。②は (a) 再確認を外す を設計者が採用。③④の一部を反映。①は実測 M1〜M3（recon）で、順番待ちの文でも hook が Enter 直後に1件ずつ発火することを確認し、§3 の guard 解除の根拠と sentSeq null の扱いを追記。④は受入条件を期待値付きに書き直した。
- 2回目（Fable、2026-10-14）: APPROVE。前回案の文言3か所（状態・§4 A・R1・維持の番号）の残りを設計者が修正。副作用（detectBreaks・最近の入力・予約行）なしを確認。任意: README に「作業中に送った文は会話に出るが、Claude が読むのは作業の区切り」を一言足す → 採用（K7 に含める）。

## 維持の仕組み
- 守り手: 設計者（Opus）。統合試験 K1〜K4・画面 K5・e2e K6 が CI の両 OS で毎回走る。正本: この design.md と CHANGELOG の1行。
