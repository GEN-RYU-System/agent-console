# 予定画面（開発／秘書）— design

状態: 設計案（Opus 作成 2026-10-30）・独立審査 第1回 REVISE（高4・中6・低4）を第7回で反映・第2回 REVISE（中5・低6）を第8回で反映・第3回 REVISE（中4・低2）を本版（第9回）で反映・再審査待ち・PO 決定待ち1件（§14）・実装未着手。
調査は recon.md（同じフォルダ）。成功条件（１）〜（７）と（８）〜（１２）は PO 承認済み（2026-10-30「1」）で、ここでは変えない。

## 1 目的（PO の言葉）
「毎日それを見れば全てキャッチアップできるようにしたい」。予定の取りこぼし（10/30 面接の遅刻）を繰り返さない。

## 2 成功条件（PO 承認済み・○×）
（１）朝に画面を開くと、今日と明日の予定が、開発と秘書に分かれて出る
（２）Google カレンダーの予定が、開いた時点の中身で出る
（３）やることを足す・終わった印を付ける・消すが、画面からできる
（４）画面の中で AI に話しかけると、「この面接を来週火曜に入れて」などが予定に入る
（５）時間が重なる予定には、赤い印が出る
（６）始まる1時間前と15分前に、画面とスマホに知らせが届く
（７）スマホで同じ画面が見られる
（８）開発の時間割に、Claude が立てた見積もり（始める時刻・終わる見込み・かかる時間）が点線の枠で出る
（９）作業が終わると、実際にかかった時間が実線の枠で見積もりの横に並び、何倍かかったかが出る
（１０）「見積もりの当たり具合」の画面に、週ごとの 終わった件数・見積もりの ±25% 以内で終わった割合・締め切りまでに終わった割合・実際÷見積もりの真ん中の値 と、過去8週の割合の棒が出る
（１１）記録は消えずに残り、表（CSV）で書き出せる
（１２）見積もりを後で直しても、当たり外れは最初の見積もりで判定する（直した回数も出る）
（８）〜（１２）は 2026-10-30 PO 承認（「1」）。画面の形（時間割・日／週／月・開発も時間割）は同日の PO 指摘と選択（「1」）で決まった。
本設計の実装対象は（１）〜（５）と（８）〜（１２）。（６）（７）は §8 に道筋だけ書き、別の設計で詰める。

## 3 対象と対象外
- 対象:
  - 中央タブ「予定」（日／週／月・開発／秘書）、やることの保存（dataDir/schedule.json）、画面用 API、重なりの赤印、文言、試験、README・CHANGELOG・版。
  - Google カレンダーの読み取り（サーバー経由・読むだけ）と、認証の前に置く戻り先 `/oauth/google/callback`（§4-4）、Keychain への書き込み関数（§4-4）。
  - AI 用の口 `/api/agent/schedule` と命令 ac-schedule.mjs（やること・見積もりの両方）。
  - 見積もりと実際の記録（dataDir/estimates/log.jsonl）、当たり具合の画面、CSV の書き出し、作戦ボードの読み直しによる打ち忘れの補完（§4-8。ac-board.mjs には手を入れない。サーバー側でボードのファイルを読み直すだけ）。
  - 予定係セッションを開くための、launchAndSend の「予定係専用の作業フォルダ1つだけ」の許可（§4-5）。
- 対象外:
  - Google カレンダーへの書き込みをサーバーが行うこと（§4-5 で AI 側に任せる）、知らせ（６）、スマホ（７）。
  - 作戦ボード（ac-board.mjs・ボードのファイル形式）・予約・定期実行の動きの変更。予約・定期実行が開ける作業フォルダは今のまま（§4-5 の許可は予定係の呼び出しだけが渡す）。
  - AI の起動指示（salesanchor-designer.md 等、このリポジトリの外）に「作業前に見積もりを打つ」を足すこと。別リポジトリ・別 PR で、PO に確かめてから行う（§4-8）。
  - Sales Anchor 側の変更。

## 4 変更の前後と詳しい動き
| | 前 | 後 |
|---|---|---|
| 中央タブ | チャット…定期実行・予約 | 加えて「予定」 |
| Google カレンダー | アプリは読まない | 予定タブを開いた時点で、表示中の範囲を読む |
| やること | 会話ごとの作戦ボードだけ | 会話をまたぐ一覧（開発／秘書） |
| 重なり | 予約と定期実行の間だけ | 予定・時刻つきのやることの間にも赤印 |
| 見積もり | 記録しない | 見積もり・開始・終了を追記だけの記録に残し、時間割と当たり具合の画面に出す |

### 4-1 画面
- 中央タブ `schedule`（ConsolePage.tsx:58 の型と :532-547 の items に1つ足す、ラベル t("ac.tabs.schedule")＝「予定」）。ペイン src/components/Schedule/SchedulePane.tsx を ReservationsPane と同じ型（`active` prop、`hidden={!active}`）で ConsolePage.tsx:608 の下に置く。
- 第2版（2026-10-30 PO 指摘「秘書をスケジュールにしてって言わなかった？タイムテーブル式にもなってない」を受けて変更）。第1版は時刻つきの一覧で、時間割の形を入れ忘れていた。
- 上部に「開発／秘書」の切り替え（金型 Tabs。SegmentedControl は金型に無いので使わない）。既定は秘書。
- その横に「日／週／月」の切り替え（2026-10-30 PO「day/week/month の切り替えタブは？」を受けて追加）。既定は日。選んだ表示は画面の中だけで覚える（localStorage、読めなければ日）。
  - 日: 下の時間割で「今日」「明日」の2列（承認済みの成功条件（１）の形）。
  - 週: 同じ時間割で月曜〜日曜の7列（日本時間）。今日の列の見出しを強調。前の週・次の週へ送るボタン。
  - 月: 月曜始まりのカレンダーの升目（5〜6行×7列）。各日に「時刻 題名」の小札を2件まで、それ以上は「ほか N 件」。重なりのある予定は赤の小札。日を押すとその日の「日」表示へ移る。前の月・次の月へ送るボタン。
  - Google から読む範囲は表示に合わせる（§4-4）。
- 時間割（秘書・開発とも同じ形）: 左に時刻の目盛り（既定 8:00〜20:00、1時間の高さは金型のトークン `--schedule-row-height`（salesanchor frontend/src の tokens.css、「1時間の高さ（標準）」48px）、この範囲外の予定があれば目盛りをその時刻まで広げる）、その右に日の列。予定は開始〜終了の長さのブロックで置く。今日の列に「いま HH:MM」の横線。
- 重なる予定は同じ列の中で横に分けて並べ、両方を赤枠＋「重なり」の札にする（§4-6）。右脇に「時間が重なっています」の説明欄。
- 終日の予定は列の見出しのすぐ下に帯で出す。時刻の無いやること・返事待ちは右脇の「時刻の決まっていないこと」欄に出す（終わった・消すボタン付き）。
- ブロックの中身: 時刻・題名・カレンダー由来は「Google」の札。色は種類（予定／やること／締め切り）で分ける。ブロックを押すと詳細（終わった・消す・メモ）の小窓。
- 開発側: 同じ時間割の形にする（確定。2026-10-30 PO「1」）。時刻のある項目（締め切り・時刻つきやること・Google の「[開発]」予定・見積もり（§4-8））はブロック。作業の進み具合（作戦ボード doing）・待っている確認・始める時刻の無い見積もりは、時刻が無いので右脇の欄に出す。見積もりの点線・実線の出し方は §4-8。
- スマホ（（７）、後の便）: 幅が狭いときは「今日」1列だけを出し、「明日」は切り替えで見る。
- 上部に「最後に読んだ時刻 HH:MM」と「読み直す」ボタン。読めなかったときは Callout（金型）で「Google カレンダーを読めませんでした（理由）」と出し、前回の中身を「HH:MM 時点」と明記して残す。
- 部品は金型（Tabs/Badge/Button/Callout/EmptyState/Modal）。色・寸法はトークン。文言は全部 t()（ja.json）。
- 取得: active の間、開いた瞬間に1回、その後 60 秒ごと。表示の範囲を変えたときにも1回。

### 4-2 開発／秘書の振り分け
- やること: 作るときに side（"dev" | "secretary"）を必ず選ぶ。
- Google カレンダーの予定: 既定は「秘書」。設定 `schedule.devCalendarIds`（置き場は §15-3）（カレンダー ID の配列、既定 []）に入るカレンダーの予定と、題名が「[開発]」で始まる予定は「開発」。
- 開発の列には自動で次も出す（読むだけ・編集不可）: (a) 開いているセッションの作戦ボードの tasks のうち status "doing"（セッション名つき、server/boards.ts の読み取りを使う） (b) 許可待ちのセッション（既存の waitingFor 状態）を「待っている確認」として。日付の無い行なので「時刻の決まっていないこと」の欄に出す。

