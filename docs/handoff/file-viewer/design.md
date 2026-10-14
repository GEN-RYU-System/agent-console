# セッションが作ったファイルを開く（file-viewer）設計 第1版

- 状態: 設計案（Opus 作成 2026-10-14）。審査前。PO 承認前。実装未着手。
- 根拠: 同じフォルダの recon.md（R1〜R7）。生出力 /tmp/CC報告ファイル/file-viewer/。

## 0. PO の言葉と目的
- PO（2026-10-14）「/tmp/CC報告ファイル/auth-b3/PO作業手順.md のように、そのセッションが作ったファイルをそのセッションでこのアプリ上で開いて見れるように出来る？」→ 設計に進む「y」。
- 目的: セッションが書いたファイルを、ターミナルや別のエディタを開かずに、そのセッションの画面から読めるようにする。

## 1. 方針（一言）
hook の記録（チャットと同じ源）に「書いたファイルの場所」を足し、セッションごとの一覧と、一覧にある物だけを読む口を作る。中央に「ファイル」タブを足し、.md は整えた表示、それ以外は等幅の文字で出す。

## 2. 成功条件（○×で判定）
| # | 基準 | 検証方法 |
|---|---|---|
| K1 | 更新後にセッションが Write・Edit したファイルが、そのセッションの「ファイル」タブに 5 秒以内に出る（新しい順） | e2e: 本物の hook に PostToolUse(Write) の JSON を流し、画面に名前が出るまで待つ |
| K2 | 別のセッションが書いたファイルは出ない | 統合試験: 2 セッション分の記録で一覧が混ざらない |
| K3 | 一覧に無いパスは読めない（404）。`..` を含む・相対パス・symlink・フォルダも読めない | 統合試験（harness） |
| K4 | .md は見出し・表・箇条書き・コードが整って出る。HTML は描画しない。画像は読み込まず代わりの文字。`javascript:` のリンクは押せない。相対リンクは文字だけ | 画面の単体試験 |
| K5 | 1 MiB を超える・バイナリ（NUL を含む／UTF-8 でない）・消えたファイルは、中身を出さずに理由を出す | 統合試験＋画面の単体試験 |
| K6 | アプリを再起動しても、過去 7 日（keepDays）に書いたファイルが一覧に戻る | 単体試験: 3〜6 日前の日付ファイルを置いて起動 |
| K7 | 担当（サブエージェント）が書いたファイルも親セッションの一覧に出て、「担当」の印が付く | 単体試験: agent_id 付きの記録 |
| K8 | hook の記録にファイルの中身が入らない（項目は決め打ち） | 単体試験: 記録のキーが決めた集合と一致 |
| K9 | 文言はすべて t()、色・大きさは SA 部品とトークンだけ（新しいハードコード 0） | npm run lint・design-governance 試験・ja.json のキー |
| K10 | CI が ubuntu・macos とも緑 | CI |
| K11 | PO の目視: 更新後にこのアプリ内のセッションで作った .md を「ファイル」タブで開いて読める | PO が画面で確認（手順は PR に書く） |

## 3. 仕組み
### 3-1 hook（hooks/activity-hook.mjs）
- toolRecord に PostToolUse の Write・Edit・MultiEdit・NotebookEdit を足す。記録は `{ts, event:"PostToolUse", session_id, agent_id?, tool, path}` だけ。
- path は tool_input.file_path、無ければ tool_input.notebook_path。文字列で、`/` で始まり、4096 文字以下、制御文字（\0〜\x1f）を含まない時だけ記録。満たさなければ null（記録しない）。content・old_string・new_string は読まない。
- PostToolUse は成功した時だけ来る（公式、recon R4）。失敗した書き込みは載らない。
- 登録: server/activity-hooks.ts HOOK_SPECS の PostToolUse matcher を "Agent" → "Agent|Write|Edit|MultiEdit|NotebookEdit"。handler は今と同じ async:true（Claude の作業を待たせない）。既存の install は自分の handler の group だけ置き換える（r3 Q5）ので、他の hook はそのまま。

