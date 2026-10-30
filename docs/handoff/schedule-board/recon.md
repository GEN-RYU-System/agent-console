# 予定画面（開発／秘書）— recon

状態: 調査済み（2026-10-30、Opus 統括・担当 Sonnet が読み取り）。設計は design.md（同じフォルダ）。

## PO の依頼（原文）
引き継ぎ ~/CC報告ファイル-keep/agent-console/schedule-board/handoff.md §1 より。
- 「再発防止したい、スケジュール管理が苦手で取りこぼしてしまうのだが管理できる？」
- 「管理ツールみたいに画面で一括管理できる？毎日それを見れば全てキャッチアップできるようにしたい」
- 「PCでもスマホでも確認ができて、googleカレンダーとclaudeなどと連携できるように出来る？agentconsoleのようにあなたや他のAIと話せて連携できると最高」
- 置き場所「2」＝ agent-console の中。「開発サイドと秘書サイドでスケジュール管理もできるようにしてくれ」
- 成功条件（1）〜（7）に「1」（2026-10-30 承認済み）。進め方は（1）〜（5）が先、（6）（7）が後。

きっかけ: 2026-10-30 14:00〜15:00 の面接に遅れた。前の予定が延び、その予定はカレンダーに無かった。知らせは「10分前に画面に1回」だけだった。

## 基準
- origin/main = de28ba7（v0.48.1、package.json:3）。手元 ~/agent-console は 270 コミット古いため、根拠は `git archive origin/main` を展開した写しで読んだ。
- 生の調査結果: /tmp/CC報告ファイル/schedule-board/recon-raw.md（123行）、Google 公式資料: /tmp/CC報告ファイル/schedule-board/google-official.md
- このリポジトリに ADR フォルダは無い（docs/ は CHANGELOG.md と handoff/ のみ）。README に「予定」「カレンダー」「やること一覧」の既存機能・記述は無い（README.md:30 の「予定」は予約日時の意味）。

## 今の動き（事実）
### 画面のタブ
- 中央タブは src/pages/ConsolePage.tsx:58 の `CenterTab`（chat / terminal / changes / files / pr / picks / routines / reservations の8種）。状態 :182、描画 :532-547（金型 `@sa/components/Tabs`、:9）。文言 src/locales/ja.json:244-253。
- 各ペインは常に置き `active` で出し分け（ConsolePage.tsx:607-608）。手本 src/components/Reservations/ReservationsPane.tsx（active の間だけ 10 秒ごとに取得 :34-39）。
- 入れ子のタブは右欄だけ（src/components/RightPane/RightPane.tsx:10, :32）。

### 保存・API・認証
- dataDir = ~/Library/Application Support/agent-console（server/config.ts:41）。JSON 保存の共通部品 server/json-store.ts（0600/0700、直列化 :10、原子的書き込み :30-36）。手本 server/reservations.ts（version 1、件数上限 :20-22）。
- 画面用 API の手本 server/http.ts:226-229（/api/reservations）。認証 http.ts:716-727（セッショントークンか Bearer、変更系は Origin 必須）。
- AI 用の口の手本 http.ts:459 handleAgentReservations（認証より前の分岐 :703、合言葉 dataDir/reserve-token、hooks/ac-reserve.mjs は 127.0.0.1 だけへ fetch・入力 64KiB 上限 :11）。

### AI がデータを書く既存の経路
- 作戦ボード（hooks/ac-board.mjs、dataDir/boards/<会話番号>.json、README.md:142-190）。会話ごとのデータで、会話をまたぐ予定には使えない（server/boards.ts:9-10）。サーバーは読むだけ（server/board-routes.ts:11-13）。
- 予約（ac-reserve）は「変更の効果を実地で測る予約だけ」（README.md:21、PO 決定 2026-10-14）。予定・知らせには使えない。
- 定期実行（ac-routine）は opus-designer 役だけ・AI 作成の有効は10件まで（README.md:48）。

### チャット
- 本物の claude CLI を PTY/tmux で動かし、文章を貼って送る（README.md:112-141、server/chat-routes.ts、1回 32KiB :10）。送信待ちはメモリのみ・1セッション10件（README.md:134-135）。
- 新しいセッションを開いて送る部品 server/launch.ts の launchAndSend（予約・定期実行が使用）。

### 外への通信・秘密・通知
- サーバーの外向き HTTP は Discord（server/discord-api.ts:33）だけ。CSP（http.ts:676）の connect-src は 'self' と ws://127.0.0.1 のみ。Google 関連の実装は無い。
- 秘密は macOS Keychain（service "agent-console"、server/keychain.ts:6-39）。
- macOS 通知 server/notify.ts:21-37。Discord 通知 server/discord-notifier.ts（再送 30秒/2分/10分、最後は macOS 通知）。時計は 1 秒 tick（reservations.ts:168）、日本時間固定（reservations.ts:15）。
- 重なり検出 server/schedule-gate.ts は予約と定期実行同士だけ（GAP 60分 :11）。カレンダー予定との重なりは無い。

### スマホ
- ~/agent-console-wt/mobile-pwa（release/mobile-pwa）は docs 2 コミットのみ・main より 336 遅れ。design.md:3「実装未着手」。PO の Tailscale 導入待ち。

### 試験・CI
- vitest（tests/unit）、Playwright（tests/e2e、reservations.spec.ts が画面操作の手本）。CI .github/workflows/ci.yml の job `check`（ubuntu-latest / macos-latest）。必須チェックの設定は `gh api` が 404 で【未確認】。

## Google 公式資料（Context7 は月の上限超過で使えず、公式頁を直接確認 2026-10-30）
- デスクトップ用 OAuth: 戻り先に `http://127.0.0.1:port` を使える。公開クライアント扱いで PKCE を必ず使う（https://developers.google.com/identity/protocols/oauth2/native-app）。
- 外部ユーザー型で公開状態「テスト」だと更新用の鍵（refresh token）は 7 日で切れる。6か月使わないと切れる。1アカウント×1クライアント100本まで（https://developers.google.com/identity/protocols/oauth2、更新 2026-10-29）。
- 読むだけの権限 calendar.events.readonly、書く権限 calendar.events / calendar.events.owned（https://developers.google.com/workspace/calendar/api/auth）。
- events.list: singleEvents=true で繰り返しを展開、orderBy=startTime はそのときだけ（events/list、更新 2026-07-29）。上限 1利用者毎分600（guides/quota）。

## 未確認のまとめ
- [?] U1: PO の予定が入っている Google アカウントが会社の Google Workspace か個人か。Workspace なら同意画面を「内部」にでき、7日切れが起きない【未確認】。
- [?] U2: agent-console が開く opus-designer セッションに Google カレンダーの接続（claude.ai コネクタ）があるか。このセッション（ccopusgo）には予定の作成・一覧の道具がある【事実：本セッションの道具一覧】。アプリ内セッションでも同じかは【未確認】。
- [?] U3: 必須チェックの名前（gh api が 404）。
