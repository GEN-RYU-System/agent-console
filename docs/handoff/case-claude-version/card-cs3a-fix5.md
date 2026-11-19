# 便CS3a 直し5 — 実装カード（claude 2.1.327 で probe が P0 で×になる件・報告の置き場所 R を信頼済みにする）

正本の設計: Sales Anchor docs/handoff/conversation-consent/design.md §14-14-18（第12版の直し3。審査3回目 APPROVE・PO の実装の承認 2026-11-20「1」）。親カード: card-cs3a.md（§2 の触らない範囲はそのまま守る）。直し1〜4: card-cs3a-fix1.md〜card-cs3a-fix4.md。
土台: release/case-probe-adddir-trust の、origin/main 6aaba26bfb58dd12f2605426d473ff1326a72413 の上でこのカードを最後に直した commit（`git log -1 --format=%H -- docs/handoff/case-claude-version/card-cs3a-fix5.md`）。
このカードに無いことはしない。迷ったら停止して `NEEDS_DECISION:` で返す。見張りに止められたら言い換えず `BLOCKED:` で返す。

## なぜ
claude 2.1.327 は、起動の引数 `--add-dir "$AC_CASE_REPORT"`（ops/shell/ccdiscord.zsh:72）で足した報告の置き場所 R について「Adding a new directory … ❯ No, exit / Yes, add it」と信頼を聞く画面で止まる。今は case-home の `.claude.json` で W だけを信頼済みにしている（server/case-sandbox.ts:423）。クラウドで本物の 2.1.327 を動かすと、`projects` に R を足せば画面は出なかった（2.1.325 は今の形でも出ない）。R を信頼済みに足し、R が git の置き場の中に入っていないことを起動のたびに確かめる。

## G1 rewriteCaseClaudeJson に R を足す（server/case-sandbox.ts:402-429）
- 署名を `export function rewriteCaseClaudeJson(CH: string, W: string, R: string): void` にする。R は省けない引数（`R?: string` にしない）。
- :402-405 の説明に 1 文足す: 「R（報告の置き場所。`--add-dir` に渡すのと同じ文字列）も信頼済みにする。書く前に R が realpath と同じで、R から `/` までに `.git` が無いことを確かめ、当たれば何も書かずに CaseSandboxUnavailableError（設計 §14-14-18）」。
- 関数の最初（:407 の `const file = …` より前）に、次の 2 つの確かめを足す。当たったら何も読まず書かずに投げる:

```ts
  let realR: string;
  try {
    realR = realpathSync(R);
  } catch {
    throw new CaseSandboxUnavailableError("sandbox unavailable: case report dir is not a real path");
  }
  if (realR !== R) throw new CaseSandboxUnavailableError("sandbox unavailable: case report dir is not a real path");
  for (let d = R; ; d = path.dirname(d)) {
    let hasGit = false;
    try {
      lstatSync(path.join(d, ".git"));
      hasGit = true;
    } catch (e) {
      // 無い（ENOENT）ときだけ「無い」。権限などで見られないときは有るとみなして止める
      hasGit = (e as NodeJS.ErrnoException).code !== "ENOENT";
    }
    if (hasGit) throw new CaseSandboxUnavailableError("sandbox unavailable: case report dir is inside a git repository");
    if (path.dirname(d) === d) break;
  }
```
- `lstatSync` が ENOENT 以外（ENOTDIR を含む）で失敗したときは投げる（上の catch のとおり）。
- :423 を次に変える:

```ts
  const realW = realOr(W);
  next.projects = { [realW]: { hasTrustDialogAccepted: true }, [R]: { hasTrustDialogAccepted: true } };
```
  （R と `realW` が同じ文字列なら鍵は自然に 1 つになる。それ以外の鍵の扱い・`KEEP_CLAUDE_JSON_KEYS`・`hasCompletedOnboarding`・:424-428 の書き方と投げ方は変えない）
- import（:4）は既に `lstatSync`・`realpathSync` を含む。足す物は無い。

## G2 呼び出しで R を渡す（server/sessions.ts:789-790）
- :790 を次に変える（:789 の注記は残す）:

