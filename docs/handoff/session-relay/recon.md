# ボタン1つで次のセッションへ引き継ぐ・名前が英語に戻る不具合（session-relay）現在地の調査

- 基準: origin/main 0a8266c（v0.21.0）。作業場所 ~/agent-console-wt/session-relay（release/session-relay）。
- 調査: Sonnet（コード /tmp/CC報告ファイル/session-relay/r1/、実機 /tmp/CC報告ファイル/session-relay/r2/）と Opus（/tmp/CC報告ファイル/session-relay/r3/code.txt・ui.txt）。下の行は Opus が読み直して照合した。

## PO の言葉（原文）
「会話の量が多くなった際に新しいセッションにボタン1つで切り替えるモードを作りたい、毎回手入力で引継ぎをするのではなく、ボタンを押したら新しいセッションが開かれて次のセッションに引継ぎをして切り替える機能、セッション名も数字で管理する、このセッションであればAgent Console2→Agent Console3にセッション名を切り替えて新しいセッションで続きがすぐに着手できるようにしたい。…セッション名については手動で新しいセッションを開いた場合も名前を入力したのにCCが立ち上がった際に名前が元の英語名に戻ってしまうので不具合を改修してほしい」

## S1 名前が英語に戻る原因
- server/hub.ts:553（snapshot）`name: agent?.name !== undefined && agent.name !== "" ? agent.name : s.name`。Claude が動いている間は Claude 側の名前が優先される。
- 実機（r2）: 起動直後の Claude の name は cwd のフォルダ名からの自動名（例 "work-06"）。そのため、アプリで付けた名前が自動名に負ける。
- 実機（r2）: `/rename X` を送ると約5秒後に name が X になり、次の指示の後も X のまま。`claude -n X` で起動しても X で保たれる。
- 役割の command は役割ごとに固定の配列（agent-console.config.json:33 `/bin/zsh -ic ccopusgo`、:42 `claude --model sonnet`）で、セッションごとに変わる名前を渡す仕組みが無い。よって `/rename` を送る経路を採る。

## S2 既存の改名の仕組み
- server/hub.ts:199-208 requestRename: checkInput が ok ならすぐ applyRename、そうでなければ pendingRenames に予約。
- server/hub.ts:211-220 applyRename: hasClaude なら端末に `/rename ${name}\r` を書く。いなければアプリ側の名前だけ変える。
- server/hub.ts:223-242 flushPendingRenames: 定期取得（:158）のたびに予約を見て、ok になったら 1 回送る。
- 起動直後に使う「初回の改名」は無い。sessions.create（server/sessions.ts:262）と restore（:320）は名前をアプリ側に持つだけ。

## S3 新しいセッションを開いて文を送る部品
- server/launch.ts:82-94 launchAndSend: cwd 再検査 → 空き確認 → sessions.restore（名前は sessionNameFor で末尾に日時を付ける :58-62）→ waitReady（:70-79、checkInput が ok かつ hasClaude になるまで。既定 3 秒ごと・120 秒まで :10-11）→ stillWanted → hub.submitText。
- server/hub.ts:393-401 submitText: 括弧付き貼り付け → pasteSubmitDelayMs 待つ → `\r`。
- server/sessions.ts:320-327 restore: worktree を新しく作らず、渡された cwd・branch で role.command を起動する。claudeSessionId が無ければ新しい会話。
- 名前は 1〜40 字（server/launch.ts:8 MAX_NAME）。

## S4 状態
- server/agents.ts:19 SessionState = "working" | "waiting" | "idle" | "no-claude" | "stopped" | "unknown"。
- 画面の SessionView は state・hasClaude・canInput を持つ（server/hub.ts:558-561）。

## S5 画面
- 一覧の行: src/components/SessionList/SessionList.tsx。行の右に閉じる（×）ボタン（停止中以外、:150-162）。部品は @sa の Button・Badge・StatusDot。
- 確認の部品: src/pages/ConsolePage.tsx は @sa/components/ConfirmModal（:504,514）と Modal を使う。閉じる確認は closeTargetId（:120,185）。
- 通知: Callout（ConsolePage.tsx の closeError・restoreNotices の表示）。

## S6 会話の量
- `claude agents --json` の項目は pid, cwd, kind, startedAt, sessionId, name, status の 7 つで、量は無い（r2）。
- statusLine の入力には context_window.used_percentage などがある（code.claude.com/docs/en/statusline、r2/q5-statusline-doc.txt）。今の hooks/ac-statusline.mjs:41-51 は rate_limits だけを残す。

## S7 未確認
- tmux の中・アプリの起動条件で、起動直後に `/rename` を送ったときの挙動（r2 は素の端末での確認）。
- 古いセッションに「~/CC報告ファイル-keep/relay/… に書いて」と頼んだとき、Claude Code が書き込みの許可を求めるか（作業フォルダの外のため）。

## 既存の設計・決まり
- このリポジトリに ADR は無い。設計の正本は docs/handoff/<仕事>/design.md。関係: v0.3.7-rename-queue（改名の予約）、routines-new-session・reservations（launchAndSend）、keep-sessions（tmux で保つ）。
