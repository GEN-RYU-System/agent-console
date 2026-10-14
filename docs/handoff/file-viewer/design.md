# セッションが作ったファイルを開く（file-viewer）設計 第2版

- 状態: 設計案 第2版（Opus 2026-10-14）。第1版は Fable 審査 REVISE（高3・中7・低6、/tmp/CC報告ファイル/file-viewer/review-design1/review.md）。第2版で全件に対応（§12 に対応表）。PO 承認前。実装未着手。
- 根拠: 同じフォルダの recon.md（R1〜R7）。生出力 /tmp/CC報告ファイル/file-viewer/。

## 0. PO の言葉と目的
- PO（2026-10-14）「/tmp/CC報告ファイル/auth-b3/PO作業手順.md のように、そのセッションが作ったファイルをそのセッションでこのアプリ上で開いて見れるように出来る？」→ 設計に進む「y」。
- 目的: セッションが書いたファイルを、ターミナルや別のエディタを開かずに、そのセッションの画面から読めるようにする。

## 1. 方針（一言）
hook の記録（チャットと同じ源）に「書いたファイルの場所」を足し、セッションごとの一覧と、一覧にある物だけを読む口を作る。中央に「ファイル」タブを足し、.md は整えた表示、それ以外は等幅の文字で出す。

## 2. 成功条件（○×で判定）
| # | 基準 | 検証方法 |
|---|---|---|
| K1 | 更新後にセッションが Write・Edit したファイルが、「ファイル」タブを開いたままで 5 秒以内に一覧に出る（新しい順） | e2e（tests/e2e、chat.spec.ts の fireHook の流儀）: 本物の hook に PostToolUse(Write) の JSON を流し、タブを開いたまま名前が出るまで待つ（rev で取り直すこと＝§3-4） |
| K2 | 別のセッションが書いたファイルは出ない | 統合試験（tests/unit、harness）: 2 セッション分の記録で一覧が混ざらない |
| K3 | 一覧に無いパスは 404（notListed）。`..`・`.`・`//`・末尾 `/` を含むパス、相対パス、制御文字入りは記録されない（hook と server の両方）。最後の段が symlink なら notRegular、フォルダなら notRegular | 統合試験（harness）＋ hook の単体試験 |
| K4 | .md は見出し・表・箇条書き・コードが整って出る。HTML は描画しない。画像は読み込まず代わりの文字。`javascript:` は押せない。ファイル表示では http・https 以外のリンクは文字だけ | 画面の単体試験（src/components/Markdown/MarkdownView.test.tsx） |
| K5 | 1 MiB を超える（読んでいる途中で伸びた場合も）・バイナリ（NUL を含む／UTF-8 として読めない）・消えたファイルは、中身を出さずに理由を出す | 統合試験＋画面の単体試験 |
| K6 | アプリを再起動しても、keepDays（既定 7 日）以内に書いたファイルが一覧に戻る。**一昨日のファイルだけ**を置いた場合も戻る | 単体試験（tests/unit/activity*.test.ts）: 一昨日だけ／3〜6 日前／今日と昨日、の 3 通り |
| K7 | 担当（サブエージェント）が書いたファイルも親セッションの一覧に出て、「担当」の印が付く | 単体試験: agent_id 付きの記録 |
| K8 | hook の記録にファイルの中身が入らない（記録のキーは ts・event・session_id・agent_id?・tool・path だけ） | hook の単体試験: キー集合が一致 |
| K9 | 文言はすべて t()、色・大きさは SA 部品とトークンだけ（新しいハードコード 0）。src/components/FilesPane・Markdown の生要素は MarkdownView の a と、一覧の ul/li/pre だけ | npm run lint・design-governance 試験＋審査で `grep -nE '<(button|input|select|textarea|a)[\s>]'` の結果を保存して確認（governance の生要素検査は src/pages だけのため） |
| K10 | 既存の環境（PostToolUse matcher が "Agent" のまま）で install すると matcher が新しくなり、check が古い matcher を「不一致」と報告する | 単体試験（tests/unit/activity-hooks.test.ts）＋更新後に `node scripts/ac-hooks.mjs check` の出力を保存 |
| K11 | チャットの見た目が変わらない（Markdown 部品を移しても） | MarkdownView の単体試験: 同じ入力で ChatMarkdown（移す前）と同じ DOM（ラッパーのクラス名以外）＋ e2e chat.spec.ts が緑 |
| K12 | CI が ubuntu・macos とも緑 | CI |
| K13 | PO の目視: 更新後に**新しく開いた**セッションで .md を作らせ、「ファイル」タブで開いて読める | PO が画面で確認（手順は PR に書く） |