```ts
    const report = caseEnv.AC_CASE_REPORT;
    if (room !== null && typeof report !== "string") throw new CaseSandboxUnavailableError("sandbox unavailable: case report dir is missing");
    const beforeNew = room === null ? undefined : (): void => rewriteCaseClaudeJson(room.CH, realOr(cwd), report as string);
```
- R は realpath を取らずに `AC_CASE_REPORT`（server/sessions.ts:628 の `info.report`。`--add-dir` に渡すのと同じ文字列）をそのまま渡す。揃っているかは G1 の確かめが見る。
- `caseEnv` の型が `Record<string, string>` で `typeof` の確かめが型の上で要らないと lint に言われたら、`report === undefined` の確かめに置き換える（意味は同じ: 無ければ投げる）。どちらにしたかを返事に書く。
- `CaseSandboxUnavailableError` が sessions.ts で既に import されていることを確かめる（:530 で使っている）。
- 件でない（`room === null`）ときは今のまま `beforeNew` は undefined。`openTerminal`（:846-881）は変えない（つなぎ直し :854-861 では `beforeNew` を呼ばない・新しく起動する :866 だけで呼ぶ・:871 で CaseSandboxUnavailableError をそのまま投げ直す、は今のまま）。

## G3 版を 0.55.3 にする
- package.json:3・package-lock.json:3 と :9・extension/manifest.json:4 の `0.55.2` を `0.55.3` に。
- docs/CHANGELOG.md の 0.55.2 の行（:5）の上に 1 行足す:
  `- 0.55.3 claude 2.1.327 で件が「Adding a new directory」の信頼の確認で止まる件を直した。(1) 件を新しく起動する前に書く case-home の .claude.json で、作業場所に加えて報告の置き場所（--add-dir に渡す道）も信頼済みにした (2) 書く前に、報告の置き場所が realpath と同じで、そこから / までに .git が無いことを確かめ、当たれば件を開かない。つなぎ直しでは今までどおり書き直さない。戻し方 bash scripts/ac-update.sh v0.55.2。設計は Sales Anchor docs/handoff/conversation-consent/design.md §14-14-18`
- README は変えない。

## G4 試験（tests/unit/case-sandbox.test.ts）
`describe("rewriteCaseClaudeJson")`（:651-710）:
- :653-660 に `let R: string;` を足し、`beforeEach` で `R = path.join(tmp, "r"); mkdirSync(R);` を足す（tmp は :47 で realpath 済み）。
- 既存の呼び出し 8 か所（:664・:675・:682・:685・:688・:694・:703・:708）に第3引数 `R` を足す。
- :667 の期待の `projects` を `{ [W]: { hasTrustDialogAccepted: true }, [R]: { hasTrustDialogAccepted: true } }` にする（K65・K67。前のファイルの `/x` は残らない）。
- :704 の期待を `expect(Object.keys(read(CH).projects as object).sort()).toEqual([W, R].sort())` にする。
- :677・:683・:686・:689 の鍵の一覧の期待は変えない（`projects` は 1 つの鍵）。
- :708 は R が有り CH が無い形のまま投げる（変えるのは引数だけ）。

新しい試験（同じ describe の中に足す）:
- K65: 空の CH で `rewriteCaseClaudeJson(CH, W, R)` → `projects` の鍵が `[W, R]`（sort して比べる）の 2 つちょうど・値はどちらも `{ hasTrustDialogAccepted: true }`。
- K66: `rewriteCaseClaudeJson(CH, W, W)` → `projects` の鍵は `[W]` の 1 つ。
- K72a: `const parent = path.join(tmp, "repo"); mkdirSync(path.join(parent, ".git"), { recursive: true }); const R2 = path.join(parent, "r"); mkdirSync(R2);` → 前に `.claude.json` へ `{"userID":"keep"}` を書いておき、`rewriteCaseClaudeJson(CH, W, R2)` が `CaseSandboxUnavailableError`（文に `inside a git repository`）を投げ、`.claude.json` の中身が `{"userID":"keep"}` のまま。
- K72b: `writeFileSync(path.join(R, ".git"), "gitdir: /x\n")` の後、同じく投げ、`.claude.json` が前の中身のまま。
- K74a: `const link = path.join(tmp, "rlink"); symlinkSync(R, link);` → `rewriteCaseClaudeJson(CH, W, link)` が投げる（文に `not a real path`）・`.claude.json` が前の中身のまま。
- K74b: `rewriteCaseClaudeJson(CH, W, path.join(tmp, "no-such-r"))` が投げる（文に `not a real path`）・`.claude.json` が前の中身のまま。

