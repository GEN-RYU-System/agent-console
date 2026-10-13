# recon: 定期実行を「毎回新しいセッション」にする

基準: origin/main f897ff6（v0.15.0）。読み取りのみ。外部サイトは参照していない（PO 指示 2026-10-13）。

## PO の依頼（原文）
「定期実行に定期で行ってほしい作業を登録するので決まった時間に新しいセッションを開き指示を投げる仕組みをこのアプリに実装したい」

## 今の動き（事実）
- 登録したときに、専用のセッションを1つ開く: `server/routines.ts:68` create → `createSession`（`server/routines.ts:71`）→ `sessions.restore({... routineId})`。
- サーバーを起動したときは、そのセッションを同じ会話で開き直す: `server/routines.ts:54` start → `restore()`（`server/routines.ts:72`）。Claude の id は `captureClaudeIds`（`server/routines.ts:73`）で routines.json に控える。
- 時刻になったら、既存の専用セッションに送る: `server/routines.ts:75` dispatch → `hub.checkInput` → `sessions.write(session, promptText + "\r")`。括弧付き貼り付けは使っていない。
- 二重実行の防止はメモリ上の Set だけ（`server/routines.ts:51,74`、上限 1000）。再起動すると消える。
- 取りこぼした回は追い付かない（`docs/handoff/v0.7.0-routines/design.md:11`「never retries/catches up」、`tests/unit/routines.test.ts:95`）。
- 専用セッションは復元リストから外している: `server/restore.ts`（`.filter((s) => !s.exited && s.routineId === undefined)`）。`Session.routineId` は `server/sessions.ts:52-53,206,266,287` で使う。
- 起動コマンドは役割の command（`server/sessions.ts:210,268`）。権限モードの引数（--permission-mode / --dangerously）は config・server のどこにも無い（`git grep` 0件）。
- チャット送信（v0.13.0）は、括弧付き貼り付けの後に `pasteSubmitDelayMs` 待ってから "\r" を送る: `server/hub.ts:41-42,370-374`。
- `hub.checkInput`（`server/hub.ts:405-410`）は毎回 `claude agents --json` を取り直して判定する。idle かつ待ち無しのときだけ ok（`server/agents.ts:80-88`）。Claude が居なければ ok:true, hasClaude:false。
- セッション名は 1〜40 文字（`server/sessions.ts:10,59-62`）。
- 画面: `src/components/Routines/RoutinesPane.tsx`（55行）・`src/components/Routines/RoutineEditor.tsx`（28行）・`src/components/Routines/Routines.css`（13行）。部品は @sa/components の Badge/Button/Callout/EmptyState/Modal/Select/Stack/Textarea/TextField。CSS は var(--space-N) 等のトークンだけで、色の直書きは無い。文言は `src/locales/ja.json:193-` の `ac.routines.*`（言語ファイルは ja.json だけ。`src/i18n.ts:19`）。
- routineId を使う試験: `tests/unit/routines.test.ts:128-132`、`tests/unit/session-restore.integration.test.ts:426-434`。
- セッションの上限 16: `server/sessions.ts:9`。
- 試験: `tests/unit/routines.test.ts`（151行、13件）。

## 本番の状態（事実）
- 導入先は v0.9.1（`~/Library/Application Support/agent-console/current -> versions/v0.9.1`）。
- 導入先に routines.json は無い（登録 0 件）。旧形式のデータを移す必要は無い。
- v0.15.0 への更新待ち job が別作業で投入済み（~/CC報告ファイル-keep/agent-console/handoff-20261013.md 追記2）。

## 既存の決め
- `docs/handoff/v0.7.0-routines/design.md`（routines.json だけが正本、検証、fresh guard、追い付かない）。
- PO 2026-10-13: v0.7.0 の定期実行は「残す」（n）。規約（Consumer Terms 3条7項）の懸念を説明したうえでの判断（メモ project_orca_selfbuilt_app）。
- Mac は 8GB で、会話の同時数がメモリ逼迫の主因。会話を自動では閉じない（メモ project_mac_memory_optimization）。
