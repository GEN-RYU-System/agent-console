# step0: 実装前の実測（チャット画面 v0.11.0）

- 日付: 2026-10-13。基準は origin/main 391b609（v0.10.0）。
- 本物の claude は 2.1.296（捨てディレクトリで `claude --model sonnet`）。hook は `--settings` で付け、`--setting-sources project,local` で PO の settings.json は読ませていない。捨ての記録係と作業ファイルは本リポジトリ外（スクラッチ）に置いた。
- SA の金型・トークンは sa-sync した .sa-cache（SA main a6b848ecfb4384660f13eb9fda47654b9eba9c5e、本リポジトリ外）から読んだ。

## (a) Stop の last_assistant_message は最後の本文だけか
実機: `claude --model sonnet -p`。「a.txt を読みますと書く → Read → b.txt を読みますと書く → Read → まとめを1文」を指示した。

実行の流れ（stream-json）:
```
assistant text  : a.txt を読みます。
assistant tool  : Read
assistant text  : b.txt を読みます。
assistant tool  : Read
assistant text  : まとめ: 2ファイルの中身は a.txt が「hello」、b.txt が「world」でした。
```
hook が受け取った Stop（抜粋）:
```
"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"まとめ: 2ファイルの中身は a.txt が「hello」、b.txt が「world」でした。"
```
- 【事実】道具を2回使った回でも、last_assistant_message は最後の text ブロックだけ。途中の文章（「a.txt を読みます。」「b.txt を読みます。」）は入らない。
- 設計への影響: チャットの返事の吹き出しは「その回の最後の本文」になる。途中の文章は出ない（設計 §2 の対象外の記載どおり）。

## (b) 端末を隠れた状態で開き、あとで端末タブを開いたとき
実機: v0.10.0 を build し、e2e の環境（ポート 4329、役割 e2e-size。起動時と大きさが変わるたびに `SIZE 列x行` を出す）で測った。「変更」タブへ移ってからセッションを選び、端末は hidden のままマウントした。

```
B1 hidden: terminal boundingBox = null
B3 shown: terminal boundingBox = {"x":280,"y":101,"width":812,"height":654}
B4 shown text = "READY /private/var/.../repo\nSIZE 120x30\nSIZE 97x40\n "
B5 xterm geometry = {"screenW":794,"screenH":640,"rowCount":40,"rowW":794,...}
B7 SIZE lines after resize-while-hidden = ["SIZE 120x30","SIZE 97x40","SIZE 69x34"]
```
- 【事実】隠れている間は pty の大きさは起動時の 120x30 のまま（TerminalPane.syncSize が 0 の大きさでは何も送らない）。
- 【事実】端末タブを開くと `SIZE 97x40` が届き、xterm は 40 行・幅 794px で描かれた。目視でも崩れなし。
- 【事実】隠す → ウィンドウの大きさを変える → 再表示でも `SIZE 69x34` が届いた（2回目も大きさ合わせが走る）。
- 設計 L-a の答え: 表示に戻ったときに ResizeObserver は発火する。hidden の変化を TerminalPane に渡す prop は足さない。TerminalPane は変えない。

## (c) 長い文章を貼ったときの UserPromptSubmit の prompt の形
実機: 本物の claude（対話）を node-pty で動かし、xterm の paste() と同じ括弧付き貼り付け（`ESC[200~ … ESC[201~`）で入れ、2秒待って Enter を送った。

| 貼ったもの | hook が受け取った prompt |
|---|---|
| 4行（日本語） | `"\n\n<pasted_content id=\"0995\">\n次の4行を読んで、…\n行4: たちつてと\n</pasted_content id=\"0995\">\n"` |
| 900字の1行 | 同じ包み（id は d46c）、全体 992 字 |
| 1行20字 | 包みなし。貼った文のまま |

- 【事実】3行を超える、または 800 字を超える貼り付けは、先頭に空行2つ、`<pasted_content id="…">` の行、本文、`</pasted_content id="…">` の行、末尾の改行、の形で届く。
- 表示のときに外すもの: 先頭の空行、開きの行、閉じの行、末尾の改行。記録は生のまま残す。
- 一緒に取れた Stop の last_assistant_message は `受け取りました`。

## (d) Markdown の依存
- 追加は react-markdown と remark-gfm の2つだけ。版は package.json の流儀（正確な版）。

```
react-markdown 10.1.0   公開 2025-03-07（dist-tags.latest。2週間以上前）  ライセンス MIT
remark-gfm     4.0.1    公開 2025-02-10（dist-tags.latest。2週間以上前）  ライセンス MIT
```
- 推移的な依存: `npm install --save-exact react-markdown@10.1.0 remark-gfm@4.0.1` の結果は「added 97 packages」。この 97 は、2つ自身を含む増えたパッケージの数。ライセンスは MIT が 96、ISC が 1（package-lock.json の license 欄の集計）。
- npm audit: `found 0 vulnerabilities`。
- 既存パッケージの版は変わっていない（package-lock.json で変わった既存の項目は @types/estree、@types/prop-types、@types/react、csstype、debug、dequal、ms の dev/peer の印の付け替えだけ）。
- 既定の urlTransform（react-markdown の lib/index.js defaultUrlTransform。`safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i`）:
  - 先頭の「プロトコル」が http・https・irc・ircs・mailto・xmpp のどれか、または相対（プロトコルが無い）のときだけ値をそのまま返し、それ以外（`javascript:` など）は空文字にする。
  - 空文字の href は、リンクとして使われない。この動きを単体試験で固定する。
- skipHtml は明示する。rehype-raw は使わない（react-markdown の readme: 「HTML は既定でエスケープされる。skipHtml で無視」）。
- 問題なし。素の表示への代替（設計 §6）には戻さない。
- Context7 は月の上限に達して使えなかった（`Monthly quota exceeded`）ため、公式の一次情報としてインストールした版の readme.md と lib/index.js を直接読んだ。

## 後片付け
- 一時の e2e（作業用に作った試験1本と、その設定ファイル。どちらもコミット対象外）は、名前を指定した rm と rmdir で消した。リポジトリには残っていない。
