# 便CS3a 直し4 — 実装カード（claude 2.1.319 で probe が P3 で×になる件）

正本の設計: Sales Anchor docs/handoff/conversation-consent/design.md §14-14-16（第12版の直し1）。親カード: card-cs3a.md（§2 の触らない範囲はそのまま守る）。直し1〜3: card-cs3a-fix1.md〜card-cs3a-fix3.md。
土台: release/case-probe-p3-followup の、origin/main 2372b23fa606a934e1c6e61adce86f7fbeecce6e の上でこのカードを最後に直した commit（`git log -1 --format=%H -- docs/handoff/case-claude-version/card-cs3a-fix4.md`）。
このカードに無いことはしない。迷ったら停止して `NEEDS_DECISION:` で返す。見張りに止められたら言い換えず `BLOCKED:` で返す。

## なぜ
v0.55.1 で claude 2.1.319 の probe が 2 回 P3 で×になった。クラウドで本物の 2.1.319 を 8 回動かした結果:
- 文3（`/plan …`）だけでは、主の会話の plan の pre が来ない（計画を文で答えて止まる）。
- 続けて「計画どおり進めてください。」を送ると plan の pre が来て、case-guard が止め post は来ない（6 / 6）。
- 今の P4（番号付きの行 2 行以上）が計画の文「1. 2. 3.」に当たり、選ぶ画面が無いのに×になる（8 / 8）。選ぶ印（`❯`・`>`）の付いた番号の行があるときだけ数えれば 0 / 16。
- 文1・文2 に「Write ツールで」「Bash は使わないでください」を足すと Bash の pre は 0 / 8、probe-1/2 は ok 4 / 4。

## G1 文の定数（server/case-say-probe.ts:24-29）
- `probeSentences` の 3 つの文を次に変える（`${R}` の位置は今と同じ。型 `[string, string, string]` は変えない）:
  - 文1: `${R}/probe-1.txt に Write ツールで ok とだけ書いてください。Bash は使わないでください。`
  - 文2: `Agent で下請けを1つ動かし、下請けに ${R}/probe-2.txt へ Write ツールで ok とだけ書かせてください。あなたも下請けも Bash は使わないでください。`
  - 文3: `/plan ${R}/probe-3.txt に Write ツールで ok とだけ書いてください。`
- 定数を足して export する（:13 `PROBE_P3_MS` の近く・:29 の後）:
  - `export const PROBE_P3_QUIET_MS = 20 * 1000;`
  - `export const PROBE_FOLLOW_UP_SENTENCE = "計画どおり進めてください。";`（文4。コメント: 文3 の返事が plan の pre なしで終わったときだけ 1 回送る。§14-14-16）
- :24 のコメント「台本の文 3 つ」は「台本の文 3 つ（文4 は PROBE_FOLLOW_UP_SENTENCE）」にする。

## G2 P3 の待ち方（server/case-say-probe.ts:466-476 の塊だけを置き換える）
今の `{ const end = …; const back = await idleWait(…); if (!back) throw new ProbeFailed("P3"); }` を、次の動きにする。:477 以降（`postIdleWaitMs` の sleep・abort の確かめ・sample・`countTools(this.records, sent2At, sent3At)`・P3〜P5 の判定）は変えない。

