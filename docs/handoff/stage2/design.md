# agent-console 段階2 設計書（毎日の使い勝手）

- 状態: 設計案（Opus 作成・Opus 自己審査）。PO: 段階2＝毎日の使い勝手を先に（2026-10-11、「確立したなら進める」）。KGI の数値は Opus 設定。
- 調査: docs/handoff/stage2/recon.md

## 1. 目的
Orca と比べて毎日の使い勝手の差が大きい 5 点を埋める。外部からの接続の入口は増やさない。
①作業の区切りを知らせる ②名前の変更とよく使う指示のボタン ③過去のセッションの再開 ④台帳ボードの絞り込み ⑤メモリの数値画面

## 2. KGI（○×で判定）

| # | 基準 | 検証方法 |
|---|---|---|
| K1 | Claude の状態が「作業中（busy）」から「待ち（waiting）」または「待機（idle）」に変わったら、6 秒以内に ①一覧の該当行に未読の印 ②窓のタイトルに未読数 ③macOS の通知（設定で切替、既定オン）が出る。行を選ぶと未読が消える | 単体（遷移判定）＋e2e（スタブの status を busy→idle）＋通知はコマンド呼び出しをスタブで記録 |
| K2 | 一覧から名前を変えられる。Claude 起動中のセッションは Claude 側の名前（`/rename`）が正本で、`claude agents --json` の name が変わったら表示も変わる | e2e（スタブ）。実 Claude は PO 確認 1 回 |
| K3 | よく使う指示を画面で登録・編集・削除でき、ボタン 1 回で選択中の端末に送られる。登録内容は 1 か所（§5）にだけ保存され、再起動後も残る | 単体・e2e |
| K4 | 「過去のセッション」一覧（正本: `claude agents --all --json`）から、Sonnet 実装役のセッションを選ぶと `--resume <sessionId>` で同じ作業場所に再開できる | e2e（スタブ） |
| K5 | 台帳ボードは既定で「作業中・レビュー・WIP」かつ「開始日が直近 30 日」だけを表示し、隠れた件数を表示する。期間・状態・文字検索で絞り込める。日付を読めない行は「日付不明」として別に数える | 単体（解析）・e2e（件数一致） |
| K6 | メモリ画面に、セッションごと（そのセッションの全子孫プロセスの RSS 合計）、アプリのサーバー、Mac 全体（物理メモリ量・空き率）を MB と % で表示し、10 秒ごとに更新 | 単体（集計）・e2e（表示）。値は `ps`・`sysctl hw.memsize`・`memory_pressure` の実出力と一致 |
| K7 | 段階1・1.5 の KGI が引き続き合格（デザイン検査・セキュリティ含む）。サーバー RSS はダミー 3 本で 150MB 以下のまま | 既存テスト |

## 3. 対象外
- Opus 設計役（ccopusgo）の再開: ccopusgo は依頼文を `--` の後ろに渡す作り（ccopusgo.zsh:63-76）で `--resume` を渡せない。対応するには PO の起動スクリプトの変更が必要なため、§12 で PO 判断。
- ブラウザの通知 API（`--app` 窓での挙動が未確認: recon §A）、効果音（Web Audio はユーザー操作が必要: recon §A）。
- 台帳への書き込み（ボードは読むだけ）。
- スマホ（段階4）、変更箇所・画面プレビュー（段階3）。

## 4. 仕組み

### 4-1. 区切りの通知（①）
- サーバーは `claude agents --json` の取得（3 秒ごと、既存）で、セッションごとに前回の status をメモリに持ち、`busy → waiting|idle` の変化を「区切り」イベントにする（これはアプリの定義。Claude の「ターン完了」の公式定義ではない: recon §A 未確認）。
- 未読はサーバーのメモリ上（セッション ID ごとの件数）。画面を選んだら既読 API で 0 に。保存しない。
- macOS 通知: `execFile('/usr/bin/osascript', ['-e', 'display notification <本文> with title "Agent Console"'])`。本文はセッション名と状態のみ（AppleScript 文字列としてエスケープ）。設定 `notify.macos`（既定 true）で切替。

