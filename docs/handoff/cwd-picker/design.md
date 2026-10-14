# 作業場所を「選ぶだけ」にする — design（v0.22.0）

状態: 設計（Opus 作成）第2版。Fable 審査 第1回 REVISE（5点）を反映、第2回 APPROVE。コード審査 APPROVE。調査と PO 原文は recon.md（同じフォルダ）。

## 1 目的
予約タブと定期実行タブの新規作成で、パスやブランチ名を手で打たずに済むようにする。
- 本店で動く役割（opus-designer・shell）: 作業場所とブランチの欄を出さない。「本店で動きます」と表示し、本店で起動する。
- 作業用コピーで動く役割（sonnet-impl）: 作業場所を「今ある作業用コピーの一覧」から選ぶ。ブランチ欄は出さず、選んだ作業用コピーのブランチを自動で記録する。

## 2 対象と対象外
- 対象: ReservationEditor.tsx、RoutineEditor.tsx、その2つが共有する新しい部品（作業場所の選択欄）、server/launch.ts の validateLaunchTarget（cwd 省略時の既定）、入力の型（`src/types.ts:99` RoutineInput・`:110` ReservationInput・`server/routines.ts:23` RoutineInput の cwd を省略可に。保存される Routine・Reservation の cwd は必須のまま）、ja.json、試験（単体・e2e）、README・CHANGELOG・版 0.22.0。
- 対象外: 定期実行の編集画面（役割・作業場所・ブランチは今も変更不可で disabled 表示のまま。値を見せるだけなので今の表示を残す）、AI 用コマンド ac-reserve.mjs（cwd を送る今の使い方はそのまま通る）、新しいセッション画面、過去の会話を再開画面、resume-targets の中身、保存形式（reservations.json・routines.json の形は変えない）、worktree の新規作成。

## 3 変更の前後
| | 前 | 後 |
|---|---|---|
| 本店型の役割 | 作業場所（必須）とブランチを手入力 | 欄なし。「本店で動きます」の一文。送る値に cwd を含めない → サーバーが本店にする |
| 作業用コピー型の役割 | 同上 | 作業場所＝一覧から選ぶ Select。ブランチ欄なし。選んだものの branch を送る |
| 一覧の出どころ | なし | 既存 GET /api/resume-targets の kind="worktree" の行（新しい保存先・新しい API は作らない） |
| サーバー | cwd 必須 | needsWorktree=false の役割で cwd が無いときだけ config.salesanchorRoot を使う。それ以外は今と同じ検査 |

## 4 詳しい動き
### 4-1 サーバー（server/launch.ts validateLaunchTarget）
- 変更前 `:45` `if (typeof input.cwd !== "string") throw …cwd invalid`
- 変更後: `const cwdIn = input.cwd === undefined && !role.needsWorktree ? config.salesanchorRoot : input.cwd;` とし、以降 `:45-48` の検査は cwdIn に対して今と同じく行う（本店も classifyCwd を通す）。needsWorktree の役割で cwd が無ければ今と同じ `cwd invalid`。
- 理由: 本店のパスの正本は config.salesanchorRoot の1か所。画面に本店パスを持たせない（SSOT）。予約・定期実行の両方が validateLaunchTarget を通る（`server/routines.ts:60`, `server/reservations.ts:172`）ので1か所の変更で両方に効く。
- 保存される cwd は今と同じく実パス（verdict.real）。保存形式は変わらない。

