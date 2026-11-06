# 便CS3a 後追い — 実装カード（probe が止まった・×になったときの証拠を残す・v0.53.1）

正本の設計: Sales Anchor docs/handoff/conversation-consent/design.md §14-14（第12版）。親カード: card-cs3a.md（§2 の触らない範囲はそのまま守る）。
土台: origin/main の 84f8f0fe1d8e2bc087622f1f6b5c6509cb75e807（v0.53.0）の次の commit（このカードを足した commit）。
このカードに無いことはしない。迷ったら停止して `NEEDS_DECISION:` で返す。見張りに止められたら言い換えず `BLOCKED:` で返す。

## なぜ（本番の手元での観測・Opus が読んだ事実）
- 1回目（監査 at 2026-11-06T16:28:58.932Z）: outcome aborted・probeCaseId ""・counts {}・paneSamples []。件の写しは作られて 78 秒後に消えた（~/worktrees/discord-cases の mtime 01:28:58 JST）。打ち切りの理由はどこにも残っていない。server/case-say-probe.ts の catch（v0.53.0 の :484-490）が想定外の例外を aborted にするとき、理由を捨てるため。
- 2回目（監査 at 2026-11-06T16:38:36.787Z）: outcome denied・failedCheck P3。P0〜P2 は○。paneSamples は P0・P1・P2 の後の 3 つだけで、文3 を送った後の画面が無い。sample() は各段の○の後にしか呼ばれないため。
- どちらも、次の判断（P3 の判定の作り直しなど）に要る証拠が無い。判定・手順は変えず、証拠だけを足す。

## E1 ×・打ち切りのときも画面を1枚残す
- 場所: server/case-say-probe.ts の run() の catch の後、片付け（`if (probeCase !== undefined) { await ports.closeCase(...` ）の直前。
- 変更: `probeCase !== undefined` かつ（`failed !== undefined` または `aborted`）かつ `panes.length < PROBE_PANE_MAX_SAMPLES` のとき、`panes.push(sanitizePane(await ports.capturePane(probeCase)))` を1回だけ行う。capturePane が投げたら飲み込む（片付けの道を必ず通す）。
- 既存の sample() はそのまま。上限 4（PROBE_PANE_MAX_SAMPLES）は変えない。

## E2 打ち切りの理由を監査に残す
- server/case-say-probe.ts:
  - `ProbeAborted` に理由を持たせる（例: `constructor(readonly reason: string) { super(reason); }`）。既存の `new ProbeAborted("abort")`・`new ProbeAborted("setRunning")` はそのまま理由になる。
  - catch で、ProbeAborted なら `abortReason = err.reason`。ProbeFailed でも ProbeAborted でもない例外なら `abortReason = "error: " + 名前 + ": " + message` を 200 バイトまでに切る（sanitizePane と同じ制御文字の除き方でよい。新しい関数を作るなら case-say-probe.ts の中だけ）。
  - finish() に abortReason を渡し、outcome が "aborted" のときだけ監査の行に `abortReason` を足す（failedCheck と同じ書き方: `...(f.abortReason !== undefined ? { abortReason: f.abortReason } : {})`）。
- server/routine-audit.ts: RoutineAuditEntry に `abortReason?: string;` を足す（failedCheck の隣）。ほかは変えない。
- 記録（case-say-claude-versions.json）の形・MAC・知らせ n1〜n6 は変えない。

## 試験（tests/unit/case-say-probe.test.ts に足す）
- T1: P3 で×（文3 の後 idle に戻らない）→ paneSamples が 4 つ（P0・P1・P2 の後 + ×の後）で、最後が文3 の後の偽の画面。
- T2: openCase が `new Error("boom")` を投げる → outcome aborted・監査の abortReason が `"error: Error: boom"`・paneSamples は []（件が無いので撮らない）。
- T3: setRunning が false → 監査の abortReason が `"setRunning"`。
- T4: capturePane が×の後だけ投げる → 片付け（closeCase・cleanup）が呼ばれ、outcome は denied のまま。
- 既存の試験は変えない（既存の期待が paneSamples の数を固定していて落ちるなら、そこだけ新しい数に直し、直した試験名を報告に書く）。

## 版
- 0.53.1: package.json・package-lock.json（version の2か所）・extension/manifest.json。docs/CHANGELOG.md に 0.53.1 の項を1つ（「件の claude の版の確かめが止まった・×になったとき、そのときの画面と止まった理由を監査に残す」）。README は変えない。

## 確かめ
- `npm ci`・`npm run typecheck`（土台の数から増やさない。数を書く）・`npm run lint`・`npm test`（赤は土台と同じ一覧であること。土台でも同じ試験を回して比べる）。
- build がクラウドで `.sa-cache` の無いことで止まるのは既知の事情。その場合はそう書く（直さない）。e2e は GitHub の CI で見る。

## 提出
- `git fetch origin` → `git switch release/case-claude-version-evidence` → `git log -1 --format=%H` が本カードの commit であることを確かめる。
- commit の文の終わりに `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。一時ファイル・秘密・ホームの絶対パスを入れない。
- `git push origin release/case-claude-version-evidence`（force・rebase・reset 禁止）。PR は作らない。マージはしない。

## 最後の返事
1行目は `DONE <新しい HEAD の40桁>`／`BLOCKED: <理由>`／`NEEDS_DECISION: <問い>` のどれか。2行目から: 変えた file:line、足した試験の名前、試験の数（通った・赤）と赤が土台と同じかどうか、typecheck の数、lint の結果、push の結果1行、`git diff --stat <本カードの commit>..HEAD`。

END OF CARD