### 4-2. 名前（②）
- 表示名の正本: Claude 起動中は `claude agents --json` の `name`。Claude が無い（シェル等）ときはアプリが起動時に付けた名前。
- 変更: Claude 起動中は、要求を受けた時点で `claude agents --json` を取り直し（3 秒前の値を使わない）、status が idle かつ waitingFor が無いときだけ、端末へ `/rename <新しい名前>` と改行（\r）を送る（人がボタンを押したときのみ）。それ以外（busy・waiting・状態を取得できない）は 409 と理由を返す。画面のボタンも同じ条件（サーバーが一覧に載せる canInput）で無効化。Claude が動いていないシェルのみのセッションはアプリの名前を書き換える（従来どおり）。
  - 修正ラウンド1（review-stage2 M1/L1）: waiting は許可プロンプトの応答待ちを含む可能性があり（未確認）、そこへ Enter を送ると既定の選択肢を押す恐れがあるため、idle のときだけに絞った。

### 4-3. よく使う指示（②）
- 保存先: `~/Library/Application Support/agent-console/quick-prompts.json`（開発時は設定の `dataDir`）。1 ファイルだけ。形式 `{ "version": 1, "items": [{ "id", "label", "text" }] }`。書込は一時ファイル→rename（途中で壊れない）。
- 送信（修正ラウンド1 で設計変更・review-stage2 M1/L1/L6）: サーバーは端末へ文章を書かない。人がボタンを押すと、画面が `POST /api/sessions/:id/send-check {promptId}` を呼ぶ。サーバーは要求を受けた時点で `claude agents --json` を取り直し、§4-2 と同じ条件（Claude 起動中は idle かつ waitingFor 無し、Claude が動いていないシェルは停止中でなければ可）を満たすときだけ 200 と本文を返す。満たさなければ 409 と理由。画面は返った本文を、画面側の xterm の `paste()`（端末が括弧付き貼付モードを有効にしていればそれで包んで送る xterm.js の正規の方法）で端末に入れ、その後 Enter（\r）を同じ入力経路（WebSocket の人の入力）で送る。上限 8KB。
  - 理由: 生の文字列＋\r を直接書くと、複数行の指示が行ごとに確定・実行され得る（括弧付き貼付でない）ため。許可トークンは発行しない（本文の入力は、認証済みの人の入力経路と同じ道を通るので、サーバーが別に書く経路が無くなる）。

### 4-4. 過去のセッション（③）
- 一覧の正本: `claude agents --all --json`（sessionId, name, cwd, startedAt, status）。保存しない。
- 再開できない行は一覧に「再開不可（理由）」を出す: ①その sessionId が現在動いている一覧 `claude agents --json` にある（このアプリの中でも別のターミナルでも。二重に同じセッションへ書かない。サーバーは 409）②cwd が本店（salesanchorRoot）そのもの（Opus 設計役のセッションは本店で動くため。Opus 設計役の再開は §12 の PO 判断なので対象外）③cwd が本店のワークツリーでない ④cwd が存在しない。再開できるのは cwd が本店のワークツリーの行だけ（Sonnet 実装役の起動コマンドで再開）。
- 再開: 役割に `resumeCommand`（設定）がある場合のみ。Sonnet 実装役は `["/bin/zsh","-ic","claude --model sonnet --resume \"$AC_RESUME_ID\""]` のように、sessionId は環境変数で渡し、シェル文字列に連結しない。sessionId は `^[0-9a-f-]{36}$` のみ受け付け。作業場所は一覧の cwd（存在確認、ワークツリー一覧に含まれるか本店であること）。

### 4-5. 台帳ボードの絞り込み（④）
- 解析で、窓口「ledger-lookup.sh」（本店 scripts/ にある）の出力行から 開始日時（3 列目）も取る。`YYYY-MM-DD HH:MM` を読めない行は「日付不明」。
- 既定: 状態 IN_PROGRESS・REVIEW・WIP、開始日が直近 30 日。画面で期間（7/30/90 日・すべて）、状態、文字検索。絞り込みの選択は閲覧者ごとの表示設定として localStorage（失敗しても既定で表示）。