### 4-3 やることの保存（正本は1か所）
- 正本 dataDir/schedule.json。書き手はサーバーの `ScheduleStore` だけ（画面も AI 用命令も HTTP で頼む）。json-store.ts の writeJsonAtomic・createSerial を使う。壊れた内容は上書きしない（reservations.ts と同じ）。
- 見積もりはここには持たない（§4-8 の別の記録ファイル）。
```ts
type ScheduleSide = "dev" | "secretary";
type ScheduleKind = "todo" | "waiting" | "deadline";
interface ScheduleItem {
  id: string;                 // "sch_" ＋ 乱数 12 文字（サーバーが振る）
  side: ScheduleSide; kind: ScheduleKind;
  title: string;              // 1〜200字、制御文字禁止
  date?: string;              // "YYYY-MM-DD"（日本時間）。無ければ「いつでも」
  start?: string; end?: string; // "HH:mm"。end は start があるときだけ、start より後
  waitingOn?: string;         // 返事待ちの相手（kind "waiting" のとき、100字まで）
  note?: string;              // 1000字まで
  status: "open" | "done";
  createdBy: "ui" | "agent"; createdAt: number; updatedAt: number; doneAt?: number;
}
// ファイル: { "version": 1, "items": ScheduleItem[] }
```
- 上限: open は 300 件。全体 1000 件、超えたら doneAt が古いものから消す。
- 日付の検査は reservations.ts の方式（存在しない日付は 400）を共通関数で使う。
- http.ts の deps に足すキー名は `scheduleItems`（ScheduleStore）・`googleCalendar`・`estimates`。既存の `deps.schedule`（ScheduleGate、http.ts:78・index.ts:119）とは別の名前にする。

### 4-4 Google カレンダーの読み取り
- サーバーが Google の公式 API（Calendar API v3 events.list）を直接呼ぶ。権限は calendar.events.readonly だけ（読むだけ）。
- つなぎ方: デスクトップ用 OAuth＋PKCE（S256）。画面の「Google とつなぐ」ボタン → `POST /api/schedule/google/connect`（認証あり・Origin 必須）が同意画面の URL を返す → 画面がシステムのブラウザで開く → Google が戻り先へ返す → サーバーが鍵を受け取る。
- 戻り先 `GET /oauth/google/callback`:
  - 戻り先の URL は `http://127.0.0.1:<いま待ち受けているポート>/oauth/google/callback`。本番は 4319。AGENT_CONSOLE_PORT で上書きした試験サーバー（config.ts:417-426）でも同じ作りで動く（デスクトップ用クライアントは 127.0.0.1 の任意のポートを受け付ける。S0-3 で実物確認）。
  - 置き場所は「認証の前に置く専用の分岐」。http.ts:695-715 の pair・PICK_INGEST・agent の分岐と同じ並びに置く。理由: 認証は `/api/` で始まる道だけにかかり（http.ts:716）、Authorization ヘッダーで判定する（:717）。システムのブラウザからの戻りにはこのヘッダーが付かない。分岐が無いと GET は :734 serveStatic に落ちる。
  - Host の検査は分岐より前で済んでいる（http.ts:685）。メソッドは GET だけ。
  - state: `connect` のたびに 32 バイトの乱数を作り、サーバーのメモリにだけ持つ。1回限り（照合したら消す）・10分で失効・同時に持つのは1つ（新しく作ったら古いものは消す）。比べるときは長さをそろえて `crypto.timingSafeEqual` で比べる。
  - PKCE の code_verifier も state と組でサーバーのメモリにだけ持つ（ファイル・ログ・画面に出さない）。
  - state が無い・一致しない・失効している → 鍵の交換をせず、何も保存しない。応答は固定の文面の HTML（「つなげませんでした。予定タブからやり直してください」）。
  - 応答の HTML に code・error・state の値を入れない（反射の防止）。成功・失敗とも固定の文面だけ。`Cache-Control: no-store`。
  - 戻り先の URL（code を含む）と、Google との交換の応答を、ログに出さない。ログに出すのは「成功」「state 不一致」「交換失敗（HTTP 状態の数字だけ）」の別だけ。
- 鍵の置き場: Keychain（service "agent-console"）に account を3つに分けて置く: "google-oauth-client-id"・"google-oauth-client-secret"・"google-calendar-refresh"。ファイル・ログ・画面に値を出さない。
  - 最初の2つは台本 scripts/ac-google-secret.sh で登録する（PO が `!` で実行、既存 ac-discord-secret.sh と同じ型。値は `security -i` の標準入力にだけ渡す。scripts/ac-discord-secret.sh:4, :45）。
  - 更新用の鍵はサーバーが戻り先で受け取って保存する。server/keychain.ts に `writeKeychainItem(securityBin, account, value)` を足す。securityBin は readKeychainItem（keychain.ts:31）と同じく引数で受け、本番は server/secret.ts の securityBinFor（index.ts:99）が渡す（試験で差し替えるため）。中身は `spawn(securityBin, ["-i"])` を開き、標準入力に `add-generic-password -U -s agent-console -a <account> -w "<値>"` の1行を書く。子プロセスの標準出力・標準エラーは捨てる（台本の >/dev/null と同じ）。子プロセスの引数に値を入れない（プロセス一覧に出さないため）。`security add-generic-password -w <値>` を引数で渡す形は使わない。
  - 拒否する値は既存の台本（scripts/ac-discord-secret.sh:33-43）と同じ範囲にそろえる: 空・空白・引用符（" と '）・バックスラッシュ・改行を含む値は保存せず、失敗として扱う（security -i は1行を自分で区切って読むため）。
  - readKeychainItem の account の型（keychain.ts:28-39、今は Discord の2種）に上の3つを足す。
- 読む範囲（表示に合わせる。すべて日本時間）:
  - 日: 今日 00:00 〜 明後日 00:00。
  - 週: 表示中の週の月曜 00:00 〜 次の月曜 00:00。
  - 月: 升目の最初の日 00:00 〜 最後の日の翌日 00:00（最大 42 日）。
  - 対象カレンダーは `schedule.calendarIds`（既定 ["primary"]、最大 5）。カレンダーごとに `singleEvents=true&orderBy=startTime&timeZone=Asia/Tokyo&maxResults=250` で呼ぶ。状態 cancelled は出さない。
  - ページ送り: nextPageToken をたどる。1カレンダー・1回の読み取りで 4 ページ（1000 件）まで。超えたらそこで止め、画面に「予定が多すぎるため一部を読めていません」の注意を出す（黙って欠かさない）。
  - 呼び出し数: 60 秒ごとに「カレンダー数 × ページ数」回。月表示・カレンダー5つ・各1ページで毎分5回。上限（1利用者毎分600）の 1% 未満。
- 写しの鮮度: `GET /api/schedule` は、その範囲の写しが 60 秒より新しければ Google を読まずに写しを返す。古いか無いときだけ読む。`POST /api/schedule/calendar/refresh` は必ず読む。画面やタブが2つ以上開いていても、Google を読むのは範囲ごとに 60 秒に1回まで。
- 写し: メモリだけに持つ（ファイルに残さない）。範囲ごとに持ち、持つのは「今日〜明後日」と「いま表示中の範囲」の2つまで（表示を変えたら古い表示の写しは捨てる）。1つの写しは最大 5000 件（5カレンダー×1000 件）。
- サーバーの外向き通信は行き先をコード定数（oauth2.googleapis.com / accounts.google.com / www.googleapis.com）に固定（discord-api.ts:75 と同じ考え）。CSP は変えない（ブラウザは Google に直接つながない。同意画面はシステムのブラウザで開く）。
- 失敗は写しを残し、理由（鍵切れ・通信失敗・上限）を返す。鍵切れ（invalid_grant）は「Google ともう一度つないでください」と表示。