## 3. 仕組み
### 3-1 hook（hooks/activity-hook.mjs）
- toolRecord に PostToolUse の Write・Edit・MultiEdit・NotebookEdit を足す。記録は `{ts, event:"PostToolUse", session_id, agent_id?, tool, path}` だけ。tool は上の 4 つのどれか（そのままの名前）。
- path は tool_input.file_path、無ければ tool_input.notebook_path（NotebookEdit の項目名は【未確認】。無ければ記録しないだけ）。
- path は **clip を通さず生の文字列**で入れる（clip は空白をまとめるため完全一致が壊れる、recon R2）。次をすべて満たす時だけ記録し、満たさなければ null:
  - 文字列で、`/` で始まる（公式例でも絶対パス、recon R4）
  - 4096 文字以下
  - 制御文字（\u0000-\u001f・\u007f）を含まない
  - `path.posix.normalize(p) === p` かつ末尾が `/` でない（`..`・`.`・`//` を落とす）
- content・old_string・new_string・tool_response は読まない。
- PostToolUse は成功した時だけ来る（公式、recon R4）。

### 3-2 登録（server/activity-hooks.ts・scripts/ac-hooks.mjs）
- HOOK_SPECS の PostToolUse matcher を "Agent" → "Agent|Write|Edit|MultiEdit|NotebookEdit"。handler は今と同じ（async:true）。
- **matcher の比較を足す**（今は group の matcher を比べていない、recon R2・server/activity-hooks.ts:90-118）。addHandlers で、自分の handler を含む group の matcher が spec.matcher と違う時:
  - その group の handler が自分の 1 つだけ → group の matcher を spec.matcher に書き換える（changed）。
  - 他の handler と同居 → その group から自分の handler だけ抜き（他は残す）、spec.matcher の新しい group を末尾に足す（changed）。
- checkHooks（findHandler :161-168 の周り）も matcher を見て、違えば `reason: "matcherDiffers"`（違うイベント名を添える）を返す。`ac-hooks.mjs check` の出力と右の欄の案内（今の missingHandler と同じ出し方）に出す。
- 既存の試験（tests/unit/activity-hooks.test.ts の handler の形と数を固定している箇所）は変えずに通す。
- 起動中の Claude セッションに設定の変更が効くかは【未確認】（公式は「normally picked up automatically」）。K13 は新しく開いたセッションで確かめる。

### 3-3 server の記録（server/activity.ts）
- セッション（session_id）ごとに `files: Map<path, {tool, lastAt, byAgent}>` を持つ。
- 当て方は順序に依存しない（冪等）: lastAt = max(既存, 新)、tool は lastAt が新しい方、byAgent は OR。上限 FILES_KEEP = 500（超えたら lastAt の古い順に落とす）。
- server 側でも 3-1 の path の条件を見て、満たさない記録は捨てる（古い hook・手で書かれた行への備え）。
- 再起動後の復元（loadFileHistory）:
  - 今の readNew（今日と昨日、server/activity.ts:227-239）はそのまま。
  - 起動して最初の 1 回、readNew と**同じ now** で、activityDir の events-YYYYMMDD.jsonl のうち「readNew の names に無い名前」かつ「日付 ≥ cutoff（pruneOldFiles :436-437 と同じ式）」の全部を読み、ファイルの記録（event が PostToolUse で tool が上の 4 つ）だけを当てる。一昨日も含む。
  - 実行は this.queue に乗せ、最初の readNew と直列にする（server/activity.ts:221-225 の流儀）。
  - readNew の cursor は名前ごとで、今日・昨日以外の cursor は捨てる（:230）。loadFileHistory は今日・昨日を読まないので二重には当たらない。万一重なっても当て方が冪等なので害は無い。
