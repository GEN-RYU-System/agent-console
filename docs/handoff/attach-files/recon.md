# 画像以外のファイルを端末に添付する（attach-files）現在地の調査

- 基準: origin/main 0a8266c（v0.21.0）。作業場所 ~/agent-console-wt/attach-files（release/attach-files）。
- 調査: Sonnet（生出力 /tmp/CC報告ファイル/attach-files/r1/）。要の行は Opus が読み直して照合した（imageTransfer.ts:1-19、server/uploads.ts:1-90、server/uploads-routes.ts:1-38、TerminalPane.tsx:148-187、src/api.ts:200-213、ja.json:197-203）。

## A1 入口
- 添付の入口は端末タブだけ。貼り付け（src/components/TerminalPane/TerminalPane.tsx:166-173、登録 :185 capture）とドロップ（:179-184、:187）。dragover は常に既定動作を止める（:175-178）。
- チャット欄に添付の入口は無い（docs/handoff/chat/design.md:58 で対象外と明記）。

## A2 画像以外を止めている所（3 か所）
- 画面: src/components/TerminalPane/imageTransfer.ts:3 `ATTACHABLE_IMAGE_TYPES = ["image/png","image/jpeg"]`、:17 で画像だけ images、:18 で残りは hasOtherFiles。
- ドロップ: TerminalPane.tsx:182-183 画像だけ attach、他は notify("notImage")（文言 src/locales/ja.json:200「貼れるのは PNG と JPEG の画像だけです」）。
- 貼り付け: TerminalPane.tsx:169 画像 0 枚か text/plain に文字があれば何もせず xterm に任せる。
- server: server/uploads-routes.ts:6 `POST /api/uploads` は `{data: base64}` だけ（名前・型は受けない）。server/uploads.ts:20-24 detectImage が先頭バイトで PNG/JPEG だけ、:52 で他は 400「image must be PNG or JPEG」。

## A3 保存と Claude への渡し方
- 保存先 dataDir/uploads/<UUID>.png|jpg（server/uploads.ts:56）。名前は server が作る。dir 700・file 600（:9-10,54-59）、一時ファイル→rename。
- 返った絶対パスを `term.paste(\` ${path} \`)`（TerminalPane.tsx:157）。Enter は押さない。1 つずつ順に（:162-165）。
- 消す: 保存のたびに prune。mtime の新しい順に uploadMaxKeep（既定 100、server/config.ts:51）を超えた分を消す。対象は UUID 名の png/jpg だけ（server/uploads.ts:12,67-88）。
- 上限 DEFAULT_UPLOAD_MAX_BYTES = 5 MiB（server/config.ts:50）。本文の上限は base64 の 4/3 倍 + 1024（uploads-routes.ts:12-14）。超えたら 413（:31-34）。画面も事前に大きさを見る（TerminalPane.tsx:151-152、state.uploadMaxBytes）。
- 通知の型 `UploadNotice = "tooLarge" | "notImage" | "failed" | "switched"`（TerminalPane.tsx:39）、表示は ConsolePage.tsx:102,160。

## A4 試験・設計
- src/components/TerminalPane/imageTransfer.test.ts:17-25（gif・pdf・空 type・text/plain は images に入らない）
- src/components/TerminalPane/TerminalPane.ux.test.tsx:166-176（pdf のドロップ → notImage）
- tests/unit/uploads.test.ts:18-24,43-46（非画像は拒否）、tests/unit/uploads.integration.test.ts
- tests/e2e/console.spec.ts:1278-1344（pdf のドロップ）
- 設計: docs/handoff/v0.7.0-terminal-ux/design.md（K4-K6、§3-4）、recon.md:91-95。

## A5 未確認
- Finder でファイルをコピーして端末に貼り付けたとき、Chrome の clipboardData.files に入るか（OS・Chrome 依存）。
- ブラウザがフォルダのドロップを File としてどう渡すか（type 空・読むと失敗、が通例とされるが実機未確認）。

## 既存の設計・決まり
- このリポジトリに ADR は無い。設計の正本は docs/handoff/<仕事>/design.md。関係: v0.7.0-terminal-ux（画像の添付）。
