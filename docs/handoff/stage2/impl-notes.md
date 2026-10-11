# 段階2 実装メモ

設計: docs/handoff/stage2/design.md ／ カード: docs/handoff/stage2/card.md ／ 実装: Claude Sonnet

## 実装順と対応するコミット範囲
1. ⑤メモリ: server/process-tree.ts（rss 列・sumRssKb）、server/memory.ts、GET /api/memory、src/components/MemoryPanel。
2. ①区切りの通知: server/notify.ts（isBreak・BreakTracker・osascript 送信）、Hub の detectBreaks、POST /api/sessions/:id/read、窓タイトル、ヘルプ文。
3. ②名前: POST /api/sessions/:id/rename、SessionView.hasClaude、src/components/RenameForm。
4. ②よく使う指示: server/quick-prompts.ts、/api/quick-prompts（CRUD）と POST /api/sessions/:id/send、src/components/QuickPrompts。
5. ③過去のセッション: server/past-sessions.ts、GET /api/past-sessions、POST /api/sessions/resume、SessionManager.resume。
6. ④台帳の絞り込み: server/ledger.ts（parseStartedAt）、src/components/LedgerBoard/ledgerFilter.ts。
7. version 0.3.0、CHANGELOG、README。

## 設計・カードとの差分と判断（実装者の判断なので設計者の確認が要る点）
- 端末への送信の改行は `\r`（pty の Enter は CR。Orca も `\r`: recon §B2）。設計書の「改行」をこの意味で実装した。
- 通知の osascript の場所は設定 `notify.osascriptBin`（既定 `/usr/bin/osascript`）。テストでスタブに差し替えるために設定へ出した。設計 §4-1 の既定は変えていない。
- 設定 `dataDir`（既定 `~/Library/Application Support/agent-console`）、`notify.macos`（既定 true）、役割の `resumeCommand` を追加。どれも省略可能で、省略時の動作は設計どおり。
- よく使う指示の文章は、改行・タブ以外の制御文字（ESC など）を拒否する（端末へエスケープ列を送らないため）。上限は設計どおり 8KB（バイト数）、件数は 40 件、ボタン名は 40 字。設計に無い上限なので確認してほしい。
- 台帳の「開始日時」は `YYYY-MM-DD HH:MM`（この Mac のローカル時刻）だけを日付として読む。`YYYY-MM-DD` だけの行は「日付不明」になる（設計 §4-5 のとおり厳密に実装）。
- 台帳の絞り込みで「隠れた件数」「日付不明」「表示」は必ずどれか 1 つに入る（合計が総数と一致）。状態の条件に合わない行は、日付不明でも「隠れた件数」に数える。
- 過去のセッションの「実行中」は、`agents --all --json` の pid が、このアプリのセッションの子孫プロセスに含まれるかで判定する（含まれる行は再開不可）。
- 再開時の作業場所は画面から受け取らず、サーバーが `claude agents --all --json` の行から引く（sessionId は UUID 形式のみ）。本店または `git worktree list --porcelain` に載る場所でなければ 400。
- メモリの Mac 全体は `sysctl -n hw.memsize` と `memory_pressure` の最終行（free percentage）。macOS 以外では取得できず、画面は「取得できません」と出す。使用 % は 100 から空き率を引いた値。
- 一覧の名前は、Claude が name を返している間は Claude の name、返さなければアプリの名前（設計 §4-2）。

## 確認した事実（コマンド出力）
- `claude agents --all --json`（この Mac、読み取りのみ・値は出さず型だけ確認）: 行のキーは pid / cwd / kind / startedAt（整数、エポックミリ秒）/ sessionId / name / status。
- ps の rss は KB（recon §E1、`man ps`）。`ps -axo pid=,ppid=,rss=` の 3 列を解析する。

## 既知の限界
- osascript 通知の初回は、macOS 側の通知許可が要る可能性がある（実機確認はこの PR の範囲外。スタブで呼び出し内容だけ検証）。
- 実 Claude での `/rename` と、`--resume` の実起動は PO 確認 1 回（設計 §2 K2・K4）。

## 修正ラウンド1（review-stage2.md への対応）

### 1. 端末への送信の安全（M1 / L1 / L6）— design.md §4-2・§4-3 を先に別コミットで更新
- 設計変更: `POST /api/sessions/:id/send` を廃止し、`POST /api/sessions/:id/send-check` にした。サーバーは端末へ書かない。要求を受けた時点で `claude agents --json` を取り直し（server/hub.ts の `checkInput`）、入れてよければ本文を返す。画面が xterm の `paste()` で本文を入れ、続けて `input("\r")` で Enter を送る（src/components/TerminalPane/TerminalPane.tsx の `pasteAndEnter`）。許可トークンは発行しない（本文の入力が認証済みの人の入力経路と同じ道になり、サーバーが別に書く経路が無くなるため）。
- 判定（server/agents.ts `inputVerdict`）: Claude 起動中は status が idle かつ waitingFor が無いときだけ。それ以外は 409 と理由（`claude is busy` / `claude is waiting` / `claude is waiting for input`）。`claude agents --json` を読めないとき・停止中も 409（Claude の有無を判定できないため）。Claude が動いていないシェルは従来どおり。`/rename` も同じ判定（waiting は許可しなくなった）。
- 一覧には `canInput` を載せ、画面のボタン（名前を変える・よく使う指示・名前の変更フォーム）を同じ条件で無効化する。
- xterm の API 原文（実物 node_modules/@xterm/xterm/typings/xterm.d.ts、版 6.0.0）:
  - `paste(data: string): void` 「Writes text to the terminal, performing the necessary transformations for pasted text. @param data The text to write to the terminal.」
  - `input(data: string, wasUserInput?: boolean): void` 「Input data to application side. The data is treated the same way input typed into the terminal would (ie. the onData event will fire).」
  - `ignoreBracketedPasteMode?: boolean` 「Whether to ignore the bracketed paste mode. When true, this will always paste without the `\x1b[200~` and `\x1b[201~` sequences, even when the shell enables bracketed mode.」（既定は無視しない＝端末が有効にしていれば括弧で包む）
  - Context7（/xtermjs/xterm.js）は paste の本体コードまでは出さなかったため、挙動は e2e で実測した（下記）。