- dropOldSessions（:285-288）でセッションごと消えるのは keepDays を過ぎた時で、K6 の範囲と同じ。
- 記録の源は events-*.jsonl だけ（別の保存先を作らない）。

### 3-4 読む口（新規 server/files-routes.ts）
- http.ts の handleApi で handleChat の直後（http.ts:186 の次）に足す。ActivityStore は AppDeps.activity（http.ts:54）から使う。
- `GET /api/sessions/:id/files`
  - 先に `await deps.activity.refresh()`（chat-routes.ts:50 と同じ）。
  - claudeSessionId が無ければ `{status:"noSession"}`。
  - `{status:"ok", files:[{path, name, dir, tool, lastAt, byAgent}]}`。name・dir は server が path.basename・path.dirname で作る。lastAt の新しい順。
- `GET /api/sessions/:id/files/content?path=<絶対パス>`（画面は encodeURIComponent で送る）
  | 状況 | 返し方 |
  |---|---|
  | セッションが無い | 404（今の NotFound と同じ） |
  | claudeSessionId が無い | 200 `{status:"noSession"}` |
  | path がそのセッションの一覧と文字列で完全一致しない | 404 `{status:"notListed"}` |
  | open(path, O_RDONLY｜O_NOFOLLOW) が ENOENT | 200 `{status:"missing"}` |
  | ELOOP（最後の段が symlink）・EISDIR・fstat が通常ファイルでない | 200 `{status:"notRegular"}` |
  | その他の開けない理由 | 200 `{status:"unreadable"}` |
  | 読んだ長さが上限を超えた | 200 `{status:"tooLarge", size}` |
  | NUL を含む、または TextDecoder("utf-8",{fatal:true}) で読めない | 200 `{status:"binary", size}` |
  | 読めた | 200 `{status:"ok", text, size, mtimeMs, kind:"markdown"｜"text"}`（拡張子 .md・.markdown が markdown。先頭の UTF-8 BOM は落とす） |
- 上限は DEFAULT_FILE_VIEW_MAX_BYTES = 1 MiB（server/config.ts に追加。diff と同じ値）。読み方は `handle.read` で最大「上限 + 1」byte だけ読み、上限を超えて読めたら tooLarge（fstat の後に伸びた場合も、recon の TOCTOU の指摘）。ハンドルは必ず閉じる。
- 読むだけ。書く・消す口は作らない。

### 3-5 画面
- 中央タブに "files"（文言 ac.tabs.files「ファイル」）を足す: src/pages/ConsolePage.tsx:55 の CenterTab、:393-407 の items、:428-466 の描画。
- FilesPane に `rev={state.activityRev}` を渡す（ChatPane と同じ、ConsolePage.tsx:432）。`active && rev` が変わったら一覧を取り直す（ChatPane.tsx:60-88 の流儀）。K1 の根拠はこれ。「再読込」ボタン（SA Button）も置く。
- 新規 src/components/FilesPane/FilesPane.tsx（＋ FilesPane.css、FilesPane.test.tsx）。
  - 左に一覧（ul/li。名前・置き場所・時刻、担当の印は SA Badge）。0 件なら SA EmptyState（文言「このセッションが書いたファイルはまだありません。コマンドの出力（> など）で作ったファイルはここには出ません」）。
  - 右に中身。markdown は MarkdownView（linkPolicy "file"）、text は `<pre>`（等幅は既存トークン --ac-font-mono）。notListed・missing・notRegular・unreadable・tooLarge・binary・noSession は SA Callout で理由を出す（文言は ja.json）。
