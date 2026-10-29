# 便2b-3d 部屋の受入で落ちた3つを直す（v0.48.1）作る係への指示書

- 設計: `docs/handoff/discord-pdca/room-design.md` 第9版 §4-2a（1〜3 と受入のやり直し）。前の便 `bin2b3c-card.md`（v0.48.0・#89）
- 目的: ①case-home の中で本体が書く3つの名前（`.claude.json.lock`・`.claude.json.tmp.<pid>.<16進12桁>`・`history.jsonl`）を部屋で書けるようにする。②件の会話の番号（`claudeSessionId`）を、case-home の `sessions/<数字>.json` を部屋の外で読んで付ける（再開で前の会話に戻れるように）。③起動関数で `DISABLE_AUTOUPDATER=1` を渡す
- この便に入れないもの: ほかの部屋の規則・受付・起動の確かめ ⑧〜⑬・(B) の名前・`.claude.json` の書き直しの中身とその呼び所・ほかの役割の振る舞い・`claude agents --json` の呼び方（`server/agents.ts:117-125` は変えない）。本物の件を開く試験（設計者がマージのあとに行う）
- 入れる順番: 作る係は PR を作るところまで（Draft にしない。題は `fix: case room writes, case session id and auto-updater (v0.48.1)` の形）。審査・マージ・タグ・入れるのは設計者
- 迷ったら止まる: 下の「決めたこと」に無い分岐・行番号が合わない・テストが今の形で書けない、のどれかに当たったら、推測で埋めず、そこで止めて「何が・どこで（file:line）・何を試したか」を報告する

## 調べた実物（行番号は origin/main ca414ad = v0.48.0）

- `server/case-sandbox.ts`: `casePaths` :52-66（`CH` :66）・`reesc` :230・`CASE_PROTECTED_WRITE` :235-240・`CH_RECORD_DIRS` :243・`CH_RECORD_FILES` :244・`chSettingNames` :246-249・`q` :260-263・`rx` :266-269・`buildCaseRoomProfile` :287 から（順 2 の作成・削除の開け直し :316-318、順 3 の書き込みの許可 :326、順 3 の拒否 :328、順 4 :332-338）・`rewriteCaseClaudeJson` :394
- `server/hub.ts`: `detectBreaks` :568-584（取得失敗で戻る :569、子孫の pid :574、`setClaudeSessionId` :577）・定期の取得 :149
- `server/sessions.ts`: `casePaths` を呼ぶ所 :353・:436・:471（`this.caseHomeDir`・`this.config.dataDir`・`this.caseTmpRoot`）・`caseMainProcesses` :270-272・`restore` :540-551・`setClaudeSessionId` :554-559・新しい tmux の起動のときだけ `beforeNew` を呼ぶ :676-700
- `server/process-tree.ts`: `descendantPids` :40・`readProcessTable` :62
- `ops/shell/ccdiscord.zsh`: `CLAUDE_CONFIG_DIR` :61・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` :62・`exec` :74
- テスト: `tests/unit/case-sandbox.test.ts`（case-home の書ける名前 :420-431・:465-481）・`tests/unit/ccdiscord-zsh.test.ts`（環境の値 :190-215。`/^(CLAUDE|ANTHROPIC)/` で数える :206-207 には `DISABLE_AUTOUPDATER` は入らない）・`tests/unit/sessions.case.test.ts`

## 決めたこと

### A. 部屋の書き込み（`server/case-sandbox.ts`）

- `CH_RECORD_FILES`（:244）に `history.jsonl` を足す（(A)。`[".last-cleanup", ".claude.json", "history.jsonl"]`）
- 新しい定数 `CH_CLAUDE_JSON_COMPANIONS = [".claude.json.lock"]`（(C) の仲間の literal）と、関数 `chClaudeJsonTmp = (CH: string): string => \`^${reesc(CH)}/\\.claude\\.json\\.tmp\\.[0-9]+\\.[0-9a-f]{12}$\``（正規表現 1つ）を :244 の下に置く
- 順 2 の作成・削除の開け直し（:318 の塊）と、順 3 の書き込みの許可（:326 の塊）の両方に、`CH_CLAUDE_JSON_COMPANIONS` の literal（`path.join(CH, n)` を `q` で）と `rx(chClaudeJsonTmp(CH))` を足す。`history.jsonl` は `CH_RECORD_FILES` に入るので、今の `chRecordLit` で両方に入る
- 順 3 の拒否（:328）と順 4（:332-338）は変えない
- テスト（`case-sandbox.test.ts` の :420-431・:465-481 の並びに足す）:
  - 出力の順 2 の開け直しと順 3 の許可の両方に、`<CH>/history.jsonl` と `<CH>/.claude.json.lock` の literal と、上の正規表現の `(regex #"…")` があること
  - その正規表現が `.claude.json.tmp.20273.0c36f211e77d` に当たり、`.claude.json.tmp.20273.0c36f211e77` （11桁）・`.claude.json.tmp.x.0c36f211e77d`・`.claude.json.tmp.20273.0c36f211e77d/x`・`.claude.json.evil`・`.claude.json.backup.1`・`backups/.claude.json.tmp.1.0c36f211e77d` に当たらないこと（JS の `new RegExp` で確かめる）
  - `backup` を含む literal・`subpath "<CH>"`（根の丸ごと）が許可に入らないこと（今のテストがあればそのまま通る）

