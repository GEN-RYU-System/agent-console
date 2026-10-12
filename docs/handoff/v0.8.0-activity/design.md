# 設計: v0.8.0 右の欄に「このセッションの様子」を、非エンジニアに分かる言葉で出す

- 状態: 設計者（Opus）が作成。Fable の設計審査 第1回 REVISE（HIGH 4・MEDIUM 5・LOW 2）を反映した第2版。再審査を待っている。
- PO 承認（2026-10-12）:
  - 依頼の言葉:「左側のセッションを選択したときに右側のカラムにそのセッションのタスク状況とエージェントの作業内容が見える化する」「台帳やワークツリーを見ても理解できないので非エンジニアが見ても理解できる表示」
  - hooks を ~/.claude/settings.json に足すことに「y」。
- 調査: docs/handoff/v0.8.0-activity/recon.md（Sonnet）
- 公式 hooks 文書の写し: scratchpad/hooks.md（本リポジトリ外。行番号は L で示す）
- 対象ADR: ADR-067、ADR-144

## 0. 事実
- 公式 hooks で取れるもの:
  - 全イベントに session_id が付く（L734）。
  - hooks は担当（サブエージェント）の中でも起きる。そのとき agent_id が付く（L271、L745）。
  - Agent の PreToolUse: tool_use_id（L1697）、tool_input の description、subagent_type、model（任意）、prompt（L1853-1858）。
  - Agent の PostToolUse: tool_use_id（L2149）、tool_response の status と agentId（L1862-1878）。
    - `run_in_background` を省いた呼び出しは、既定で async_launched になる。そのときは totalDurationMs などの使用量の項目は来ない（L1864、L1876）。
  - SubagentHandback で報告する担当（v2.1.271 以降）は、報告の本文が last_assistant_message ではなく、SubagentHandback の tool_input.message に入る（L1874、L2534）。PO の環境の担当は、この形で報告している（この設計の審査でも確認）。
  - SubagentStop: agent_id、agent_type、last_assistant_message。Claude Code の内部の担当でも起き、そのとき agent_type は空のことがある（L2526-2553、L2530）。
  - TaskCreated と TaskCompleted: task_id、task_subject（L2563-2644）。途中の進み具合を伝えるイベントは公式に無い。
  - UserPromptSubmit: prompt。ただし、人の入力のほかに、定期実行、背景の担当の報告の戻り、ほかのセッションからのメッセージでも起きる（L1426-1430）。
- hook の書き方:
  - `async: true` の command の hook は Claude を待たせない（L3995）。timeout は効かない（L4022）。終了コード 0 と 2 以外の失敗は、Claude の動きを止めない（L856-858）。
  - `args` を付けると、各要素が1つの引数として渡され、引用符は要らない（exec の形、L464-470）。付けないと shell で分割される。
  - スクリプトが見つからないと、Claude の画面に毎回失敗の通知が出る（L862）。
- 既定の dataDir は `~/Library/Application Support/agent-console/` で、空白を含む（README.md:19、server/config.ts:58）。
- PO の今の hooks:
  - Stop 2、PreToolUse 13、PostToolUse 1、UserPromptSubmit 1。Agent 専用の matcher group は0件（recon B）。
  - 既存の agent-start-hook.sh は、別の目的で ~/.claude/logs/agent-events.jsonl に書いている。session_id では記録していない。
