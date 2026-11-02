---
mode: handoff
---
# 実装カード: アプリの不具合でないのに CI が赤くなる 9 つの原因を直す（試験と CI だけ）

親: [design.md](./design.md)（第5.1版。§1 成功条件 S1〜S12・§2 対象 D1〜D9・§5 検証の手順）

この文書は何か: agent-console の試験と CI の段の 9 か所（D1〜D9）を直し、直す前と後の確かめを取る作業指示です。アプリの本体（server/・src/・extension/）は変えません。

- 状態: 設計 第4版 審査 APPROVE（2026-11-01・手元の審査役 opus）・PO 実装承認 済（2026-11-01、選択肢「1 直しを始める」）・クラウドの Sonnet へ実装依頼
- 担当: 下の §5 の表のとおり 3 つに分ける。直し（D1〜D7）と、クラウドで動く確かめは Sonnet（クラウド）。Mac でしか動かない確かめは評価役（evaluator・opus・この Mac）。PR・CI の 10 回・使い捨て PR・審査・マージは Opus。
- 土台: origin/main ff5997594。設計の行番号はこの版のもの（第4版の審査で照合済み）。
- 第5版の追加（2026-11-02）: D1〜D7 は 022433e で push 済み。S1 の 10 回で新しく 2 つの原因（D8 日付の境目・D9 macOS の CI のつなぎ直し）が見つかり、PO の決定「1」で設計に足した。D8・D9 は 022433e の上に足す。下の §2-B が第5版の進め方。状態: 第5版は REVISE（2026-11-02）。第5.1版の審査待ち。審査合格の後に Sonnet へ依頼する。

## 読んだ節と照合（Opus、2026-11-01）

- 前のカード（unread-ball-with-po/card.md）と同じ形にした。プレースホルダを残さない・触るファイルを §1 で全部挙げた・PR は Opus が起票（Sonnet は push まで）。
- 直し方（D1〜D7 の変更前後）と成功条件（S1〜S12）は design.md を正本とし、このカードに写し直さない。このカードは、だれがどこで何をするか・順番・止まる条件だけを決める。
- 担当を分けた理由（事実）: 2026-11-01 のクラウドの実装（unread-ball-with-po）の記録で、クラウドの環境にはデザインシステムの写し（.sa-cache）が無く、`npm run build` と `npm run test:e2e` が動かなかった。同じ記録で tests/unit/tmux-host.integration.test.ts は 5 件落ちていた。S4・S5・S7・S8 と S9 の build・e2e はクラウドで取れないので、この Mac の評価役が取る。
- 受領確認: 着手前に、報告の1行目へ「受領確認: ci-flake-fix card を読んだ」と書く。

## 1. 作るもの・触らないもの

触る（design.md §1 S10 の 10 個と、このカード。これ以外は commit しない）:

1. `tests/e2e/pc-meter.spec.ts`（D1）
2. `tests/unit/hub-write-lock.test.ts`（D2）
3. `tests/unit/routines.test.ts`（D3）
4. `tests/unit/tmux-host.integration.test.ts`（D4・第5版の D9）
5. `tests/e2e/console.spec.ts`（D5）
6. `tests/fixtures/claude-stub.sh`（D6）
7. `.github/workflows/ci.yml`（D7）
8. 文書: `docs/handoff/ci-flake-fix/` の中だけ（recon.md・design.md・この card.md）
9. `tests/unit/daily-use.integration.test.ts`（D8。第5版）

S10 は「10 個とこのカード」（design.md §1 S10 のとおり）。アプリの本体を変えないという S10 の意図は変わらない。

触らない: `server/`・`src/`・`extension/`・`hooks/`・`scripts/`・`package.json`・`package-lock.json`・`playwright.config.ts`・`vitest.config.ts`・ほかのすべて。版は上げない。確かめのための一時の変更（S3・S4・S5、`tests/e2e/file-link.spec.ts` を含む）は commit しない。

## 2. 進め方: Sonnet（クラウド）

1. `git log -1 origin/main` が ff5997594 か、それを含むことを確かめる。design.md §2 の行番号が、§1 の1〜7のファイルで5行以上ずれていたら `BLOCKED:` に続けてずれたファイルと行番号。
2. `npm ci` のあと、直す前の写しを別の場所に作る（`git worktree add <別の場所> origin/main`、その中でも `npm ci`）。そこで S2（直す前）と S3（直す前の (a)(b)）を取る。一時の変更の戻し方は design.md §5 の段落のとおり（1つずつ入れて回し、すぐ戻し、`git diff --exit-code -- <5ファイル>` が rc=0）。
3. 作業の枝 `release/ci-flake-fix` で D1〜D7 を design.md §2 のとおりに入れ、commit する（一時の変更を入れる前に必ず commit）。設計に書いていない変更を足さない。決まっていないことに当たったら `NEEDS_DECISION:` に続けて、どこの何が決まっていないか。
4. S2（直した後）・S3（直した後の (a)(b)）を取る。
5. `npm run typecheck`・`npm run lint`・`npm test` を直す前の写しと直した後の両方で流し、落ちる試験の名前の一覧を比べる。直した後に増えた失敗が 0 であること。今回触った単体の試験ファイル（hub-write-lock・routines）は、直した後に全部合格であること。tmux-host.integration は環境の都合で落ちてよいが、落ちた試験の名前が直す前と同じであること。build・test:e2e が環境の都合で動かないときは、理由の生の文面の最後の行を書いて進む。
6. S10: `git diff --name-only origin/main...HEAD` が §1 の 1〜9 だけ。`git status --porcelain` が空。
7. `git push origin release/ci-flake-fix`。PR は作らない。

