# 端末の「よく使う指示」が Claude の作業中に押せない（quick-busy-paste）現在地の調査

- 基準: origin/main 658de91（v0.23.0）。作業場所 ~/agent-console-wt/quick-busy-paste（release/quick-busy-paste）。
- 調査: Sonnet（/tmp/CC報告ファイル/quick-disabled/excerpts.txt）と Opus（/tmp/CC報告ファイル/quick-disabled/design-src.txt）。下の行は Opus が読み直して照合した。

## PO の言葉（原文）
「よく使う指示が押せない場面が多々あるのだが原因を調べて解消してほしい」
「opusが考えているときや作業しているときも追加でメッセージを送りたい場合があり、手入力で送信ができるがよく使う指示は選択できないことが多い」

## R1 押せない原因
- src/pages/ConsolePage.tsx:410-416 端末タブのバーは `canSend={activeSession?.canInput === true}`。チャットタブのバーは onPick を渡すので常に押せる（src/components/QuickPrompts/QuickPromptBar.tsx:39 `usable = onPick !== undefined || canSend`）。
- canInput は server/hub.ts:561 `inputVerdict(info, this.agents).ok`。inputVerdict（server/agents.ts:80-88）は Claude が idle で待ちが無いときだけ ok。よって Claude が考えている・作業している（busy）間はボタンが灰色で押せない。これが PO の言う「選択できない」場面。
- 押せても、サーバーの send-check（server/http.ts:291-295）が `hub.checkInput`（同じ inputVerdict）で判定し、busy なら 409。

## R2 手入力のチャットが作業中でも送れる理由
- server/agents.ts:95-103 chatVerdict: idle と busy で ok。確認待ち（waitingFor あり）・status が idle/busy 以外・状態不明・停止は不可。
- server/hub.ts:562 `canChat: chatVerdict(...).ok`、server/hub.ts:434-439 checkChat（private）、server/hub.ts:366 チャットの払い出しが checkChat を使う。作業中の Claude へ貼り付けて Enter を送る運用は、この経路で既に動いている。

## R3 よく使う指示は貼るだけ
- src/pages/ConsolePage.tsx:192-203 handleSendPrompt: send-check で本文を受け取り、`terminalRef.current?.pasteOnly(...)` で入力欄に入れるだけ（Enter は送らない、v0.17.0 docs/handoff/quick-paste/design.md）。
- 押せなかった理由は画面に出ない（QuickPromptBar.tsx:58 の title は指示の本文）。409 のときだけ Callout「送信できませんでした」＋理由の英語（ConsolePage.tsx:201）。

## R4 緩めなかった過去の理由
- docs/handoff/quick-paste/design.md §5 R1: 「確認の画面（waiting）に文字が入る事故の防止」。busy を不可にした理由は書かれていない（waiting と同じ判定関数を流用していただけ）。

## R5 checkInput の他の呼び出し元（今回は触らない）
- server/hub.ts:202,235（名前変更）、server/chat-routes.ts:62（チャットの即時送信の send-check）、server/diff-routes.ts:60（部品）、server/launch.ts:74（定期実行・予約）、server/picks-routes.ts:77（選んだ物）。

## R6 直す必要のある試験
- tests/unit/daily-use.integration.test.ts:346-356「answers 409 for busy and waiting」（busy は 409 を期待）。
- tests/e2e/console.spec.ts:638-648（busy でボタン無効・409 を期待）。
- src/pages/ConsolePage.test.tsx:373-379（canInput: false で無効を期待）。:314 の `live` は canChat を持たない（基底 :9 は false）。
- src/components/QuickPrompts/QuickPromptBar.test.tsx:62-65,130-（canSend: false で無効。部品の判定は変えないので、そのまま通る見込み）。

## 既存の設計・決まり
- このリポジトリに ADR は無い。設計の正本は docs/handoff/<仕事>/design.md。関係: quick-paste（貼るだけ v0.17.0）、chat の busy 送信（chatVerdict 導入時）。
- UI 文字は i18n（src/locales/ja.json の ac.quick.*。en.json は無い、src/i18n.ts）。部品は @sa の Button・Callout。