### 3-2 server の記録（server/activity.ts）
- セッション（session_id）ごとに `files: Map<path, {tool, lastAt, byAgent}>` を持つ。同じ path は 1 件にまとめ、lastAt と tool を新しい方で上書き。byAgent は一度でも agent_id 付きなら true。上限 FILES_KEEP = 500（古い lastAt から落とす）。
- 再起動後の復元: 今の readNew（今日と昨日）はそのまま。起動して最初の 1 回だけ、残っている日付ファイルのうち一昨日より前（keepDays の範囲）を読み、ファイルの記録だけを当てる（loadFileHistory）。チャットなど他の記録は今までどおり 2 日分。
- 記録の源は events-*.jsonl だけ（別の保存先を作らない）。

### 3-3 読む口（新規 server/files-routes.ts、http.ts の handleApi に登録）
- `GET /api/sessions/:id/files` → `{status:"ok", files:[{path, name, dir, tool, lastAt, byAgent}]}`（lastAt の新しい順）。claudeSessionId が無ければ `{status:"noSession"}`（チャットと同じ）。
- `GET /api/sessions/:id/files/content?path=<絶対パス>` →
  - path が、そのセッションの一覧の path と文字列で完全一致しなければ 404（一覧が唯一の許可。diff の matchFile と同じ考え）。
  - `open(path, O_RDONLY | O_NOFOLLOW)` で開き、fstat が通常ファイルでなければ `{status:"notRegular"}`。開けなければ ENOENT → `{status:"missing"}`、その他 → `{status:"unreadable"}`。
  - サイズが DEFAULT_FILE_VIEW_MAX_BYTES（1 MiB、config.ts に追加、diff と同じ値）を超えたら `{status:"tooLarge", size}`。
  - 読んだ中身に NUL があるか、TextDecoder("utf-8", {fatal:true}) で読めなければ `{status:"binary", size}`。
  - それ以外 `{status:"ok", text, size, mtimeMs, kind:"markdown"|"text"}`（拡張子 .md・.markdown が markdown）。
  - 読むだけ。書く・消す口は作らない。

### 3-4 画面
- 中央タブに "files"（文言 ac.tabs.files「ファイル」）を足す。ConsolePage.tsx:55 の CenterTab と :393-407 の items、:428-466 の描画。
- 新規 src/components/FilesPane/FilesPane.tsx（＋ .css、.test.tsx）。左に一覧（名前・置き場所・時刻・担当の印は SA Badge）、右に中身。一覧が 0 件なら SA EmptyState（「このセッションが書いたファイルはまだありません。コマンドの出力（> など）で作ったファイルはここには出ません」）。タブを開いた時と「再読込」ボタン（SA Button）で一覧を取り直す。
- Markdown の部品を共通に移す: src/components/ChatPane/ChatMarkdown.tsx → src/components/Markdown/MarkdownView.tsx（＋ Markdown.css に .ac-chat__md の見た目を移し、クラス名を .ac-md に）。ChatPane はこれを使う形に置き換え（見た目は変えない）。
- ファイルの表示では、リンクは http・https だけを別タブのリンクにし、相対・その他は文字だけ（ファイルの中の相対リンクで別のファイルを読みに行かせない）。MarkdownView に `linkPolicy: "chat" | "file"` を持たせる。
- .md 以外は `<pre>`（等幅は --ac-font-mono）。tooLarge・binary・missing 等は SA Callout で理由を出す。
- 新しい色・大きさが要る時は src/tokens.app.css に --ac- で登録してから使う（直書きしない）。

## 4. SSOT
- 「どのファイルを書いたか」の正は hook の記録（events-*.jsonl）だけ。チャットと同じ源。transcript は読まない。
- 「読んでよいか」の正は 3-2 の一覧だけ。