### 4-5 画面の中で AI に話しかける（（４））
- 予定タブの下に話しかけ欄（1行入力＋送る）。送り先は「予定係」セッション1つ: 役割 opus-designer・名前「予定係」（launchAndSend が後ろに日時を付ける。launch.ts:64-68）。返事は既存のチャットタブで読める（行の右に「チャットを開く」）。
- 予定係の見分け方:
  - サーバーは、予定係として開いたセッションの番号をメモリに1つだけ持つ（`assistantSessionId`）。名前の前方一致では探さない。
  - 送るとき、その番号のセッションが SessionManager にあり、終わっていない（exited でない）なら、そのセッションの既存の送信待ち（chat/queue）に積む。
  - 番号が無い・セッションが無い・終わっている（PO が閉じた場合を含む）なら、launchAndSend で新しく開き、その番号で `assistantSessionId` を置き換える。
  - 開いている途中の扱い: launchAndSend は番号を返すまで最長 約4分15秒かかる（launch.ts:99-118）。サーバーは「開いている途中」の印（`assistantLaunching`）をメモリに持ち、その間は新しく開かない。途中に届いた文はメモリの待ち行列（最大 10 通。超えたら 429「予定係を開いている途中です。少し待ってから送ってください」）に入れ、launchAndSend の結果が sent になったら、そのセッションの送信待ち（chat/queue）へ順に積む。
  - 結果が sent 以外（not_ready・cwd_invalid など）のときは、`assistantSessionId` を置き換えず、待ち行列の文を捨て、launchAndSend が番号を返していればそのセッションを閉じ（not_ready は開いたまま返すため。launch.ts:109・:112）、画面に「予定係を開けませんでした（理由）。送った N 通は届いていません」と Callout で出す。
  - 画面への返事: `POST /api/schedule/assistant/send` は開くのを待たずにすぐ返す（202 { state: "launching" | "queued", pending: N }）。開けたか・失敗したかは `GET /api/schedule` の `assistant: { state: "none" | "launching" | "ready" | "failed", pending, error? }` で画面が知る（60 秒ごとの取得に加え、launching の間は 5 秒ごと）。
  - 名前が「予定係」で始まる別のセッションがあっても、番号が違えば使わない（予定係が2つになっても、送るのは覚えている1つだけ）。
  - launchAndSend に渡す slotKey は、予約・定期実行と同じく開く時刻の分の key `jstSlot(new Date()).key`（"YYYY-MM-DDTHH:mm+09:00"。launch.ts:24-26 と :64 で名前の末尾の日時に使われる。jstSlot の定義は routines.ts:60、渡し方は routines.ts:133・reservations.ts:109 と同じ）。独自の文字列は渡さない（名前が壊れるため）。stillWanted は常に true（話しかけ欄から送った文は取り消しの口が無いため。launch.ts:30-31）。
- 再起動したとき: 予定係も、ほかのセッションと同じく戻す（つなぎ直す）。
  - 理由: 本体は tmux の中で動き、アプリを止めても動き続ける（README.md:196）。戻さずに飛ばすと known に入らず（restore.ts:175）、一覧に無い tmux のセッションは消されない（sessions.ts:299-306）。更新のたびに前の予定係が裏に残り、次に話しかけるともう1つ開いてしまう。
  - やり方: server/restore.ts の :164 の classifyCwd の判定に、launchAndSend と同じ例外を足す。classifyCwd が "outside" を返し、かつ realpath(item.cwd) が設定の assistantCwd の realpath と同じなら、通して（block を null として）今どおり戻す。missingCwd の知らせは出ない。
  - 戻したあと、そのセッションの番号で `assistantSessionId` を覚え直す（予定係のフォルダのセッションが2つ以上戻ったときは、createdAt が最も新しい1つを覚え、残りは閉じる。最後に動いた時刻は実物に無いため。session-store.ts:15-23）。
- 作業フォルダ: `dataDir/schedule-assistant/`（設定 `schedule.assistantCwd` で変えられる）。
  - 事実: launchAndSend は classifyCwd（server/resume-targets.ts:46-54）で、作業フォルダが本店（salesanchorRoot）かその worktree でなければ `cwd_invalid` で拒む（launch.ts:102-104）。このままでは予定係を開けない。
  - 選んだ方法: launchAndSend の要求に省略可能な `extraAllowedCwd`（絶対パス1つ）を足す。classifyCwd が "outside" を返したときだけ、`realpath(req.cwd) === realpath(extraAllowedCwd)` なら通す。この値を渡すのは予定係の呼び出しだけ。予約・定期実行の呼び出しは渡さないので、開ける作業フォルダは今と変わらない。
  - 本店を作業フォルダにする案は取らない。理由: 本店の CLAUDE.md・決まりが読み込まれ、予定係の決まりと混ざる。
  - 試験: (a) extraAllowedCwd 付きで予定係のフォルダを開ける (b) extraAllowedCwd 無しでは同じフォルダが今どおり cwd_invalid (c) extraAllowedCwd と違うフォルダ（親・シンボリックリンク経由の別の場所）は cwd_invalid (d) 予約・定期実行の既存試験が緑のまま (e) 復元: 予定係のフォルダのセッションは戻り、missingCwd の知らせが出ず、assistantSessionId がその番号になる。ほかのフォルダの外のセッションは今どおり missingCwd (f) 見分け方: 覚えた番号が生きていれば新しく開かない・終わっていれば開き直して番号を置き換える (g) 開いている途中に2通目を送っても launchAndSend は1回だけ呼ばれ、sent のあと2通とも送信待ちに積まれる。not_ready のときは2通とも捨てられ、assistant.state が failed になる。
  - 変更・PR タブ（workplace.ts:30）も classifyCwd を使う。予定係のフォルダでは今どおり 409 を返すだけで、変えない。
- AI がすること:
  - やることの追加・完了・削除 → 命令 `node "<dataDir>/bin/ac-schedule.mjs" add|list|done|remove`（ac-reserve.mjs と同じ型: 127.0.0.1 だけ、合言葉ファイル、入力 64KiB 上限、Origin があれば拒否）。
  - 合言葉と呼べる役割は、新しく作らず既存のものを使う（出どころを1つにするため）: 合言葉は dataDir/reserve-token（http.ts:81、ac-reserve.mjs:9）、役割は設定 `reserveRoles`（config.ts:377、既定 ["opus-designer","shell"]）。新しい秘密のファイルを作らないので、case-sandbox.ts:90 の隔離の一覧と guard の拒否文字列は変えなくてよい。reserveRoles を変えると、予約と予定・見積もりの両方の呼べる役割が一緒に変わる（README の「予定」節に書く）。
  - 呼び出し元の確認は予約と同じ checkCaller（http.ts:512-520）。会話番号（CLAUDE_CODE_SESSION_ID）が無い・生きているセッションに無い・役割が違うときは 403 で、何も書かない。
  - 監査の記録: 予約と同じく writeAudit（http.ts:474-475）で dataDir/routine-audit.jsonl に書く。
    - 名前（RoutineAuditAction、server/routine-audit.ts:11 に足す）は2つ: "scheduleWrite"（やることの add・done・remove）と "estimateWrite"（見積もりの estimate・revise・start・done-estimate・cancel）。既存の "add" とはぶつからない。
    - RoutineAuditEntry に足す欄: `op`（上の op の名前）・`scheduleItemId`（やることの番号）・`estimateId`（見積もりの番号）。対象が決まらない（estimate・add の拒否）ときは番号の欄を入れない。
    - 予約と同じく、通したとき（outcome "ok"）も拒否したとき（"denied"、403・409 とも）も1行書く。題名・メモなど本文の中身は書かない。
  - Google カレンダーへの予定の追加（「この面接を来週火曜に入れて」）→ AI のセッションが持つ Google カレンダーの接続で入れる。サーバーは書き込み権限を持たない（最小権限）。入った予定は次の読み取り（最長 60 秒、または「読み直す」）で画面に出る。
  - 予定係が最初に読む決まり（頼み方・日付の解き方「来週火曜」＝日本時間で次の週の火曜・開発／秘書の決め方・入れる前に重なりを確かめて返事に書く）は、予定係の作業フォルダに CLAUDE.md として置く（アプリの起動時に bin と同じ方法で写す）。
- 担当（サブエージェント）からは ac-schedule を打てない（hooks/ac-routine-guard.mjs:3, :20-21 が "Application Support/agent-console" を含む担当の Bash を拒む。activity-hooks.ts:12-19）。これは今のままにする。予定係も見積もりも、会話の本体（Opus）が打つ。
- 前提 U2（アプリ内セッションに Google カレンダーの接続があるか）は第0段で確かめる。無かった場合は §5 の案 B（サーバーに calendar.events.owned を足し ac-schedule に event-add を足す）に切り替え、PO に知らせる。

### 4-6 重なりの赤印（（５））
- 同じ日の「時刻のある行」（Google の予定＋start/end のあるやること＋始める時刻のある見積もり。開発・秘書の両方を合わせて）で、区間 [start, end) が少しでも重なる2行の両方に赤い印（危険色のトークン）と「重なり: 〇〇」の説明を付ける。end の無いやることは 30 分とみなす。終日の予定・終わったやること・終わった見積もりは数えない。
- 計算は画面側の純粋な関数 `findOverlaps(rows)`（単体試験しやすくするため）。
- 時間割での見せ方: 重なる予定は列を左右に分けて並べ（重なりの組ごとに横幅を等分）、両方を赤枠にする。位置の計算も純粋な関数 `layoutDay(rows, startHour)`（上端・高さ・左右の位置を返す）にして単体試験する。