- アプリ:
  - 右の欄は LedgerBoard だけ（ConsolePage.tsx:380-382）。
  - 各セッションの Claude の sessionId は、hub が `claude agents --json` から取っている（hub.ts:192-199、sessions.ts:213-216）。UUID の検査は sessions.ts:21 の isClaudeSessionId。
  - 状態の表示（作業中・待ち・許可待ち）は、すでに agents.ts:85-93 と ja.json の ac.state にある。

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 左でセッションを選ぶと、右の欄の上に「このセッション」と「台帳」のタブが出る。「このセッション」が先に開く。セッションを選んでいないときは「台帳」だけ|単体試験＋e2e|
|K2 「このセッション」には、上から次を出す: (1) 今の状態（作業中／返事待ち／許可の確認待ち。今ある表示を使う）、(2) 今動いている担当（呼び名・頼んだ仕事の説明・動き始めてからの時間）、(3) 終わった担当（新しい順に10件。呼び名・仕事の説明・結果のひとこと（報告の先頭 120 字）・かかった時間）、(4) やることの一覧（作った順。終わったものには印）、(5) 最近の入力（新しい順に3件、先頭 80 字。工程0で人の入力を見分けられたときだけ「しんごさんの指示」と書く）|統合試験（偽の hook の入力を流す）＋e2e|
|K3 担当の呼び名: model か resolvedModel を小文字にして、ja.json の表のキー（sonnet・opus・fable・haiku）を部分一致で探す。見つかれば表の名前（例「Sonnet（調査・実装）」「Fable（審査）」）、無ければ subagent_type をそのまま出す。技術の用語（worktree、ブランチ、台帳）は出さない|単体試験|
|K4 記録は dataDir/activity/events-YYYYMMDD.jsonl（UTC の日付）に、1件1行で書く。サーバーは今日と昨日のファイルを読む。`activityKeepDays`（既定 7、config）より古いファイルは、本番のポートのサーバーだけが消す。並列に 20 のプロセスで 200 行ずつ書いても、読めない行が0件|統合試験|
|K5 hook は async で、Claude を待たせない。失敗しても Claude の作業は止まらない。書くのは決めた項目と長さだけ（§3-2）|単体試験（偽の入力をスクリプトに流す）|
|K6 設定を足す道具は、今ある設定を壊さない。足す前に控えを取る。足すのは agent-console の handler（args[0] が /hooks/activity-hook.mjs で終わる）だけ。2回実行しても増えない。外す道具は、自分の handler だけを外し、空になった自分の group を消す。dataDir に空白があっても、exec の形で正しく足せる|単体試験（一時の HOME で）|
|K7 アプリの外で動くセッションの記録も入るが、右の欄には、選んだセッションの session_id のものだけを出す|統合試験|
|K8 記録の仕組みが外れているとき（settings.json に handler が無い、node か hook のファイルが無い）は、右の欄に「記録の仕組みが外れています」と、直し方（README の手順）を出す|統合試験|
|K9 文言は i18n。見た目は SA の金型とトークンだけ。lint と既存の試験・CI（両 OS）が通る|CI|
|K10（導入後）PO が、担当を呼んでいるセッションを選ぶと、右の欄に担当の呼び名と仕事の説明が出て、終わると結果のひとことが出る。出ないときは、K8 の案内が出る|PO の目視|

## 2. 対象と対象外
- 対象:
  - 新設:
    - hooks/activity-hook.mjs（hook の本体）
    - server/activity.ts（記録を読んで、セッションごとにまとめる）
    - server/activity-routes.ts（API）
    - scripts/ac-hooks.mjs（設定に足す・外す・点検する道具）
    - src/components/ActivityPane/
  - 変更:
    - server/http.ts
    - hub.ts と types.ts（SessionView に claudeSessionId を足す）
    - ConsolePage.tsx（右の欄をタブにする）
    - config（activityKeepDays）
    - ja.json、試験、版 0.8.0、CHANGELOG、README
- 対象外:
  - 担当の会話の中身（transcript）を読むこと（公式に形式が無い）
  - やることの途中の進み具合（公式のイベントが無い）
  - 孫の担当（担当がさらに呼んだ担当）の表示。記録はするが、v0.8.0 では出さない
  - 既存の hooks の変更
  - 担当の仕事の説明を日本語に直すこと。説明は Claude が書いた文のまま出す。設計者（Opus）は、これから担当を呼ぶときの説明を日本語で書く（運用の決まり。記憶に残す）。

## 3. 仕組み
### 3-1 hook の本体の置き場所
- リポジトリの hooks/activity-hook.mjs が正本。
- 本番のサーバーが起動したときに、dataDir/hooks/activity-hook.mjs に写す。入れ替えは一時ファイル→rename。
- ポートを上書きした起動（自己診断・試験）では写さない（v0.6.0 と同じ条件）。

### 3-2 hook が書くもの（activity-hook.mjs）
- 対象のイベントは6つ:
  - PreToolUse（Agent と SubagentHandback）
  - PostToolUse（Agent）
  - SubagentStop
  - TaskCreated
  - TaskCompleted
  - UserPromptSubmit
  - Stop と Notification は使わない。状態は agents --json が正本のため。
- 標準入力の JSON を読み、次の項目だけを1行の JSON にする。
  - 共通: ts（hook が受け取った時刻）、event、session_id、agent_id（あれば）
    - session_id は UUID の形のものだけ使う（sessions.ts:21 と同じ検査）。
  - PreToolUse（Agent）: tool_use_id、description（200字）、subagent_type、model
  - PreToolUse（SubagentHandback）: agent_id、message の先頭 120 字
  - PostToolUse（Agent）: tool_use_id、status、agentId、resolvedModel、totalDurationMs（来たときだけ）
  - SubagentStop: agent_id、agent_type、last_assistant_message の先頭 120 字
  - TaskCreated と TaskCompleted: task_id、task_subject（200字）
  - UserPromptSubmit: prompt の先頭 80 字。工程0で、人の入力でないものの印が分かれば、source を付ける。
