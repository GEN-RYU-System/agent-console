# 作戦ボードの書き忘れ防止（board-guard）設計 第3版

- 状態: 第3版（Opus 2026-10-14。工程0の実測を §11 に反映）。Fable 審査 APPROVE（/tmp/CC報告ファイル/board-adoption/review-design3/review.md。中1・低は §12 に反映）。PO 承認済み（2026-10-14「3から順番にy,」＝file-viewer→keep-login→session-relay→board-guard の順に実装してよい。離席中の完走は同日夜の PO 委任による。工程3の `ac-hooks.mjs install` は §3-2 のとおり PO の手元で行う）。それまでの経過: 第2版＋審査反映。第2版は Fable 審査 APPROVE（工程0へ進んでよい。/tmp/CC報告ファイル/board-adoption/review-design2/review.md。中 A〜C は下に反映）。第1版は Fable 審査 REVISE（/tmp/CC報告ファイル/board-adoption/review-design1/review.md。第1版の控え: /tmp/CC報告ファイル/board-adoption/design-v1.md）。PO 未承認。
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
6. transcript_path を先頭から行ごとに読み、assistant の content の tool_use が3件に達した所で読み止める（全部は読まない。工程0 (f): 本番で最大の transcript 82MB を全部読むと最大 3.7 秒、読み止めは最大 49ms。load 約48）。最後まで読んで3未満なら exit 0。transcript は書き込みが遅れることがある（公式）ので、少なく数えた時は止めない側に倒れる。手順5（ボードが ok なら抜ける）を先に置くので、読むのはボードが無いセッションだけ。
7. dataDir/board-guard/<id> を作ってから、stdout に `{"decision":"block","reason":"<文面>"}` を出して exit 0。印を先に作るので、2回目は必ず止めない。
- 文面（日本語・固定）: 作戦ボードがまだ無い（または形が壊れている）こと、`node "<dataDir>/bin/ac-board.mjs" write` に JSON を標準入力で渡すこと、項目と上限（ac-board.mjs:13 の BOARD_LIMITS を import して組む。数値を書き写さない）、単発の質問だけのセッションなら theme だけでよいこと、この案内は1回だけであること。
- 工程0 (c) で block 同士でも両方の reason が届いたので、block のままとする（§11）。

### 3-2 登録の一般化（server/activity-hooks.ts・scripts/ac-hooks.mjs）
handler の種類を表にする。
- activity: 目印 "/hooks/activity-hook.mjs"、async: true、今の9つのイベント（変えない）。
- board-guard: 目印 "/hooks/board-guard.mjs"、async なし、timeout 15（全部読む場合の最大実測 3.7 秒の3倍以上。工程0 (f)）、Stop だけ。
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

## 11. 工程0の結果と第3版の決め（Opus 2026-10-14）
生出力: /tmp/CC報告ファイル/board-adoption/step0/（実測は Sonnet。途中で使い捨てソケットを別の審査担当が誤って止めたため (b) はやり直し済み、中断前の分は b1-aborted/ に退避して不使用）。
- (b) /clear の前後で `claude agents --json` の sessionId は変わる（ed6ed734… → 3d782b39…、pid は同じ。agents-b2-before/after.txt）。サーバーはこの番号を拾って保存する（hub.ts:408）。open-sessions.json まで変わることは工程3の実機で確かめる。変わらない場合はその会話で止まらない（止めない側）。
- (c) japanese-reply-guard と同時に block した時、Claude には両方の reason が別々に届いた（transcript-c1.jsonl に "Stop hook feedback:" が2件）。次の Stop では stop_hook_active=true で両方とも止めなかった。→ block のままでよい。additionalContext には変えない。
- (d) Agent の呼び出し1回は親の transcript で tool_use 1件。担当の中の呼び出しは別ファイル（subagents/）で、数えない（probe-e.log）。→ 手順6はこのままでよい。
- (e) 起動後に足した hook: `--settings` のファイルは監視されず効かなかった。作業フォルダの .claude/settings.json は新規作成の次の応答から効いた。デバッグログの監視対象は ~/.claude/settings.json（user 設定）を含む（debug-e.log）。user 設定の編集で起動中のセッションに効くかは、触らない制約のため未実測。→ 工程3の install 後、起動中のセッションの次の応答で効くことを `claude --debug` か errors.log・印ファイルで確かめる。効かない時は、そのセッションを開き直すと効く（起動時に読むため）、と README に書く。
- (f) 読み止め版は最大 48.6ms、全部読む版は最大 3694ms（82MB・16,755行、load 約48、f-timing.txt）。→ timeout 15。
- §3-2 の補い（review-design2 の中 B）:
  - 種類の表: activity は今の HOOK_SPECS（:24）のまま。board-guard 用に BOARD_GUARD_SPECS = Stop のみを足す。
  - board-guard の handler の期待値: `{ type: "command", command: <nodePath>, args: [<dataDir>/hooks/board-guard.mjs], timeout: 15 }`（async なし）。Stop の配列の末尾に自分専用のグループで足す。
  - sameHandler（:59）は種類ごとに比べる項目を持つ（board-guard は timeout も比べる）。CheckInput（:170）・installHooks（:288）・uninstallHooks（:307）は種類を受ける。
  - activity-start.ts:39 の check は今の activity の結果を右の欄の案内と e2e（:117）へ渡すまま変えない。board-guard の check 結果は起動時と1時間ごとのログにだけ出す。
  - scripts/ac-hooks.mjs の install / uninstall / check は両方の種類を扱う。install は board-guard.mjs を dataDir/hooks/ に、ac-board.mjs を dataDir/bin/ に写してから登録する（bin が無いと board-guard は止めない側に倒れるため）。