- 実測（e2e「複数行の指示は、括弧付き貼付モード…」）: 括弧付き貼付モード（ESC[?2004h）を有効にした端末アプリには `"\u001b[200~first-line\rsecond-line\u001b[201~\r"` が届いた。本文は括弧で包まれ、改行は `\r` になり、Enter（`\r`）は閉じ括弧の直後に続く（端末アプリ側の 1 回の読み取りにまとまることがある）。括弧付き貼付を有効にしない端末（既存の役割）には、本文がそのまま入り、Enter が続く。
- 区切りの検知・通知・未読の処理は端末に書かない: `daily-use.integration.test.ts` で `sessions.write` が呼ばれないこと・端末の出力が変わらないことを固定（L5）。

### 2. L2 メモリ集計
- server/memory.ts の `MemoryCollector`: ps・sysctl・memory_pressure の結果を 5 秒キャッシュし、同時の要求は 1 回の実行にまとめる（失敗はキャッシュしない）。セッション一覧は要求ごとに最新を使う。単体テストは tests/unit/memory.test.ts。

### 3. L3 再開の二重起動
- 再開は、その sessionId が `claude agents --json`（現在動いている一覧。別のターミナルのものも含む）にあれば 409。この一覧を取得できなければ 409（二重でないことを確認できない）。`claude agents --all --json` の行に別の場所で動いているセッションが含まれるか・status の値の範囲は引き続き未確認（U2）なので、サーバーは両方の一覧を突き合わせている。

### 4. L4 BreakTracker.forget
- `SessionManager.onRemoved` を足し、Hub が一覧から外されたセッションの `forget` を呼ぶ（テストで呼び出しを確認）。

### 7. L8 再開の対象
- 一覧の各行に「再開不可（理由）」を出す（running / main / outside / missing）。cwd が本店（salesanchorRoot）そのもの = Opus 設計役のセッションは対象外（design.md §3・§12）。再開できるのは cwd が本店のワークツリー（`git worktree list --porcelain`）の行だけ。サーバーも同じ判定で 400。

### 6. L7 メモリ画面の名前
- /api/memory は一覧と同じ表示名（Claude の name 優先）を使う。

### 8. 見た目
- ① 版表示: 版は server/index.ts:32 `readVersion()` が起動時に process.cwd() の package.json から読み、server/http.ts:113 の `appVersion` として返し、src/pages/ConsolePage.tsx:293 のフッターに出す。前回のスクショ 01・02 は 0.3.0 への版上げ（package.json を 0.2.1→0.3.0 にした作業）より前に撮ったため 0.2.1 と出ていた。コードの不具合ではない。撮り直したスクショは「版: 0.3.0」。e2e「フッターに … 版」は package.json の版と一致を見ている。
- ② メモリ画面の %: SA の ProgressBar（.sa-cache/frontend/src/components/loading/ProgressBar.tsx:14 `clamp = Math.max(0, Math.min(100, Math.round(n)))`、:54 `${pct}%`）は値を整数に丸めて表示する。アプリ側の文字は 0.4 のように小数 1 桁だったので食い違った。`percentOf` を整数丸めにして、棒と文字で同じ値にした（0.4% は両方「0」）。

### 9. ローカルの並列テストの 5 秒タイムアウト（実測）
- 計測: `npx vitest run --reporter=json`（既定の並列、load averages 17〜23 の Mac。他のエージェントも動いている）。結果は /tmp/CC報告ファイル/orca-selfbuilt/s2/vitest-default.json。
- 5 秒を超えて落ちた 2 件（その回）:
  - tests/unit/design-governance.test.ts「reports px/rem/em literals…」5536ms: 1 つの it の中で `node scripts/check-design-governance.mjs` を 9 回（同期の spawnSync）起動していた。1 回あたり約 0.6 秒が 9 回で 5 秒を超えた。
  - tests/unit/keychain.test.ts「fails when the secret is empty or malformed」5012ms: 1 つの it で bash スタブを 3 回起動。
- 修正: どちらも 1 回の起動を 1 つの it にする（it.each など）。タイムアウト値は変えていない。design-governance は 5 つの it を 1 件ずつの it に分け、modern color functions は it.each にした。
- 前回の別のタイムアウト: src/pages/ConsolePage.test.tsx の最初のテスト。`await import("./ConsolePage")`（SA の金型を含む画面全体の変換・読込）が最初のテストの 5 秒に含まれていた。ファイルの先頭で 1 回だけ読むようにした。
- 別の遅いファイル（失敗はしていない）: tests/unit/scripts.test.ts は 1 つの it が最大 24 秒（導入・更新・切戻しの実スクリプトを複数回起動）。非同期の待ちが無い同期処理が中心で、vitest の 5 秒の判定にかからないまま通っている。実環境へ触れないスタブ構成。今回は変更していない。
- 修正後の既定並列（load averages 約 23）: `Test Files 41 passed (41)` / `Tests 446 passed (446)`（Duration 186s）。