- 書き込み:
  - dataDir/activity/events-YYYYMMDD.jsonl を `a` で開き、1行を1つの Buffer にして、1回の writeSync で書く。
  - 書けた長さが足りなければ、それ以上は書かずに終える。
  - 1行の上限は 4KiB。1回の write に収めるための、実用上の上限。
- ファイルとフォルダは 600 と 700。
- どんな失敗でも、終了コード 0 で終わり、何も出力しない。
- node の標準の部品だけを使う。

### 3-3 設定の道具（scripts/ac-hooks.mjs install / uninstall / check）
- install:
  - ~/.claude/settings.json を読み、JSON として正しいことを確かめる。
  - 控えを取る（settings.json.ac-backup-<日時>）。控えは新しい3つだけを残し、それより古い控えは消す（消すのは、この名前の形のファイルだけ）。
  - 6つのイベントに、自分の matcher group を足す。
    - matcher: PreToolUse は "Agent|SubagentHandback"、PostToolUse は "Agent"、そのほかは無し。
    - handler: `{"type":"command","command":"<node の絶対パス>","args":["<dataDir>/hooks/activity-hook.mjs"],"async":true}`（exec の形）。
  - 自分の handler かどうかは、args[0] が /hooks/activity-hook.mjs で終わるかで見分ける。
  - すでにあれば足さない。
  - 一時ファイル→rename で書き、読み直して JSON を確かめる。
- uninstall:
  - 自分の handler だけを外す。
  - 外して空になった自分の group は消す。ほかの handler が同じ group にあれば、残す。
- check:
  - settings.json に自分の handler があるか、その node と hook のファイルがあるかを返す。
  - サーバーは起動のときと1時間ごとに check を行い、結果を K8 の表示に使う。
- 実行するのは設計者。PO の承認済み。自動の判定に止められたら、PO に `!` で1行を実行してもらう。

### 3-4 サーバー（server/activity.ts）
- 今日と昨日の events ファイルを、前回の読み終わりの位置から読み足す。hub の定期の回か、fs.watch を使う。ファイルの名前は日付で変わるので、名前を付け替えることはしない。
- JSON として読めない行は捨て、その数を数える（K4）。
- session_id ごとに、記録をメモリにまとめる。上限は、終わった担当 10件、やること 50件、入力 3件。
- 担当の結び方:
  - PreToolUse と PostToolUse は tool_use_id で結ぶ。並列に呼んでも取り違えない。
  - PostToolUse の agentId と、SubagentStop の agent_id と、SubagentHandback の agent_id で、結果を結ぶ。
    - 結果のひとことは SubagentHandback の message を優先する。無いときだけ、SubagentStop の last_assistant_message を使う。
  - かかった時間は、SubagentStop の ts − PreToolUse の ts。totalDurationMs は、来たときの補助にする。
  - agent_id が付いた PreToolUse（Agent）は、孫の担当とみなし、v0.8.0 では出さない。
  - 結べないものは、出せる項目だけを出す。
- `GET /api/sessions/:id/activity` は、その app のセッションの claudeSessionId のまとめと、K8 の点検の結果を返す。sessionId がまだ無いときは `{status:"noSession"}`。
- 状態は、今ある agents --json の status と waitingFor をそのまま使う（SSOT）。
- 古いファイルを消すのは、本番のポートのサーバーだけ（README.md:36。自己診断のサーバーも同じ dataDir を読むため）。

### 3-5 画面（src/components/ActivityPane/）
- 右の欄の上に、SA の Tabs（「このセッション」「台帳」）を置く。台帳は今の LedgerBoard のまま。
- 「このセッション」は、K2 の5つの区切りを、SA の Card・Badge・EmptyState で出す。
- 時間は「3分前」「2分かかった」のように出す（文言は ja.json）。
- 新しい記録が来たら、WebSocket の合図で取り直す。

## 4. SSOT
- 担当とやることの記録の正本は dataDir/activity/ の日付のファイルの1か所。画面は、サーバーがまとめた写しを出す。
- 今の状態の正本は、今までどおり agents --json。
- hook の本体の正本はリポジトリの hooks/。dataDir/hooks/ は写し。
- 呼び名の表は ja.json だけ。上限は config だけ。

## 5. 安全
- hook は手元のファイルに書くだけで、外には送らない。async で、失敗しても Claude を止めない。
- 入力と報告は、表示する長さだけを残す。入力に PO が貼った秘密の文が混ざるおそれは、600/700 の手元のファイルに限ることで受け入れる。
- settings.json は、控えを取ってから自分の handler だけを足す。外す道具と点検の道具を用意する。