### B. 会話の番号の拾い方（新しい `server/case-agents.ts`・`server/hub.ts`・`server/sessions.ts`）

- `server/case-agents.ts` に純粋に近い同期の関数を1つ置く: `readCaseClaudeSessionId(caseHome: string, pids: ReadonlySet<number>): string | undefined`
  - `fs.readdirSync(path.join(caseHome, "sessions"))` の名前のうち `/^[0-9]+\.json$/` に当たる物だけを見る（`.key` などほかの名前は開かない）。名前の数字が `pids` に無い物は開かない
  - 開く前に `fs.lstatSync` で普通のファイル（`isFile()` が真、シンボリックリンクでない）かつ大きさ 64KiB（`CASE_SESSION_FILE_MAX = 64 * 1024`）以下を確かめる。開くのは `fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)` → `fs.fstatSync` で同じ確かめをもう一度 → 読む → 閉じる
  - JSON として読み、`pid` が数で名前の数字と同じ、かつ `pids` にあり、`sessionId` が文字列で UUID の形（`sessions.ts` の `isClaudeSessionId` と同じ判定を使う。正規表現を写さず import する。import できない形なら止めて報告）の物の `sessionId` を返す。ほかのキーは使わない
  - どの失敗（置き場が無い・読めない・壊れている）でも投げず、undefined。見つかった物が2つ以上で `sessionId` が違うときも undefined（どれかを選ばない）
- `server/sessions.ts` に `caseHomeOf(id: string): string | undefined` を足す。生きている件の役割（`caseSandbox: true`）のセッションのときだけ、今の `casePaths({ id, H: this.caseHomeDir, D: this.config.dataDir, tmpRoot: this.caseTmpRoot }).CH`（:436 と同じ式）を返す。ほかは undefined。道の組み立てをほかの所に書かない
- `server/hub.ts` の `detectBreaks`（:568）の最初（:569 の取得失敗で戻る行の前）で、件の番号を付ける:
  - 件のセッションが1つも無ければ何もしない（`readProcessTable` も呼ばない）
  - あれば `readProcessTable().catch(() => null)` を1回呼び（null なら何もしない）、件ごとに `readCaseClaudeSessionId(CH, descendantPids(s.term.pid, table))` の結果が undefined でなければ `this.sessions.setClaudeSessionId(s.id, 結果)`
  - :574-577 の今の付け方はそのまま（件の本体は `claude agents --json` に出ないので、件については何も起きない）。通知・状態の判定は変えない
- テスト（新しい `tests/unit/case-agents.test.ts`。一時の置き場に case-home を作る）:
  - `sessions/<pid>.json`（pid が pids にある・sessionId が UUID）→ その sessionId
  - pid が pids に無い → undefined／名前の数字とファイルの中の `pid` が違う → undefined
  - シンボリックリンクの `<pid>.json`（中身が正しい物を指す）→ undefined
  - 64KiB を超える → undefined／JSON でない → undefined／sessionId が UUID の形でない → undefined
  - `<pid>.<16進>.key` だけがある → undefined（開かないことは、中身を壊れた JSON にしても例外が出ないことで確かめる）
  - `sessions/` が無い → undefined
  - 2つの正しいファイルで sessionId が違う → undefined
- テスト（hub か sessions の今の試験の下支えで書ける所）: 件のセッションに対し、case-home の `sessions/<子孫の pid>.json` を置くと `claudeSessionId` が付く。件でないセッションの case-home の道は `caseHomeOf` が undefined。書けない形なら、`case-agents.test.ts` と `caseHomeOf` の単体のテストだけにして、そのことを PR 本文に書く

### C. 起動関数（`ops/shell/ccdiscord.zsh`）

- :62 の次の行に `export DISABLE_AUTOUPDATER=1` を足す（説明の書き添えは :60 の今の1行に「更新の確かめも止める」を足す形でよい）
- テスト（`ccdiscord-zsh.test.ts`）: :190 の試験の中で `e.DISABLE_AUTOUPDATER` が `"1"` であること。:207 の並びは変えない

### D. 版と記録

- `package.json` の version を 0.48.1。`package-lock.json` の版の2か所と、版を持つ manifest（v0.48.0 の PR #89 で版を上げたファイルと同じ所）をそろえる
- `docs/CHANGELOG.md` の 0.48.0 の行の上に1行: 「0.48.1 部屋の受入で落ちた3つを直した（case-home の `.claude.json.lock`・`.claude.json.tmp.<pid>.<16進12桁>`・`history.jsonl` を書けるようにした・件の会話の番号を case-home の `sessions/<pid>.json` から付ける・起動関数で `DISABLE_AUTOUPDATER=1`）。戻し方 `bash scripts/ac-update.sh v0.48.0`」

## 確かめ（作る係が PR の前に行う）

- `npm test`（vitest 全部）・`npm run lint`・型の確かめ（今の CI と同じ命令）が通る
- `git diff origin/main --stat` が、上に挙げたファイルだけ
- 公開のリポジトリなので、家の道・利用者の名前・秘密を書かない（道は `<…>` に伏せる）