### 4-7 API
- 画面用（`/api/` の下・認証あり・変更系は Origin 必須。http.ts:716-727）:
  - `GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD` → { items, calendar: { events, fetchedAt, error?, connected, truncated }, dev: { boards, waiting } }。from〜to は §4-4 の読む範囲（最大 42 日）。
  - `POST /api/schedule/items`、`PATCH /api/schedule/items/:id`（status / title 等）、`DELETE /api/schedule/items/:id`
  - `POST /api/schedule/calendar/refresh`
  - `POST /api/schedule/google/connect`（同意画面の URL を返す。state と code_verifier をここで作る）
  - `POST /api/schedule/assistant/send`（{ text } 32KiB まで）→ 予定係が生きていれば今の送信の口と同じく 200。開いている途中・開き始めなら 202 { state, pending }。開いている途中の待ち行列が満杯なら 429。予定係の送信待ちが満杯・止まっているときは今の 409（hub.ts:405・:407）をそのまま返し、画面は Callout で理由を出す。
  - GET /api/schedule の返り値に `assistant: { state, pending, error? }` を足す（§4-5）。
  - `GET /api/schedule/estimates?from=&to=` → 時間割に出す見積もりの一覧（§4-8 の EstimateTask の配列）
  - `GET /api/schedule/estimates/summary?weeks=8` → 週ごとの数字（§4-8）と、読めなかった行の数
  - `GET /api/schedule/estimates.csv` → CSV（§4-8）
  - 既存の `/api/schedule/preview`（http.ts:227、定期実行の時刻の関門）はそのまま残す。新しい道は `/api/schedule` ちょうど、または `/api/schedule/items`・`/calendar/`・`/google/`・`/assistant/`・`/estimates` で始まるものだけを受け、preview と取り合わない（試験で preview の既存の動きが変わらないことを確かめる）。
- 認証の前に置く分岐（§4-4）: `GET /oauth/google/callback`。
- AI 用: `POST /api/agent/schedule`（認証の前の分岐。http.ts:459 handleAgentReservations と同じ順の検査: Origin があれば拒否→合言葉→役割）。本文 `{ op, ... }`。op は add / list / done / remove（やること）と estimate / revise / start / done-estimate / cancel / list-estimates（見積もり）。

### 4-8 開発の見積もりと実際（成功条件（８）〜（１２）は PO 承認済み 2026-10-30）
PO 原文（2026-10-30）: 「開発にもclaudeが立てた見積もりを表示できるようにして、見積もりに対して実績として見積もり通りに開発が完了できているかどうかも確認して見積もりの精度も見える化、記録して分析できるようにしてほしい」

成功条件（§2 に転記済み）:
- （８）開発の時間割に、Claude が立てた見積もり（始める時刻・終わる見込み・かかる時間）が点線の枠で出る。
- （９）作業が終わると、実際にかかった時間が実線の枠で見積もりの横に並び、「1.6倍かかった」「見積もりどおり」が出る。
- （１０）「見積もりの当たり具合」の画面に、週ごとの 終わった件数・見積もりの ±25% 以内で終わった割合・締め切りまでに終わった割合・実際÷見積もりの真ん中の値 が出る。過去8週の割合が棒で並ぶ。
- （１１）記録は消えずに残り、表（CSV）で書き出せる。
- （１２）見積もりを後で直しても、当たり外れは最初の見積もりで判定する（直した回数も出る）。

前提の事実:
- 今の作戦ボードの作業（tasks）は `{title, status}` だけで、時刻も見積もりも持たない。書くたびに丸ごと置き換わる（README.md:152, :175）。会話をまたげない（server/boards.ts:9-10）。ac-board はサーバーを通らずファイルへ直接書く（hooks/ac-board.mjs:121-142）。→ 見積もり・実際はボードにも schedule.json にも持たず、別の記録ファイルに持つ。

記録ファイル:
- `dataDir/estimates/log.jsonl`（フォルダ 0700・ファイル 0600）。1行1出来事。追記だけで、書き換え・削除の口は作らない（（１１）（１２））。
- 書き手はサーバーの `EstimateLog` だけ。追記は createSerial（json-store.ts:10）で直列にし、`appendFile`（1行ずつ、末尾に改行）で書く。
- 読むときは毎回ファイル全体を読み、作業ごとにまとめる。JSON として読めない行・型に合わない行は飛ばし、飛ばした数を summary の応答に入れる（画面に「読めなかった記録 N 行」）。ファイルは直さない。
- 1行の型（時刻はすべて Unix ミリ秒）:
```ts
type EstimateEvent =
  | { v: 1; type: "estimated"; id: string; at: number; title: string;   // title 1〜200字
      minutes: number;            // 1〜1440 の整数
      plannedStart?: number;      // 始める予定の時刻
      due?: number;               // 締め切り
      sessionId: string;          // 呼び出し元の会話番号（checkCaller に通ったもの。打ち忘れの補完に使う）
      sessionName?: string }      // SessionManager 上のセッション名
  | { v: 1; type: "revised"; id: string; at: number; minutes: number; plannedStart?: number; due?: number }
  | { v: 1; type: "started"; id: string; at: number }
  | { v: 1; type: "done"; id: string; at: number; source: "agent" | "board" }
  | { v: 1; type: "cancelled"; id: string; at: number; reason?: string };   // reason 200字まで

// 読み出し用（ファイルには書かない。log からまとめて作る）
interface EstimateTask {
  id: string; title: string; sessionId: string; sessionName?: string;
  firstMinutes: number;        // 最初の estimated の minutes（当たり外れはこれで判定）
  currentMinutes: number;      // 最後の revised、無ければ firstMinutes
  revisions: number;           // revised の行数
  plannedStart?: number; due?: number;   // 最後の値（revised で上書き）
  startedAt?: number; doneAt?: number; doneSource?: "agent" | "board"; cancelledAt?: number;
  state: "planned" | "started" | "done" | "cancelled";
}
```
- 作業の番号 `id`: estimate のときにサーバーが振る（"est_" ＋ 乱数 12 文字）。ScheduleItem.id とは別の番号で、やることとは結び付けない。
- 順番の決まり: started・done・cancelled は1作業に1回だけ（2回目は 409）。done は started の後だけ（started 無しの done は 409）。done・cancelled の後の revise は 409。

命令（AI 用、ac-schedule.mjs。口は §4-7 の `/api/agent/schedule`）:
- `estimate --title "…" --minutes 90 [--start "2026-11-02 10:00"] [--due "2026-11-02 18:00"]` → 番号を返す。日時は日本時間。会話番号は ac-reserve.mjs と同じく環境変数 CLAUDE_CODE_SESSION_ID だけから取り、標準入力の自己申告は使わない（hooks/ac-reserve.mjs:65, :105）。番号が無ければ 403 で記録できない（§4-5）。サーバーは確認に通った呼び出し元の会話番号を sessionId に、そのセッションの SessionManager 上の名前を sessionName に書く（命令からは受け取らない）。
- `revise <番号> --minutes 120 [--start …] [--due …]`
- `start <番号>`・`done-estimate <番号>`・`cancel <番号> [--reason "…"]`・`list-estimates`（副命令の名前は §4-7 の op と同じ。やることの完了 `done` とは別の名前にする）
- 打つのは会話の本体（Opus）。担当（サブエージェント）は guard に拒まれる（§4-5）。

時間割での見せ方（（８）（９））:
- 開発の時間割に、`GET /api/schedule/estimates` の EstimateTask から作る。plannedStart がある見積もりは、plannedStart から currentMinutes の長さの点線の枠。plannedStart が無いものは右脇の「時刻の決まっていない見積もり」欄。
- startedAt がある見積もりは、startedAt から（終わっていれば doneAt まで、終わっていなければ「いま」まで）の実線の枠を、点線の枠の右隣に並べる（同じ時間の幅を左右に分ける。layoutDay で扱う）。
- 終わった見積もりの結果札: 倍率 r = 実際の分 ÷ firstMinutes。
  - 0.75 ≤ r ≤ 1.25 のとき「見積もりどおり」。
  - r > 1.25 のとき「X.X倍かかった」。r < 0.75 のとき「X.X倍で終わった」。
  - X.X は小数1桁の四捨五入（例: 95 ÷ 60 = 1.583… → 1.6）。
- 直した回数が1回以上なら、枠に「直した N 回」。

数え方（（１０）。純粋な関数 `summarizeEstimates(tasks, nowMs)`）:
- 週: 日本時間の月曜 00:00 〜 次の月曜 00:00。作業は doneAt の週に数える。
- 終わった件数: その週に doneAt がある作業の数（cancelled は数えない）。
- 実際の分: doneAt − startedAt を分にしたもの（小数のまま）。PO の確認待ちの時間を差し引くかは未決。未決の間は差し引かない（started〜done の経過そのまま）で判定する。
- ±25% 以内の割合: |実際の分 − firstMinutes| ≤ 0.25 × firstMinutes（等しいときは以内）の件数 ÷ 終わった件数。
- 締め切りまでに終わった割合: due のある作業だけを分母にし、doneAt ≤ due（等しいときは間に合った）の件数 ÷ due のある件数。due のある作業が0件の週は「—」。
- 真ん中の値: その週の r（実際の分 ÷ firstMinutes）を並べた真ん中。件数が奇数なら真ん中の1つ、偶数なら真ん中の2つの平均。表示は小数2桁の四捨五入。0件の週は「—」。
- 割合の表示は整数の % に四捨五入。0件の週は「—」（0% と出さない）。
- 過去8週の棒: 今週を含む直近8週ぶん、必ず8本。棒の高さは ±25% 以内の割合。0件の週は高さ0の空の棒に「—」。目標の線は 70%（見本どおり。値は設定 `schedule.accuracyTarget` で変えられる。置き場は §15-3）。