## 6. 代替案
- transcript を読む: 公式に形式が無い。不採用。
- 既存の agent-events.jsonl を使う: 目的が違い、session_id も無い。不採用。
- hook から HTTP で送る: アプリが止まっていると失われ、認証も要る。不採用。
- 1つのファイルを大きさで名前を付け替える: 追記と付け替えが重なると、行を取りこぼす。日付ごとのファイルにして、付け替えをやめる（Fable の審査 M1）。

## 7. リスクと対処
- 工程0の (1)〜(7) のどれかが想定と違う: 止まって戻す。
- node の版が変わってパスが消える: K8 の点検で分かり、install で直せる。
- 記録が増える: 日付ごとに分け、7日より古いものを消す。

## 8. 外部・過去事例の参照と我々への応用
- 公式 hooks の文書（code.claude.com/docs/en/hooks、2026-10-12 取得）。async の command の hook で、Claude を止めずに記録を取るのは、公式に用意された使い方。
- 過去事例 v0.6.0: 拡張のフォルダを dataDir に写す考え方を、hook の本体の置き場所に使い回す。
- 適用限界: 外部の同様の見える化の事例は調べていない。成否は K10 で測る。

## 9. 工程0（実装の最初）
- (a) 別ポートの試験用サーバーで、本物の `claude --model sonnet` を動かす。条件は、捨てディレクトリ、一時の HOME と settings（PO の設定は使わない）、hook を設定した状態。
  - 背景で担当を1つ呼ばせ、次の7つを確かめる。
    1. hook の session_id と `claude agents --json` の sessionId が一致するか
    2. PreToolUse（Agent）に description と model が来るか
    3. PostToolUse の agentId と SubagentStop の agent_id が一致するか
    4. SubagentHandback の tool_input.message と agent_id が来るか
    5. 背景の担当の報告が戻ったときの UserPromptSubmit の prompt の形（人の入力と見分けられる印があるか）
    6. TaskCreated が起きるか
    7. 設定を書き換えたあと、動いているセッションと新しいセッションの両方で hook が起きるか
- (b) 一時の HOME で、ac-hooks.mjs の install を2回、uninstall を1回、check を実行する。dataDir は空白を含む形にして、設定が期待どおりかを確かめる。
- 結果は docs/handoff/v0.8.0-activity/step0.md に書く。1 か 3 が想定と違えば、止まって戻す。5 は、見分けられなければ K2(5) を「最近の入力」のままにする。

## 10. 設計審査
- 第1回（Fable、2026-10-12）: REVISE。すべて反映した。
  - H1 SubagentHandback の報告を取る。
  - H2 exec の形（args）にする。
  - H3 UserPromptSubmit を人の入力と決めつけない。
  - H4 tool_use_id と agent_id で結ぶ。かかった時間は ts の差で出す。
  - M1 日付ごとのファイルにして、付け替えをやめる。
  - M2 書き込みの原子性の根拠を、正しい書き方に直した。
  - M3 道具の細部（空の group、見分け方、控えの数、点検）。
  - M4 残す長さを、表示する長さに合わせる。
  - M5 呼び名の決め方を手順で書く。
  - L1 Stop と Notification は使わない。
  - L2 §0 を正した。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K5（Claude を止めない）、K6（設定を壊さない）、K4（行が混ざらない）を試験で固定する。
- Claude Code の版を上げたら、工程0の (a) を試験で確かめる。

## 11. 設計審査 第2回（Fable、2026-10-12）
- 判定: APPROVE。第1回の指摘は、すべて反映されていることを確認された。
- 実装のときに入れる決め（LOW）:
  - L-a 終わりが記録されない担当は、開始から 24 時間を過ぎたら「今動いている担当」から外す。
  - L-b K8 の点検は、起動のとき、1時間ごと、に加えて、activity の API を呼ぶたびにも行う。設定ファイルを読むだけなので軽い。
  - L-c 工程0 (a) で、一時の HOME では claude がログインを保てない場合の予備の手順:
    - 本物の HOME のまま、`--settings` で hooks だけの JSON を足して (1)〜(6) を確かめる。
    - (7) だけは、一時の HOME で install を使って確かめる。
    - どちらの場合も、PO の settings.json は工程0では触らない。
  - L-d 読むのは今日と昨日（UTC）の記録だけ。そのため、2日以上前の担当は、再起動したあとには出ない。このことを README に書く。
- install を PO の settings.json に実行する直前に、PO に改めて明示の承認を取る。
