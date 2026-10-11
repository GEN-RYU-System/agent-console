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