CSV（（１１）。`GET /api/schedule/estimates.csv`）:
- 文字コードは UTF-8（先頭に BOM。Excel で文字化けさせないため）、改行は CRLF、値は必要に応じて "" で囲む。
- 1行1作業。cancelled も含めて全作業を出す（state 列で分かる）。
- 列（この順）: id, title, session_name, state, estimated_at, first_minutes, current_minutes, revisions, planned_start, due, started_at, done_at, done_source, actual_minutes, ratio, within_25pct, met_due
- 日時は日本時間 "YYYY-MM-DD HH:mm"。actual_minutes は小数1桁、ratio は小数2桁。終わっていない作業の actual_minutes・ratio・within_25pct・met_due は空欄。

打ち忘れの補完（作戦ボードから）:
- ac-board.mjs には手を入れない（§3）。サーバーが dataDir/boards/*.json を読み直して気付く。
- 何で気付くか: 30 秒ごとに dataDir/boards/ のファイルの更新時刻（mtime）を見て、変わったファイルだけ読む（fs.watch は使わない。取りこぼしが起きにくく、試験しやすいため）。
- ボードの写しはファイルに持たない（第11回で変更。PO 指示「データを分散させることは禁止」と、ボードの正本は boards/<番号>.json だけという事実 server/boards.ts:2 による）。前に何だったかは比べない。見積もりの記録 log.jsonl を「まだ終わっていない」の正本とし、そこから判定する。
  - メモリに持つのは「ファイル名 → 最後に読んだ mtime」だけ（読み直しを減らすため。再起動で消えたら全部を1回読み直す。中身は持たない）。
  - 読めないボード（readBoard が invalid を返す。ac-board.mjs:176-179）: 補わず、mtime も覚えない。次の30秒でまた読む。
  - 消えたボード: メモリの mtime からも消す。
  - 一時ファイル（`<番号>.json.<pid>.<時刻>.tmp`）は `*.json` に当たらないので読まない。
- 補う条件（すべて満たすときだけ）:
  - (a) あるボードで、作業名 T の status が今 "done"。
  - (b) そのボードの会話番号（ファイル名の claudeSessionId）と、作業名 T（前後の空白を除いて完全一致）が同じ見積もりが、ちょうど1件ある。
  - (c) その見積もりが started で、done・cancelled がまだ無い。
- 補う中身: `{ type: "done", id, at: ボードのファイルの mtime, source: "board" }` を1行追記する。
- 補わないとき:
  - 同じボードに同じ作業名が2つ以上ある。
  - 当てはまる見積もりが2件以上ある。
  - started が無い。
  - 会話番号が違う（`/clear` で番号が変わった場合を含む。README.md:182）。
  - ボードのファイルの mtime が見積もりの startedAt より前（実際の時間がマイナスになる）。
  - これらは補わず、見積もりは「始まったまま」で残す。画面では、始まってから 24 時間たっても終わっていない見積もりに「終わりの記録がありません」の札を出す。
- 始めた記録が無い見積もり: plannedStart を過ぎても started が無い見積もりには「始めた記録がありません」の札を出す。plannedStart が無いものは、打ってから 24 時間たっても started が無ければ同じ札。数（終わった件数など）には入らないが、当たり具合の画面に「始めた記録の無い見積もり N 件」「終わりの記録の無い見積もり N 件」を出す（黙って数から消さない）。
- 一度 done が入った作業は、次に気付いたときも (c) に当たらないので増えない。再起動しても log.jsonl に done があるので増えない。始める前から done だったボードの作業は、mtime が startedAt より前なので補わない（上の「補わないとき」）。
- 補った件は表と CSV（done_source=board）で分かる。
- 【未確認】作業名の揺れでどれだけ結び付けられるか → 便2 の第0段で実データ（dataDir/boards）を数える。

見積もりを立てる決まり: AI の起動指示に「作業を始める前に ac-schedule estimate を打つ」を足す。起動指示はこのリポジトリの外（salesanchor 側・~/.claude 側）なので本設計の対象外。便2 の後に、文面を PO に確かめてから別 PR で足す。

## 5 代替案と選んだ理由
| 案 | 中身 | 判断 |
|---|---|---|
| A（採用） | サーバーが Google 公式 API を読むだけの権限で読む。書くのは AI の接続 | （２）の「開いた時点」を AI 無しで毎回守れる。サーバーは読むだけ |
| B | サーバーに書く権限も持たせ、ac-schedule で予定も入れる | U2 が × のときの代わり。権限が広がる |
| C | カレンダーの「非公開の iCal アドレス」を読む | Google 側の設定が要らない。ただしアドレス1つで全予定が読める秘密になり、繰り返し予定の解釈に新しい部品が要り、中身の新しさが【未確認】 |
| D | 画面を開くたびに AI に接続で読ませる | 毎回 AI の時間と使用量がかかる。開くたびに AI を自動で動かす形は過去に避けた（定期実行の議論）。不採用 |

見積もりの記録の置き場:
| 案 | 中身 | 判断 |
|---|---|---|
| E（採用） | 追記だけの log.jsonl | （１１）「消えずに残る」と（１２）「最初の見積もりで判定」が、書き換えの口を作らないことで守れる |
| F | 作戦ボードの tasks に欄を足す | ボードは丸ごと書き換わり会話ごと（README.md:152）。最初の見積もりが残らない。不採用 |
| G | schedule.json の ScheduleItem に欄を足す | 上限 1000 件で古いものが消える（§4-3）。（１１）に反する。不採用 |

## 6 リスクと対処
- 鍵が7日で切れる（外部ユーザー型・テスト公開のとき）→ U1 が Workspace なら同意画面を「内部」にする。個人アカウントなら公開状態を「本番」にする手順を PO 手順書に書く（その際の Google の警告画面の扱いは第0段で実物確認）。切れたら画面に「もう一度つないで」を出す（黙って空にしない）。
- 鍵の漏れ → Keychain だけに置く。サーバーからの保存も `security -i` の標準入力で渡し、子プロセスの引数に出さない（§4-4）。ログ・画面・ファイルに出さない試験を入れる（K8）。権限は読むだけ。
- 戻り先が認証の前にある → state・PKCE・固定文面・ログに出さない（§4-4）。127.0.0.1 だけで待ち受け（server/index.ts:40）、Host は自分自身だけ（auth.ts:246-247）なので外からは届かない。
- Google が止まる・通信失敗 → 前回の写しを時刻つきで残し、赤字ではなく注意の Callout で知らせる。
- カレンダーに入っていない予定は出ない（10/30 の原因そのもの）→ 予定係に「今日の予定を確認して」と頼むと、空き時間に入っていない用事が無いかを聞き返す決まりを予定係の CLAUDE.md に書く。仕組みで完全には防げないことを PO に伝える。
- 日付の取り違え（来週火曜）→ AI は入れる前に「11/3（火）14:00〜15:00 で入れます」と日付を書いてから入れる決まり。
- Mac のメモリ（8GB）→ 写しは範囲2つ・各最大 5000 件をメモリに持つだけ（§4-4）。log.jsonl は1作業あたり数行で、1日20作業でも1年で約 2MB。読むたびに全体を読んでも軽い。
- 見積もりの打ち忘れ → ボードからの補完（§4-8）。補えない場合は「終わりの記録がありません」の札で見える化する（黙って数から消さない）。
- 社外の相手の名前 → カレンダーの題名をそのまま出す（PO の Mac の中だけ・ログに出さない）。やることに名前を入れるかは PO が決める（§14 の後で聞く）。

## 7 第0段（実装前に確かめること）
- S0-1: アプリ内で開いた opus-designer セッションの道具一覧に Google カレンダーの作成・一覧があるか（U2）。
- S0-2: PO の予定が入っている Google アカウントの種類（U1）。PO の手作業（§14）の中で分かる。
- S0-3: 127.0.0.1 の戻り先（本番 4319・試験の別ポート）がデスクトップ用クライアントで通るか（公式は任意の空きポートを例示）。
- S0-4: extraAllowedCwd（§4-5）を足した試作で、予定係のセッションが dataDir/schedule-assistant/ で開き、そのフォルダの CLAUDE.md を読むか。
- S0-5: dataDir/boards の実データで、作業名がどれだけ揺れるか（同じ作業の名前が doing と done で変わる件数）を数える（便2 の前）。

## 8 便の分け方（1回に1つ変える。この順に出す）
- 便1: やることの保存・画面用 API（items）・予定タブ（日／週／月・開発／秘書の時間割）・足す/終わった/消す・重なりの赤印。→（１）の半分・（３）・（５）
- 便2: 見積もりと実際。AI 用の口 `/api/agent/schedule` と ac-schedule.mjs の土台（合言葉・127.0.0.1・役割の検査）をここで作り、見積もりの命令（estimate/revise/start/done-estimate/cancel/list-estimates）を載せる。log.jsonl・ボードからの補完・開発の時間割の点線/実線・当たり具合の画面・CSV。第0段 S0-5 を先に行う。→（８）〜（１２）
- 便3: Google カレンダーの読み取り（つなぐボタン・戻り先・鍵・取得・表示）。PO の Google 側の初回設定（D1）が済んでから。→（１）（２）
- 便4: 予定係と話しかけ欄・launchAndSend の extraAllowedCwd・ac-schedule のやること命令（add/list/done/remove）・予定係の決まり。開発の列の自動表示。第0段 S0-1・S0-4 を先に行う。→（４）・（１）の残り
- 便の外: AI の起動指示に「作業前に見積もりを打つ」を足す（別リポジトリ・別 PR・PO 確認。便2 の後）。
- 後の設計: （６）知らせ＝既存の Discord 通知（スマホに届く）と macOS 通知を、1秒の時計で「1時間前・15分前」に1回ずつ送る。予約（ac-reserve）は使わない。（７）スマホ＝mobile-pwa の続き（Tailscale 待ち）。

## 9 受入（基準と検証のしかた）
| 基準 | 検証方法 |
|---|---|
| K1（１）予定タブを開くと、秘書側は時刻の目盛りつきの時間割で今日・明日の2列が出て、各予定が開始時刻の位置に長さどおりのブロックで出る。開発側に切り替えても同じ | e2e: 今日 10:00〜11:00 と明日 15:00〜16:00 の項目を作り、ブロックの上端が 10:00・15:00 の目盛りと同じ高さ（±2px）、高さが 60 分ぶん（±2px）であることを確認。開発側でも同じ。PO 目視（朝に開く） |
| K1b 日／週／月を切り替えると、日=2列・週=7列の時間割、月=升目に変わり、どの表示でも同じ予定が同じ日に出る | e2e: 今日 14:00 の予定を作り、3つの表示それぞれで今日の位置に出ることを確認。月表示で日を押すと日表示に移る |
| K2（２）Google で予定を足してから予定タブを開くと、その予定が出る | 単体: 偽の Google 応答で events.list の引数（timeMin/timeMax/singleEvents/timeZone）を日・週・月の3つで確認（週=月曜0時〜次の月曜0時、月=升目の最初〜最後の翌日）。nextPageToken を4ページたどり5ページ目で止めて truncated=true。PO 目視: Google で予定を足す→タブを開く→出る（60秒以内、または「読み直す」で即時） |
| K3（２）読めないとき空にせず理由と前回時刻を出す | 単体: 取得失敗・invalid_grant で写しが残り error が返る |
| K3b 戻り先が安全に動く | 単体: state 無し・不一致・11分後・2回目の使用で、鍵の交換が呼ばれず Keychain に書かれない。応答の HTML に渡した code・state・error の文字列が含まれない。ログの出力に code が含まれない。正しい state では交換が1回呼ばれ、writeKeychainItem が1回呼ばれる。Authorization ヘッダー無しで serveStatic に落ちず分岐に入る |
| K4（３）足す・終わった印・消すが画面ででき、再起動後も残る | e2e: 足す→終わった→消す。単体: ScheduleStore の保存・壊れたファイルを上書きしない |
| K5（４）話しかけ欄に「11/6 に〇〇のやることを秘書に足して」→画面に出る | PO 目視（便4の後）。単体: ac-schedule の検査（役割・Origin・上限）。単体: §4-5 の試験 (a)〜(g)（作業フォルダの例外・復元・見分け方・開いている途中） |
| K6（４）「この面接を来週火曜に入れて」→ Google に入り、画面に出る | PO 目視（便4の後、S0-1 が ○ のとき） |
| K7（５）重なる2行の両方に赤印、重ならない行には出ない | 単体: findOverlaps（端が接するだけは重なりでない・終日除外・end 無しは30分） |
| K7b（５）重なる予定が時間割で左右に並び、互いに隠れない | 単体: layoutDay（13:00〜14:15 と 14:00〜15:00 が左右に分かれる・重ならない予定は全幅）。e2e: 2つのブロックの横の範囲が重ならない |
| K10（８）（９）見積もりを打つと時間割に点線の枠、終わりを打つと実線の枠と結果札が出る | e2e: 試験の前に、試験用の dataDir の estimates/log.jsonl へ時刻を決めた行（今日 10:00 始める予定・60分の estimated、10:00 の started、11:35 の done）を書き込んでおく（サーバーは読むたびにファイル全体を読むので、書いた行がそのまま画面に出る。Playwright の偽の時計はサーバーの時刻に効かないので使わない）→ 点線の枠の上端が 10:00・高さ 60 分ぶん（±2px）→ 実線の枠が右隣に出て「1.6倍かかった」。AI 用の口（/api/agent/schedule）を通す確かめは単体（ac-schedule の試験）で行い、e2e では使わない（生きている opus-designer のセッションが要るため）。単体: 結果札の文言（60→75 は「見積もりどおり」、60→76 は「1.3倍かかった」、60→44 は「0.7倍で終わった」、60→45 は「見積もりどおり」、95/60 の丸めは 1.6） |
| K11（１０）週の数字が記録どおりに出る | 単体: summarizeEstimates — (a) ±25%: 60→75 は以内・76 は外・45 は以内・44 は外 (b) 直した見積もり（60→revise 120→実際 75）は最初の 60 で判定して以内 (c) 締め切り: doneAt=due は間に合った、due+1分は遅れ、due の無い作業は分母に入らない、全部 due 無しは「—」 (d) 真ん中の値: r が [1.0, 1.5, 2.0] で 1.50、[1.0, 1.2, 1.4, 2.0] で 1.30 (e) 週の境目: 日曜 23:59 の done はその週、月曜 00:00（日本時間）の done は次の週 (f) 8週の棒は常に8本、0件の週は「—」 (g) cancelled と終わっていない作業は数えない |
| K12（１１）（１２）記録が消えず CSV で出る・直した回数が出る | 単体: log.jsonl への追記だけ（既存の行のバイト列が変わらない）・壊れた行を飛ばして残りを読み、飛ばした数を返す・順番違反（started 前の done 等）は 409。単体: CSV の1行目が §4-8 の17列の見出しと一致、行数＝作業の数＋1、BOM 付き。e2e: K10 と同じく、log.jsonl に estimated → revised → revised → started → done の5行を先に書き込み、時間割の枠と当たり具合の表に「直した 2回」、CSV の revisions 列が 2 |
| K13 打ち忘れの補完 | 単体: (a) started 済みの見積もりと同じ会話番号・同じ作業名のボードが doing→done になると、done(source: board) が1行だけ追記される (b) もう一度読み直しても増えない (c) サーバーを再起動して全部を読み直しても増えない (c2) start より前の mtime で done のボードは補わない (c3) dataDir/estimates/ に board-seen.json など log.jsonl 以外のファイルができない (d) 同じ作業名が2つ・会話番号違い・started 無しでは追記されない |
| K8 秘密が画面・ログ・ファイル・子プロセスの引数に出ない | 単体: ログ出力と API 応答に鍵の値（試験用の偽の値）が含まれない。dataDir 下の新しいファイル（schedule.json・estimates/log.jsonl）に偽の値が含まれない。writeKeychainItem が spawn に渡す引数の配列が `["-i"]` だけで、偽の値は標準入力にだけ書かれる |
| K9 既存の試験と CI が緑 | CI check（ubuntu / macos）。`/api/schedule/preview` と予約・定期実行・復元の既存試験が変わらず緑。tests/e2e/console.spec.ts:769 の dataDir 直下の一覧（起動時に必ずできるものだけ）に schedule-assistant を足し、起動時にはできない schedule.json・estimates を除外（今の activity・boards と同じ扱い）に足して緑。playwright.config.ts の app の testMatch に schedule を足し、tests/e2e/schedule.spec.ts が CI で実際に動いた（結果に schedule.spec.ts の行がある）ことを確かめる |

## 10 戻し方
- 1つ前の版へ `bash scripts/ac-update.sh v<前の版>`（切り戻し手順は README の PO 向け節）。schedule.json・estimates/ は旧版が読まないだけで残る。Google との接続は Keychain の3項目を消し、Google のアカウント設定で接続を取り消す。

## 11 維持の仕組み
- 正本: やることは schedule.json（書き手はサーバーだけ）、予定は Google カレンダー（アプリは写しだけ）、見積もりと実際は estimates/log.jsonl（追記だけ・書き手はサーバーだけ）。
- 試験: tests/unit（schedule-store / google-calendar / google-oauth-callback / keychain-write / find-overlaps / layout-day / estimate-log / summarize-estimates / board-complement / estimates-csv / ac-schedule / launch-extra-cwd / restore-assistant / assistant-session）と tests/e2e/schedule.spec.ts を CI が毎回回す。
- e2e を CI で動かすために: playwright.config.ts の app の testMatch（今は console|activity|chat|reservations|relay|terminal-wheel|pc-meter|file-link だけ）に schedule を足す。dataDir 直下の一覧を完全一致で比べている tests/e2e/console.spec.ts:769 には、起動時に必ずできる schedule-assistant だけを足す。schedule.json（最初にやることを書いたときに作る）と estimates/（最初に見積もりか補完の行を書いたときに作る）は起動時に作らないので、除外の側（activity・boards と同じ）に足す。
- 決まりの置き場: README に「予定」節（使い方・AI の命令・鍵の登録・つなぎ直し・見積もりの打ち方と数え方）。予定係の決まりはアプリが写す CLAUDE.md（正本はリポジトリの hooks/ 横に置く）。

## 12 外部事例
- 使った根拠は Google の公式資料のみ（recon.md「Google 公式資料」）。予定の取りこぼしが画面でどれだけ減るかの、数値つきの直接の事例は見つけていない。効果は事例でなく、導入後の PO の毎朝の目視（K1・K2）と、遅刻・取りこぼしが起きたかの記録で測る。
- 見積もりの当たり具合も、外部の数値を目標の根拠にしていない。目標の線 70% は見本の仮の値で、最初の8週の実測を見てから PO と決め直す。

## 13 審査の履歴
- 第1回（Opus 2026-10-30・自己審査）: REVISE。(a) U2 が × のときの代わりが無い→§4-5 末尾と案 B を追加 (b) 7日切れの対処が無い→§6 に追加 (c) カレンダーに無い予定は仕組みで拾えない点が成功条件の外にあることを明記→§6 に追加。
- 第2回（同日・自己審査）: APPROVE（設計として）。未解決: U1・S0-3 は PO の手作業の中で確かめる。
- 第3回（同日、PO 指摘を受けて）: REVISE→修正済み。第1版の画面は一覧で、PO の言う「スケジュール（タイムテーブル式）」を入れ忘れていた。§4-1 を時間割に書き直し、§4-6 に layoutDay、§9 の K1 を位置で測れる形にし K7b を足した。
- 第4回（同日、PO「day/week/month の切り替えタブは？」を受けて）: REVISE→修正済み。§4-1 に日／週／月を足し、§9 に K1b を足した。
- 第5回（同日、PO の見積もり依頼を受けて）: 草案。§4-8 と K10〜K12 を足した。見本は https://claude.ai/artifact/W2HibYmeYxLbJwSUYD7QVT。
- 第6回（同日・自己審査）: APPROVE（設計として）。
- 独立審査 第1回（reviewer・Opus 新規起動 2026-10-30、全文 /tmp/CC報告ファイル/schedule-board/review-pr92.md）: REVISE（高4・中6・低4）。引用の行はすべて実物と一致。
- 第7回（同日、独立審査の反映）: H1→§4-5 extraAllowedCwd・S0-4。H2→§4-4 戻り先を認証の前の分岐に・state/PKCE/反射/ログ/ポート・K3b。H3→§4-8 打ち忘れの補完（30秒ごとの mtime・board-seen.json・条件と補わないとき）・K13。H4→§4-8 型・番号・順番・命令 revise/cancel・§4-7 API。M1→K10・K11・K12 を数で決まる形に・CSV の列。M2→§4-4 読む範囲・ページ送り・呼び出し数・§6。M3→§4-4 writeKeychainItem（security -i の標準入力）・account 3つ・K8。M4→§4-5 担当は打てない・合言葉と役割は既存の reserve-token と reserveRoles。M5→§4-1 確定。M6→§3 対象・対象外、§8 を実行順（見積もりを便2、ac-schedule の土台も便2）。L1→§4-3 deps のキー名・§4-7 preview との並び。L2→recon.md の行番号。L3→節を番号順に。L4→§4-8 未決の間は差し引かない。
- 独立審査 第2回（reviewer・Opus 新規起動 2026-10-30、全文 /tmp/CC報告ファイル/schedule-board/review-pr92-r2.md）: REVISE（中5・低6）。前回の14件はすべて直っていた。
- 第8回（同日、第2回の反映）: N-M1→§4-5 再起動では予定係を戻さず知らせも出さない（restore.ts で飛ばす）・試験 (e)。N-M2→§4-5 予定係の見分け方（番号をメモリに1つ・slotKey）・試験 (f)。N-M3→§4-8 見積もりの完了は done-estimate、ScheduleItem.id は sch_＋12文字。N-M4→K10・K12 の e2e は log.jsonl に行を先に書いて確かめる。N-M5→§11・K9 に console.spec.ts:769 と testMatch。N-L1→§4-4 拒否する文字・securityBin・出力を捨てる。N-L2→§4-8 最初の1回・読めないボード・消えたボード・mtime が開始より前。N-L3→§4-5・§4-8 番号が無ければ 403・sessionName の出どころ・監査の記録・reserveRoles の共用。N-L4→§4-4 写しの鮮度 60 秒。N-L5→§4-1 金型 Tabs。N-L6→§4-8 始めた記録が無い見積もりの札と件数。再審査は reviewer（Opus 新規起動）に、中5件と低6件に絞って頼む。
- 独立審査 第3回（同日、全文 /tmp/CC報告ファイル/schedule-board/review-pr92-r3.md）: REVISE（中4・低2）。第2回の11件中8件は直っていた。
- 第9回（同日、第3回の反映）: R3-M1→§4-5 再起動では予定係も戻し番号を覚え直す（飛ばすと tmux に残るため）。R3-M2→slotKey は jstSlot(new Date()).key。R3-M3→§4-5 開いている途中の待ち行列・失敗時の画面・202 と assistant.state・試験 (g)。R3-M4→console.spec.ts:769 は schedule-assistant だけ一覧へ、schedule.json・estimates は除外へ。R3-L1→§4-5 監査の名前2つ・欄・拒否も書く。R3-L2→K5 を (a)〜(g) に。
- 第11回（同日、実装前の実物照合 §15）: ボードの写し board-seen.json を取りやめ（二重持ちのため）・1時間の高さをトークン --schedule-row-height に・設定の置き場を config.json の schedule に・金型に無い部品を D4 として PO に聞く。
- 独立審査 第4回（同日、全文 /tmp/CC報告ファイル/schedule-board/review-pr92-r4.md）: APPROVE。6件すべて〇・重大な新しい指摘なし。合否に関係しない気付き3つ（開けなかったときのセッションを閉じる・復元が2つのとき createdAt で選ぶ・§4-7 に 202/429/409 と assistant を書く）と行番号1か所を第10回で反映。

## 14 PO の決定
- D1: Google カレンダーをアプリに読ませるための、Google 側の初回設定（PO の手作業・約15分・Google の管理画面での操作）を行うか。→ 行う（2026-10-30 PO「1」）。手順は Opus が画面ごとに案内する。
  - U1 の答え（2026-10-30 PO）: 予定が入っているのは会社の独自ドメインのアカウント。Google Workspace かどうかは、同意画面で「Internal」を選べるかで確かめる（まだ確かめていない）。
  - 案内する手順（公式頁 configure-oauth-consent・enable-apis 2026-09-03 更新、create-credentials 2026-10-12 更新を確認）: ①そのアカウントで Google Cloud console を開き、プロジェクトを作る ②Calendar API を Enable ③Google Auth platform > Branding > Get Started で App name・User support email → Audience で Internal → Contact Information → 規約に同意して Create。Internal の場合、Data Access でのスコープの登録は要らない（同頁）。
  - 結果（2026-10-30 PO「終わった」）: ①〜③を PO が実施。止めの連絡は無く、Internal で作れたと PO の報告で受けた（Opus は画面を見ていない）。
  - 「Internal」が選べなければそこで止め、Opus に知らせてもらう（個人向けの手順に切り替える）。
  - Desktop app のクライアントを作る段（Clients > Create Client）は、アプリ側に鍵を受け取る入れ物ができる便3の直前に行う。秘密の値をチャットに貼らせないため。後から値を見られるかは公式頁に記載がなく、まだ確かめていない。便1・便2 はこれに依存しないので先に作れる。
- D3: 作り始めてよいか → 作り始めてよい（2026-10-30 PO「1」）。順番は §8 のとおり（やることと見積もり → Google の読み取り → AI に話しかける）。
  - 同時の PO 指示（2026-10-30 原文）:「推測は禁止して事実確認を怠らずに確実性を重視して最も効果があり、現状把握の粒度が細く、精度が高いエビデンスを確立して安全に進めてくれ。また配線とDBのSSOTは遵守してデータを分散させることは禁止。フロントエンドのパーツもデザイントークンとデザインシステム を遵守して、金型登録のないハードコードを禁止する。推測で自身で判断したり不透明無まま進めることは禁止、分からないことは聞いてくれ。確立したなら進める。」
  - これを受け、実装カードを出す前に、金型・トークン・データの置き場を origin/main の実物で照合する（結果は §15 に書く）。照合が済むまで実装には渡さない。
- D2: 見積もりの成功条件（８）〜（１２）→ 承認（2026-10-30 PO「1」）。
- D4: 金型に無い部品（時間割・月の升目・棒の図・点線の決まり）の扱い（§15-1）→ 返事待ち（2026-10-30）。返事まで画面の部分は実装に渡さない。PO から既製の部品を取り込む案が出て、比較の結果（§15-1）で FullCalendar を推奨し、取り込む部品を聞いている（2026-10-30）。
- 後で聞く: 実際の時間から PO の確認待ちの時間を差し引くか（未決の間は差し引かない）／やることに社外の相手の名前を入れてよいか／最初に入れる秘書側のやること（引き継ぎ §4）／当たり具合の目標の線（最初の8週の後）。

## 15 実装前の実物照合（2026-10-30、PO 指示「推測禁止・SSOT・金型」を受けて）
照合の版: agent-console origin/main de28ba7、salesanchor origin/main ad5edd0。生の結果 /tmp/CC報告ファイル/schedule-board/ssot-facts.md（担当 Sonnet が読み取り、Opus が要点を照合）。

### 15-1 金型とトークン（事実）
- `@sa` は salesanchor frontend/src の写し（agent-console vite.config.ts:4,8、tsconfig.json:15、scripts/sa-sync.mjs:36）。金型の正本は salesanchor 側。
- §4-1 の Tabs・Badge・Button・Callout・EmptyState・Modal は全部ある（salesanchor frontend/src/components/Tabs.tsx:52、Badge.tsx:36、Button.tsx:43、Callout.tsx:25、EmptyState.tsx:33、Modal.tsx:36）。
- 時間割（日・週）・月の升目・縦の棒の図の金型は無い。salesanchor の予定ページに時間割と月の升目の実装はあるが、ページの中だけで外に出していない（pages/schedule/SchedulePageImpl.tsx:568 ScheduleWeekGrid・:732 ScheduleMonthGrid、export は :826 の SchedulePage だけ）。
- 時間割のトークンはある（tokens.css:365-390。--schedule-row-height 48px「1時間の高さ」、--schedule-time-gutter-width、--schedule-now-line、--schedule-month-cell-min-h、--schedule-day-min-w ほか）。種類の色 --cal-*（:393-399）と図の色 --chart-series-*（:409-415）もある。
- 点線（dashed）の線と線の太さのトークンは無い。agent-console の検査（scripts/check-design-governance.mjs、CI の npm run lint）は border の 1px 以外の長さの直書きを止める。
- 金型の登録の決まり（salesanchor docs/CC_UI_GOVERNANCE.md:9, :14-15）: 金型に無い部品は、PO の許可を得て components/ に Xxx.tsx・Xxx.css（var() のみ）・Xxx.stories.tsx で登録してから使う。agent-console には ui-allow の例外の仕組みが無い。
- 使い回せるかの照合（salesanchor origin/main a742879、生の結果 /tmp/CC報告ファイル/schedule-board/sa-calendar-facts.md）。PO 質問「すでに salesanchor にカレンダーの金型があるがそれを今回のイメージに横展開できる？」への事実:
  - 登録済みの金型（components/）ではない。予定ページの中の部品（SchedulePageImpl.tsx:568 週・:732 月。外に出していない。部品の .stories も無い。Schedule.stories.tsx は CSS の見本だけ）。
  - そのまま使える所: 列の数は渡す日の数で決まる（:568-587 days）、重なりの横並び（schedule-utils.ts:207-235 layoutDay）、いまの線、終日の帯、押したときの動き、月の升目の「+N」。
  - 足りない所: 予定ごとの見た目を変えられない（点線・赤枠・札。schedule.css:549 の shift だけ）、中身を差し替えられない、時刻の範囲が 24 時間固定（:86 ほか）、色が担当者の色に固定、月の升目の件数が3で固定。
  - Sales Anchor だけの物に頼っている（担当者 schedule-owner、カレンダーの設定 features/schedule/calendars.config、日本語の直書きの "ja-JP"）。
  - 棒の図の金型は無い（recharts をページで直接使用。DashboardPage.tsx:26、LlmUsageSection.tsx:14）。点線のトークンも無い（pages-layout.css:698 の直書きだけ）。
「金型登録のないハードコード」になる。登録するかを PO に聞く（D4）。返事まで便1（画面）は渡さない。
- 既製の部品を取り込む案（2026-10-30 PO「同じようなクローンがあれば使いたい…合意できる？」→ Opus 合意。条件: 試作の見た目を作れる・色と大きさをトークンに置き換えられる・有料版なしで要る機能が使える・手入れが続いている・今の作りと組み合わせられる）。
  - 机上の比較（生の結果 /tmp/CC報告ファイル/schedule-board/calendar-lib-research.md）: salesanchor frontend/package.json:72-76 に @fullcalendar/*（^6.1.20、MIT）が既に入っていて、ソースからは使っていない。react-big-calendar は CSS 変数で色を変えられない、TOAST UI は手入れ停止（archived）で外した。
  - FullCalendar を前に外した理由（生の結果 /tmp/CC報告ファイル/schedule-board/fullcalendar-history.md）: 導入 PR #765（2026-05-25）、置換 PR #2399（2026-06-21、本文は「Google Calendar style parity」のみ）。部品の問題を理由とした記述は origin/main のどこにも無い。本当の動機は未確認。
  - 実際に動かした比較（FullCalendar 6.1.20 と Schedule-X 4.9.1、React 18.3.1、Asia/Tokyo、有料機能なし。生の結果と画像 /tmp/CC報告ファイル/schedule-board/spike/RESULT.md、fc-*.png、sx-*.png。Opus が fc-two.png・sx-two.png を目視で照合）:

    | 確かめたこと | FullCalendar | Schedule-X |
    |---|---|---|
    | 2列と7列 | ○ 日数2の表示を標準で作れる | ○ 週の始まりを今日に合わせる回避策が要る |
    | 月の升目 1日2件＋残り件数 | ○ | ○ |
    | 重なりの横並び＋赤枠＋札 | ○ | ○（重なりを許さない指定が要る） |
    | いまの線 | ○ 標準 | ○ 別の部品が要る。線の色が直書きで変数で変えられない |
    | 終日の帯 | ○ | ○ |
    | 見積もり点線・実際の実線・中の札 | ○ 中身を React で差し替え | ○ 中身は HTML の文字列だけ確認 |
    | 8〜20時・1時間 48px | ○ 実測 49px（30分の枠 24px＋線 1px）。高さは変数でなくセレクタ指定 | ○ 実測 48px。先頭の時刻の字が欠けた |
    | 変数だけで色を替える（暗い画面も） | ○ --fc-* 29個。変数を通らない色は影の rgba 7種と透明の線 | ○ --sx-* 59個。変数を通らない色は #eceef1・#4a4458・#f00 ほか |
    | 日本語と日本時間 | ○ 日本語は同梱 | ○ 日本語は別の部品が要る |
    | 配る JS の大きさ（gzip） | 120,514 B | 124,869 B（ほかに CSS 5,807 B） |
  - 判断（Opus 推奨・PO 未承認）: FullCalendar v6 を包んだ金型を salesanchor components/ に登録して使う。理由: 既に依存に入っている／回避策なしで要る形が全部出た／いまの線が無料の標準機能で変数で色を替えられる／中身を React で差し替えられる。
  - 残る未確認: v7 に上げるか（最新 v7.1.3、v7 の色の変数の仕組みは見ていない）、1時間の高さを --schedule-row-height だけで決める方法（今はセレクタ指定で 49px）、影の rgba 7種をトークンに寄せる方法、実機のスマホ幅。これらは金型を作る設計で確かめる。

### 15-2 データの置き場（事実と決定）
- やること schedule.json、見積もり estimates/log.jsonl、Google の予定はメモリの写しだけ（ファイルに残さない）。それぞれ書き手はサーバーだけ。
- ボードの写し board-seen.json は、ボード正本 boards/<番号>.json の tasks の title・status と同じ値を持つ二重持ちだった（ac-board.mjs:121-142）。第11回で取りやめ、log.jsonl から判定する形に変えた（§4-8）。
- 画面の localStorage は「日／週／月」の選択だけ（データではなく表示の好み。既存の theme.ts:16・ledgerFilter.ts:79 と同じ使い方）。

### 15-3 設定の置き場（決定）
- agent-console に画面から書ける設定の置き場は無い。設定は agent-console.config.json だけで、型は server/config.ts:84 の Config、読むのは parseConfig（:293）・loadConfig（:425）、書くのは人の手だけ。
- §4 の `schedule.calendarIds`・`schedule.devCalendarIds`・`schedule.assistantCwd`・`schedule.accuracyTarget` は、すべて Config に `schedule` の項目として足し、parseConfig で検査する（reserveRoles と同じ置き場。config.ts:377）。ほかの場所（dataDir のファイル・画面の localStorage）には持たない。
