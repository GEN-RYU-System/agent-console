# 作戦ボードの書き忘れ防止（board-guard）設計 第2版

- 状態: 第2版＋審査反映（Opus 2026-10-14）。第2版は Fable 審査 APPROVE（工程0へ進んでよい。/tmp/CC報告ファイル/board-adoption/review-design2/review.md。中 A〜C は下に反映）。第1版は Fable 審査 REVISE（/tmp/CC報告ファイル/board-adoption/review-design1/review.md。第1版の控え: /tmp/CC報告ファイル/board-adoption/design-v1.md）。PO 未承認。
- PO の言葉（2026-10-14）: 「あなたが作ってくれた右側の作戦ボードだがほとんどのセッションで使っておらず有効化されていない、どうやったら他のセッションも守る？」
- 根拠の生出力: /tmp/CC報告ファイル/board-adoption/facts.md、r2/（公式・settings.json の Stop の並び）、r3/（origin/main f255892 の行番号。§0 のコードの行はすべて r3 による）

## 0. 事実（origin/main f255892・v0.19.0、Claude Code 2.1.296。稼働中の本番は v0.17.0）
- ボードを書く指示は ~/.claude/prompts/salesanchor-designer.md:42 の1か所だけ。届くのは opus-designer 役（`ccopusgo` 起動）だけで、sonnet-impl 役（`claude --model sonnet`）には届かない（agent-console.config.json:27-50）。
- 2026-10-14 08:41 JST の本番 dataDir: open-sessions.json 11件、boards/ 4件（r3/5b）。指示が起動時に入っていた e7a95d2c でも書き込みは0回（facts.md §2）。→ 指示文だけでは守られない。
- hooks/ac-board.mjs: 引数は `write` だけ（:190）。readBoard(dataDir, sessionId) を export（:161、none/invalid/ok）。dataDir は自分の置き場所の1つ上（:216,225）。置き場所が bin/ でなければ exit 1（:217）。isMain は argv[1] との比較（:204-211）なので、import しても書き込みは走らない。
- 写し: サーバー起動時に activity-hook.mjs を dataDir/hooks/（activity-setup.ts:11,38-40 / activity-start.ts:44）、ac-board.mjs を dataDir/bin/（activity-setup.ts:20,43-45 / activity-start.ts:49）へ写す。scripts/ac-hooks.mjs は ac-board.mjs を写さない（:15 の import に無い）。
- 登録: `node scripts/ac-hooks.mjs install|uninstall|check`（:65-78）。「アプリは設定を書き換えない」（:8）。activity-hooks.ts は activity 専用の作り: Handler 型は `async: true` 固定（:41-47、buildHandler :49-51）、目印は args[0] の末尾 "/hooks/activity-hook.mjs"（:8、isOwnHandler :53-57）、addHandlers :90、removeHandlers :125、findHandler :161-168、checkHooks :177。控えは6世代（BACKUPS_KEPT :11、pruneBackups :215-217）、commit は控え→一時ファイル→rename→読み直し検証→失敗なら控えから戻す（:246-275）。試験が handler の形と数（9）を固定（tests/unit/activity-hooks.test.ts:50,81-87,92,258,312）。
- agent-console 起動を示す専用の環境変数は無い（sessions.ts:74-85,285）。hook から見分けられる材料は open-sessions.json の claudeSessionId。保存の経路: hub.ts:402 detectBreaks → :408 setClaudeSessionId（sessions.ts:229-232）→ restore.ts:45 onChange → :65 sync → :81 書き込み。新しいセッションは、この経路が番号を拾うまで open-sessions.json に番号が無い。
- 定期実行由来のセッションを open-sessions.json で見分ける印は無い（キーは claudeSessionId・cwd・name・roleId の4つ。routineId は server/ に0件。r3/5a）。
- hook の session_id と CLAUDE_CODE_SESSION_ID（ボードの書き込み先）は、親・担当内・--resume・--continue の4場面で一致を実測済み（docs/handoff/board/step0.md:36-45）。
- 今の Stop の handler（r2/stop-hooks.txt）: 同期の agent-stop-hook.sh（記録・読み上げのみ、止めない）と japanese-reply-guard.py（stop_hook_active が true なら止めない :37、条件に合えば decision:block :42-43）、async の activity-hook.mjs（止めない）。
- 公式（https://code.claude.com/docs/en/hooks。Context7 は「Monthly quota exceeded」で利用不可のため直接確認）:
  - Stop は main agent の応答終了で走る。ユーザーの割り込みでは走らない。サブエージェントの終了は SubagentStop で別。
  - 入力に stop_hook_active・last_assistant_message・transcript_path 等。stop_hook_active は「stop hook により続行中」の時 true。
  - block は `{"decision":"block","reason":"…"}` か exit 2。async の hook は decision が効かない。timeout 時は出力を捨てる（止めない）。
  - 同じイベントの hook は並列に走る。Stop の block 同士の reason の合成は記載なし。additionalContext は全 hook の分を保つと記載あり。
  - 連続続行は8回で上限（ツールを呼ぶと数え直し）。
  - exit 0 の hook の stderr は Claude に見えない。
  - settings.json の直接の編集は、通常はファイル監視で反映される。