```ts
      const hasPlanPre = (): boolean =>
        this.records.some((r) => r.ts >= sent3At && r.phase === "pre" && r.agent_id === "" && r.permission_mode === "plan");
      counts.p3FollowUp = 0;
      // P3 の×の前に数を監査へ残す（§14-14-16 の 2 (d')）
      const failP3 = (): ProbeFailed => {
        counts = { ...counts, ...countTools(this.records, sent2At, sent3At) };
        return new ProbeFailed("P3");
      };
      {
        const end = ports.now() + PROBE_P3_MS;
        let sawBusy = false; // P3 の待ちの中だけの旗。observed は使わない
        let idleStreak = 0;
        let followUp = false;
        for (;;) {
          const s = await ports.readState(c);
          const status = s.state?.status;
          if (status !== undefined) observed.add(status);
          if (status === "busy") sawBusy = true;
          idleStreak = status === "idle" ? idleStreak + 1 : 0;
          if (status === "idle" && hasPlanPre()) break;
          if (idleStreak >= 2 && (sawBusy || ports.now() - sent3At >= PROBE_P3_QUIET_MS)) {
            followUp = true;
            break;
          }
          if (ports.now() >= end) throw failP3();
          await this.tick(deadline);
        }
        if (followUp) {
          if (!(await ports.send(c, PROBE_FOLLOW_UP_SENTENCE))) throw failP3();
          counts.p3FollowUp = 1; // 送れたときだけ 1（送れなければ 0 のまま。§14-14-16 の 4）
          const back = await idleWait(PROBE_P3_MS, async () => hasPlanPre());
          if (!back) throw failP3();
        }
      }
```
- 文4 を送るのは 1 回の probe で最大 1 回。2 回目を送る道を作らない。
- `counts.p3FollowUp` と `countTools` の数は P3 の×のときも監査に残る（`failP3`。`counts` は :350 の `let`。:482 の `counts = { ...counts, ...tools }` はそのまま）。`p3FollowUp` は文4 の `send` が true を返した後で 1 にする（false なら 0 のまま）。
- 時刻の決まり: `sent3At` は今と同じく文3 の `send` の前の `ports.now()`（:467）。見回しは文3 の後すぐ 1 回目、その後 `tick` ごと。
- 文4 を送るのは、`idle` を 2 回の見回しで続けて見て、かつ P3 の中で `busy` を見たか文3 から 20 秒たったときだけ。
- `observed` に状態を足すのは今の idleWait と同じ（P5 の状態の確かめのため）。

## G3 P4 の数え方（server/case-say-probe.ts:73-90 `countPickScreens`）
- 番号付きの行（`/^\s*[❯>]?\s*\d+\.\s/`）が 2 行以上続く塊のうち、塊の中に `/^\s*[❯>]\s*\d+\.\s/` に合う行が 1 つ以上ある塊だけを 1 と数える（塊ごとに 1。塊の終わり＝番号付きでない行か、文の終わり）。
- `Yes`/`No` が同じ行・`(y/n)`・`Do you want to`・`Esc to cancel` の 4 つの数え方は変えない。
- :73 のコメントを「選ぶ印（❯・>）の付いた番号の行を含む、番号付きの行 2 行以上の塊」に直す。

## G4 版を 0.55.2 にする
- package.json:3・package-lock.json:3 と :9・extension/manifest.json:4 の `0.55.1` を `0.55.2` に。
- docs/CHANGELOG.md の 0.55.1 の行の上に 1 行足す:
  `- 0.55.2 件の claude の版の確かめ（probe）を claude 2.1.319 に合わせた。(1) 文1〜3 に「Write ツールで」、文1・文2 に「Bash は使わないでください」を足した (2) 文3（/plan）の返事が計画の文だけで終わったときは「計画どおり進めてください。」を1回だけ送り、止める仕組みが働くかを見る (3) 選ぶ画面の数え方で、選ぶ印（❯・>）の無い番号付きの計画の文を数えない (4) 監査の counts に p3FollowUp（文4 を送ったら 1）を足した。戻し方 bash scripts/ac-update.sh v0.55.1。設計は Sales Anchor docs/handoff/conversation-consent/design.md §14-14-16`

## G5 試験（tests/unit/case-say-probe.test.ts だけ）
偽の世界（`world`）に足す物（ほかの扱いは変えない）:
- `Opts` に 3 つ足す:
  - `s4?: (rec) => void` — `send` で `text === PROBE_FOLLOW_UP_SENTENCE` のとき呼ぶ（無ければ何も記録しない）。
  - `statusAt?: (sentCount: number, readsSinceSend: number) => string | undefined` — `readState` のたびに呼ぶ。`sentCount` はその時の `sent.length`、`readsSinceSend` は最後の `send` の後に `readState` が呼ばれた回数（0 から。`send` のたびに 0 に戻す）。状態は `statusOverride ?? o.statusAt?.(…) ?? o.status ?? "idle"` の順で決める。
  - `failSend4?: boolean` — true のとき、文4 の `send` は `sent`・`sentAt` に積み、時計を 50 進め、記録を作らず `false` を返す。
- `world` の中に `const sentAt: number[] = []` を足し、`send` の最初（`clock += 50` の前）に `sentAt.push(clock)` する。返り値に `sentAt` を足す。`run()` の返り値からも `w.sentAt` で読めるようにする（`w` を返しているなら足すだけ）。
- 時刻の見方: 文3 の `send` の時刻 `sentAt[2]` は実装の `sent3At` と同じ。見回しは `sentAt[2] + 50`・`+1050`・`+2050`… の時刻に起きる（pollMs 1000・`send` で 50 進む）。

