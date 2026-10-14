# 設計: 端末の「よく使う指示」を Claude の作業中でも押せるようにする（quick-busy-paste）

- 現在地: [recon.md](recon.md)（基準 origin/main 658de91）
- 状態: 設計案 第2版（設計者 Opus）。第1版は Fable 審査 REVISE（/tmp/CC報告ファイル/quick-disabled/review-design1/review.md、高1・中3・低6）を全件反映。実装は PO の y の後。

## 0. KGI（○×で判定）
1. Claude が考えている・作業している（一覧の点が working）間も、端末タブのよく使う指示のボタンが押せ、押すと端末の入力欄に本文が入る（Enter は送られない）。
2. Claude が許可・質問を待っている（waiting）・セッションが止まっている・状態が分からないときは押せず、バーに押せない理由が日本語で1行出る。
3. 押した直後に waiting に変わった場合はサーバーが 409 を返し、端末には何も入らない（今と同じ）。

## 1. 見える変化
- 変更前: Claude が作業中だとバーのボタンが灰色で押せない。理由も出ない。
- 変更後: 作業中でも押せる。入力欄に入った文章は、Claude の作業が終わってから人が Enter を押すか、作業中に Enter を押して Claude Code の順番待ちに入れられる（手入力と同じ）。許可待ちなどで押せないときは、バーに理由が出る。

## 2. 対象と対象外
- 対象:
  - server/hub.ts:434 `checkChat` を private から公開に変える（中身は変えない）。
  - server/http.ts:292 send-check の判定を `hub.checkInput(id)` → `hub.checkChat(id)` に変える。:291 のコメントに「作業中（busy）でも可。確認待ち・状態不明・停止は不可（chatVerdict）」を足す。
  - src/pages/ConsolePage.tsx:412 `canSend={activeSession?.canInput === true}` → `canSend={activeSession?.canChat === true}`。押せない理由を `blockedHint` として渡す（§3）。
  - src/components/QuickPrompts/QuickPromptBar.tsx: 任意の prop `blockedHint?: string` を足す。`!usable && blockedHint !== undefined && pinned.length > 0` のとき、:57-61 のボタン列の後ろ（同じ `ac-quick__buttons` の中）に `<span className="ac-quick__empty">{blockedHint}</span>` を出す（既存のクラス QuickPrompts.css:31 を使い、新しい色・寸法を作らない。登録なし・常に表示なしの案内 :55-56 と2つ並ばないよう、pinned が1件以上のときだけ）。:13-14 の canSend のコメントを「作業中も可。確認待ち・停止中・状態不明は false」に直す。
  - src/pages/ConsolePage.tsx:419-423 の警告「送信できませんでした」が残り続ける不具合（PO 報告 2026-10-14「上部に送信できませんでした claude is busy と常時表示が出ている」）。【事実】quickError を消すのは次に押したとき（:195）だけで、押せない間は消えない。直し方: 選択中のセッションが変わったとき、またはそのセッションの canChat が false→true に変わったときに `setQuickError(null)` する（useEffect、依存は selectedId と activeSession?.canChat）。
  - src/locales/ja.json の ac.quick に 3 キー（§3）。en.json は無い（src/i18n.ts は ja.json だけを読む）。
  - 試験: recon R6 の 3 か所、src/pages/ConsolePage.test.tsx:314 の `live` に `canChat: true` を足す（基底 :9 は canChat:false のため、足さないと :330・:345・:364 の3件が落ちる）、QuickPromptBar.test.tsx に blockedHint の表示・非表示の 2 件、警告が消える試験 1〜2 件（§3）。
  - 版（package.json・package-lock.json 2 か所・extension/manifest.json）、docs/CHANGELOG.md 1 行、README のよく使う指示の説明。版の番号はマージ時点の次の空き番号。
- 対象外（触らない）: inputVerdict・chatVerdict の中身、checkInput の他の呼び出し元（recon R5）、canInput の算出、チャットタブのバー（onPick）、pasteOnly、ボタンの見た目。

## 3. 変更前後
server/http.ts
```ts
// 変更前 :292
const verdict = await hub.checkInput(id);
// 変更後
const verdict = await hub.checkChat(id);
```
src/pages/ConsolePage.tsx（:410-416 付近）
```tsx
<QuickPromptBar
  prompts={quickPrompts}
  canSend={activeSession?.canChat === true}
  {...(activeSession !== undefined && activeSession.canChat !== true ? { blockedHint: t(quickBlockedKey(activeSession.state)) } : {})}
  onSend={handleSendPrompt}
  ...
/>
```
`quickBlockedKey`（ConsolePage.tsx の中の小さな関数）:
- state が "stopped" → "ac.quick.blockedStopped"
- state が "unknown" → "ac.quick.blockedUnknown"
- それ以外（waiting、または idle・working のまま確認待ちを持つ場合 server/agents.ts:101） → "ac.quick.blockedWaiting"