## 1. 方針
指示文（お願い）ではなく、アプリ側の hook で「ボードが無いまま作業を進めているセッション」を1回だけ止め、書き方を本人に渡す。止めるのは agent-console が開いたセッションだけ。

## 2. 成功条件（○×で判定）
- K1: open-sessions.json に番号があり、transcript の tool_use が3件以上で、ボードが無いセッションの応答終了で1回止まり、reason に書き方（コマンドと JSON の形）が出る。判定: 単体試験＋工程3の実機（`claude --debug` のログと画面）。
- K2: 同じセッションで2回目以降は止めない（書かなかった場合も）。止めた印は dataDir/board-guard/<id>。判定: 単体試験。
- K3: open-sessions.json に無い session_id は止めない（agent-console の外の Claude、番号がまだ保存されていない新しいセッションの最初の応答）。判定: 単体試験。
- K4: ボードが ok なら止めない。invalid なら K1 と同じく1回止める（reason に「形が壊れている」）。判定: 単体試験。
- K5: stop_hook_active が true なら止めない。判定: 単体試験。
- K6: どこで失敗しても止めない（常に exit 0、出力なし）。失敗は dataDir/board-guard/errors.log に日時つき1行。判定: 単体試験（open-sessions.json 壊れ・bin/ac-board.mjs 無し・transcript 無し・印が書けない、の4つで exit 0・出力なし・errors.log に1行）。
- K7: `ac-hooks.mjs install/uninstall/check` が board-guard も足す・外す・点検する。既存の利用者 hook と activity の handler は変わらない。判定: 単体試験と、工程3の install 前後で `jq -S` で正規化した settings.json の差分が board-guard の handler 1つだけであること（uninstall 後は install 前と一致）。
- K8（運用指標）: ボード保有率 = boards の ok 件数 ÷ open-sessions.json の件数。基準値 3/11（2026-10-14 08:41 JST。boards のファイルは4件だが、1件は閉じたセッション a2a5ef28 の物。review-design2）。導入7日後に 10/11 以上。測るのは scripts/board-coverage.mjs。

