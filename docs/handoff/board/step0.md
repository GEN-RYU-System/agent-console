# step0: 実装前の実測（作戦ボード v0.12.0）

- 日付: 2026-10-13。基準は origin/main 288ddcb（v0.11.0）。
- 本物の claude は 2.1.296（捨てディレクトリで claude --model sonnet）。hook は --settings で付け、--setting-sources project,local で PO の settings.json は読ませていない。捨ての記録係と作業ファイル・写真は本リポジトリ外（スクラッチの board-step0 フォルダ）に置いた。
- SA の金型・トークンは sa-sync した .sa-cache（SA main ef2f8fca122d4a1a778a913de784fe9758aa4857、本リポジトリ外）から読んだ。
- 設計 §9 の分岐の判定: (a) ① は「来る」・② は「一致する」、(b) は親の Bash で食い違わなかった。→ **設計 §3-1 は成り立つ。実装に進んだ**（BLOCKED の条件には当たらない）。

## (a) 担当の再開で SubagentStart が来るか、agent_id が一致するか、SendMessage の入力の項目
実機: claude --model sonnet -p。hook は PreToolUse（全道具）・PostToolUse（全道具）・SubagentStart・SubagentStop・UserPromptSubmit に捨ての記録係（標準入力の JSON をそのまま 1 行で追記し、環境変数 CLAUDE_CODE_SESSION_ID も添える）を付けた。
指示: 「Bash で printenv を実行 → Agent（general-purpose）の担当に printenv と ALPHA を返させる → 担当が終わったら SendMessage で、その担当の agentId に BETA と返させて再開 → 再開した担当の返事を報告」。

記録された 16 件（記録をそのまま 1 件ずつ整形した出力。長い tool_response の末尾は整形のとき切った。env は記録係が見た CLAUDE_CODE_SESSION_ID、sid は hook の session_id）:
```
{"env":"ad60efcb-9d0c-43a1-936f-e3d31b43c907","ev":"UserPromptSubmit","sid":"ad60efcb-9d0c-43a1-936f-e3d31b43c907"}
{"env":"ad60efcb-...","ev":"PreToolUse","tool":"Bash","input":"{\"command\":\"printenv CLAUDE_CODE_SESSION_ID\"}"}
{"env":"ad60efcb-...","ev":"PostToolUse","tool":"Bash","resp":"{\"stdout\":\"ad60efcb-9d0c-43a1-936f-e3d31b43c907\",\"stderr\":\"\", ...}"}
{"env":"ad60efcb-...","ev":"PreToolUse","tool":"ToolSearch","input":"{\"query\":\"select:SendMessage\",\"max_results\":1}"}
{"env":"ad60efcb-...","ev":"PostToolUse","tool":"ToolSearch","resp":"{\"matches\":[\"SendMessage\"], ...}"}
{"env":"ad60efcb-...","ev":"PreToolUse","tool":"Agent","tuid":"toolu_016McgJD24oUr6N5871JFLHF","input":"{\"description\":\"Report session ID\",\"prompt\":\"Bash で printenv CLAUDE_CODE_SESSION_ID を実行し、…\",\"subagent_type\":\"general-purpose\",\"run_in_background\":false,\"name\":\"helper\"}"}
{"env":"ad60efcb-...","ev":"SubagentStart","agent_id":"ab4603515d5beee56","agent_type":"general-purpose"}
{"env":"ad60efcb-...","ev":"PreToolUse","agent_id":"ab4603515d5beee56","agent_type":"general-purpose","tool":"Bash","input":"{\"command\":\"printenv CLAUDE_CODE_SESSION_ID\", ...}"}
{"env":"ad60efcb-...","ev":"PostToolUse","agent_id":"ab4603515d5beee56","agent_type":"general-purpose","tool":"Bash","resp":"{\"stdout\":\"ad60efcb-9d0c-43a1-936f-e3d31b43c907\", ...}"}
{"env":"ad60efcb-...","ev":"SubagentStop","agent_id":"ab4603515d5beee56","agent_type":"general-purpose"}
{"env":"ad60efcb-...","ev":"PostToolUse","tool":"Agent","tuid":"toolu_016McgJD24oUr6N5871JFLHF","resp":"{\"status\":\"completed\",\"prompt\":\"...\",\"agentId\":\"ab4603515d5beee56\",\"agentType\":\"general-purpose\", ...}"}
{"env":"ad60efcb-...","ev":"PreToolUse","tool":"SendMessage","tuid":"toolu_01DAVmTjt6urPzryRjj4ntLC","input":"{\"to\":\"ab4603515d5beee56\",\"summary\":\"Ask helper to reply BETA\",\"message\":\"BETA と返答してください\",\"type\":\"message\",\"recipient\":\"ab4603515d5beee56\",\"recipient_kind\":\"agent\",\"content\":\"BETA と返答してください\"}"}
{"env":"ad60efcb-...","ev":"SubagentStart","agent_id":"ab4603515d5beee56","agent_type":"general-purpose"}
{"env":"ad60efcb-...","ev":"PostToolUse","tool":"SendMessage","tuid":"toolu_01DAVmTjt6urPzryRjj4ntLC","input":"{\"to\":\"ab4603515d5beee56\",\"summary\":\"Ask helper to reply BETA\",\"message\":\"BETA と返答してください\"}","resp":"{\"success\":true,\"message\":\"Resuming agent ab46035\",\"resumedAgentId\":\"ab4603515d5beee56\",\"pin\":{\"id\":\"ab4603515d5beee56\",\"name\":\"ab4603515d5beee56\",\"ref\":\"124a9b\"}}"}
{"env":"ad60efcb-...","ev":"SubagentStop","agent_id":"ab4603515d5beee56","agent_type":"general-purpose"}
{"env":"ad60efcb-...","ev":"UserPromptSubmit","sid":"ad60efcb-9d0c-43a1-936f-e3d31b43c907"}
```
- ① 【事実】**再開のときに SubagentStart は来る**。最初の呼び出しで 1 回（Agent の PreToolUse の直後）、SendMessage の再開で 1 回（SendMessage の PreToolUse と PostToolUse の間）、同じ agent_id で来た。
- ② 【事実】**一致する**。SubagentStart の agent_id は ab4603515d5beee56。PostToolUse（Agent）の tool_response.agentId は ab4603515d5beee56。SendMessage の PostToolUse の resumedAgentId も ab4603515d5beee56。3 つとも完全に同じ文字列。
- ③ 【事実】SendMessage の PreToolUse の tool_input の項目の名前は to・summary・message・type・recipient・recipient_kind・content の 7 つ（to が相手の agentId、message と content が本文）。PostToolUse の tool_input は to・summary・message の 3 つ。本作の hook は SendMessage を記録しない（SubagentStart だけで再開を知る）ので、この名前は使わない。
- 補足【事実】前景の担当（run_in_background なし）の PostToolUse（Agent）は status completed で、SubagentStop の**後**に来る。再開（SendMessage）では Agent の PostToolUse は来ない。再開した担当の終わりは SubagentStop だけで知る。設計 §3-1 の「始まり = 呼び出しと SubagentStart の新しい方、終わり = 停止・報告・completed の新しいもの」がそのまま成り立つ。

