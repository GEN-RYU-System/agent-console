# 工程0: 貼り付け経路の実測（2026-10-12）

判定: 成功（届いた）。実装に進む。

## 方法
- 捨てディレクトリ（mktemp -d）で node-pty から `claude --model sonnet`（claude v2.1.296、Sonnet 5.5）を起動（120x40）。
- 信頼の確認画面: 上矢印＋Enter で 1 回だけ答えた。
- 文章を `ESC[200~ … ESC[201~` で貼り、2000ms 待ってから `\r` を送った。最後の行は「READY7 とだけ答えてください」。
- 45 秒後に Ctrl-C を 2 回送って終了。スクリプト: /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad/step0/probe.cjs、画面記録: /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad/step0/screen3.txt, screen18.txt（スクラッチパッド内）。

## 結果（画面記録の要所）
|行数|`[Pasted text` の表示|READY7 の応答|
|---|---|---|
|3 行|出ない（短い貼り付けは claude が折りたたまず、そのまま入力欄に表示。3 行で 1 つの依頼として送信され、応答は 1 回）|`⏺READY7` 1 回|
|18 行|`Pasted text #1 +17 lines]`（1 つの依頼）|`⏺READY7` 1 回|

- 3 行の文章でタグが出ないのは claude 側の仕様（折りたたみは長い貼り付けのみ）で、依頼が 1 つにまとまって届いた点は 3 行・18 行とも同じ。
- 画面に出た行: 3 行 =`⏺READY7✢Schlepping… (running Stop hooks…`、18 行 =`⏺READY7Musing… (running Stop hooks…`。応答は各 1 回のみ。
- 副作用: 起動した claude に UserPromptSubmit フックが走っていた（環境のもの）。claude の起動は止められなかった。

## xterm の paste() が括弧付きの形で送ること
- tests/fixtures/bracketed-role.mjs は `ESC[?2004h` で括弧付き貼付モードを有効にし、受信バイト列を `ALL:` で表示する。
- tests/e2e/console.spec.ts:593 の bracketed-target 試験を現在の origin/main 054fd94 で実行（`npx playwright test -g "括弧付き貼付モード"`）:
  `✓ tests/e2e/console.spec.ts:593:1 › 段階2 K3: 複数行の指示は、括弧付き貼付モードの端末へ ESC[200~ ... ESC[201~ で包まれて入り、その直後に Enter が届く (2.2s)  1 passed`
- 試験の期待値は `first-line\rsecond-line\u001b[201~\r"`（閉じ括弧の直後に Enter）。
- 残る差: 今の e2e は待ち時間なしで Enter を送る。2000ms の待ちを入れた形の本物の claude への貼り付けは、上の実測（node-pty 直接）で確認。アプリ内セッション経由の最終確認は K11（導入後、PO の目視）。