### 4-6. メモリ画面（⑤）
- 画面が 10 秒ごと（画面を開いているときだけ）サーバーに問い合わせ、サーバーが `ps -axo pid=,ppid=,rss=`、`sysctl -n hw.memsize`、`memory_pressure` の最終行を実行し、セッションごとに pty の pid の子孫 RSS を合計。単位 KB→MB。
- 修正ラウンド1（review-stage2 L2）: サーバーは OS の実行結果を 5 秒キャッシュし、同時の要求は 1 回の実行にまとめる（複数タブ・連打で ps 等が増えない）。セッション名は一覧と同じ表示名（Claude の name 優先）。画面の % は棒グラフと文字で同じ値・同じ丸め（整数）。
- 表示は SA 金型（ProgressBar, Badge, DataTable 等）。直値なし。

## 5. データの正本（SSOT）

| データ | 正本 | アプリの扱い |
|---|---|---|
| Claude の状態・名前・過去セッション | Claude Code（`claude agents --json` / `--all --json`） | 読むだけ。名前の変更は Claude の `/rename` |
| 未読数 | サーバーのメモリ | 保存しない |
| よく使う指示 | quick-prompts.json（1 ファイル） | ここだけに保存 |
| 台帳 | 本店 active-work.d（窓口 ledger-lookup.sh） | 読むだけ |
| 絞り込み・テーマ | 閲覧者ごとの表示設定（localStorage） | 失敗しても既定で動く |
| メモリ値 | OS（ps / sysctl / memory_pressure） | 保存しない |

## 6. 安全
- 新しい API はすべて既存の認証（セッショントークン・Origin・Host）の内側。外部への入口は増えない。
- 端末へ送る文字（/rename、よく使う指示）は人のボタン操作のときだけ。タイマーでは送らない（規約: Consumer Terms 第3条7項）。区切りの検知・通知・未読の処理は端末に 1 バイトも書かない（テストで固定）。Claude が動いているセッションへは、送る直前に取り直した状態が idle（waitingFor 無し）のときだけ送る。
- osascript には文字列をエスケープして渡す。sessionId・名前は検証してから使い、シェル文字列に連結しない。
- quick-prompts.json は権限 600。

## 7. デザインシステム
- 新しい UI は SA 金型（Button, IconToggleButton, Badge, Modal, TextField, Textarea, Select, Tabs, ProgressBar, DataTable, Toast, Popover）とアプリの金型（components/）だけで作る。文言は i18n。デザイン検査は既存のまま適用。

## 8. 代替案と選択理由

| 案 | 不採用理由 |
|---|---|
| Claude の hooks で区切りを検知 | settings.json を書き換えない方針（段階1）。`--settings` で渡す案は hooks の併合が未確認 |
| ブラウザの Notification API | `--app` 窓での挙動が未確認 |
| アプリ独自の名前を正本にする | Claude 側の名前と二重管理になる |
| `~/.claude/projects` の jsonl を直接読む | 読んでよいという公式の明記が未確認 |

## 9. リスクと対処

| リスク | 対処 |
|---|---|
| `claude agents --json` の status の意味が版で変わる | 遷移判定は単体テストで固定し、画面下部に Claude の版を表示（既存） |
| `/rename` を Claude が受け付けない状態で送る | waiting/idle のときだけ有効。送信後 10 秒で name が変わらなければ画面に「反映されていません」 |
| 台帳の日付の書式揺れ | 読めない行は「日付不明」に数え、隠さない |

## 10. 維持の仕組み
- 守り手: Claude Opus（設計・審査）＋Claude Sonnet（実装・点検）。CI がテスト・デザイン検査・audit・署名を毎 PR で実行。

## 11. 外部・過去事例の参照と我々への応用
- Orca の quick commands（設定に保存し `sendInput(command + "\r")` で送信: recon §B）と同じ送り方を採用。保存先はアプリの 1 ファイルに限定。
- Orca の状態検知は managed hooks（settings.json 書込）で、本アプリは採らない（段階1の方針）。

## 12. 未決（PO 判断）
- Opus 設計役（ccopusgo）の再開: ccopusgo.zsh に再開用の引数を足すかどうか（PO の設定ファイルのため）。

## 13. 設計審査（Architect・同一 AI による自己審査）
判定: **APPROVE（条件付き）**
- 条件: §3 の対象外を守る。K1 の「区切り」はアプリの定義であると画面のヘルプ文に明記する。