## 12. 第3版の審査（Fable APPROVE）を受けた決め（Opus 2026-10-14）
- 中1 `ac-hooks.mjs check` の出し方: stdout は今の1つの JSON のまま、鍵 `boardGuard`（"ok" / "missing" / "differs"）を足す。終了コードは今の activity の判定だけで決め、board-guard の状態では変えない（既存の試験 tests/unit/activity-hooks.test.ts:314-316 と右の欄の案内を変えないため）。
- 低: timeout で打ち切られた回は errors.log に残らない（公式は出力を捨てる）。印も作られないので、次の応答終了でもう一度試す。tool_use が3未満の巨大な transcript では全部読み最大 3.7 秒（timeout 15 の内）。どちらも受け入れる。
- 低: 工程3の (e) の確認は、必ず本物の `ac-hooks.mjs install` で行う（settings.json は rename で置き換わるため、手で echo 書き込みして代用しない）。工程0 (e) の起動は --setting-sources project,local で、本番と条件が違う。

## 13. main（de5b053・v0.31.0）を合流した後の決め（Opus 2026-10-15）
照合の生出力: /tmp/CC報告ファイル/board-guard/line-check.md（Sonnet。合流コミット 904256c、衝突なし）。
- 【事実】§3-2 が求めた「種類の表」は v0.25.0（ac-routine の guard）で既に入っている。server/activity-hooks.ts:20-31 の HookSpec（file / async / timeout / if）、:38-50 の HOOK_SPECS（記録用9＋guard 1）、:57-64 の Handler（async 任意・timeout 任意）、:74-80 buildHandler(spec)、:82-86 isOwnHandler（:14 OWN_HOOK_SUFFIXES）、:89-93 isHandlerOf、:95 sameHandler（buildHandler の結果と丸ごと比べるので timeout も比べる）。addHandlers（:141）・removeHandlers（:191）・findHandler（:235-247）・checkHooks（:256）は HOOK_SPECS 全体を回す。同じイベント・同じ matcher でも file が違えば別の group として末尾に足す（:150-183）。
- 決め1（§3-2・§11 の BOARD_GUARD_SPECS を取り消す）: 別の表は作らず、guard と同じ作法で HOOK_SPECS の末尾に1行足す。`{ event: "Stop", file: BOARD_GUARD_HOOK_FILE, async: false, timeout: 15 }`。BOARD_GUARD_HOOK_FILE = "board-guard.mjs" を :10 の GUARD_HOOK_FILE の隣に置き、OWN_HOOK_SUFFIXES（:14）に `/hooks/${BOARD_GUARD_HOOK_FILE}` を足す。理由: 表を2つにすると「自分の handler」の正本が2か所になる（SSOT）。既存の関数は1行も変えずに済む。handler の期待値は §11 のまま（async なし・timeout 15・Stop の末尾に自分専用の group）。
- 決め2（§12 中1 を取り消す）: ac-hooks.mjs check に boardGuard の鍵は足さない。board-guard の handler も HOOK_SPECS に入るので、今の checkHooks の結果（missingEvents に "Stop(board-guard.mjs)"）と終了コードにそのまま入る。
  - 影響【事実】: 版を入れてから PO が install するまでの間、右の欄（src/types.ts:260 の hooks）と1時間ごとのログ（server/activity-start.ts:78-79）は「記録の仕組みが外れています」を出す。記録用 hook と guard は動き続ける。v0.25.0 で guard を足した時と同じ動き。
  - これを受け入れる理由: PO の install（工程3）を思い出させる案内として働く。表示を変えないために点検を2系統に分けると、決め1の SSOT が崩れる。