## 5. 安全
- 読める範囲は「そのセッションが書いたと記録されたパス」だけ。任意のパスは読めない（K3）。
- symlink は最後の段だけ O_NOFOLLOW で拒む。途中のフォルダが symlink の場合は辿る（そのパスにセッションが書いた事実があるため）。
- 口は今の認証（トークン・Host 検査）の内側。GET だけ。
- 中身は画面に出すだけで、記録・ログに残さない。
- 注意（PO に伝える）: セッションが設定ファイルなど秘密を含むファイルを書いた場合、その中身も画面で読める。アプリは 127.0.0.1 とトークンで PO だけが見る前提。スマホ版（mobile-pwa）の時もこの前提を引き継ぐ。

## 6. 決めたこと（Opus）
- D1 源は hook（transcript ではない）。理由: チャットと同じ源にそろう（SSOT）。hook の入力は公式に書かれた形（recon R4）で、transcript の中の形は公式の約束ではない。担当の書き込みも親の session_id で届く（実データ 460/460）。
- D2 読める範囲は「記録された path との完全一致」。作業場所の中かどうかでは決めない。理由: PO の例は /tmp にある。
- D3 再起動後は 7 日分を一覧に戻す（K6）。
- D4 版は次の空き番号（board-guard が先なら v0.22.0、後なら v0.21.0）。

## 7. 代替案
- A transcript を読む: 更新前に書いたファイルも出せる。不採用。transcript の形・置き場（worktree のディレクトリ名の規則は未確認）に依存し、担当の分は subagents/ の別ファイルも読む必要がある。チャットと源が分かれる。
- B Bash の `>` で作ったファイルも出す: コマンド文字列からパスを推し量ることになり、確実でない。不採用（一覧に出ないことを画面に書く）。
- C 作業場所の中を全部見せる: 見せる範囲が広すぎ、/tmp の例も満たさない。不採用。

## 8. リスクと対処
- 更新より前に書いたファイルは出ない → PO に事前に伝える。
- hook の登録し直しが要る → 更新の手順（update-when-idle の最後の hooks install）で入る。入ったかは `node scripts/ac-hooks.mjs check` で確かめる。
- board-guard も server/activity-hooks.ts を変える → 後にマージする方が先の版に合わせて直す（rebase、衝突は手で解く）。
- 一覧が多いセッション → 500 件で頭打ち。
- MultiEdit・NotebookEdit の入力の形は未確認 → file_path か notebook_path が無ければ記録しないだけ（壊れない）。

## 9. 外部・過去事例
- 外部事例は使わない。理由: アプリ内部の配線の話で、判断は手元の事実（recon）と公式の hook 仕様で足りる。
- 過去事例: v0.4.0 の差分の口（一覧との完全一致で許可）と、チャット便1の Markdown 部品を流用する。

## 10. 工程
- 工程1（Sonnet）: hook と HOOK_SPECS、activity.ts の files と loadFileHistory、files-routes.ts、config の上限、単体・統合試験（K2・K3・K5・K6・K7・K8）。
- 工程2（Sonnet）: MarkdownView へ移す、FilesPane、タブ、ja.json、画面の試験と e2e（K1・K4・K5・K9）。
- 審査（Fable）→ CI（K10）→ マージ・タグ・update-when-idle → PO 目視（K11）。

## 触るファイル・触らないファイル
- 触る: hooks/activity-hook.mjs、server/activity-hooks.ts、server/activity.ts、server/files-routes.ts（新規）、server/http.ts、server/config.ts、src/api.ts、src/types.ts、src/pages/ConsolePage.tsx、src/components/FilesPane/*（新規）、src/components/Markdown/*（新規）、src/components/ChatPane/ChatPane.tsx・ChatPane.css・ChatMarkdown.tsx（移すだけ）、src/locales/ja.json、tests/unit/*、tests/e2e/*、版の 4 か所と docs/CHANGELOG.md・README.md。
- 触らない: diff の口、チャットの口、セッションの保存形式（open-sessions.json）、作業場所の判定（workplace.ts）、tmux まわり。

## 維持の仕組み
- K2・K3・K8 の試験が CI に入り、読める範囲を広げる変更は赤になる。
- 文言とトークンは既存の lint・design-governance 試験が見る。