- Markdown 部品を共通に移す:
  - src/components/ChatPane/ChatMarkdown.tsx → src/components/Markdown/MarkdownView.tsx。ChatMarkdown.tsx は消し、ChatPane.tsx:12,159 を MarkdownView に置き換える。
  - ChatPane.css の .ac-chat__md のブロック（:78-165）を**そのまま** src/components/Markdown/Markdown.css に移し、セレクタの `.ac-chat__md` を `.ac-md` に置き換えるだけ（どれも .ac-chat__md の子孫セレクタで、.ac-chat の祖先に依存しないため見た目は変わらない、review-design1 中7）。MarkdownView が Markdown.css を import し、ChatPane.css からは削る。
  - `linkPolicy: "chat"`（既定）は今の挙動のまま（defaultUrlTransform が通す相対リンクも a）。`"file"` は http・https だけ a（別タブ）、それ以外は span。
- 新しい色・大きさが要る時は src/tokens.app.css に --ac- で登録してから使う（直書きしない）。

## 4. SSOT
- 「どのファイルを書いたか」の正は hook の記録（events-*.jsonl）だけ。チャットと同じ源。transcript は読まない。
- 「読んでよいか」の正は 3-3 の一覧だけ。

## 5. 安全
- 読める範囲は「そのセッションが書いたと記録されたパス」だけ。任意のパスは読めない（K3）。
- 記録の偽造: dataDir/activity は 0700・ファイルは 0600（hooks/activity-hook.mjs:11-12,177-185）で、書けるのは同じ OS ユーザーだけ。同じユーザーはもともと全部のファイルを読めるので、偽造で広がる権限は無い。
- symlink: 最後の段は O_NOFOLLOW で拒む（macOS・Linux とも使える。node v24.12.0 darwin で fs.constants.O_NOFOLLOW=256、review-design1）。途中のフォルダの symlink は辿る（そのパスにセッションが書いた事実があり、記録後に差し替えられるのも同じユーザーだけ）。
- 認証は Authorization: Bearer（server/http.ts:389、cookie ではない）なので、他のサイトからの GET に認証は付かず、GET で Origin を見なくても読み出されない（チャット・差分と同じ）。DNS rebinding は Host 完全一致（server/auth.ts:159-161、http.ts:372）で 421。
- 中身は画面に出すだけで、記録・ログに残さない。
- 注意（PO に伝える）: セッションが秘密を含むファイルを書いた場合、その中身も画面で読める。アプリはこの Mac の PO だけが見る前提（127.0.0.1・トークン）。

## 6. 決めたこと（Opus）
- D1 源は hook（transcript ではない）。理由: チャットと同じ源にそろう（SSOT）。hook の入力は公式に書かれた形（recon R4）で、transcript の中の形は公式の約束ではない。担当の書き込みも親の session_id で届く（実データ 460/460）。
- D2 読める範囲は「記録された path との完全一致」。作業場所の中かどうかでは決めない。理由: PO の例は /tmp にある。
- D3 再起動後は keepDays（7 日）分を一覧に戻す。
- D4 /clear で会話の ID が変わると、前の会話で書いたファイルは一覧から消える（チャットと同じ）。残すには保存形式（open-sessions.json）を変える必要があり、今回はしない。
- D5 matcher の比較は file-viewer 側で入れる。board-guard は後から rebase する時に、これを「種類ごとの比較」へ広げる。
- D6 版は次の空き番号（board-guard が先なら v0.22.0、後なら v0.21.0）。

## 7. 代替案
- A transcript を読む: 更新前に書いたファイルも出せる。不採用。transcript の形・置き場（worktree のディレクトリ名の規則は未確認）に依存し、担当の分は subagents/ の別ファイルも読む必要がある。チャットと源が分かれる。
- B Bash の `>` で作ったファイルも出す: コマンド文字列からパスを推し量ることになり、確実でない。不採用（一覧に出ないことを画面に書く）。
- C 作業場所の中を全部見せる: 見せる範囲が広すぎ、/tmp の例も満たさない。不採用。