### 4-2 画面の共有部品 `src/components/LaunchTargetField/LaunchTargetField.tsx`（新規）
- 表示だけを受け持つ部品。一覧の取得・保存可否・branch の解決は親（各エディタ、§4-3）が持つ。
- props: `role: RoleView | undefined`、`targets: ResumeTarget[] | null`（null=読込中。型は `src/types.ts:113`）、`loadError: boolean`、`value: string`（選んだ worktree の path）、`onChange(path: string)`。
- 本店型（`!role?.needsWorktree`）: 金型 `Callout variant="info"`（既存エディタと同じ作法 `src/components/Reservations/ReservationEditor.tsx:44`）。title `t("ac.launchTarget.mainTitle")`＝「作業場所」、本文 `t("ac.launchTarget.mainOnly")`＝「本店（いつもの作業場所）で動きます」。入力欄なし。
- 作業用コピー型:
  - 読込中（targets===null）: 金型 `Select` を disabled、options 空、placeholder `t("ac.launchTarget.loading")`＝「一覧を読み込み中…」。
  - 読込失敗（loadError）: `Callout variant="warning"` title `t("ac.launchTarget.loadFailedTitle")`＝「作業用コピーの一覧を読めませんでした」、本文 `t("ac.launchTarget.loadFailed")`＝「画面を開き直してください」。Select は出さない。
  - worktree 行が0件: `Callout variant="warning"` title `t("ac.launchTarget.noneTitle")`＝「作業用コピーがありません」、本文 `t("ac.launchTarget.none")`＝「本店で動く役割を選ぶか、先に作業用コピーを作ってください」。Select は出さない。
  - それ以外: 金型 `Select`（@sa/components）。label `t("ac.launchTarget.worktree")`＝「作業用コピー」、placeholder `t("ac.launchTarget.choose")`＝「選んでください」、required、fullWidth、helperText `t("ac.launchTarget.worktreeHelp")`＝「作業用コピーの名前（ブランチ）で選びます」。options は targets の kind==="worktree" の行を返ってきた順に `{value: path, label}`。label は `branch ?? パス末尾`（ResumePicker の `nameOf` と同じ規則。`src/components/ResumePicker/ResumePicker.tsx:22` から export して使い、規則を1か所にする）。branch===null の行は `disabled: true`、label の後ろに `t("ac.launchTarget.noBranch")`＝「（ブランチなし・選べません）」。選択が空のまま保存すると、Select の required と空の placeholder option（金型 Select.tsx:100）でブラウザの入力検査が止める。
- 色・余白はトークン（既存の Reservations.css / Routines.css のクラス、または部品の追加クラスも var(--…) のみ）。生 select・生 input・色直値は使わない。

### 4-3 ReservationEditor / RoutineEditor（親の責務）
- 作業場所 TextField（Reservation `:39` / Routine `:20`）とブランチ TextField（`:40` / `:21`）を、新規作成時は LaunchTargetField に置き換える。
- 親が state を持つ: `targets: ResumeTarget[] | null`（初期 null）、`loadError: boolean`、`picked: string`（path）。エディタを開いたとき `fetchResumeTargets()`（`src/api.ts:75`）を1回呼び、成功で `targets = items`、失敗で `loadError = true`（RoutineEditor は新規作成時のみ呼ぶ）。
- 役割を変えたら `picked = ""`。
- 保存ボタン（金型 Button）の disabled 条件（作業用コピー型のときだけ）: `role.needsWorktree && (targets === null || loadError || worktree 行が0件)`。本店型は一覧の状態に関係なく保存できる。
- 送る値: 本店型 → cwd・branch を含めない。作業用コピー型 → `cwd: picked`、`branch: targets.find(t => t.path === picked)?.branch`（disabled により null の行は選ばれない）。
- RoutineEditor の編集時（routine !== undefined）は今の disabled の TextField 表示（`:19-21`）と送信（`:16`、routine の cwd/branch をそのまま送る）を残す（対象外、§2）。

### 4-4 文言（ja.json、ac.launchTarget.*）
- 追加: mainTitle / mainOnly / worktree / choose / worktreeHelp / noBranch / loading / loadFailedTitle / loadFailed / noneTitle / none（文面は §4-2）。
- 削除: ac.reservations.cwd / branch（使用箇所は `src/components/Reservations/ReservationEditor.tsx:39-40` のみ。審査で grep 確認済み）。
- 残す: ac.routines.cwd / branch（編集時の表示 `src/components/Routines/RoutineEditor.tsx:20-21` で使う）。

### 4-5 AI 用の経路への影響
- `hooks/ac-reserve.mjs` は本文を /api/agent/reservations へ素通しする（`server/http.ts:326` → `server/reservations.ts:172`）。cwd を送る今の使い方は不変。本店型の役割で cwd を省いた要求は、今の 400 から 201（本店）に変わる。CHANGELOG に1行書く（R13）。

## 5 代替案と選んだ理由
- A 予約データに「本店」記号を保存し実行時に解決 → 保存形式が変わり旧版切り戻しで読めなくなる。不採用。
- B 画面が resume-targets の kind="main" 行のパスを送る → shell は resumeScope が無く、本店行は opus-designer の resumeScope に依存（`server/resume-targets.ts:65-69`）。設定の都合で本店行が消えると壊れる。不採用。
- C（採用）cwd 省略時にサーバーが config.salesanchorRoot を使う。正本1か所、保存形式不変、AI 用コマンドの今の使い方もそのまま通る。

