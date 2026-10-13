# chat2（作業中でも送れる）recon

調査日 2026-10-13 / 基準 origin/main 4b86c9b (v0.12.0) / claude 2.1.296 / 設計提案は含まない。
実測の道具・生ログ（本リポジトリ外）: /private/tmp/claude-501/chat2work/（run.cjs, out1.txt, out2a〜c.txt, out3.txt, d.cjs, 各 d* の記録）

## A. 今のコード

【事実】送る前の判定（サーバー）
- `server/chat-routes.ts:54-61` POST `/chat/send-check`: 本文検査 → `deps.hub.checkInput(id)` → `!verdict.ok` なら 409（`SessionConflictError`）→ ok なら `{text, submitDelayMs: config.pasteSubmitDelayMs}` を返す。サーバーは端末へ書かない。
- `server/hub.ts:228-233` `checkInput`: `Promise.all([fetchAgents(claudeBin), readProcessTable()])` で `claude agents --json` と `ps -axo pid=,ppid=,rss=` を毎回取り直し、`inputVerdict` を返す。
- `server/agents.ts:80-88` `inputVerdict`: exited→不可 / rows が null→不可 / Claude なし→可 / `status !== "idle"`→不可（`claude is ${status}`）/ `waitingFor` あり→不可 / それ以外可。
- `server/agents.ts:90-99` `stateForSession`: busy→"working"、waiting→"waiting"、idle→"idle"、行なし→"no-claude"、exited→"stopped"、rows null→"unknown"。出どころは `claude agents --json` の `status`（`server/agents.ts:41` で busy/waiting/idle 以外は "unknown"）。`waitingFor` は `server/agents.ts:47`。
- `server/hub.ts:355` `canInput: inputVerdict(info, this.agents).ok`（一覧用。定期取得 this.agents の値で、チェックの取り直しではない）。
- `agent-console.config.json:17` `"pasteSubmitDelayMs": 2000`（`server/config.ts:184-186` で 0 以上）。

【事実】送る流れ（画面）
- `src/components/ChatPane/ChatPane.tsx:99-100` `blockedKey = blockedReasonKey(state, canInput)`、`canSendNow` は blockedKey が null のときだけ。`:102-127` `send`: blockedKey があれば return → `checkChatSend` → `paste(sessionId, text, submitDelayMs)` → 結果 sent / pastedNotSent / それ以外。
- `src/components/ChatPane/chatLogic.ts:36-39` `blockedReasonKey`: `canInput` が false なら state 別の文言キー（working→`ac.chat.blocked.working`、waiting→`ac.chat.waitingInTerminal` ほか）。
- `src/components/TerminalPane/TerminalPane.tsx:76-85` `pasteSubmitAfter`: 表示中の端末が違えば "notPasted" → `term.paste(text)` → `setTimeout(delayMs)` → 端末が差し替わっていたら "pastedNotSent" → `term.input("\r", true)` → "sent"。待っている間の状態確認は無い（端末の同一性だけ）。
- 判定（サーバー応答）から Enter までの窓: send-check の応答 → paste → 2000ms → Enter。

【事実】hook の記録（チャットの会話の元）
- `server/activity.ts:318,321,386` のとおり chat の user/assistant は hook の記録（`rec.last_assistant_message` など）から作る。server 配下の ts ファイルに `queued_command` の処理は無い（grep 0 件）。

## B. 公式文書（https://code.claude.com/docs/en/interactive-mode.md, permissions.md を curl。取得ファイルは本リポジトリ外 /tmp/cc2_*.md）

【事実】作業中の入力（interactive-mode.md 357-361 行）
- 「Type a message and press `Enter` while Claude is working. Claude Code queues the message instead of interrupting the turn, and lists the queued entries in the conversation until it sends them.」
- 369 行「Messages: if you queue a message while Claude is running tool calls, Claude Code passes it to Claude as soon as those tool calls finish, within the same turn. When the turn ends with messages still queued, they go out without another key press, in the order you typed them」
- 372 行 Ctrl+Enter（v2.1.275〜）で今すぐ送る。381 行「Press `Esc` to interrupt the turn without submitting your draft. Claude Code keeps what you queued and sends it right away.」
- 36 行 Esc: 「On a permission prompt, `Esc` declines the action, the same as **No** without a comment」
- 34 行 Tab: 許可の確認で Yes/No にコメント欄を開く。permissions.md 41-52 行「Add a comment when you answer a permission prompt」（Tab でコメント欄を開いて入力→Enter）。

【事実】許可の確認（permission prompt）で文字を打った・貼ったときの扱い: 両文書に該当する記載は見つからなかった（grep: "permission prompt" を含む行は上記 Esc/Tab/Shift+Tab/コメント欄のみ）。【未確認】他ページに記載があるか。

## C. 実測（本物の claude 2.1.296 --model sonnet、node-pty、捨てディレクトリ、`--setting-sources project,local`、hook なし）