## 8. リスクと対処
- 更新より前に書いたファイルは出ない → PO に事前に伝える。
- /clear 以後は前の会話の分が消える（D4）→ PO に事前に伝える。
- 起動中のセッションに hook の変更が効かない場合がある →「新しく開いたセッションで確かめる。効かなければ開き直す」を PR の手順に書く。
- matcher が古いまま残る → 3-2 で install が直し、check が不一致を出す（K10）。
- board-guard も server/activity-hooks.ts を変える → D5。後にマージする方が rebase して衝突を手で解く。
- 一覧が多いセッション → 500 件で頭打ち。
- MultiEdit・NotebookEdit の入力の形は【未確認】→ file_path か notebook_path が無ければ記録しないだけ（壊れない）。

## 9. 外部・過去事例
- 外部事例は使わない。理由: アプリ内部の配線の話で、判断は手元の事実（recon）と公式の hook 仕様で足りる。
- 過去事例: v0.4.0 の差分の口（一覧との完全一致で許可）と、チャット便1の Markdown 部品を流用する。

## 10. 工程
- 工程1（Sonnet）: hook（3-1）、登録の matcher 比較（3-2）、activity.ts の files と loadFileHistory（3-3）、files-routes.ts と config（3-4）、試験（K2・K3・K5・K6・K7・K8・K10）。
- 工程2（Sonnet）: MarkdownView へ移す、FilesPane、タブと rev、ja.json、画面の試験と e2e（K1・K4・K5・K9・K11）。
- 審査（Fable）→ CI（K12）→ マージ・タグ・update-when-idle（最後に hooks install が走り K10 の check を保存）→ PO 目視（K13）。

## 触るファイル・触らないファイル
- 触る: hooks/activity-hook.mjs、server/activity-hooks.ts、scripts/ac-hooks.mjs（check の出力）、server/activity.ts、server/files-routes.ts（新規）、server/http.ts、server/config.ts、src/api.ts、src/types.ts、src/pages/ConsolePage.tsx、src/components/FilesPane/*（新規）、src/components/Markdown/*（新規）、src/components/ChatPane/ChatPane.tsx・ChatPane.css・ChatMarkdown.tsx（移すだけ）、右の欄の hook 案内の部品（matcherDiffers の文言）、src/locales/ja.json、tests/unit/*、tests/e2e/*、版の 4 か所（package.json:3、package-lock.json:3,9、extension/manifest.json:4）と docs/CHANGELOG.md・README.md。
- 触らない: diff の口、チャットの口、セッションの保存形式（open-sessions.json）、作業場所の判定（workplace.ts）、tmux まわり。

## 維持の仕組み
- K2・K3・K8・K10 の試験が CI に入り、読める範囲を広げる変更・matcher の取りこぼしは赤になる。
- 文言とトークンは既存の lint・design-governance 試験が見る。components 配下の生要素は審査で grep する（K9）。

## 12. 第1版の審査（REVISE）への対応
| 指摘 | 対応 |
|---|---|
| 高1 install が matcher を比べない | 3-2・K10・D5 |
| 高2 タブを開いたままでは取り直さない | 3-5（rev）・K1 |
| 高3 一昨日の穴・順序・冪等 | 3-3・K6 |
| 中1 clip で path が変わる・`..` | 3-1・3-3・3-4 の表・K3 |
| 中2 /clear で消える | D4・§8 |
| 中3 起動中セッションへの反映 | 3-2 末尾・§8・K13 |
| 中4 安全の根拠・TOCTOU・BOM | §5・3-4 |
| 中5 governance は src/pages だけ | K9 |
| 中6 読む口の細部 | 3-4 |
| 中7 チャットの見た目の見張り | 3-5・K11 |
| 低1・低2 recon の行番号・r3 Q5 | recon.md を直した |
| 低3 MultiEdit・NotebookEdit | 3-1・§8 に【未確認】 |
| 低4 版の 4 か所 | 触るファイルに行番号 |
| 低5 linkPolicy "chat" の挙動 | 3-5 |
| 低6 スマホ版への言及 | §5 から外した |
