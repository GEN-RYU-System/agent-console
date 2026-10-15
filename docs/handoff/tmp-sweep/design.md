# 設計カード: ディスク満杯のあとに残る一時ファイルを自動で片付ける（agent-console v0.38.2）

- 作成: Opus（設計）2026-10-15 22:45 ／ 基準 origin/main 69e39b9（v0.38.1）
- PO 承認: 10/15「6. 一時ファイルが残る不具合 …→進める」（実装・マージ・入れ替えまで）
- 審査: 本ファイル末尾（同一AIによる自己審査。独立レビューではない）

## 0. 観測した事実
- 【事実】dataDir に `usage.json.79037.ipyoxeeekrc.tmp` が1件残っている（150 byte、mode 600、更新 10/15 20:46）。中身は完全な JSON（キーは fiveHour・observedAt・sevenDay・version、observedAt=1792064774027）。
- 【事実】同じ時間帯に server.err.log に `metrics: poll failed: ENOSPC: no space left on device, open '.../session-metrics.json.7877.*.tmp'` が9行ある（ディスク満杯）。
- 【事実】書いたのは hooks/ac-statusline.mjs の writeJsonAtomic（L68-87、名前の形 `<file>.<pid>.<乱数>.tmp`）。導入済み dataDir/bin/ac-statusline.mjs は origin/main と同一（cmp 一致）。
- 【事実】writeJsonAtomic は open→write→close→chmod→rename の順で、失敗時は catch で rmSync(tmp, {force:true}) する。中身が完全で mode 600 なので、chmod までは済んでいた。
- 【未確認】rename が失敗し、続く rmSync も失敗した（APFS は満杯時に削除も失敗しうる）のか、プロセスが chmod と rename の間で止められたのか。どちらでも、「失敗時にその場で消す」だけでは残りうる。
- 【事実】この残りがあると、下の帯（usage-footer）の合格条件 K6「翌日 dataDir に *.tmp が0件」を満たせない。

## 1. 目的・変化
- 変える前: 書き込みが途中で失敗すると、一時ファイルが永久に残る。
- 変えた後: 次に書き込みが成功したとき、同じファイル名の古い（60秒より前の）一時ファイルを消す。利用者に見える変化はない（dataDir のゴミが自然に消える）。
- 対象: hooks/ac-statusline.mjs の writeJsonAtomic を使う2つ（usage.json・session-metrics.json）。
- 対象外: server/json-store.ts など他の書き込み（現に残っている物はない。今回は直さない）、画面、ディスク満杯そのもの。

## 2. 変更（触るファイル）
1. hooks/ac-statusline.mjs
   - import に `readdirSync, lstatSync, unlinkSync` を足す。
   - 定数 `STALE_TMP_MS = 60 * 1000`、`MAX_SWEEP = 50` を足す。
   - 関数 `sweepStaleTmp(dataDir, fileName, now = Date.now())` を足す（export する。試験用）:
     - `readdirSync(dataDir)` の各名前のうち、正規表現 `^<fileName をエスケープ>\.\d+\.[a-z0-9]+\.tmp$` に一致するものだけを対象にする。
     - `lstatSync` で通常ファイル（isFile()）かつ `now - mtimeMs > STALE_TMP_MS` のものだけ `unlinkSync`。シンボリックリンク・ディレクトリは触らない。
     - 1回で消すのは最大 MAX_SWEEP 件。
     - どの段階の例外も握りつぶす（全体を try/catch。戻り値は消した件数）。決して throw しない。
   - writeJsonAtomic の `renameSync(tmp, file);` の直後で `sweepStaleTmp(dataDir, fileName);` を呼ぶ（成功したときだけ）。
   - 冒頭コメントに「書き込み成功のたびに、同じ名前の60秒より古い一時ファイルを片付ける」を1行足す。
2. hooks/ac-statusline.d.mts: sweepStaleTmp の型宣言を足す。
3. tests/unit/ac-statusline.test.ts: 試験を足す（§3 の K1〜K6）。
4. 版 0.38.2: package.json・package-lock.json（2か所）・extension/manifest.json・docs/CHANGELOG.md に1行（v0.38.1 の 845c5e5・aeb2265 と同じ形）。
5. docs/handoff/tmp-sweep/design.md: 本カードの写し。

触らない: server/ 全部、src/ 全部、scripts/、他の hooks。

## 3. 受入条件
|基準|検証方法|
|---|---|
|K1 mtime を120秒前にした `usage.json.123.abc.tmp` は、writeUsage の成功後に消える|単体試験（utimesSync で時刻を戻す）|
|K2 mtime が今の `usage.json.123.abc.tmp` は消えない（書き込み中の他プロセスを消さない）|単体試験|
|K3 名前が合わない物は古くても消えない: `usage.json.bak`・`usage.json.abc.tmp`（pid なし）・`routines.json.1.a.tmp`・`session-metrics.json.1.a.tmp`（usage の書き込み時）|単体試験|
|K4 名前が合う古いシンボリックリンク・ディレクトリは消えない|単体試験|
|K5 writeSessionMetrics の成功後も、session-metrics.json の古い一時ファイルが消える|単体試験|
|K6 sweepStaleTmp は dataDir が無いときも throw せず 0 を返す。writeUsage の既存試験（200ms 以内など）はすべて通る|単体試験・npm test 全体|
|K7 npm run typecheck・lint・test、CI ubuntu/macOS が緑|CI|
|K8 導入後: healthz が 0.38.2、10/15 20:46 の `usage.json.79037.*.tmp` が導入から1分以内に消え、usage.json の更新時刻が新しくなる|Opus が ls -lT と curl healthz で確認|

## 4. 想定分岐
- 既存試験に dataDir の中身の件数を数える試験があり、掃除で数が変わる → 試験の意図を確かめて止まって報告（勝手に直さない）。
- 正規表現のエスケープで fileName の `.` が漏れる → K3 で検出。
- CI macOS の tmux 計時の揺れ（既知）で落ちる → 失敗ジョブだけ再実行1回。2回落ちたら報告。
- main が先に進んで衝突 → origin/main を merge（rebase・force push はしない）。

## 5. 戻し方・測り方
- 戻し方: `bash scripts/ac-update.sh v0.38.1`（dataDir/bin も前の版に戻る）。
- 測り方: K8。翌日（10/16）に `ls dataDir/*.tmp` が0件か（usage-footer K6 と同時）。

## 6. 外部事例
不要。理由: 「一時ファイル→rename」の失敗時の残骸を、次の成功時に古さで片付けるのは標準的な手当てで、設計判断に外部の数値は使わない。

---
## 自己審査（Opus／同一AI）2026-10-15 22:50 判定: APPROVE
- 原因が【未確認】の2通りどちらでも、K1 の仕組みで次の成功時に消える。根拠は §0 の観測（完全な中身・mode 600）。
- 60秒の閾値: 書き込みは200ms以内（usage-meter 設計 K4）。他プロセスの書き込み中ファイルを消す恐れはない（K2）。
- 消す対象は名前の形（pid と乱数つき）＋通常ファイル＋古さの3条件で絞る。dataDir の他の物（routines.json・open-sessions.json 等）は名前が合わない（K3）。
- statusline は各セッション10秒ごとに動くので、readdir が増える。dataDir の項目は約20件で、負荷は小さい【推測：測っていない】→ K6 の200ms試験で確認する。
- 未解決なし。