## 6 リスクと対処
- 57 件の長い一覧 → 金型 Select（ネイティブ選択）でスクロール可。名前はブランチ名で表示。
- 選んだ作業用コピーが保存後に消える → 実行時の再検査（`server/launch.ts:85-87`）で cwd_invalid として記録される（今と同じ）。
- 旧版へ戻す → 保存形式は同じなので v0.21.0 で読める。

## 7 受入条件
| 基準 | 検証方法 |
|---|---|
| R1 予約タブで役割 opus-designer を選ぶと、作業場所・ブランチの入力欄が無く「本店（いつもの作業場所）で動きます」が出る | エディタ単体試験（新規）で入力欄の不在と文言を確認 |
| R2 R1 のまま保存すると予約が作られ、保存された cwd が本店の実パスになる | サーバー単体試験: cwd 無しの POST が 201、保存 cwd = realpath(salesanchorRoot) |
| R3 sonnet-impl を選ぶと「作業用コピー」選択欄が出て、選択肢は resume-targets の worktree 行（main 行は出ない）。branch=null の行は選べない | エディタ単体試験（fetchResumeTargets をモック） |
| R4 作業用コピーを選んで保存すると、送る値の cwd=その path、branch=その行の branch | エディタ単体試験で送信値を確認 |
| R5 sonnet-impl で cwd 無しの POST は 400（cwd invalid）。cwd を付けた従来の POST は今まで通り通る | サーバー単体試験（新規1件）＋既存 tests/unit/reservations.test.ts・routines.test.ts が無変更で通る |
| R6 一覧の読込失敗・0件のとき、作業用コピー型では Callout が出て保存できない | エディタ単体試験 |
| R7 定期実行タブの新規作成でも R1〜R6 と同じ | RoutineEditor の単体試験 |
| R8 定期実行の編集画面は今と同じ（3項目 disabled 表示） | 単体試験 |
| R9 新しい画面文言はすべて t() 経由。生 select / 生 input / 色直値なし | `npm run lint` と grep（`<select`・`<input`・`#[0-9a-f]{3,6}` を変更ファイルで0件） |
| R10 typecheck・lint・build・npm test・e2e が通る。e2e は reservations.spec.ts:22 の作業場所 fill を削除し、初期役割（e2e-plain、needsWorktree=false、`tests/fixtures/e2e-env.ts:136`）で「本店（いつもの作業場所）で動きます」が見えることを確認する形に直す（e2e の一時リポジトリには worktree が無いため作業用コピー型は単体試験で確認） | ローカル実行と CI |
| R11 版 0.22.0、CHANGELOG・README の予約/定期実行の説明を更新 | diff |
| R13 本店型の役割で cwd を省いた /api/agent/reservations の POST が 201、保存 cwd=本店の実パス | サーバー単体試験（新規） |
| R12 導入後、実画面で opus-designer の予約を2分後に作り、届く | 導入後の実機確認（PO の画面または Opus） |

## 8 維持の仕組み
- cwd の既定は validateLaunchTarget の1か所。予約・定期実行・今後の起動系は同じ関数を通す。
- 作業場所の選び方は LaunchTargetField（表示）と launchTarget.ts（一覧取得・保存可否・送信値）の1か所。予約・定期実行の両エディタが使う。
- 守り手: CI（ubuntu・macOS の vitest・Playwright）と、設計ガバナンス検査（scripts/check-design-governance.mjs、lint の中で動く）。

## 外部・過去事例の参照と我々への応用
- 外部事例は使わない。理由: 入力方式の変更で、判断に必要な根拠（候補一覧・本店の正本・検査の位置）はこのリポジトリの既存実装で足りる。
- 応用した過去事例: v0.3.3（過去の会話を再開の候補一覧 /api/resume-targets を作業場所の候補に再利用）、v0.21.0（予約と定期実行で検査を validateLaunchTarget の1か所に共通化した形をそのまま使う）。

## 10 導入
PR マージ → タグ v0.22.0 → 導入前に `launchctl list | grep ac-update` で待機中の更新 job が無いことを確認 → PO が ac-update.sh v0.22.0 → healthz の版を確認 → R12。
