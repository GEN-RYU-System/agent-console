# 作業場所を「選ぶだけ」にする — recon

基準: origin/main 0a8266c（= v0.21.0）。作業用コピー ~/agent-console-wt/cwd-picker（release/cwd-picker）。生出力: /tmp/CC報告ファイル/agent-console-picker/。

## PO の依頼（原文・2026-10-14）
- 「作業場所 * ブランチここは非エンジニアには埋められないのだがもっと非エンジニア寄りに作れる？それとも登録しないといけないか？」
- Opus の提案「予約と定期実行の両方の画面を、この『選ぶだけ』の形に変えてよいですか（y/n）」への返答として:「推測は禁止して事実確認を怠らずに確実性を重視して…配線とDBのSSOTは遵守してデータを分散させることは禁止。フロントエンドのパーツもデザイントークンとデザインシステム を遵守して、金型登録のないハードコードを禁止する。…確立したなら進める。」

## 画面（今）
- `src/components/Reservations/ReservationEditor.tsx:39` 作業場所は TextField（自由入力・必須）、`:40` ブランチは TextField（任意）。役割は Select（`:38`、初期値 roles[0] `:16`）。送信 `:29` は `{name, roleId, cwd, ...(branch ? {branch} : {}), date, time, promptText}`。クライアント検査なし。サーバーのエラーを Callout に出す（`:30-31`, `:45`）。
- `src/components/Routines/RoutineEditor.tsx:20` 作業場所（必須）、`:21` ブランチ、`:19` 役割。編集時は役割・作業場所・ブランチが disabled（`:19-21`）。サーバーも更新でこの3つの変更を拒否（`server/routines.ts:64`）。
- 両エディタは `roles: RoleView[]` を受け取る（各 `:11`）。RoleView は `src/types.ts:27-31` `{id, labelKey, needsWorktree}`。画面へは GET /api/state の roles（`server/http.ts:144`）。resumeScope は画面に届かない。
- 普段の「新しいセッション」は作業場所欄を持たず、needsWorktree の役割だけブランチ名を出す（`src/components/NewSessionForm/NewSessionForm.tsx:47-56`）。

## 作業場所の候補一覧（既存）
- GET /api/resume-targets（`server/http.ts:249-252`）→ `listResumeTargets(config.salesanchorRoot, config.roles)`（`server/resume-targets.ts:61-78`）。絞り込みクエリなし。
- 中身: 本店1行（resumeScope "main" の役割があるとき、`:65-69`）＋ `git worktree list --porcelain`（`:25-28`）の本店以外で実在するもの全件（resumeScope "worktree" の役割があるとき、`:70-76`）。形 `ResumeTarget {kind:"main"|"worktree"; path; branch:string|null; roleId}`（`server/resume-targets.ts:15-20`、`src/types.ts:113-119`）。detached の worktree は branch=null（`:58`, `:75`）。
- 画面側の取得関数 `fetchResumeTargets()`（`src/api.ts:75`）。使用は「過去の会話を再開」（`src/components/ResumePicker/ResumePicker.tsx`、呼び出し `src/pages/ConsolePage.tsx:239`）。

## サーバーの検査（正本）
- `server/launch.ts:42-51` validateLaunchTarget: 役割の存在、cwd は文字列で、`classifyCwd`（`server/resume-targets.ts:43-51`）が「実在し、本店か worktree 一覧のどれか」と判定したものだけ。`role.needsWorktree` なら branch が文字列であること（中身の検査なし）。戻り値は実パス。呼び出し `server/routines.ts:60`、`server/reservations.ts:172`。実行時にも cwd を再検査（`server/launch.ts:85-87`）。branch はセッションの表示用（`:90`）だけで、worktree の作成には使わない。
- 本店の正本は config の `salesanchorRoot`（全役割共通。役割ごとの既定 cwd はない）。

## 金型
- `Select`（@sa/components、実体 ~/agent-console/.sa-cache/frontend/src/components/Select.tsx:124-180）。props: options `{value,label,disabled?}[]`（`:19-23`）, label, helperText, error, size, fullWidth, placeholder（先頭の空 option）, native の value/onChange/disabled/required。agent-console での使用例: NewSessionForm.tsx:39-45、両エディタの役割欄。
- 作業用コピーには `.sa-cache` が無い（gitignore）。`vite.config.ts:5,9`・`tsconfig.json:16` が参照するため、build/test 前に本体の .sa-cache を用意する必要がある。

## 文言
- `src/locales/ja.json` のみ（en.json なし）。ac.routines.cwd / branch、ac.reservations.cwd / branch（どちらも「作業場所」「ブランチ」）。

## 試験
- 予約・定期実行のエディタ単体試験は無い。e2e `tests/e2e/reservations.spec.ts:21-25` が `getByLabel("作業場所").fill(ROOT)`。サーバー単体 `tests/unit/reservations.test.ts:44,214,273`、`tests/unit/routines.test.ts:8,54,126,181`（cwd を明示して送る）。

## 実データ（本番 dataDir ~/Library/Application Support/agent-console、読み取りのみ）
- routines.json なし（定期実行 0 件）。reservations.json 2 件: 2 件とも opus-designer・cwd=本店・branch なし。
- 本番 config（current → versions/v0.21.0 の agent-console.config.json。リポジトリと同一）: opus-designer needsWorktree=false/resumeScope=main、sonnet-impl true/worktree、shell false/なし。
- 本店の worktree は本店含め 57 件。