## (b) CLAUDE_CODE_SESSION_ID と hook の session_id
| 場面 | 環境変数 CLAUDE_CODE_SESSION_ID | hook の session_id | Bash の printenv の出力 |
|---|---|---|---|
| 親の Bash（claude -p）の PreToolUse・PostToolUse | ad60efcb-9d0c-43a1-936f-e3d31b43c907 | ad60efcb-9d0c-43a1-936f-e3d31b43c907 | ad60efcb-9d0c-43a1-936f-e3d31b43c907 |
| Agent（general-purpose、sonnet）の中の Bash | ad60efcb-9d0c-43a1-936f-e3d31b43c907 | ad60efcb-9d0c-43a1-936f-e3d31b43c907 | ad60efcb-9d0c-43a1-936f-e3d31b43c907 |
| 番号を付けずに選ぶ一覧（claude --resume）から再開した会話（対話・node-pty） | b06ed72f-cded-499d-b079-bcd88bcf5377 | b06ed72f-cded-499d-b079-bcd88bcf5377 | b06ed72f-cded-499d-b079-bcd88bcf5377 |
| claude --continue で再開した会話（対話・node-pty） | b06ed72f-cded-499d-b079-bcd88bcf5377 | b06ed72f-cded-499d-b079-bcd88bcf5377 | b06ed72f-cded-499d-b079-bcd88bcf5377 |