git の操作は1命令ずつ流す。commit の文は Write でファイルに書いて `git commit -F` で流す。

## 2-B. 第5版の進め方: Sonnet（クラウド）

1. `git log -1 origin/release/ci-flake-fix` が 022433e か、それを含むことを確かめる。design.md D8・D9 の行番号が5行以上ずれていたら `BLOCKED:`。
2. 直す前の写し（022433e から別の作業場所）で S11 を取る（design.md §5 の5の時刻ずらしの道具。4 つの時刻 × 3 回）。
3. 作業の枝で D8・D9 を design.md §2 のとおりに入れ、commit する。
4. 直した後で S11（12 回すべて合格）・S9 の typecheck・lint・npm test の比べ・S10 を取る。直す前に S11 の 23:55 が 3 回中 3 回落ちなければ、値を書いて止まる。macOS の CI の値（S12）はクラウドでは取れないので、git diff だけを確かめる。
5. `git push origin release/ci-flake-fix`。PR は作らない。

## 3. 進め方: 評価役（この Mac。Sonnet の push の後）

1. この Mac の作業場所 `/Users/tanizawashingo/agent-console-wt/ci-flake-fix` で `git pull` し、push された HEAD と同じか確かめる。直す前の写しは origin/main から別の作業場所に作る。両方で `npm ci`・`npm run sa-sync`・`npm run build`。
2. 直す前の写しで: S4（旧の順）・S5（直す前）・tmux の 2 つの試験の 1 回分の所要時間（design.md D4。3 倍が 90000・120000 に収まるか）。
3. 直した後で: S4（新の順）・S5（直した後）・S7 の手元の半分（CI を入れずに）・S8・S9（typecheck・lint・npm test・build・test:e2e が全部 rc=0）。
4. 一時の変更の戻し方は design.md §5 の段落のとおり。最後に両方の作業場所で `git status --porcelain` が空。
5. 生出力は `/tmp/CC報告ファイル/ci-flake-fix/` に保存し、S ごとに ○ / × と根拠のファイルを報告する。

## 4. 停止する条件（3者共通）

- §2 の1でずれた → `BLOCKED:`。
- 直す前に S3 (a)(b) が 3 回中 3 回落ちない、S4 の旧の順が 0 回、S5 の直す前が 16 未満、S11 の 23:55 が 3 回中 3 回落ちない → 値を書いて止まる（design.md §1 のとおり）。
- 直した後に、直す前には無かった失敗が出た → 落ちた試験の名前と生の行を書いて `NEEDS_DECISION:`。期待を書き換えない。
- 一時の変更が戻らない（`git diff --exit-code` が rc≠0）→ 止まる。
- 見張りに止められた → 言い換えず `BLOCKED:` で文面を返す。

## 5. だれが何をするか

|項目|Sonnet（クラウド）|評価役（この Mac）|Opus|
|---|---|---|---|
|D1〜D7 の直しと commit・push|○|||
|S2・S3|○（直す前と後）|||
|S4・S5・S7 の手元の半分・S8||○（直す前と後）||
|S9|typecheck・lint・npm test の比べ|全部 rc=0（D8・D9 を入れた後にもう一度）||
|S10|○|○（再確認）||
|S11（第5版）|○（直す前と後）|||
|S12（第5版）|git diff|git diff の再確認|S1 の 10 回の macOS の中央値|
|S1（CI 10 回）・S6（使い捨ての下書き PR）・S7 の CI の半分|||○|
|PR の起票・審査役（opus）の審査・マージ|||○|

## 6. 終わりの条件

- Sonnet: §2 の 1〜7 と §2-B の 1〜5 が済み、push 済み。報告の最後の行は `DONE` / `BLOCKED:` ＋理由 / `NEEDS_DECISION:` ＋内容 のどれか。
- 評価役: §3 の S ごとの ○ / × がそろう。第5版では、D8・D9 の push の後に §3 の 1 と 3 の S9（build・test:e2e を含めて全部 rc=0）と S10 をもう一度取る。
- Opus: S1〜S12 がすべて ○。どれか × なら止まって報告する。

## 7. カードの自己審査（2026-11-01 Opus。同じ AI による自己審査）

- 判定: APPROVE
- 設計との整合: 触るファイルは design §1 S10 と同じ（このカードを足すだけ）。確かめは design §1 の S1〜S12 と §5 の手順をそのまま使い、取る場所だけを分けた。直し方の正本は design §2 の1か所。
- 設計からの変更: 確かめを取る担当を「実装役」から 3 者に分けた。理由は上の「担当を分けた理由」の事実。成功条件と判定の値は変えていない。
- 残る未確認: S7 の CI の半分のログの行（design のとおり補足扱い）。クラウドで `npm test` 全体の落ちる試験の一覧が、前回の 31 件と同じかは、まだ確かめていない（§2 の5で直す前と後を比べるので、判定には使わない）。

END OF CARD