直す・足す試験:
- :140-146 の文の試験を新しい 3 つの文に直し、`PROBE_FOLLOW_UP_SENTENCE` が `"計画どおり進めてください。"`、`PROBE_P3_QUIET_MS` が `20000` であることを足す。
- :158-164 の P4 の試験に足す: `"1. 計画を立てる\n2. 書く\n3. 確かめる\n"` は 0。`"> 1. Yes\n  2. No\n"` は 1。`"  1. Yes\n  ❯ 2. No\n"` は 1。`"❯ 1. Yes\n\n2. No\n"`（空行で塊が切れる）は 0。`"❯ 1. a\n  2. b\nx\n❯ 1. c\n  2. d\n"` は 2。既存の行は変えない。
- :182 の K51 の ok の試験に `expect(row.counts?.p3FollowUp).toBe(0)` と `expect(w.sent.length).toBe(3)` を足す（F4f の代わり。文3 で plan の pre が来たら文4 を送らない）。

新しい試験（describe 名は「CS3a fix4: sentence 4 after a plan reply without a plan pre」）。どれも文3 は記録なし（`s3: () => undefined`）。
- F4a: `statusAt: (n, k) => (n === 3 && k < 2 ? "busy" : undefined)`・`s4` で plan の pre（post なし）→ `outcome: "ok"`・`sent` が 4 つで 4 つ目が `PROBE_FOLLOW_UP_SENTENCE`・`sentAt[3] - sentAt[2] === 3050`・監査の `counts.p3FollowUp === 1`・`isUsable(FP)` が true。
- F4b: 状態はずっと `idle`・`s4` で plan の pre → ok・`sentAt[3] - sentAt[2] === 20050`。
- F4g: `statusAt: (n, k) => (n === 1 && k === 0 ? "busy" : undefined)`（P1 の間だけ busy を 1 回）・`s4` で plan の pre → ok・`sentAt[3] - sentAt[2] === 20050`（P1 の busy で早く送らない）。
- F4i: `statusAt: (n, k) => (n === 3 && k < 10 ? (k % 2 === 0 ? "busy" : "idle") : undefined)`・`s4` で plan の pre → ok・`sentAt[3] - sentAt[2] === 10050`（一瞬の idle で送らない。idle が 2 回続いた見回しで送る）。
- F4c: `s4` も記録なし → `failedCheck: "P3"`・`sent` が 4 つ（文4 は 1 回だけ）・監査の `counts.p3FollowUp === 1`・`counts.planPres === 0`・`counts.p2Posts >= 1`（×でも数が残る。旧 F4h はここに入れる）。
- F4d: `failSend4: true` → `failedCheck: "P3"`・`sent` が 4 つ・監査の `counts.p3FollowUp === 0`・`counts.planPres === 0`（送れなければ 0・×でも数が残る）。
- F4e: `s4` で plan の pre と主の会話の post（`agent_id: ""`・同じ `tool_use_id`）→ `failedCheck: "P3"`。
- 既存の試験（:207 の表・F1・T1〜T4 ほか）は変えずに通ること。`["P3", { s3: () => undefined }]` は文4 の道を通って P3 のまま×になる。

## 触らない
- server/case-say-probe.ts の G1〜G3 以外（E1〜E4・P0〜P2・P5・R1・記録・MAC・24 時間と 3 回の規則・片付け・監査の形）。
- server/hub.ts（probeSend）・server/case-say-versions.ts・case-guard・hooks・tests/e2e・README・ほかのファイル。

## 確かめ
- `npm ci`・`npm run typecheck`（origin/main 2372b23 で先に数え、増やさない。両方の数を書く）・`npm run lint`・`npx vitest run tests/unit/case-say-probe.test.ts`（結果の数を書く）。
- 全部の試験は GitHub の CI で見る。クラウドで `npm test` を回せたら結果を書く。

## 提出
- `git fetch origin` → `git switch release/case-probe-p3-followup` → `git log -1 --format=%H` が本カードの commit であることを確かめる。
- commit の文の終わりに `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。一時ファイル・秘密・ホームの絶対パスを入れない。
- `git push origin release/case-probe-p3-followup`（force・rebase・reset 禁止）。PR は作らない。マージはしない。

## 最後の返事
1行目は `DONE <新しい HEAD の40桁>`／`BLOCKED: <理由>`／`NEEDS_DECISION: <問い>` のどれか。2行目から: 変えた file:line、typecheck の数（前後）、lint の結果、vitest の結果、push の結果1行、`git diff --stat <本カードの commit>..HEAD`。

END OF CARD