- 決め3（写し）: server/activity-setup.ts に BOARD_GUARD_FILE_NAME・boardGuardPathIn・installBoardGuardFile を installGuardFile（:17-25）と同じ作法で足す。server/activity-start.ts の起動時の写し（:43-52 の並び）に installBoardGuardFile を足す。scripts/ac-hooks.mjs の install（:73-75）は installHooks の前に installBoardGuardFile と installBoardCommand（今は import に無い。:15）を呼ぶ。install の案内文（:76）とファイル先頭の説明（:3。handler の本数 10 → 11）を直す。
- 決め4（試験）: tests/unit/activity-hooks.test.ts は v0.25.0 の guard の足し方に倣って書き換える。:20 OWN_HANDLER_COUNT を +2 に、:74-75 の HOOK_SPECS の期待に1行足し本数の文言を 11 に、:281 の missingEvents に "Stop(board-guard.mjs)" を足す。:147 と同じ形で board-guard.mjs が1本だけであることを足す。ACTIVITY_HANDLER_COUNT（:18、記録用だけの本数）を使う所は変えない。
- 決め5: §0 の「routineId は server/ に0件」は今は成り立たない（server/routine-audit.ts:17、server/http.ts:400）。ただし open-sessions.json の項目には今も routineId が無いので、§6 の決め（定期実行由来も止める）は変えない。
- 決め6: §11 の `activity-start.ts:117` は f255892 でも存在しない誤記（ファイルは72行）。e2e の :117 の意味で、§3-2 の check を変えない方針は決め2で取り消したので、この引用は使わない。
- 版: いま最新のタグは v0.31.0。次の空き番号（0.32.0 の見込み）を、マージの直前に `git tag` で確かめてから決める。§8 の「v0.21.0 の予定」は古い。
- 変えないもの: §3-1（board-guard.mjs の手順）、§3-3、§4〜§7、K1〜K8（ただし K7 の「activity の handler は変わらない」は「既存の handler（記録用9・guard）は変わらない」と読む）。
- §13 の審査（Fable REVISE、/tmp/CC報告ファイル/board-guard/review-s13.md）を受けた追記（Opus 2026-10-15）:
  - 決め4の補い（高2・中1）: tests/unit/activity-hooks.test.ts の makeEnv（:48-52）で、:51 の隣に board-guard.mjs の空ファイルも置く（無いと checkHooks の :282 が hookFileMissing を返す）。:112 と :174 の `after.hooks.Stop` の期待の末尾に `{ hooks: [{ type: "command", command: <node>, args: [<hooks>/board-guard.mjs], timeout: 15 }] }` を足す。:154・:168 の missingEvents の末尾にも "Stop(board-guard.mjs)" を足す。
  - 決め3の行番号の訂正（中）: scripts/ac-hooks.mjs の install は :66-71（:67 installHookFile・:68 installGuardFile・:69 installHooks・:70 案内文）。installBoardGuardFile と installBoardCommand は :68 の後・:69 の前に呼ぶ。:73-75 は uninstall なので触らない。
  - 試験の形（中）: ac-routine-guard と同じ形にする（tests/unit/ac-routine-guard.test.ts:1-4・:35。判定の関数を import で試し、本体は spawnSync で stdin→stdout・終了コードを試す）。import するので hooks/board-guard.d.mts を作る（hooks/ac-routine-guard.d.mts と同じ作法）。触るファイルに hooks/board-guard.d.mts と tests/unit/board-guard.test.ts を足す。
  - 文言（低）: 本数 10 → 11 を activity-hooks.ts:13,34,137,255、ac-hooks.mjs:3、README.md:55、試験 :74,:101 で直す。README の新しい版の節に「更新したあとにやること（hook を入れ直す）」を、既存の節（README.md:154 付近・:181 付近）と同じ型で足す。install までは右の欄に「記録の仕組みが外れています」と出るが、記録と guard は動いていること、ボードの案内（board-guard）は install まで働かないことを書く。src/locales/ja.json:581 の案内文は変えない（全体の文言で、この期間だけのずれは README で補う）。
