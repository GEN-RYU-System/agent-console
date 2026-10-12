# 工程0の記録: セッションの様子（設計 §9 と §11 L-c）

- 実施: 2026-10-12、実装担当（Sonnet）。claude 2.1.296、node v24.12.0。
- 版について: 設計の書類の名前は v0.8.0 のままだが、端末の改善が v0.8.0 として別に出るため、この機能は版 0.9.0 で出す（調整役の指示）。
- 生の出力の置き場（本リポジトリ外）: /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad/step0/（raw.jsonl、raw7.jsonl、agents7.json、out-a.raw、out-b.raw、out-real.raw、out-view-real.raw、drive7.out、recorder.mjs、settings-a.json、drive7.mjs）
- 結果: 「止まって戻す」とした (1) と (3) は想定どおり。実装に進んだ。

## (a) 本物の `claude --model sonnet` で 7 点

- 【事実】やり方の変更（L-c の予備の手順）: 一時の HOME で `claude -p` を動かすと「Not logged in · Please run /login」になった（ログインを保てない）。そのため、本物の HOME のまま、捨てディレクトリで動かし、hook は `--settings` で足した（記録するだけの recorder.mjs。PO の settings.json には書いていない）。(7) だけは一時の場所の設定ファイルを使った。
- 【事実】背景の担当を 1 つ呼ばせ、TaskCreate / TaskUpdate も使わせた（out-a.raw、raw.jsonl の 8 行）。

| # | 確かめたこと | 結果 | 根拠 |
|---|---|---|---|
| 1 | hook の session_id と `claude agents --json` の sessionId の一致 | 一致 | stream-json で動かしたセッションの session_id 5ef849cf-… が、動作中に取った agents7.json の 12 行のうち 1 行（kind=interactive、cwd=捨てディレクトリ）の sessionId と一致 |
| 2 | PreToolUse(Agent) に description と model | 来た | description「動作確認の担当」、model「sonnet」、subagent_type、run_in_background（raw.jsonl 3 行目） |
| 3 | PostToolUse の agentId と SubagentStop の agent_id | 一致 | どちらも adb70659d13d3046a（raw.jsonl 4 行目と 6 行目）。status は async_launched、resolvedModel は claude-sonnet-5-5 |
| 4 | SubagentHandback の message と agent_id | 来た | tool_input.message「担当OK」、agent_id は同じ adb70659d13d3046a（5 行目）。この回の SubagentStop には last_assistant_message が無かった |
| 5 | 背景の担当の報告が戻ったときの UserPromptSubmit | 印あり | prompt が `<agent-message from="<agentId>">` で始まり、`[Subagent hand-back]` の説明が続く（7 行目）。人の入力にはこの印が無い |
| 6 | TaskCreated が起きるか | 起きた | task_id「1」、task_subject「step0 確認」。TaskCompleted も起きた |
| 7 | 設定を書き換えたあと、動いているセッションと新しいセッションで hook が起きるか | 両方で起きた | 動いているセッション: 1 通目のあとに捨てディレクトリのプロジェクト設定へ UserPromptSubmit を書き足し、2 通目で recorder が記録（raw7.jsonl）。新しいセッション: 最初から設定がある状態の別の実行（out-a.raw）で起きた |

- 【事実】(5) の結果、見分けられるのは「担当の報告の戻り」だけ（人の入力には印が無いので、人の入力かどうかを確実に見分けることはできない）。K2(5) の見出しは「最近の入力」のままにし、「しんごさんの指示」とは書かない。hook は `<agent-message` で始まる入力に source=agent を付け、画面の「最近の入力」からは外す（設計 §9 の「見分けられなければ『最近の入力』のまま」に沿った決め）。
- 【未確認】(7) は、PO の `~/.claude/settings.json`（ユーザー階層）ではなく、捨てディレクトリのプロジェクト階層の設定で確かめた。同じ設定ファイルの監視の仕組みだが、ユーザー階層での確認は導入後（K10）。
- 【事実】実際の hook の本体（activity-hook.mjs）を、`scripts/ac-hooks.mjs install` で捨てディレクトリのプロジェクト設定に入れて（dataDir は空白入りの Application Support）、本物の claude を動かした（out-real.raw）。events ファイルに 8 行が書かれ（権限 600）、`ActivityStore` に読ませると「終わった担当 1 件（説明・Sonnet・結果『実フックOK』・13.9 秒）、やること 1 件（完了）、最近の入力 1 件（報告の戻りは入らない）」になった（out-view-real.raw）。

## (b) 一時の HOME で ac-hooks.mjs

- 【事実】やり方: 一時の HOME（b-home）に元の設定（permissions・hooks の Stop と PreToolUse・enabledPlugins）を置き、dataDir は `…/Library/Application Support/agent-console`（空白入り）。install 2 回 → check → uninstall → check の順で実行（out-b.raw）。
- 【事実】結果:
  - install 1 回目: 6 つのイベントに足し、控え settings.json.ac-backup-<日時> を 1 つ作った。2 回目は「すでに入っています（変更なし）」で、増えず、控えも増えない。
  - check: install 後は `{"ok":true}`（終了コード 0）、uninstall 後は `{"ok":false,"reason":"missingHandler",…6 イベント}`（終了コード 1）。
  - handler は exec の形（command は node の絶対パス、args に空白入りのパスが 1 要素）、async: true。
  - uninstall 後の設定は、元の設定と JSON として同一（SAME）。
  - 【事実】書き直すと、元の 1 行の配列（`"allow": ["Bash(ls:*)"]`）は複数行に整形される（JSON の意味は同じ。元の中身は控えに残る）。
