# 現在地: チャットの予約条件（基準 origin/main df660d0・0.17.0）

調査は担当（Sonnet）、読み取りのみ。生出力: /tmp/CC報告ファイル/agent-console-busy-send/。

## 判定
- server/agents.ts:6 AgentStatus = busy|waiting|idle|unknown。:24 KNOWN_STATUS 以外は parseAgentsOutput（:27-53）が unknown。
- server/agents.ts:80-88 inputVerdict: 終了済み→不可／rows null→不可（"claude state is unknown"）／Claude の行なし→ok・hasClaude:false／status が idle 以外→不可（`claude is ${status}`）／waitingFor あり→不可／他→ok。
- server/agents.ts:90-99 stateForSession: busy→working、waiting→waiting、idle→idle、行なし→no-claude、rows null→unknown。

## 送信の流れ
- server/hub.ts:150-157 pollAgents（agentsPollMs=3000、agent-console.config.json:8）の末尾で flushChatQueues（:322-325）。enqueueChat（:249-260）直後にも1回。
- server/hub.ts:342-380 flushChatQueueOnce: :354-355 で poll の status が busy/waiting なら chatSentGuard を外す／:357 guard があれば止まる／:358 inputVerdict が ok でなければ止まる（busy はここで止まる）／:359-360 checkInput で取り直し／:367 sent に／:368 guard 設定／:370 括弧付き貼り付け／:371 2000ms（pasteSubmitDelayMs、config.json:17）／:372-373 取り消し等なら Enter を送らない／:374 "\r"。
- chatSentGuard（:90）の解除: :355、reconcileChatQueues の user 記録（:314-318）、cancelChat（:267）、dropChatState（:280）。

## 共有している呼び出し元（inputVerdict を変えると波及）
- inputVerdict: hub.ts:229（名前変更）、:358（チャット）、:532（snapshot canInput）。
- checkInput: hub.ts:198, :231, :359、chat-routes.ts:62、diff-routes.ts:60、picks-routes.ts:80、http.ts:281（よく使う指示）、routines.ts:75（定期実行。reason の文字列で分類。tests/unit/routines.test.ts:27 が "claude is busy" 前提）。
- 画面の canInput: ConsolePage.tsx:393,416,431,445、RenameForm.tsx:21、DiffPane.tsx:172、PicksPane.tsx:200、ChatPane.tsx:103。

## 画面
- src/components/ChatPane/chatLogic.ts:31-42 queueNoticeKey(state, canInput)。ChatPane.tsx:103, :214-223（waiting のときだけ「端末を開く」）。
- src/locales/ja.json:406 queue.note、:407 queue.queued、:413 queue.notice.working（en.json は無い）。README.md:56-62 v0.13.0 節。

## 過去の実測（chat2 recon, docs/handoff/chat2/recon.md）
- C-1（:40-58）作業中に貼って2秒後に Enter → 順番待ちに入り、作業は止まらない。
- C-2（:60-88）許可の確認中に貼って Enter → 4回とも「1. Yes」が押され、文は消える。
- C-3（:90-100）確認中に貼るだけ → 何も起きず、文は消える。
- C-4（:102-109）waiting の検出は画面より1〜4秒遅れ得る。
- D（:111-120）checkInput 1回 1〜11秒。
- 公式: Claude Code interactive-mode（作業中の Enter は順番待ち、同ターン内で渡す）。/tmp/CC報告ファイル/agent-console-bugs-20261013/9-interactive-mode.md:357-372。

## 順番待ちの実測（2026-10-13 UTC、claude 2.1.296・sonnet、ハーネス /private/tmp/claude-501/chat2work/run.cjs 再利用）
生出力: /tmp/CC報告ファイル/agent-console-busy-send/measure/（pty-m*.raw, hook-m*.log, agents-m*.log, transcript-m*.txt）。
- M1: sleep 20 中に貼付→2秒→Enter。UserPromptSubmit hook は Enter の +71ms に発火（prompt="queued-one"）。sleep 完了時に queue-operation remove（reason absorbed_mid_turn）で取り込み。agents は終始 busy、waitingFor なし。transcript は role:user 行ではなく attachment queued_command。
- M2: 2件（間3秒）。hook は Enter の +38ms・+57ms に1件ずつ、順に発火。連結されない。取り込みは同じ時刻に2件。
- M3: busy 中に貼るだけ（Enter なし）→許可確認（waiting/waitingFor: permission prompt）。確認中は下書きが画面に見えない。Esc 後、入力欄に下書きが残っていた。「No」での回答は【未確認】。
- 【未確認】M2 でモデルに渡った文面が連結されたか。

## 既存試験（影響）
- tests/unit/chat-queue.integration.test.ts :99 K2、:136 K3（guard の意味）。
- src ChatPane.test.tsx:313-315、chatLogic.test.ts:43-47。tests/e2e/chat.spec.ts:246（:294-307 busy で書かれない）。
- 影響外（変えないことが条件）: daily-use.integration.test.ts（名前変更）、routines.test.ts。

## 並行 PR
- #32（release/routines-new-session・OPEN）: hub.ts :379 直後に submitText を追加（flushChatQueueOnce の隣）、版 0.18.0。agents.ts・チャット欄は触らない。