## 3. 仕組み
### 3-1 hooks/board-guard.mjs（新規。dataDir/hooks/ に写す）
全体を try/catch で包み、どこで失敗しても errors.log に1行書いて exit 0（errors.log も書けなければ黙って exit 0）。
1. stdin の JSON を読む。session_id が UUID 形でなければ exit 0。
2. stop_hook_active が true なら exit 0。
3. dataDir = 自分の置き場所の1つ上。open-sessions.json の items[].claudeSessionId に session_id が無ければ exit 0。
4. dataDir/board-guard/<id> があれば exit 0。
5. `await import(pathToFileURL(join(dataDir, "bin", "ac-board.mjs")).href)` で readBoard を読む（判定の正本を ac-board.mjs の1か所に保つ。相対 import は写し先が hooks/ と bin/ に分かれるので使わない）。読めなければ K6。readBoard が ok なら exit 0。
6. transcript_path を先頭から行ごとに読み、assistant の content の tool_use が3件に達した所で読み止める（全部は読まない。本番の最大の transcript は 10.1MB で、全件を読むと最大 2.85 秒かかった。review-design2）。最後まで読んで3未満なら exit 0。transcript は書き込みが遅れることがある（公式）ので、少なく数えた時は止めない側に倒れる。timeout は工程0 (f) の実測で決める。
7. dataDir/board-guard/<id> を作ってから、stdout に `{"decision":"block","reason":"<文面>"}` を出して exit 0。印を先に作るので、2回目は必ず止めない。
- 文面（日本語・固定）: 作戦ボードがまだ無い（または形が壊れている）こと、`node "<dataDir>/bin/ac-board.mjs" write` に JSON を標準入力で渡すこと、項目と上限（README「作戦ボード」）、単発の質問だけのセッションなら theme だけでよいこと、この案内は1回だけであること。
- 工程0 (c) の結果、block 同士で reason が落ちると分かった場合は、block の代わりに additionalContext で同じ文面を渡す形に変える（第3版で決める）。

### 3-2 登録の一般化（server/activity-hooks.ts・scripts/ac-hooks.mjs）
handler の種類を表にする。
- activity: 目印 "/hooks/activity-hook.mjs"、async: true、今の9つのイベント（変えない）。
- board-guard: 目印 "/hooks/board-guard.mjs"、async なし、timeout 5、Stop だけ。
触る関数: Handler 型（:41-47。async を任意、timeout を任意に）、buildHandler（:49-51。種類から作る）、isOwnHandler（:53-57。種類ごとの目印）、addHandlers（:90）・removeHandlers（:125）・findHandler（:161-168）・checkHooks（:177）は種類を引数に取る。commit（:246-275）と控え（:11,215-217）は変えない。
- 既存の試験（activity-hooks.test.ts:50,81-87,92,258,312）の期待は変えずに通す。board-guard 用の試験を足す。
- 写し: activity-setup.ts に board-guard.mjs を dataDir/hooks/ へ写す関数を足し、activity-start.ts の起動時と ac-hooks.mjs install の両方で呼ぶ。
- 実際の install は PO の手元で `! node scripts/ac-hooks.mjs install` を1回（settings.json を変えるため。アプリは書かない方針を守る）。

### 3-3 測る口
- scripts/board-coverage.mjs（新規、読むだけ）: open-sessions.json の各 claudeSessionId の readBoard の結果を数え、「ok 件数/全件数（日時）」を1行で出す。

## 4. SSOT
- ボードの正本は dataDir/boards/<id>.json のまま。判定は readBoard の1か所（board-guard も board-coverage も import する）。
- 「agent-console のセッションか」の正本は open-sessions.json。新しい表を作らない。
- 止めた印は dataDir/board-guard/<id>（空ファイル）、失敗は同じ所の errors.log。

## 5. 安全
- 止めるのは1セッション1回だけ。stop_hook_active でも止めない。続行の上限（8回）に近づかない。
- 失敗は必ず「止めない」側（K6）。timeout も公式どおり止めない。
- 本番の settings.json は ac-hooks.mjs の控え・検証つきの書き込みでだけ変える。
- 本番の tmux ソケットや他のセッションの中身には触れない。読むのは open-sessions.json・boards・本人の transcript だけ。

## 6. 決めたこと（Opus）
- 定期実行由来のセッションも止める対象に含める。理由: 開いている間は他のセッションと同じく作業を進め、PO が作戦ボードで見る対象になる。止まるのは1回だけ。見分ける印も今は無い（§0）。
- 復元の直後は、ボードの無いセッションが次の応答終了でそれぞれ1回止まる（復元された会話の transcript には前の tool_use が残っているため）。意図した動き。
- 新しいセッションの最初の応答では、番号がまだ保存されていなければ止まらない。次以降の応答で止まる。