- 【事実】親の Bash でも、担当の中の Bash でも、環境変数は hook の session_id と同じ（食い違いなし）。→ 設計の停止条件（親の Bash で食い違う）には当たらない。
- 【事実】番号なしの再開（一覧から選ぶ・--continue）でも、環境変数・hook の session_id・Bash の出力は、再開した会話の番号 b06ed72f-…（最初に作った会話の番号）と同じだった。公式の文書は「起動時の番号を受け取りうる」と書くが、この版（2.1.296）では食い違いは再現しなかった。README に、再現しなかったことと、もし食い違えばボードが別の番号に書かれることを書いた。
- 手順の注意【事実】この実測を動かした Claude セッションは CLAUDE_CODE_CHILD_SESSION の印を引き継ぐため、対話の claude は「Transcript saving is off」と出し、会話を保存しない（そのため最初の一覧は「No conversations found in this project」だった）。捨ての対話の claude にだけ環境変数 CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 を付けて保存させた。
- 起動は 1 回も自動判定に止められなかった。

## (c) ProgressBar は label を渡さなければ文字が出ない
SA の ProgressBar.tsx（.sa-cache の frontend/src/components/loading/ProgressBar.tsx、SA ef2f8fca…。本リポジトリ外）を読んだ（実機は要らない）。
- :6-12 props は value・variant・label?（label は省略できる）。:14 clamp で 0〜100 に丸める。
- :46-61 の描画: :48 `{label && (` の中（:49-56）だけが文字（:51 の done なら固定の 'Done'、そうでなければ label。:53-55 の % とチェック）を出す。label を渡さなければ、この枠は描かれず、:58-60 の棒（role="progressbar"、aria-valuenow、幅 pct%）だけが出る。
- → label を渡さない限り、100% でも 'Done' の文字（i18n できない固定文）は出ない。本作は label を渡さず、「完了 N / M」の文を自前の ja.json の文言で出す。単体試験と e2e で 100% のときも Done が出ないことを固定した。

## (d) 右の欄の既定の幅で、KPI の 4 列の DataTable が読めるか
実機: 本物の画面（e2e の環境、ポート 4329）で、SA の DataTable（density compact）に、名前・目標・今・単位の 4 列で KPI を 3 件出し、写真を撮った（写真は本リポジトリ外のスクラッチ、kpi-table-1400.png と kpi-table-1100.png）。
- 【事実】右の欄の既定の幅（窓 1400px のとき）は 283px、窓 1100px のとき 217px（要素の boundingBox）。
- 【事実】4 列の表は読めなかった: 「名前」の列だけが枠いっぱいに出て、目標・今・単位の 3 列は枠の右の外（DataTable の横スクロールの中）にあり、見えない。KPI の肝心の「今の値」が見えない。
- → 設計 §3-3 の指定どおり、**「名前 ／ 今の値 → 目標 単位」の 1 件ずつの一覧に切り替えた**（DataTable は使わない）。切り替えたあとの写真（kpi-1400.png、kpi-1100.png）で、名前（折り返す）の下の行に「212 → 300 件」の形で全部が 283px・217px の両方で読めることを確かめた。

## 試験の RED → GREEN の記録
- RED（実装の前に取った）:
  - 単体・統合・画面（vitest）: Test Files 8 failed (8)、Tests 38 failed | 86 passed | 5 skipped (129)。落ちた理由は、SubagentStart が記録されない・EVENTS に無い・hook が 8 つ・再開しても running に戻らない・ac-board.mjs と installBoardCommand が無い・「作戦ボード」のタブ名と board-* の区切りが無い、など。
  - e2e（playwright、activity.spec.ts）: 6 件中 1 failed、5 did not run。K1 の「作戦ボード」のタブが見つからない（element(s) not found）で止まり、後ろは serial のため実行されなかった。
- GREEN（実装の後）:
  - npm run typecheck → 終了コード 0。npm run lint → design governance: OK（終了コード 0）。
  - npm test → Test Files 79 passed (79)、Tests 1151 passed (1151)。
  - npm run build → 終了コード 0（最後に dist-server/hooks/ac-board.mjs を写す）。
  - npm run test:e2e → 55 passed。
  - 途中で落ちた 2 件（1 回目の e2e）は、実装でなく試験の直し: 作戦ボードの「最後に更新」は書いた直後は「たった今」と出るので期待を直した／保存先の一覧の試験（console.spec.ts）に、サーバーが作る bin/ と、右の欄の試験だけが作る boards/ を足した。

## 後片付け
- 一時の試験 1 本（右の欄の写真用）は、名前を指定した rm で消した。リポジトリには残っていない。写真・記録係・点検の道具は本リポジトリ外のスクラッチにある。
- 本作が捨てディレクトリで作った claude の会話（保存を許可した 2 件）は、PO の ~/.claude の下の捨てディレクトリ用の項目に残る（本作のコードとは無関係）。
