# 設計: 端末の「よく使う指示」は貼るだけ（Enter を送らない）v0.16.0

- 現在地: [recon.md](recon.md)（基準 origin/main f897ff6）
- 状態: 設計案（設計者 Opus）。PO の y（2026-10-13）は方向の合意。

## 1. 目的と、見える変化
- 変更前: 端末の上のバー・一覧の「使う」を押すと、選んだ文章が Claude の入力欄に入り、そのまま送られる。
- 変更後: 押すと文章が Claude の入力欄に入るだけで、送られない。しんごさんが手を直してから端末で Enter を押すと送られる。押したあとは端末にカーソルが移るので、そのまま打てる。

## 2. 対象と対象外
- 対象: `TerminalHandle.pasteAndEnter` を `pasteOnly` に置き換える（`\r` を送らない）。呼び出し元 `ConsolePage.tsx:191`、試験、e2e、ja.json の `ac.quick.textHint`、README、QuickPromptBar のコメント（:26）、版 0.16.0（package.json・package-lock.json・extension/manifest.json・docs/CHANGELOG.md）。
- 対象（コメント・試験名）: 「Enter を送る」前提を消す。`server/http.ts:276` のコメント→「画面が xterm の paste() で入れるだけ。Enter は人が端末で押す」、`src/components/QuickPrompts/QuickPromptBar.tsx:15`→「その指示を選択中の端末の入力欄に入れる（id を渡す）」、`:26` も同じ趣旨、`tests/e2e/console.spec.ts:619` の試験名→「ボタン 1 回で選択中の端末の入力欄に入り（Enter は送らない）」、`src/components/TerminalPane/TerminalPane.test.tsx:84` の試験名→「pasteOnly pastes through xterm paste(), moves focus to the terminal, and never sends Enter」。
- 対象外（触らない）: `pasteSubmitAfter`（変更・部品・チャット）、ChatPane の `onPick`、サーバーの send-check（`server/http.ts:276`。409 の判定もそのまま）、`canSend` による押せる・押せないの判定、ほかの文言（`ac.quick.text`「送る文章」・`ac.quick.switched` は意味が変わらないので残す）。

## 3. 変更前後
`src/components/TerminalPane/TerminalPane.tsx`
- 変更前（:69-75）: `current.term.paste(text); current.term.input("\r", true); return true;`
- 変更後: 
```ts
pasteOnly(expectedSessionId: string, text: string): boolean {
  const current = termRef.current;
  if (!current || current.sessionId !== expectedSessionId) return false;
  current.term.paste(text);
  current.term.focus();
  return true;
},
```
- 型（:18-25）の名前とコメントも `pasteOnly`・「Enter は送らない。入れたあと端末に入力の焦点を移す」に改める。
- `term.focus()` の理由: 焦点がボタンに残ると、しんごさんが続けて Enter を押したときボタンがもう一度押され、同じ文章が 2 回貼られる。焦点を端末に移せば、その Enter は Claude への送信になる。

`src/pages/ConsolePage.tsx:186-191`
- `pasteAndEnter` → `pasteOnly`。コメント「paste() で入れてから Enter を送る」→「paste() で入れるだけで Enter は送らない（送るのは人が端末で Enter を押したとき）」。

`src/locales/ja.json:139`
- 「ボタンを押すと、選択中の端末の入力欄にこの文章を入れます。送るのは端末で Enter を押したときです（8KB まで）。」

`README.md:139`・`:67`
- 「「使う」で選択中の端末の入力欄に入れ」「ボタンを押すと、選択中の端末の入力欄に文章を入れます（Enter は送りません。送るのは端末で Enter を押したとき。8KB まで）」。:67 は「「よく使う指示」は手すきのときに端末の入力欄へ貼るだけ、「変更」「部品」はその場で貼って送る」に改める。

## 4. 代替案
- A（採用）: 貼るだけ＋焦点を端末へ。変更が 1 か所の口に閉じ、サーバー・ほかのタブに影響しない。
- B: 端末タブにもチャットと同じ入力欄を置き、そこへ入れる。部品の新設が要り、端末の入力欄（Claude の本物）と二重になる。不採用。
- C: 設定で「押したら送る／貼るだけ」を切り替える。PO の依頼は「自動送信されない」1 通りで、切り替えは不要（YAGNI）。不採用。

## 5. リスクと対処
- R1 押せる条件: 貼るだけになっても、作業中・確認の待ちには押せないまま（canSend とサーバーの 409）。確認の画面に文字を入れる事故を防ぐため、緩めない。
- R2 2 回貼り: 焦点を端末へ移すことで、続けての Enter がボタンを押し直さない（§3）。単体試験で `focus` が呼ばれることを、e2e で端末の入力欄（`.xterm-helper-textarea`）に焦点があることを確かめる。一覧の「使う」は、SA の Modal が閉じるときに焦点を一覧ボタンへ戻す（`Modal.tsx:49-57`）が、`term.focus()` は send-check の応答の後に走るので最後は端末になる。【推測】一覧の経路も同じ結果になるが、e2e で確かめるのはバーのボタンの経路だけ（未実測）。
- R3 切り替え: 確認中に別のセッションへ切り替わったときは今までどおり何も入れず `ac.quick.switched`。
- R4 古い名前の残り: `pasteAndEnter` を全部消す（`grep -rn pasteAndEnter src tests` が 0 件）。