## G5 試験（tests/unit/sessions.case.test.ts）
- :172-175（件を開く試験）に足す（K68）: `const report = vars[2];` として、`expect(report).toBe(path.join(x.tmpRoot, "CC報告ファイル", "discord-case", s.id))` と `expect(Object.keys(claudeJson.projects).sort()).toEqual([W, report].sort())` と `expect(claudeJson.projects[report]).toEqual({ hasTrustDialogAccepted: true })`。（`vars` は :156 で読んだ起動の環境。3 つ目が `AC_CASE_REPORT`。:160 と同じ並び）
- :426 からの試験（K73）に足す:
  - :442（つなぎ直しの後）は今の期待のまま（前の中身 `{ mcpServers: … }` のまま＝R の鍵も足されない）。
  - :450-452（起動し直した後）に `const R = path.join(x.tmpRoot, "CC報告ファイル", "discord-case", s.id);` と `expect((rewritten.projects as Record<string, unknown>)[R]).toEqual({ hasTrustDialogAccepted: true });` を足す。
- ほかの試験は変えずに通ること。

## 触らない
- server/case-sandbox.ts の G1 以外（`casePaths`・`buildCaseSettings`・`writeCaseFiles`・`writeCaseRoom`・`writeCaseKeybindings`・`CASE_DENY_*`・`CASE_ALLOW_*`・`KEEP_CLAUDE_JSON_KEYS`・`writeAtomicSync`・`realOr`）。
- server/sessions.ts の G2 以外（`checkCaseSandbox` :552-637・`openTerminal`・`createCase`・`removeCaseRequest`・つなぎ直しの判定）。
- ops/shell/ccdiscord.zsh（起動の引数）・room.sb・case.json の形・hooks・case-guard・agent-console.config.json（`caseSayClaudeVersions` に 2.1.327 を足さない）。
- server/case-say-probe.ts・server/case-say-probe-wiring.ts・server/case-say-versions.ts・server/hub.ts（`PROBE_` の定数・E1〜E4・P0〜P5・R1・24 時間と 3 回の規則・版の記録・鍵・MAC）。
- tests/e2e・README・ほかのファイル。

## 確かめ
- `npm ci`・`npm run typecheck`（origin/main 6aaba26 で先に数え、増やさない。両方の数を書く）・`npm run lint`・`npx vitest run tests/unit/case-sandbox.test.ts tests/unit/sessions.case.test.ts`（結果の数を書く。sessions.case は tmux が要る。tmux が無くて回せない試験があれば、その数と理由を書き、GitHub の CI に任せる）。
- 全部の試験は GitHub の CI で見る。クラウドで `npm test` を回せたら結果を書く。

## 提出
- `git fetch origin` → `git switch release/case-probe-adddir-trust` → `git log -1 --format=%H` が本カードの commit であることを確かめる。
- commit の文の終わりに `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。一時ファイル・秘密・ホームの絶対パスを入れない。
- `git push origin release/case-probe-adddir-trust`（force・rebase・reset 禁止）。PR は作らない。マージはしない。

## 最後の返事
1行目は `DONE <新しい HEAD の40桁>`／`BLOCKED: <理由>`／`NEEDS_DECISION: <問い>` のどれか。2行目から: 変えた file:line、G2 の確かめを `typeof` と `=== undefined` のどちらにしたか、typecheck の数（前後）、lint の結果、vitest の結果、push の結果1行、`git diff --stat <本カードの commit>..HEAD`。

END OF CARD
