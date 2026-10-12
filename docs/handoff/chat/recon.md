# recon: 中央に「チャット」タブを足す（2026-10-13、PO 承認「y」）

- 基準: main = 807e9fa（v0.9.1）。本番 4319 の healthz は `{"ok":true,"version":"0.9.1","commit":"807e9fa4afbed03b857586eb8f2c95086435323c"}`（読み取りのみ）。
- v0.10.0（PR #24、ブランチ release/layout = a5e6222）は origin から読むだけ（`git show` / `git diff origin/main origin/release/layout`）。
- 公式 hooks の写し: hooks.md（本リポジトリ外。claude.ai/docs の hooks ページの写し。以下「hooks.md:行」）。interactive-mode / terminal-config / desktop も同様に本リポジトリ外の公式文書（code.claude.com/docs/en/*.md を curl で取得した写し。以下「interactive-mode.md:行」など）。
- 書き方: 【事実】は根拠つき。【推測】【未確認】は分けて書く。設計提案はしない。
- パスは本リポジトリのルートからの相対パス（バッククォート内はフルパスで書く）。本リポジトリ外のものはバッククォートを付けず「本リポジトリ外」と書く。

---

## A. 公式 hooks（Stop / StopFailure / UserPromptSubmit）

### A-1 Stop
- 【事実】Stop は「メインの Claude Code が応答を終えたとき」に走る。「ユーザーの割り込み（interrupt）で止まったときは走らない」。API エラーのときは Stop でなく StopFailure が走る（hooks.md:2669-2673）。
  - 原文: `Does not run if the stoppage occurred due to a user interrupt. API errors fire [StopFailure](#stopfailure) instead.`
- 【事実】入力は共通項目に加えて `stop_hook_active`、`last_assistant_message`、`background_tasks`、`session_crons`（hooks.md:2681）。
- 【事実】`last_assistant_message` は「Claude の最終応答のテキスト内容（the text content of Claude's final response）」。transcript を読まずに使える。読み上げ・通知の hook は transcript でなくこの項目を使うこと、transcript は Stop の時点で最後のメッセージを含むとは限らない、と書かれている（hooks.md:2685）。
- 【事実】`last_assistant_message` の長さの上限の記載は hooks.md に無い（`grep -n -i -E 'truncat|max length|character limit'` の結果は PostToolUse の error 文字列 hooks.md:2268 の中間省略だけ。上限の記載があるのは session_crons の prompt の 1000 字 hooks.md:2696-2710だけ）。
- 【事実】`last_assistant_message` が「最後の text ブロックだけ」か「その回の全 text」かは、原文は「final response」としか書かない（hooks.md:2685）。
- 【未確認】途中（ツール呼び出しの前）に出た文章が含まれるか。実機で確かめていない。
- 【事実】共通項目: `session_id`、`prompt_id`（その回のユーザー入力の UUID。最初の入力まで無い）、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name`、`agent_id`、`agent_type`（hooks.md:731-748）。`agent_id` は「サブエージェント／in-process teammate の中で hook が起きたとき」に付く（hooks.md:747）。
- 【推測】メイン Claude の Stop には `agent_id` が付かず、担当の終わりは SubagentStop（hooks.md:2528）になる。v0.9.0 の hook も `agent_id` を共通項目として拾う（`hooks/activity-hook.mjs:76`）。Stop 自体に `agent_id` が付かないことは実機で未確認。
- 【事実】Stop hook は `decision: "block"` などで会話を続けさせられるが（hooks.md:2743-2762）、agent-console の hook は何も出力しない（`hooks/activity-hook.mjs:3`）。連続 8 回の続行上限がある（hooks.md:2683）。
- 【事実】`/goal` は Stop hook の近道で、Stop が複数回起きることがある（hooks.md:2675-2677）。1 回のユーザー入力に対し Stop が 1 回とは限らない、は【推測】。

### A-2 StopFailure
- 【事実】API エラーで回が終わったときに Stop の代わりに走る。出力と終了コードは無視される（hooks.md:2773-2779、947）。
- 【事実】入力は `error`（`rate_limit`、`overloaded`、`authentication_failed`、`oauth_org_not_allowed`、`account_on_hold`、`billing_error`、`invalid_request`、`model_not_found`、`server_error`、`max_output_tokens`、`cloud_credential_error`、`unknown`）、任意の `error_details`、任意の `last_assistant_message`（hooks.md:2779-2785）。
- 【事実】StopFailure の `last_assistant_message` は Claude の返事ではなく「画面に出る API エラー文字列そのもの」（例 `API Error: Rate limit reached`）（hooks.md:2785）。Stop と同じ項目名で意味が違う。
- 【事実】matcher は `StopFailure` に限り英数字・`_`・`|` だけ（hooks.md:299）。

### A-3 UserPromptSubmit
- 【事実】`prompt` は「送られた文章」（hooks.md:1440）。貼り付けで `[Pasted text #N]` に畳まれたものは、**その場で展開された全文**で届く。
- 【事実】「Claude が貼り付けに印を付けるセッション」では、展開された内容が `<pasted_content id="…">` 行と `</pasted_content id="…">` 行の間に入る。hook がパースするならこの行を考慮すること、と書かれている（hooks.md:1440）。
- 【事実】印を付けるかどうかは機能フラグの取得に依存する。「フラグを取得しないセッションでは貼り付けに印は付かない」（terminal-config.md:333）。
- 【事実】agent-console が端末へ文章を入れるのは xterm の `paste()`（`src/components/TerminalPane/TerminalPane.tsx:79`）。Claude 側から見ると「貼り付け」なので、3 行超または 800 字超は `[Pasted text #N +M lines]` に畳まれる（terminal-config.md:327）。
- 【推測】したがってチャットから送った複数行の文章の `prompt` は、印付きセッションでは `<pasted_content …>` 行に包まれて届く可能性がある。この PO の環境で印が付くかは【未確認】（実機の events に長文の記録がまだ無い）。
- 【事実】画像: hooks.md の UserPromptSubmit の節に、画像添付の扱いの記載は無い（hooks.md:1420-1500 を読んだ）。画像を貼ったときの `prompt` は【未確認】。
- 【事実】`session_title` は、そのセッションに**カスタム名**があるときだけ付く。`--name`・`/rename`・hook の `sessionTitle` 出力・SDK の `renameSession()` で付いた名前。自動生成された題名は含まれない（hooks.md:1442、1215-1217）。
- 【事実】UserPromptSubmit は人の入力だけでなく次でも走る（hooks.md:1426-1430）。
  - スケジュールされたタスクの発火（`/loop` の繰り返しを含む）
  - 背景サブエージェントがそのセッションへ報告を返したとき
  - 別セッションが送ったメッセージ（cross-session messaging）
- 【事実】v0.9.0 の工程0で、背景の担当の報告の戻りは `prompt` が `<agent-message from="<agentId>">` で始まり `[Subagent hand-back]` の説明が続く、と実測している（`docs/handoff/v0.8.0-activity/step0.md:19`）。同ファイル 23 行に「見分けられるのは担当の報告の戻りだけ。人の入力には印が無いので、人の入力かどうかを確実に見分けることはできない」。
- 【未確認】定期実行（スケジュール）・別セッションからのメッセージの `prompt` の形。工程0は担当の報告の戻りだけを実測している。
- 【事実】既定の timeout は UserPromptSubmit が 30 秒（hooks.md:426、1432）。agent-console の hook は `async: true`（`server/activity-hooks.ts:43`）。

---

## B. v0.9.0 の実物

### B-1 hook 本体 `hooks/activity-hook.mjs`
- 【事実】1 行の上限 `MAX_LINE_BYTES = 4096`（:10）。超えたら**切り詰めずに、その記録を書かない**（`appendRecord` :112-117 の `if (buf.length > MAX_LINE_BYTES) return false;`）。
- 【事実】長さの定数（:14-19）: DESCRIPTION 200、SUBJECT 200、REPORT 120、PROMPT 80、ID 100、NAME 100（いずれもコードポイント数）。
- 【事実】`clip()`（:27-31）は制御文字を空白にし、連続する空白を 1 つにまとめ、先頭 max 字を取る。**改行は消える**（Markdown の構造は残らない）。
- 【事実】記録する event は `buildRecord`（:70-101）の switch で PreToolUse / PostToolUse（`toolRecord` :41-64）、SubagentStop（:81-85、`last_assistant_message` を 120 字）、TaskCreated / TaskCompleted（:86-91）、UserPromptSubmit（:92-97、`prompt` を 80 字、`<agent-message` で始まれば `source: "agent"`）。それ以外（Stop を含む）は `default: return null`（:98-99）= **Stop は記録していない**。
- 【事実】`session_id` が UUID の形でないものは捨てる（:73）。
- 【事実】コメント冒頭に「会話の本文・transcript のパスなどは残さない」とある（:68）。設計 `docs/handoff/v0.8.0-activity/design.md:84` に「Stop と Notification は使わない。状態は agents --json が正本のため」、:192 に「L1 Stop と Notification は使わない」。
- 【事実】ファイル名は UTC の日付 `events-YYYYMMDD.jsonl`（:104-106）。権限は 600 / ディレクトリ 700（:11-12）。
- 【事実】サーバー起動のたびに、リポジトリの hooks/activity-hook.mjs を `dataDir/hooks/activity-hook.mjs` へ写す（一時ファイル → rename）（`server/activity-setup.ts:21-35`）。本番ポートのときだけ（:14-15）。本番の写し: `~/Library/Application Support/agent-console/hooks/activity-hook.mjs`（権限 600、7427 byte、2026-10-13 02:01）。

### B-2 まとめ `server/activity.ts`
- 【事実】受け付ける event は `EVENTS` の 6 種（:23）。ここに無い event の行は `parseLine`（:123-135）で捨てられ `invalidLines` に数えられる（:220-222）。**Stop を足すには :23 の集合にも足す必要がある**。
- 【事実】`apply`（:241-269）の switch が event ごとの取り込み。UserPromptSubmit は `applyPrompt`（:325-330）。`source === "agent"` または本文が空のものは入力に入れない（:327）。同じ `ts` と本文の重複は入れない（:328）。
- 【事実】入力は新しい順で、メモリに `INPUTS_KEEP = 20` 件（:19、329）、画面に返すのは `INPUTS_MAX = 3` 件（:12、380）。
- 【事実】セッションごとの上限: `STARTS_KEEP`・`STOPS_KEEP`・`HANDBACKS_KEEP`・`NESTED_KEEP` 400、`TASKS_KEEP` 200（:14-18）。
- 【事実】読むのは**今日と昨日**のファイルだけ（`readNew` :178-190 の `names`）。サーバーを再起動すると、メモリには昨日以降の記録しか戻らない。ファイルは `activityKeepDays`（既定 7）より古い日付のものを 1 時間ごとに消す（:408-426、`server/activity-start.ts:12`・`server/activity-start.ts:50-53`）。
- 【事実】セッションの鍵は Claude の `session_id`（= app の `claudeSessionId`）。`view(sessionId)`（:339）はそのセッションの分だけ返す。
- 【事実】2 秒ごとに新しい行を読む（`ACTIVITY_POLL_MS = 2000`、`server/activity-start.ts:10`・`server/activity-start.ts:40`）。新しい行を取り込んだら `rev` が進み、WebSocket の `activityRev`（`server/hub.ts:46`・`server/hub.ts:145-148`・`server/hub.ts:364`）で画面へ合図される。
- 【事実】書きかけの最後の行は改行が付くまで取り込まない（:208-216）。1 チャンク（1 MiB）に改行が 1 つも無い行は読めない行として飛ばす（:210-216）。

### B-3 API `server/activity-routes.ts`
- 【事実】`GET /api/sessions/:id/activity`（認証の内側）。`claudeSessionId` がまだ無ければ `{status:"noSession"}`（:17-20）。あれば `refresh()` してから `{status:"ok", now, ...view, hooks: checkHooks()}`（:21-22）。
- 【事実】画面は `fetchActivity`（`src/api.ts`）で取る。`src/components/ActivityPane/ActivityPane.tsx` は 5 秒ごと（:15）と `rev` の変化（:75-83）で取り直す。表示は SA の Card・Badge・Callout・EmptyState（:4-7）。

### B-4 install / check `server/activity-hooks.ts`
- 【事実】`HOOK_SPECS`（:20-27）は PreToolUse（matcher `Agent|SubagentHandback`）、PostToolUse（`Agent`）、SubagentStop、TaskCreated、TaskCompleted、UserPromptSubmit の 6 つ。コメント :19 に「Stop と Notification は使わない」。
- 【事実】handler は `{type:"command", command:<node>, args:[<hook path>], async:true}`（:34-44）。自分の handler の目印は `args[0]` が `/hooks/activity-hook.mjs` で終わること（:8、46-50）。
- 【事実】`addHandlers`（:83-111）は HOOK_SPECS の各 event について、自分の handler があれば足さず、無ければ新しい group を足す。**HOOK_SPECS に Stop を足してから `node scripts/ac-hooks.mjs install` を再実行すれば、Stop の handler だけが追加され、既存の 6 つは変更なし**（`found && !stale` で continue :101）。PO の ~/.claude/settings.json（本リポジトリ外） に設定を書くのは、実行した人（スクリプトの注記 `scripts/ac-hooks.mjs:6`）。アプリは書き換えない。
- 【事実】`checkHooks`（:170-195）は HOOK_SPECS の全 event に自分の handler があるか、node とファイルがあるかを見る。無い event があると `{ok:false, reason:"missingHandler", missingEvents}`（:186-188）。→ **HOOK_SPECS に Stop を足すと、再 install するまで、右の欄に「記録の仕組みが外れている」警告（`activity-hooks-warning`、ActivityPane.tsx:127-133）が出る**（コードから読んだ結論。実機では未確認）。
- 【事実】install は書き換える前に控え `settings.json.ac-backup-<日時>` を取り、3 件残す（:9-11、202-211、239-265）。書いたあとに JSON を読み直し、失敗したら控えから戻す（:259-264）。
- 【事実】PO の現在の ~/.claude/settings.json（本リポジトリ外）（読むだけ。値は出さない。event 名と件数のみ）:
  - `Stop` は 1 group・handler 2 件（うち agent-console のもの 0）。`PermissionDenied` 1、`PreToolUse` 8 group・14 handler（自分のもの 1）、`PostToolUse` 2（1）、`SubagentStop` 1（1）、`TaskCreated` 1（1）、`TaskCompleted` 1（1）、`UserPromptSubmit` 2 group・2 handler（1）。
  - つまり PO の Stop には他の handler がすでに 2 件あり、agent-console の handler を足すと 3 件になる（`addHandlers` は別 group を足す :107-108。他人の group には触れない）。
- 【事実】`scripts/ac-hooks.mjs` は `install|uninstall|check`、`--settings`、`--data-dir`（:15-37）。install は hook 本体の写しも行う（:42）。

---

## C. 実際の記録（本番 `~/Library/Application Support/agent-console/activity/`、読み取りのみ。文章は写していない）

- 【事実】フォルダには `events-20261012.jsonl` の 1 ファイルだけ（2932 byte、2026-10-13 02:04 更新）。他の日のファイルは無い。
- 【事実】event 別の件数（15 行、読めない行 0）: SubagentStop 6、UserPromptSubmit 5、PreToolUse 2、PostToolUse 2。Stop は 0（記録していないので当然）。
- 【事実】項目名:
  - UserPromptSubmit: `ts`、`event`、`session_id`、`prompt`（5 行すべて。`source` は 0 行）
  - SubagentStop: `ts`、`event`、`session_id`、`agent_id`、`last_assistant_message`（6 行すべて）
  - PreToolUse: `ts`、`event`、`session_id`、`tool`、`tool_use_id`、`description`、`model`（`subagent_type` は 2 行中 1 行）
  - PostToolUse: `ts`、`event`、`session_id`、`tool`、`tool_use_id`、`status`、`agentId`、`resolvedModel`
- 【事実】長さ（文字数）: UserPromptSubmit `prompt` は n=5、最小 1・中央値 4・p90 67・最大 67。SubagentStop `last_assistant_message` は n=6、最小 1・中央値 30・p90 32・最大 32。PreToolUse `description` は n=2、10〜18。1 行の最大は 301 byte（上限 4096 に対して）。
- 【事実】標本が 15 行・1 日分なので、長文の入力、`<pasted_content` の印、複数行の扱いを観測できていない。→ 上記 A-3 の推測は実機で【未確認】のまま。

---

## D. 送る仕組み（端末へ入れて Enter）

### D-1 端末の部品 `src/components/TerminalPane/TerminalPane.tsx`
- 【事実】`TerminalHandle` は 2 つ（:16-33）。
  - `pasteAndEnter(sessionId, text): boolean`（:25、69-75）: xterm の `term.paste(text)` のあと `term.input("\r", true)`。**待たずに Enter**。表示中の端末がそのセッションのものでなければ false で何も入れない（:71）。
  - `pasteSubmitAfter(sessionId, text, delayMs): Promise<"sent"|"notPasted"|"pastedNotSent">`（:32、76-85）: 貼ってから delayMs 待ち、端末が差し替わっていなければ Enter。コメント（:26-31）に「複数行を 1 つの依頼として受け取らせるため。本物の claude で 2 秒待つと `[Pasted text #N]` の 1 つの依頼になることを実測した」。
- 【事実】`paste()` は端末側が括弧付き貼付モードならそれで包み、そうでなければ改行を `\r` に直して入れる（:20-23）。どちらも `onData` を通って WebSocket の人の入力経路に出る（:118-120）。
- 【事実】`onData` は 16 KiB（`INPUT_CHUNK_CHARS` :14）ごとに分割して `{type:"input", data}` を送る（:118-120。分割は `src/components/TerminalPane/chunkInput.ts:1-13`、サロゲートペアを割らない）。サーバーは `msg.type === "input"` を pty へ書く（`server/ws.ts:36`）。WebSocket の 1 フレーム上限は 256 KiB（`server/ws.ts:10`）。
- 【事実】画像: 貼り付け・ドロップで `uploadImage` → 保存した**絶対パス**を ` <path> ` として貼る（Enter は押さない）（:147-183）。
- 【事実】端末は `hidden` 属性（display:none）で隠すだけで外さない（`src/pages/ConsolePage.tsx:369-370` のコメント。大きさ 0 のとき resize を送らない `src/components/TerminalPane/TerminalPane.tsx:109-115`）。→ チャットタブを足しても、端末タブを開いていない間も `terminalRef` の端末は生きている（現状の「変更」「部品」タブがこれに依存している）。

### D-2 既存の送り方 3 種
- 【事実】よく使う指示: `src/pages/ConsolePage.tsx:179-190` の `handleSendPrompt` が `checkQuickPromptSend`（`src/api.ts:70-71` = `POST /api/sessions/:id/send-check` `{promptId}`）→ 返った本文を `terminalRef.current?.pasteAndEnter(checkedId, text)`。確認している間に別セッションへ切り替わったら `ac.quick.switched` を出して入れない（:187）。
- 【事実】変更タブ・部品タブ: サーバーの `send-check` が文章と `submitDelayMs`（既定 2000、`server/config.ts:36`）を返し（`server/diff-routes.ts:56-62`、`server/picks-routes.ts:80-82`）、画面が `pasteSubmitAfter`（`src/pages/ConsolePage.tsx` の `pasteToTerminal`、:194-197）で貼る → 待つ → Enter。DiffPane は `src/components/DiffPane/DiffPane.tsx:152-160`。
- 【事実】サーバーは端末へ書かない。`send-check` は「入れてよい状態なら本文を返す」だけ（`server/http.ts:264-269`）。本文はサーバーが持つ保存済みの指示（`promptId`）か、diff コメント・部品の組み立て結果で、**任意の本文を受け取って返す口は今は無い**（`quickPrompts.get(str(promptId))` :265）。
- 【事実】指示の本文の検査（`server/quick-prompts.ts:42-47`）: 1 文字以上、8 KiB 以下、改行・タブ以外の制御文字（ESC など）を含まない。ラベル 40 字、最大 40 件（:8-9）。→ 改行は通る。
- 【事実】`checkInput(id)` は要求を受けた時点で `claude agents --json` と ps を取り直して判定する（定期取得の値は使わない）（`server/hub.ts:228-233`）。

### D-3 IME・複数行
- 【事実】`isComposing`・`compositionstart`・`keyCode 229` の使用は `src` と `server` に 0 件（grep）。`onKeyDown` や `key === "Enter"` の使用も `src` の .tsx に 0 件。→ **IME 変換中の Enter を送らない処理の先例は、このリポジトリに無い**。現在の入力欄はすべて「ボタンで送る」形（Enter キーで送る入力欄が無い）。
- 【事実】入力欄は SA の Textarea / TextField を使う（`src/components/QuickPrompts/QuickPromptEditor.tsx`、`src/components/DiffPane/CommentForm.tsx`、`src/components/RenameForm/RenameForm.tsx`、`src/components/NewSessionForm/NewSessionForm.tsx`、`src/components/Routines/RoutineEditor.tsx` ほか）。
- 【事実】複数行: 端末へは `paste()` なので括弧付き貼付モードで 1 つの貼り付けになる。Claude 側は 3 行超または 800 字超を `[Pasted text #N]` に畳み、全文を送る（terminal-config.md:327）。
- 【事実】Claude Code の入力欄での改行は `\` + Enter、Option+Enter、Shift+Enter、Ctrl+J、または直接の貼り付け（interactive-mode.md:80-90）。agent-console の貼り付け経路は最後の「Paste mode」に当たる。
- 【事実】実測済み（コメントの記載）: 本物の claude に貼って 2 秒待つと 1 つの依頼になる（`src/components/TerminalPane/TerminalPane.tsx:27-29`）。貼ってすぐ Enter（`pasteAndEnter`）の複数行が 1 つの依頼になるかは、このリポジトリの記録では【未確認】。

### D-4 作業中・許可待ちの扱い（今の判定）
- 【事実】`SessionView.canInput`（`src/types.ts:14`、`server/hub.ts:355` = `inputVerdict(info, this.agents).ok`）。
- 【事実】`inputVerdict`（`server/agents.ts:80-88`）:
  - 停止中 → 不可（:81）
  - `claude agents --json` の取得失敗（rows が null）→ 不可（:82）
  - Claude が動いていないシェル → 可（:84）
  - Claude の status が idle でない（busy・waiting・unknown）→ 不可、理由 `claude is <status>`（:85）
  - idle でも `waitingFor` あり → 不可（:86）
  - それ以外 → 可（:87）
- 【事実】コメント（agents.ts:74-79）: 「waiting は許可プロンプトの応答待ちを含み得て、そこへ Enter を送ると既定の選択肢を押す恐れがある」。
- 【事実】画面の案内: 変更タブ・部品タブは `canInput` が false のとき、`SessionView.state` に応じた文言（`working`・`waiting`・`stopped`・`unknown`）を出す（`src/components/DiffPane/DiffPane.tsx:48-53`・`src/components/DiffPane/DiffPane.tsx:170-175`）。よく使う指示のボタンは `canSend={activeSession?.canInput === true}` で disabled（`src/pages/ConsolePage.tsx:354`、`src/components/QuickPrompts/QuickPromptBar.tsx:23`）。

---

## E. 表示（Markdown・吹き出し）

- 【事実】本リポジトリの依存（`package.json:19-30`）: `@heroicons/react`、`@xterm/addon-fit`、`@xterm/xterm`、`i18next`、`lucide-react`、`node-pty`、`react`、`react-dom`、`react-i18next`、`ws`。**Markdown を描画する部品（react-markdown・marked 等）は入っていない**。
- 【事実】SA の取り込み: `.sa-cache` は本店 `/Users/tanizawashingo/agent-console/.sa-cache`（SOURCE = 6c1c5e82418e3ba38c10702f2a74161fd24a7e80）にあり、**この worktree には `.sa-cache` が無い**（`ls -a` で確認。gitignore 対象で、vite は `vite.config.ts:5` で `./.sa-cache/frontend/src` を `@sa` に割り当てる）。→ この worktree でビルド・試験をするには `.sa-cache` の取得が要る（`scripts/sa-sync.mjs`、中身は未読）。
- 【事実】`.sa-cache` には `frontend/src` だけがあり package.json は無い。SA の `src` 内に Markdown ライブラリの import は 0 件（`from "react-markdown|marked|remark|markdown-it|dompurify|micromark|mdast"` の grep 結果が空）。`dangerouslySetInnerHTML` を使うものも、ヒットしたのは語 `marked`（`marked_count` 等）だけで描画部品ではない。
- 【事実】SA の部品（`/Users/tanizawashingo/agent-console/.sa-cache/frontend/src/components/`）: Badge、Button、Callout、Card、ConfirmModal、DataTable、Drawer、EmptyState、Modal、PageLayout、Popover、Select、Stack、Tabs、Textarea、TextField、Tooltip、TwoColumn など。**「吹き出し」専用の部品は無い**。
- 【事実】Card（SA の Card 金型（Card.tsx の 1〜60 行）、本リポジトリ外）は `variant`（container / interactive / metric）・`density`（default / compact）を持ち、`className` を受ける。ActivityPane がすでに使っている（`src/components/ActivityPane/ActivityPane.tsx:44`）。
- 【事実】SA に吹き出しの先例はある。受信箱の SA の frontend/src/pages/inbox/InboxPage.css:505-543（本リポジトリ外。sa-sync した .sa-cache）の `.inbox-msg-row`（`display:flex`）、`.outbound { justify-content: flex-end }`、`.inbound { justify-content: flex-start }`、`.msg-bubble`（`max-width:70%`、`padding: var(--space-2) var(--space-3)`、`white-space: pre-wrap`、`word-break: break-word`）、`.msg-bubble.outbound`（`background: var(--bubble-outbound-bg)`、`color: var(--on-accent)`、`border-radius: var(--radius-bubble-out)`）、`.msg-bubble.inbound`（`--bubble-inbound-bg`、`--text-primary`、`--radius-bubble-in`）。トークンは SA の frontend/src/index.css:101-102（ライト `#EFEFEF` / `#8B2EF5`）、:294-295（ダーク `#334155` / `#6d28d9`）、frontend/src/tokens.css:97-98（角丸）（いずれも本リポジトリ外）。
  - 【事実】これは受信箱ページ専用の CSS（SA の InboxPage.css、本リポジトリ外）で、金型（SA の components フォルダ）ではない。agent-console が SA の pages フォルダの CSS を読み込めるかは【未確認】。
- 【事実】agent-console の側で等幅・折り返しを保つ先例: `src/components/DiffPane/DiffPane.css:146`・`src/components/DiffPane/DiffPane.css:191` と `src/components/PicksPane/PicksPane.css:115` に `white-space: pre-wrap`。ActivityPane は `overflow-wrap: anywhere`（`src/components/ActivityPane/ActivityPane.css:45-50`・`src/components/ActivityPane/ActivityPane.css:94-96`）。等幅フォントは `src/tokens.app.css:8-10` の `--ac-font-mono`。
- 【事実】デザイン検査: `scripts/check-design-governance.mjs` が `src/tokens.app.css` に置ける値を制限している（font stack だけ。v0.10.0 で長さも許す）。色の直値は書かない運用（`src/tokens.app.css:6`）。
- 【事実】色・余白は SA のトークン（`--bg-subtle`、`--border`、`--text-primary`、`--text-muted`、`--space-*`、`--font-*`）を `var()` で使う（例 `src/components/QuickPrompts/QuickPrompts.css:1-30`、`src/pages/ConsolePage.css`）。
- 【事実】Textarea は SA に金型がある（SA の components/Textarea.tsx、本リポジトリ外）。`variant` は `standard | karte | embedded | composer | schedule`、`composer` は枠なし・フォーカスで `outline: 2px solid var(--accent)`（SA の components/FormField.css:307-321、本リポジトリ外）、`textStyle: "code"` で等幅。`size` は sm/md/lg。
- 【事実】i18n: 言語ファイルは `src/locales/ja.json` だけ（en.json は無い）。タブの文言は `ac.tabs.*`（ja.json:166-172）。

---

## F. タブ

### F-1 今の中央タブ（main）
- 【事実】`type CenterTab = "terminal" | "changes" | "pr" | "picks" | "routines"`（`src/pages/ConsolePage.tsx:50`）、状態は `useState<CenterTab>("terminal")`（:106）。
- 【事実】`<Tabs variant="underline" size="sm" activeKey onChange items=[…]>`（:338-350）。表示名は ja.json:166-172: 端末 / 変更 / PR / 部品 / 定期実行。「変更」には diff 件数、「部品」には未送信件数の `count` が付く（:344-346）。
- 【事実】`centerTab === "terminal"` のときだけ `QuickPromptBar` を出す（:351-358）。各ペインは `active={centerTab === …}` を受けて自分で隠す形（DiffPane・PrPane・PicksPane・RoutinesPane）。端末は `hidden={centerTab !== "terminal"}`（:370）。
- 【事実】3 列のグリッド: 左 20%・中央 1fr・右 22%、下にフッター（`src/pages/ConsolePage.css:1-11`）。中央は縦の flex（:22）。
- 【事実】右の欄は `RightPane`（`src/components/RightPane/RightPane.tsx:22-37`）。「このセッション」（ActivityPane）と「台帳」の 2 タブ。

### F-2 v0.10.0（origin/release/layout = a5e6222、PR #24。読むだけ）
- 【事実】変更ファイル 32 件、+1246/-73（`git diff --stat origin/main origin/release/layout`）。
- 【事実】中央の `Tabs` に `className="ac-center-tabs"` を付ける（ConsolePage.tsx に +1 行）。`src/pages/ConsolePage.css` に `.ac-center-tabs.comp-tabs .comp-tabs__tab { height: var(--ac-tab-h); font-size: var(--font-2xl); padding: 0 var(--space-6); }` を追加。`src/tokens.app.css` に `--ac-tab-h: 56px`。タブ項目の配列と `CenterTab` の型は**変更なし**（5 つのまま）。→ チャットタブを足す箇所（:50、:338-350）は v0.10.0 とは衝突しにくいが、同じ Tabs 周辺を触るので、どちらが先にマージされるかで ConsolePage.tsx の再調整が要る【推測】。
- 【事実】その他: セッションの行の 2 段構成とドラッグ並び替え（`server/sessions.ts`・`SessionList`・`POST /api/sessions/:id/move`）、よく使う指示に `pinned`（既定 true、`server/quick-prompts.ts`）と 1 行のバー＋一覧モーダル。
- 【事実】`checkQuickPromptSend` の流れ（`handleSendPrompt`）は v0.10.0 でも変更なし（`src/pages/ConsolePage.tsx` の diff に含まれない）。

---

## G. 試験

- 【事実】単体（`tests/unit/`）:
  - `tests/unit/activity-hook.test.ts`（216 行）: `buildRecord` の項目と長さ（:42〜）、UserPromptSubmit は 80 字・改行を空白 1 つ・`<agent-message` で `source=agent`（:95）、対象外 event は null（:109）、`appendRecord` が 1 回の writeSync（:126）、4096 byte 超は書かない（:139）、権限 600/700（:146）、20 プロセス並列に 200 行ずつ（:153）、本物の node で hook を実行して終了コード 0・出力なし（:176〜）、node: 以外の import が無い（:210）。
  - `tests/unit/activity-hooks.test.ts`（298 行）: install / uninstall / check。`tests/unit/activity.test.ts`（297 行）・`tests/unit/activity.integration.test.ts`（111 行）: まとめ・API。
  - 画面: `src/components/ActivityPane/ActivityPane.test.tsx`（209 行）、`src/components/TerminalPane/TerminalPane.test.tsx`（`pasteSubmitAfter` の待ち 1999ms/2000ms を fake timers で :114-140）、`src/components/TerminalPane/TerminalPane.ux.test.tsx`。
- 【事実】e2e `tests/e2e/activity.spec.ts`（178 行）: 本物の hook に Claude の入力の形の JSON を `spawnSync(process.execPath, [HOOK], {input})` で流す（`fireHook` :41-46）。設定の足し込みは本物の `scripts/ac-hooks.mjs` を一時の `AC_E2E_CLAUDE_SETTINGS` にだけ行い、実際の ~/.claude/settings.json（本リポジトリ外） が変わらないことも検査する（:168-173）。K8（handler が無いとき警告が出て、足すと消える :101）、K2/K3/K7（:117）。
- 【事実】偽 claude: `tests/fixtures/claude-stub.sh`。`claude agents --json` に対し、コマンドラインに `agent-console-e2e-role` を含むプロセスの pid ごとに `{"pid", "status", "sessionId", "unknownKey"}` を返す。状態は `$STUB_STATUS_FILE` の中身（既定 idle）、名前は `$STUB_NAME_FILE`、sessionId を UUID にするのは `$STUB_UUID_FILE`、遅延は `$STUB_SLOW_FILE`（:8-28）。CRLF と末尾のエスケープを混ぜる（:19、28）。`waitingFor` は返さない（スタブに項目が無い）。→ busy・waiting を作るには `STATUS_FILE` に書く。waitingFor つきは未対応【事実】。
- 【事実】「偽 claude で hook を流す」方法は、スタブが `claude agents` を返すだけで、hook は呼ばない。hook の試験は上記のとおり JSON を hook に直接流す形（Stop も同じ方法で流せる【推測】）。
- 【未確認】Stop / StopFailure の実機の入力 JSON（この PO の環境）。まだ記録していない。

---

## H. 作業中でも追加のメッセージを送りたい

### H-1 Claude Code の CLI で、作業中に入力して Enter を押すと
- 【事実】CLI（端末）: 「Claude が作業中に、メッセージを入力して Enter を押すと、Claude Code は**割り込まずにキューに入れ**、送るまで会話に一覧表示する」（interactive-mode.md:357-359「Queue messages while Claude works」）。
  - 原文: `Type a message and press Enter while Claude is working. Claude Code queues the message instead of interrupting the turn, and lists the queued entries in the conversation until it sends them.`
- 【事実】いつ Claude に届くか（interactive-mode.md:365-370）: メッセージは、ツール呼び出しを実行中なら「そのツール呼び出しが終わった直後に、同じ回の中で」Claude に渡す。回が終わってもキューに残っていれば、キー操作なしで入力順に送られる。コマンドとシェルコマンドは回の終わりまで保留して 1 つずつ実行。
- 【事実】送った・キューに入れたメッセージは Claude が応答し始めるまで灰色で表示される（interactive-mode.md:361）。
- 【事実】`Ctrl+Enter`（または `Ctrl+X Ctrl+S`）でキューをすぐ送る（v2.1.275 以降）。作業の種類で、バックグラウンドへ移せる作業はバックグラウンドに回って同じ回で読まれ、「応答を書いているだけ」などは回を割り込んで次に送る（interactive-mode.md:372-377）。`Esc` は回を中断し、キューは保持してすぐ送る（:381）。キューを取り戻すのは `Up`（:389-391）。
- 【事実】`Esc` は「回の途中で現在の応答やツール呼び出しを止める。Claude は今までの作業を保つ。キューがあれば次に送る」（interactive-mode.md:36）。`Ctrl+C` は実行中の操作を中断（:21）。
- 【事実】**Desktop 版**の別の記載: 「stop ボタンで即時に中断するか、**訂正を入力して Enter を押すと、動いている操作を止めずに送れる**。Claude は訂正をすぐ読む」（desktop.md:60。Desktop アプリの文書で、CLI のものではない）。CLI の挙動の根拠にはしない。
- 【事実】common-workflows.md と terminal-config.md に、作業中の入力のキューに関する記載は無い（`grep -n -i -E 'type a correction|without stopping|queue'` の結果が 0 件）。
- 【事実】許可プロンプトが出ているときの文字入力の扱いは、interactive-mode.md に記載が無い（キューの節は「Claude is working」前提）。許可ダイアログではキー操作がダイアログに渡る（`Tab`: 許可の答えにコメントを付ける、左右: ダイアログのタブ移動、interactive-mode.md:33-34）。
- 【事実】agent-console が端末へ入れるのは「貼り付け＋Enter」であり、上のキュー動作は pty の中の Claude Code の入力欄の動作。このリポジトリの記録に、**作業中（busy）に平文を貼って Enter を送った実測は無い**。実測があるのは `/rename x\r` の書き込み（次項）。
- 【未確認】busy 中に括弧付き貼付＋Enter で送った複数行の文章が、キューに入るか・割り込むか・欠けるか。公式文書の記載（キュー）が貼り付け経路でも成り立つかは実機で未確認。

### H-2 既存の判定と、許可待ちで送らない理由
- 【事実】`inputVerdict`: status が idle で `waitingFor` なしのときだけ可（`server/agents.ts:80-88`）。コメントの理由: 「waiting は許可プロンプトの応答待ちを含み得て、そこへ Enter を送ると既定の選択肢を押す恐れがある」（:76-78）。
- 【事実】v0.3.7 の実測（2026-10-12、Claude 2.1.296、`docs/handoff/v0.3.7-rename-queue/design.md:12-18`）:
  - 作業中（busy。ツール実行中と文章生成中の両方）に `/rename x\r` を書き込む → 名前は約 3 秒で変わり、元の作業は最後まで終わり、会話の入力として入り込むことはなかった（:13-15）。
  - 許可待ち（waiting、waitingFor "permission prompt"）に `/rename x\r` を書き込む → 名前は変わらず、「Enter が許可プロンプトの既定『1. Yes』を押し、コマンドが実行された」（:16-18）。
- 【事実】だから rename は「busy の間にすぐ送ることはせず、予約して idle になってから送る」方式（同 design.md:20、PO が y で選んだ案）。判定（`checkInput`）と書き込みの間に `await` が 1 回あり、busy から waiting へ変わる恐れをゼロにできないため（:20）。
- 【事実】実装: `requestRename`（`server/hub.ts:160-168`）は `checkInput` が ok なら即送信、そうでなければ `pendingRenames` に予約。`flushPendingRenames`（:184-203）が定期取得のたびに、ポーリング値で ok のものだけ `checkInput` を取り直して 1 回送る。
- 【事実】画面側: `RenameForm` は `willQueue = !blocked && !session.canInput`（`src/components/RenameForm/RenameForm.tsx:21`）。
- 【事実】よく使う指示・変更・部品の送信は、v0.3.7 の予約は使わず、`canInput` が false のあいだはボタンを押せない（D-4）。

### H-3 SessionView で busy と許可待ちを区別できるか
- 【事実】`SessionView.state` は `"working" | "waiting" | "idle" | "no-claude" | "stopped" | "unknown"`（`src/types.ts:1`）。`stateForSession`（`server/agents.ts:90-99`）: status busy → working、waiting → waiting、idle → idle、それ以外 → unknown。
- 【事実】`working`（作業中）と `waiting`（待ち）は `state` で区別できる。どちらも `canInput` は false（:85）。
- 【事実】`SessionView` は `waitingFor` を持たない（`src/types.ts:3-23`、`server/hub.ts:343-360`）。`waitingFor` は `AgentRow` の項目（`server/agents.ts:13`、コメント「status が waiting のときだけ付く（許可プロンプト・質問などの待ち理由）」）。画面からは「許可待ち」と「質問などの待ち」は区別できない。
- 【事実】`inputVerdict` は「idle なのに waitingFor がある」ケースも不可にしている（:86）。実機でこの組合せが起きるかは【未確認】。
- 【事実】`state` は `server/hub.ts` の定期取得（`this.agents`）の値で、`canInput` もそれから作る（:355）。`send-check` は取り直した値（:228-233）。つまり画面の `state` は最大でポーリング間隔ぶん古い。ポーリング間隔の値は今回読んでいない【未確認】。
- 【事実】v0.3.7 で実測したのは waitingFor が `"permission prompt"` のときだけ。他の待ち理由（質問など）で Enter が何を押すかは【未確認】。

---

## I. チャットの入力欄から「よく使う指示」を使いたい

### I-1 QuickPromptBar（v0.9.1 = main）
- 【事実】`src/components/QuickPrompts/QuickPromptBar.tsx:15-33`。props は `prompts`、`canSend`、`onSend(promptId)`、`onEdit`。各指示は SA の Button（outline・sm）で、`disabled={!canSend}`、`onClick={() => onSend(p.id)}`、`title={p.text}`（:22-26）。「編集」ボタンで `QuickPromptEditor` のモーダルを開く（`src/pages/ConsolePage.tsx:439`）。
- 【事実】`src/pages/ConsolePage.tsx` の配置: `centerTab === "terminal"` のときだけバーを出す（:351-358）。一覧は `fetchQuickPrompts` で最初に読み（:118-119）、編集後に `loadQuickPrompts` で読み直す。
- 【事実】指示のデータは `{id, label, text}`（`src/types.ts:77-81`）。画面は一覧の取得で**本文 `text` を持っている**（ボタンの `title={p.text}`）。
- 【事実】サーバーは dataDir の quick-prompts.json に保存（`server/quick-prompts.ts:7`、権限 600）。

### I-2 v0.10.0（origin/release/layout）
- 【事実】`src/components/QuickPrompts/QuickPromptBar.tsx`（60 行）: バーは 1 行。左の「よく使う指示」ボタンで一覧モーダル（Modal・Stack、各行に「常に表示」トグル（`updateQuickPrompt(p.id, {pinned})`）と「使う」ボタン）、真ん中に `pinned` の指示のボタン、右に「編集」。props に `onChanged` が増える。`canSend` のとき以外は押せない（ボタンと「使う」とも `disabled={!canSend}`）。「使う」は一覧を閉じてから `onSend(id)`。
- 【事実】`QuickPrompt` に `pinned: boolean`。保存ファイルでは任意で、無ければ true（`server/quick-prompts.ts` の `parsePinned`）。version は 1 のまま。`PUT /api/quick-prompts/:id` は `pinned` だけを送る更新も受ける。
- 【事実】`handleSendPrompt` と `checkQuickPromptSend` は変更なし。v0.10.0 でも送り方は「確認 → 本文を返す → `pasteAndEnter`」。

### I-3 send-check の流れ（よく使う指示）
1. 画面 `handleSendPrompt(promptId)`（`src/pages/ConsolePage.tsx:179-190`）。選択中の id を `checkedId` に控える。
2. `POST /api/sessions/:id/send-check` `{promptId}`（`src/api.ts:70-71`）。
3. サーバー `server/http.ts:264-269`: `quickPrompts.get(promptId)` → `hub.checkInput(id)` → ok でなければ `SessionConflictError`（409）→ ok なら `{text}`。**サーバーは端末に書かない**。
4. 画面: `selectedIdRef.current === checkedId` かつ `terminalRef.current?.pasteAndEnter(checkedId, text) === true` のときだけ入る。そうでなければ `ac.quick.switched`（ja.json:127）。失敗は `quickError` の Callout（`ac.quick.sendError` :126）。

### I-4 「本文を入力欄に入れてから送る」形にできるか（事実のみ）
- 【事実】`handleSendPrompt` は本文（`text`）を 3 の `send-check` の返り値で受け取るだけで、入力欄に置く経路は今のコードに無い。一方、画面は一覧 API で全指示の `text` をすでに持っている（`quickPrompts` state、ConsolePage.tsx:93）。
- 【事実】`send-check` は `promptId` を取り、本文をサーバー保存のものから返す（`quickPrompts.get`）。クライアントが本文を渡す形ではない。入力欄に入れた本文（編集したもの）を `send-check` に通して判定だけ受ける口は現状無い。判定だけを行う API は `hub.checkInput`（hub.ts:228）と、`GET`/`POST` で `canInput` を返す `SessionView`（snapshot）だけ。
- 【事実】送信の実行は常にクライアントの `pasteAndEnter` / `pasteSubmitAfter`（D-1）。貼り付ける文字列はクライアントが決める。
- 【事実】Enter を送らずに文章だけを端末へ入れる前例はある（画像のパスを貼る `src/components/TerminalPane/TerminalPane.tsx:156` は `term.paste` のみで Enter なし）。
- 【事実】本文の検査（8 KiB 以下・ESC などの制御文字なし）はサーバー側が保存時に行う（`server/quick-prompts.ts:42-47`）。入力欄から任意の文章を送る場合の検査（長さ・制御文字）は、今の経路には無い（`pasteAndEnter` は検査しない）。
- 【事実】指示の本文には改行を含められる（TEXT_CONTROL は改行・タブを許す、`server/quick-prompts.ts` の `TEXT_CONTROL`）。