## 6. 受入条件
- 単体試験の前提: `TerminalPane.test.tsx:14-28` の偽 `Terminal` に `focus = vi.fn(() => calls.push("focus"))` を足す（無いと `pasteOnly` が TypeError で落ちる）。`pasteSubmitAfter` の既存試験は `focus` を呼ばないので、`calls` の期待値は変えない。

|基準|検証方法|
|---|---|
|K1 押すと端末に文章が入り、`\r` は送られない|TerminalPane.test.tsx: `pasteOnly` の後の `calls` が `["paste:<本文>", "focus"]` と等しい（`input:` が無い）|
|K2 押したあと端末に焦点が移る|K1 の `calls` に `focus` が 1 回だけある|
|K3 切り替わった端末には入れない|TerminalPane.test.tsx: 別の sessionId では false・`calls` が空（`paste` も `focus` も無い）|
|K4 画面の配線|ConsolePage.test.tsx: バーを押すと `pasteOnly` が本文で呼ばれる。作業中・切り替え時は呼ばれない（既存 :28・:96-98・:137・:320・:337・:349・:423 を名前替え）|
|K5 本物の端末で送られない|e2e console.spec.ts（既存 :652-653 を置き換え）。偽シェル `tests/fixtures/role.mjs` は入力を素通しで書き戻す作り。①idle でバーを押す → `expect.poll(() => page.getByTestId("terminal").innerText().then((s) => (s.match(/echo-quick-prompt-v2/g) ?? []).length)).toBe(1)`、1 秒待っても 1 のまま（貼るだけなら端末の反響で 1 回だけ出る）②`await expect(page.locator(".xterm-helper-textarea")).toBeFocused()` ③`page.keyboard.press("Enter")` → 同じ数え方で 2（Enter で行が渡り、素通しで別の行に書き戻される）。根拠: 審査役が node-pty で role.mjs を直接起動した実測（貼る→1 回、Enter→2 回）|
|K5b 複数行も括弧付きで入り、Enter は届かない|e2e `console.spec.ts:703`（「段階2 K3: 複数行の指示は…」）の期待を変える。試験名の末尾「その直後に Enter が届く」→「Enter は届かない」。`toContainText('first-line\\rsecond-line\\u001b[201~"')`（閉じ括弧の直後で届いたバイト列が終わる）を確かめ、1 秒待ってから `not.toContainText('\\u001b[201~\\r')` を確かめる（待つのは、遅れて届く \r を見逃さないため）|
|K6 古い名前・古い説明が残らない|`grep -rn pasteAndEnter src tests server` が 0 件。`server/http.ts` の send-check のコメントと `ConsolePage.tsx` の `handleSendPrompt` の中に「Enter を送る」が無い（変更タブの `pasteToTerminal` の説明「…貼って Enter を送る」は対象外の `pasteSubmitAfter` の説明なので残す。`src/api.ts:132`・`server/chat-routes.ts:36` も対象外の経路の説明なので残す）|
|K7 文言|ja.json `ac.quick.textHint`・README :67・:139 が §3 のとおり|
|K8 CI|macOS・Ubuntu の両方で CI 成功|

## 審査の記録
- 1 回目（Fable、2026-10-13）: REVISE。①K5 の判定が偽シェルの作りに合わない ②偽 Terminal に focus が無い ③コメント・試験名の 4 か所の漏れ ④recon のパスの誤り ⑤Modal の経路の焦点の注記（任意）。①〜⑤を本文に反映した。
- 実装中の訂正（設計者、2026-10-13）: K6 の grep が対象外の `pasteToTerminal` のコメント（ConsolePage.tsx:197）まで拾うため、K6 の範囲を quick prompt の経路に絞った。
- 実装中の訂正2（設計者、2026-10-13）: recon で見落とした e2e `console.spec.ts:703` が「閉じ括弧の直後に Enter が届く」を確かめていたので、K5b として期待を「Enter は届かない」に変える。

## 7. 外部事例
- 不要。理由: 自前の画面の 1 つの口から `\r` を外すだけで、外の製品の挙動に依存しない。xterm.js の `paste()`・`focus()` は既存コードで使っている公開の API（`paste` は TerminalPane.tsx の既存、`focus` は @xterm/xterm の Terminal の公開メソッド。実装担当が node_modules/@xterm/xterm の d.ts で `focus(): void` を確かめる）。

## 8. 維持の仕組み
- 単体試験（K1〜K4）と e2e（K5）が CI の両 OS で毎回走る。
- 正本: この design.md と CHANGELOG 0.16.0 の 1 行。