環境: 親の CLAUDE_CODE_* / CLAUDECODE / CLAUDE_* を外して起動（残すと「Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION」になり記録が残らない）。初回は信頼の確認が出る（Down→Enter で Yes を選択。捨てディレクトリの信頼が ~/.claude.json に残る）。形は括弧付き貼付 `\x1b[200~…\x1b[201~` → 待つ → `\r`。画面は @xterm/headless で描画して取得。時刻は起動からの秒。agents は 1 本ずつ直列で取得（1 回 0.8〜5.9 秒かかるため、「呼び出し開始」と「結果が出た時刻」を併記）。実行後は全て Ctrl-C ×2〜3（必要時 SIGTERM）で終了、`ps` で残プロセス無しを確認（claude --model sonnet の行 0 件）。

### C-1 作業中に送る（Bash で sleep 20 の最中）out1.txt

【事実】生ログ要点:
```
[ 23.35] first prompt submitted
[ 28.63] --- Bash running ---   ⏺ Bash(sleep 20) / ⎿ Running… / esc to interrupt
[ 28.64] PASTED "After that, also write the word SECOND on its own line."
[ 30.67] ENTER sent after 2000ms
[ 30.72] AGENTS busy|waitingFor=-   (call started 26.25, took 4469ms)
[ 35.68] working +5s :  ⎿ Running… (6s) / ❯ After that, also write the word SECOND on its own line. / ctrl+x ctrl+s to send now / ❯ Press up to edit queued messages
[ 45.69] working +15s:  ⎿ Running… (16s) （まだ順番待ちの表示）
[ 50.73] working +20s:  Bash 完了、順番待ちの表示が消える
[ 55.75] ⏺ DONE1 / SECOND
[ 56.71] AGENTS idle|waitingFor=-   (call started 51.00, took 5707ms)
```
- 結果: 今の作業（sleep 20）は止まらず最後まで走り、完了直後に同じターン内で処理された。記録（transcript）: tool_result は 02:12:13、最終応答は `"DONE1\n\nSECOND"`（1 つの応答に両方）。
- 画面の表示は Enter の約 5 秒後に「❯ 文章 / ctrl+x ctrl+s to send now」の順番待ち。最初の実行（out は残していないが同じ結果）でも "DONE1 / SECOND"。
- agents: 送信前後とも busy のまま、順番待ちに入っても status/waitingFor に変化なし。busy→idle はターン終了後（結果が出たのは終了の約数秒後）。
- 記録ファイル（~/.claude/projects/…/*.jsonl、本リポジトリ外）では順番待ちの文章は `type: attachment` の `queued_command`（prompt 付き、時刻 02:11:54.503 = Enter 付近）として残り、`role: user` の行としては出ない（user 行は最初の依頼だけ）。hook（UserPromptSubmit）が順番待ちの送信で発火するかは【未確認】（hook なしで実測したため）。

### C-2 許可の確認が出ている状態で、貼る→2000ms→Enter（default モード、`echo hi > a.txt`）

試行 4 回（out2a, out2b, out2c と先に走らせた 1 回）。いずれも画面は次の確認を表示:
```
Bash command / Write "hi" to a.txt / echo hi > a.txt
Do you want to proceed?
❯ 1. Yes
  2. Yes, and always allow access to … from this project
  3. Yes, and switch to auto mode · …
  4. No
Esc to cancel · Tab to amend
```
【事実】結果（図: 貼る→2000ms→`\r`）:
- 試行（レンダリング付きの 1 回目、画面全文を取得）: 
```
[ 26.80] SCREEN shows permission prompt (first seen)
[ 28.32] PASTED "PASTED-TEXT-2 hello"
[ 29.36] paste +1s : 画面は貼る前と同一（文章は画面のどこにも出ない、選択肢の位置 ❯ 1. Yes のまま）
[ 30.38] ENTER sent after 2000ms
[ 30.91] AGENTS waiting|waitingFor=permission prompt   (call started 27.55, took 3360ms)
[ 31.91] Enter +1.5s: ⏺ Bash(echo hi > a.txt) ⎿ Running… / ✢ Inferring…
[ 34.92] ⎿ (No output) / ⏺ DONE2   a.txt exists: true
```
- 試行 b: 画面に確認が出た 10.65、貼る 12.18、Enter 14.24、`a.txt exists: true`、agents は 13.42 に waiting（permission prompt）→ 15.95 busy → 18.27 idle。
- 試行 c: 画面 11.78、貼る 13.29、Enter 15.31、`a.txt exists: true`。
- 試行 a: Enter 30.74。Enter 後 1.5 秒の画面はまだ確認のまま、4.5 秒後は `Bash(echo hi > a.txt) ⎿ Running…`（実行された。直後の `a.txt exists` 判定が早すぎて false）。マシンが重く描画が遅れていた（agents 呼び出しが 2.3〜7.4 秒）。
- 記録（transcript）: `tool_result "(Bash completed with no output)"`, `is_error: false` → 実行された。貼った文章 `PASTED-TEXT-2 hello` は transcript のどの行にも無い（user 行・コメント・tool_result に無し）。
- 結論（事実）: 貼る→2000ms→Enter で、「1. Yes」が押され、危険な操作側（書き込みを伴う Bash）が実行された。貼った文章は取り込まれず消えた（4/4 で Yes。うち 1 回は遅れて実行）。No・フィードバック欄・Tab のコメント欄には入らなかった。
- 【未確認・説明できない差分】最初に走らせた 1 回（agents を 500ms 周期で並走させた旧ハーネス）は、Enter 後の 4 秒の出力が空で a.txt も無く、約 20 秒後の Ctrl-C で拒否（"The user doesn't want to proceed"）になった。Enter が効かなかったのか描画が遅れていたのかは未確認（当時は agents 呼び出しが 15 秒でタイムアウトするほど詰まっていた）。

### C-3 許可の確認で貼るだけ（Enter なし）out3.txt

【事実】
```
[ 17.65] SCREEN shows permission prompt (first seen)
[ 18.88] AGENTS waiting|waitingFor=permission prompt   (call started 17.57, took 1311ms)
[ 19.16] PASTED "PASTED-TEXT-3 hello"
[ 22.16] paste only, +3s: 画面は貼る前と同一（確認の 4 つの選択肢、❯ 1. Yes のまま、文章は表示されない）
[ 22.17] a.txt exists: false
```
- 貼るだけでは何も起きず、確認も消えず、実行もされない（transcript に tool_result なし）。貼った文章は表示も記録もされない。

### C-4 `claude agents --json` の status / waitingFor の遷移

【事実】（行は `claude agents --json` のうち当該 pid の行。時刻は「呼び出し開始 / 所要」）
- C-1: 起動後 idle → （依頼送信 23.35 の後）busy（out1 は呼び出し開始 26.25 の結果、30.72 に表示）→ 順番待ちを入れても busy のまま → 終了後 idle（呼び出し開始 51.00、所要 5.7 秒）。waitingFor は全期間「-」。
- C-2 試行 b: busy（10.76 表示）→ waiting|waitingFor=permission prompt（呼び出し開始 11.06、13.42 表示）→ Enter(14.24) 後 busy（15.95）→ idle（18.27）。
- C-2 試行 c: 画面の確認 11.78 → waiting|permission prompt は呼び出し開始 12.01、13.14 表示（画面から約 0.2 秒後に開始した呼び出しで検出、結果が戻ったのは 1.4 秒後）。
- C-2 1回目（描画付き）: 画面の確認 26.80 → waiting の最初の検出は呼び出し開始 27.55（所要 3.4 秒、30.91 表示）。Enter(30.38) の約 0.5 秒後に結果が出た。
- 【事実】画面に確認が出てから agents が waiting を返すまでの遅れ: 試行 c で約 0.2 秒（呼び出しを開始した時点で既に waiting）、1 回目で呼び出し開始が画面の 0.75 秒後。agents の呼び出し自体が 0.8〜5.9 秒かかるので、「結果が見える時刻」は画面より 1〜4 秒遅れることがある。busy→waiting の切り替わった正確な瞬間は 1 秒未満の粒度では【未確認】（呼び出しの所要が長く、中間の状態を捕まえられない）。

## D. send-check 1 回（checkInput 相当）の所要時間

【事実】`checkInput` と同じ `Promise.all([claude agents --json, ps -axo pid=,ppid=,rss=])` を node で 10 回直列に測定（/private/tmp/claude-501/chat2work/d.cjs。測定時 claude セッションが他に 11 行あり負荷あり。agent-console 本体・テスト用 claude は動かしていない）:
```
1 回目の 10 回: 4410 6325 9908 7411 8182 7648 6691 11187 6133 1875 (ms)   min 1875 / median 7051 / max 11187
2 回目の 10 回: 1428 1713 2470 1464 964 2194 1511 2577 5995 5936 (ms)       min 964 / median 1953 / max 5995
```
- 参考: C の実測中の agents 単体の呼び出しは 0.8〜7.4 秒（out の "agents call durations ms"）。
- 事実: 1 回 1〜11 秒。`fetchAgents` のタイムアウトは 15 秒（`server/agents.ts:105`）。つまり判定は「応答が返った時点」の状態で、その後 2000ms の待ちが付く。
- 【推測ではなく数値の対応】送る直前に取り直すと、判定そのものに最大 11 秒かかる。2 回目の測定では中央値 約 2 秒（最小 1 秒、最大 6 秒）。負荷で大きく変わる。

## 未確認の一覧
- 許可の確認で文字を打つ（貼る以外）ときの扱いの公式記載。
- 順番待ちに入れた文章で hook（UserPromptSubmit）が発火するか、いつ発火するか。
- 初回の旧ハーネスでの C-2 で Enter が効かなかった理由。
- agents の busy→waiting が切り替わる正確な瞬間（1 秒未満）。
- 質問（AskUserQuestion）など許可以外の waiting（waitingFor の他の値）での貼る+Enter の挙動。