セッションが選ばれていない（activeSession が undefined）ときは理由を出さない（今と同じ灰色）。

文言（ja.json）:
- "blockedWaiting": "Claude が許可・質問への返事を待っているので押せません。端末で答えると押せます"
- "blockedStopped": "セッションが止まっているので押せません"
- "blockedUnknown": "Claude の状態を確かめられないので押せません。少し待つと押せることがあります"


試験の変更:
- daily-use.integration.test.ts:346-356 → 名前「answers 200 for busy and 409 for waiting Claude sessions」。busy は 200、waiting は 409、idle は 200。
- console.spec.ts:638-648 → busy のときボタンが有効で send-check が 200（busy の間はボタンを押さない。:654-659 の「反響が1回」の前提を崩さないため）、waiting のときボタンが無効・バーに「許可・質問への返事を待っている」が出て send-check が 409・端末に本文が入らない。idle に戻してからの押下と Enter の確認（:649 以降）はそのまま。
- ConsolePage.test.tsx:373-379 → `canChat: false, state: "waiting"` で無効と理由の表示。`canInput: false, canChat: true` で押せる、の 1 件を足す。
- ConsolePage.test.tsx:364 の試験（409 で alert が出る）の末尾に、別のセッションを選ぶと alert が消える確認を足す。canChat の false→true で消える件は、既存試験で fetchState の再取得を起こせる手段を実装者が確かめて足す（起こせないなら理由を報告して見送る）。

## 4. 代替案と選んだ理由
- A（採用）: 判定を chatVerdict に揃える。手入力のチャットが作業中に送れる実績（hub.ts:366）と同じ判定で、waiting の事故防止（過去の R1）は保たれる。
- B: inputVerdict 自体を緩める。名前変更・定期実行・部品など他の 5 経路（recon R5）まで変わるので不採用。
- C: 押せないまま理由だけ出す。PO の「作業中も追加で送りたい」に応えないので不採用。
- 過去の設計 docs/handoff/quick-paste/design.md:46 R1 の「作業中・確認の待ちには押せないまま」のうち、作業中の部分を本設計で改める。確認の待ちは押せないまま（R1 の理由＝確認画面への誤入力の防止は保つ）。

## 5. リスクと対処
- R1 作業中に貼った文字が Claude の画面の入力欄に入り、Claude が確認画面を出した瞬間に重なる: 貼るだけで Enter は送らないので、確認画面の選択は起きない。押した瞬間の状態はサーバーが取り直して判定（KGI 3）。
- R2 Claude が作業中に人が Enter を押す: Claude Code の順番待ちに入る（チャットの busy 送信と同じ動き）。今の手入力と同じで、新しい危険ではない。
- R3 状態の取り直しの間（数百 ms）に waiting へ変わる: 既存の範囲と同じ。

## 6. 受入条件と検証方法
| 基準 | 検証方法 |
|---|---|
| busy で send-check が 200、waiting で 409、idle で 200 | `npx vitest run tests/unit/daily-use.integration.test.ts` |
| 端末タブのボタンが canChat で有効になり、waiting では理由が出る | `npx vitest run src/pages/ConsolePage.test.tsx src/components/QuickPrompts/QuickPromptBar.test.tsx` |
| 実画面で busy 中に押せて入力欄に入り、waiting では押せず理由が出る | `npx playwright test tests/e2e/console.spec.ts -g "よく使う"`（該当の試験名で絞る） |
| 型・i18n キーの一致・全試験 | `npm run typecheck`・`npm test`・CI 全緑 |
| PO の目視 K14 | 導入後、Claude に長い作業をさせている間に端末タブのよく使う指示を押し、入力欄に文章が入ることを見る |

## 7. 外部事例
- 不要。既存のチャットの busy 送信（同じアプリ内の実績）を判定の根拠にしており、外部の事例で補う論点が無い。

## 8. 維持の仕組み
- 判定は chatVerdict 1 か所に寄せる（判定の重複を作らない）。試験 3 層（統合・画面・e2e）が busy=可・waiting=不可を固定する。

## 9. 戻し方
- PR を revert して前の版を入れ直す（update-when-idle で前のタグを指定）。データの形は変わらない。