## 7. 代替案
- 指示文を全役のプロンプトに足す: 指示があっても0回の実例（e7a95d2c）があり不採用。sonnet-impl への書き方の伝達は reason が担う。
- 毎回止める: 単発の質問で毎回止まり邪魔になる。不採用。
- SessionStart で思い出させるだけ: 強制がなく今と同じ。不採用（将来の追加は可）。
- ボードの「古さ」も見る: 判定が推測になる。今回は対象外。

## 8. リスク
- japanese-reply-guard と同時に block した時の reason の合成は公式に記載なし → 工程0 (c)。japanese-reply-guard の続行中は stop_hook_active が true なので board-guard は見送り、次の応答終了で止まる。
- /clear で番号が変わった時、`claude agents --json` の sessionId と open-sessions.json の claudeSessionId が新しい番号になるかは【未確認】→ 工程0 (b)。ならないなら、その会話では止まらない（止めない側）。
- install 後、起動中のセッションに新しい hook が効くかは【未確認】→ 工程0 (e)。
- transcript の形は公式の安定した約束ではない。数えられなければ止めない側に倒れる。
- 版の跳び: 本番は v0.17.0。keep-sessions（v0.20.0）の後に出す（v0.21.0 の予定）。

## 9. 外部・過去事例
- 外部事例は使わない。理由: Claude Code の hook でセッション内の記録を強制する公開事例で、数値つきの物を確認していない。根拠は自前の実測（4/11、e7a95d2c の0回）。
- 過去事例: japanese-reply-guard.py（Stop で block、stop_hook_active で抜ける）が本環境で動いている。

## 10. 工程
- 工程0（実測・製品コードは変えない。使い捨ての Stop hook と捨ての対話で行う）:
  - (a) session_id と CLAUDE_CODE_SESSION_ID の一致: 実測済み（docs/handoff/board/step0.md:36-45）。やり直さない。
  - (b) /clear の前後で `claude agents --json` の sessionId と、試験用 dataDir の open-sessions.json の claudeSessionId が変わるか。
  - (c) japanese-reply-guard と同時に block した時に Claude に届く reason。block と additionalContext の両方で試す。
  - (d) transcript_path の tool_use の数え方（担当の呼び出しが1件と数えられること）。
  - (e) settings.json に足した Stop hook が、起動中のセッションで効くか（`claude --debug` のログの Stop hook の行）。
  - (f) node で手順6の読み止め方式の所要時間を、本番で一番大きい transcript とその時の負荷で測る（読むだけ）。timeout を「最大の実測の3倍以上」で決める。
  - 結果で第3版を書き、Fable の審査を受けてから実装カードを出す。
- 工程1: board-guard.mjs と単体試験（K1〜K6）。
- 工程2（第3版で §3-2 に sameHandler :59・HOOK_SPECS :24・CheckInput :170・installHooks :288・uninstallHooks :307・activity-start.ts:39 の check（右の欄の案内と e2e :117 に流れる）・ac-hooks.mjs の3分岐と、board-guard の handler の期待値を書き足してからカードにする）: activity-hooks.ts の一般化・ac-hooks.mjs・写し・board-coverage.mjs と試験（K7）。
- 工程3: 版上げ・リリース・PO の install・K1 の実機確認・K7 の jq 比較。7日後に K8。

## 触るファイル・触らないファイル
- 触る: hooks/board-guard.mjs（新規）、server/activity-hooks.ts、server/activity-setup.ts、server/activity-start.ts、scripts/ac-hooks.mjs、scripts/board-coverage.mjs（新規）、tests/unit/ の試験、README.md「作戦ボード」節、docs/CHANGELOG.md、版の4か所。
- 触らない: hooks/ac-board.mjs、boards の保存形式、open-sessions.json の形、画面、~/.claude/scripts の既存 hook、~/.claude/prompts。

## 維持の仕組み
- ac-hooks.mjs check（起動時と1時間ごとのログ）が board-guard の登録漏れも出す。
- K8 の保有率を board-coverage.mjs で測る。週次保守の定期実行に足すかは導入7日後に決める。
