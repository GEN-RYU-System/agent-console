# 便2b-3d 部屋の受入で落ちた3つを直す（v0.48.1）作る係への指示書

- 設計: `docs/handoff/discord-pdca/room-design.md` 第9.3版 §4-2a（1〜3 と受入のやり直し）。前の便 `bin2b3c-card.md`（v0.48.0・#89）
- 目的: ①case-home の中で本体が書く3つの名前（`.claude.json.lock`・`.claude.json.tmp.<pid>.<16進12桁>`・`history.jsonl`）を部屋で書けるようにする。②件の会話の番号（`claudeSessionId`）を、case-home の `sessions/<数字>.json` を部屋の外で読んで付ける（再開で前の会話に戻れるように）。③起動関数で `DISABLE_AUTOUPDATER=1` を渡す
- この便に入れないもの: ほかの部屋の規則・受付・起動の確かめ ⑧〜⑬・(B) の名前・`.claude.json` の書き直しの中身とその呼び所・ほかの役割の振る舞い・`claude agents --json` の呼び方（`server/agents.ts:117-125` は変えない）。本物の件を開く試験（設計者がマージのあとに行う）
- 入れる順番: 作る係は PR を作るところまで（Draft にしない。題は `fix: case room writes, case session id and auto-updater (v0.48.1)` の形）。審査・マージ・タグ・入れるのは設計者
- 迷ったら止まる: 下の「決めたこと」に無い分岐・行番号が合わない・テストが今の形で書けない、のどれかに当たったら、推測で埋めず、そこで止めて「何が・どこで（file:line）・何を試したか」を報告する。room.sb の正規表現の形を新しく書くとき・変えるときは、JS の試験だけで決めず、一時の置き場で `/usr/bin/sandbox-exec` に通して、通すべき名前が通り、断るべき名前が断られるかを確かめる（Seatbelt は JS と当たり方が違う。room-design §4-2a の 1）。確かめられなければ止める

## 調べた実物（行番号は origin/main ca414ad = v0.48.0）

- `server/case-sandbox.ts`: `casePaths` :52-66（`CH` :66）・`reesc` :230・`CASE_PROTECTED_WRITE` :235-240・`CH_RECORD_DIRS` :243・`CH_RECORD_FILES` :244・`chSettingNames` :246-249・`q` :260-263・`rx` :266-269・`buildCaseRoomProfile` :288 から（順 2 の作成・削除の開け直し :316-318、順 3 の書き込みの許可 :326、順 3 の拒否 :328、順 4 :332-338）・`rewriteCaseClaudeJson` :394
- `server/hub.ts`: `detectBreaks` :569-584（取得失敗で戻る :570、子孫の pid :574、`setClaudeSessionId` :577）・定期の取得 :149・`onPollError` :164-171（agents の失敗で `this.agents = null`）
- `claudeSessionId` を鍵に使う所（取り違えの塞ぎの理由。変えない）: `server/http.ts:511-517`（呼び出し元の照合）・`:378-386`（画面の承認）・`server/held-merge.ts:29`（保存の一覧の合わせ）
- `server/sessions.ts`: `casePaths` を呼ぶ所 :353・:436・:471（`this.caseHomeDir`・`this.config.dataDir`・`this.caseTmpRoot`）・`caseMainProcesses` :270-272・`restore` :540-551・`setClaudeSessionId` :554-559・新しい tmux の起動のときだけ `beforeNew` を呼ぶ :676-700
- `server/process-tree.ts`: `descendantPids` :40・`readProcessTable` :62
- `ops/shell/ccdiscord.zsh`: `CLAUDE_CONFIG_DIR` :61・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` :62・`exec` :74
- テスト: `tests/unit/case-sandbox.test.ts`（case-home の書ける名前 :420-431・:465-481）・`tests/unit/ccdiscord-zsh.test.ts`（環境の値 :190-215。`/^(CLAUDE|ANTHROPIC)/` で数える :206-207 には `DISABLE_AUTOUPDATER` は入らない）・`tests/unit/sessions.case.test.ts`

## 決めたこと

### A. 部屋の書き込み（`server/case-sandbox.ts`）

- `CH_RECORD_FILES`（:244）に `history.jsonl` を足す（(A)。`[".last-cleanup", ".claude.json", "history.jsonl"]`）
- 新しい定数 `CH_CLAUDE_JSON_COMPANIONS = [".claude.json.lock"]`（(C) の仲間の literal）と、関数 `chClaudeJsonTmp = (CH: string): string => \`^${reesc(CH)}/\\.claude\\.json\\.tmp\\.[0-9]+\\.${"[0-9a-f]".repeat(12)}$\``（正規表現 1つ）を :244 の下に置く。Seatbelt の正規表現は回数の `{12}` を受けない（`{12}` では正しい名前も拒否される。room-design §4-2a の 1）ので、`[0-9a-f]` を12回並べた形にする。`{n}` の形はどこにも使わない
- 順 2 の作成・削除の開け直し（:318 の塊）と、順 3 の書き込みの許可（:326 の塊）の両方に、`CH_CLAUDE_JSON_COMPANIONS` の literal（`path.join(CH, n)` を `q` で）と `rx(chClaudeJsonTmp(CH))` を足す。`history.jsonl` は `CH_RECORD_FILES` に入るので、今の `chRecordLit` で両方に入る
- 順 3 の拒否（:328）と順 4（:332-338）は変えない
- テスト（`case-sandbox.test.ts` の :420-431・:465-481 の並びに足す）:
  - 出力の順 2 の開け直しと順 3 の許可の両方に、`<CH>/history.jsonl` と `<CH>/.claude.json.lock` の literal と、上の正規表現の `(regex #"…")` があること
  - その正規表現が `.claude.json.tmp.20273.0c36f211e77d` に当たり、`.claude.json.tmp.20273.0c36f211e77` （11桁）・`.claude.json.tmp.x.0c36f211e77d`・`.claude.json.tmp.20273.0c36f211e77d/x`・`.claude.json.evil`・`.claude.json.backup.1`・`backups/.claude.json.tmp.1.0c36f211e77d` に当たらないこと（JS の `new RegExp` で確かめる）
  - 注記: Seatbelt の正規表現は大文字と小文字を区別しない（大文字の16進や `.CLAUDE.JSON.TMP…` も通る。150 の seatbelt-regex-test2.txt）。JS の試験は区別する。大文字の形が部屋で断られることを試験で求めない（塞ぎの正規表現は後に来る拒否なので崩れない）
  - `buildCaseRoomProfile` の出力の `(regex #"…")` のどれにも `{` が無いこと（JS では当たっても Seatbelt では当たらない形を止めるため）
  - `backup` を含む literal・`subpath "<CH>"`（根の丸ごと）が許可に入らないこと（今のテストがあればそのまま通る）

### B. 会話の番号の拾い方（新しい `server/case-agents.ts`・`server/hub.ts`・`server/sessions.ts`）

- `server/case-agents.ts` に純粋に近い同期の関数を1つ置く: `readCaseClaudeSessionId(caseHome: string, pids: ReadonlySet<number>): string | undefined`
  - まず `fs.lstatSync(path.join(caseHome, "sessions"))` で本当のディレクトリ（`isDirectory()` が真。シンボリックリンクは偽になる）を確かめ、その `dev`・`ino` を控える。違えば undefined。読み終えたら `sessions` をもう一度 `lstat` し、本当のディレクトリで `dev`・`ino` が同じでなければ、読んだ物を捨てて undefined（途中でリンクにすり替えられたとき）
  - `fs.readdirSync` の名前のうち `/^[0-9]+\.json$/` に当たる物だけを見る（`.key` などほかの名前は開かない）。名前の数字が `pids` に無い物は開かない
  - 開く前に `fs.lstatSync` で普通のファイル（`isFile()` が真、シンボリックリンクでない）かつ大きさ 64KiB（`CASE_SESSION_FILE_MAX = 64 * 1024`）以下を確かめる。開くのは `fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)`（名前付きパイプにすり替えられても止まらないため）→ `fs.fstatSync` で、普通のファイル・`nlink === 1`・64KiB 以下をもう一度確かめる → `CASE_SESSION_FILE_MAX + 1` バイトの入れ物に `fs.readSync` で読み、読めた長さが上限を超えたら捨てる → `finally` で閉じる
  - JSON として読み、`pid` が数で名前の数字と同じ、かつ `pids` にあり、`sessionId` が文字列で UUID の形（`sessions.ts` の `isClaudeSessionId` と同じ判定を使う。正規表現を写さず import する。import できない形なら止めて報告）の物の `sessionId` を返す。ほかのキーは使わない
  - どの失敗（置き場が無い・読めない・壊れている）でも投げず、undefined。見つかった物が2つ以上で `sessionId` が違うときも undefined（どれかを選ばない）
- `server/sessions.ts` に `caseHomeOf(id: string): string | undefined` を足す。件の役割かは `this.config.roles.find((r) => r.id === session.roleId)?.caseSandbox === true` で見る（`findRole` は見つからないと投げるので使わない）。生きている件の役割のセッションのときだけ、今の `casePaths({ id, H: this.caseHomeDir, D: this.config.dataDir, tmpRoot: this.caseTmpRoot }).CH`（:436 と同じ式）を返す。ほかは undefined。道の組み立てをほかの所に書かない
- `server/hub.ts` の `detectBreaks`（:569）の最初（:570 の取得失敗で戻る行の前）で、件の番号を付ける:
  - 件のセッションが1つも無ければ何もしない（`readProcessTable` も呼ばない）
  - `this.agents === null`（直前の `claude agents --json` が失敗）なら何もしない（照合できないので付けない）
  - あれば `readProcessTable().catch(() => null)` を1回呼び（null なら何もしない）、件ごとに `readCaseClaudeSessionId(CH, descendantPids(s.term.pid, table))` の結果を得る。件のある回は、この表の取得が :571 とは別にもう1回走る（ps が2回）。件の無い回の動きは今と同じ
  - 照合の一覧: その件以外のセッション（`this.sessions.list()` の全部。止まった物も）の `claudeSessionId` と、`this.agents` の全部の行の `sessionId`
  - 今付いている番号の見直し（毎回。付けるより先）: 件に今付いている `claudeSessionId`（起動時の復元で保存の一覧から入った物も含む。`server/restore.ts:179` → `sessions.ts:626` は照合を通らないため）が照合の一覧にあれば、`clearCaseClaudeSessionId(s.id)` で外す
  - 付ける: 結果が照合の一覧に無ければ `this.sessions.setClaudeSessionId(s.id, 結果)`。あれば付けない。毎回同じ照合をするので、前の回の `claude agents --json` のあとに始まったセッションの番号を一度付けても、次の回で外れる
  - 件の処理の全体を try/catch で包み、例外は `console.error` に1行出して捨てる（外へ出すと `onPollError` で `this.agents = null` になり、全部のセッションの状態が不明になるため）
  - :574-577 の今の付け方はそのまま（件の本体は `claude agents --json` に出ないので、件については何も起きない）。ただし :577 では件のセッションには `setClaudeSessionId` を呼ばない（件の番号は上の件の処理だけが付ける。件が将来 `claude agents --json` に出ても、外して付け直す揺れにならない）。:577 の行の直後で、件でないセッションの行に `sessionId` があるときは、値が変わったかどうかに関わらず毎回、同じ番号を持つ件のセッションを（`this.sessions.list()` の全部を回し、止まった物も含めて。件かどうかの見分けは `clearCaseClaudeSessionId` の中で行い、`caseHomeOf` では絞らない）探し、あればその件の番号を外す（`setClaudeSessionId` は値が同じだと何もしないので、その中には入れない）。外すのは `server/sessions.ts` に足す `clearCaseClaudeSessionId(id: string): void`（件の役割のセッションのときだけ `claudeSessionId` を消して `this.notify()`。止まった件にも同じに掛ける。`claudeSessionId` が元から無ければ何もしない（`notify` もしない）。ほかの役割では何もしない）。通知・状態の判定は変えない
- テスト（新しい `tests/unit/case-agents.test.ts`。一時の置き場に case-home を作る）:
  - `sessions/<pid>.json`（pid が pids にある・sessionId が UUID）→ その sessionId
  - pid が pids に無い → undefined／名前の数字とファイルの中の `pid` が違う → undefined
  - シンボリックリンクの `<pid>.json`（中身が正しい物を指す）→ undefined／`sessions` そのものが正しい置き場へのシンボリックリンク → undefined
  - `<pid>.json` が名前付きパイプ（`mkfifo`）→ すぐ undefined が返る（止まらない）／固いリンク（`nlink` が2）→ undefined
  - 64KiB を超える → undefined／JSON でない → undefined／sessionId が UUID の形でない → undefined
  - `<pid>.<16進>.key` だけがある → undefined（開かないことは、中身を壊れた JSON にしても例外が出ないことで確かめる）
  - `sessions/` が無い → undefined
  - 2つの正しいファイルで sessionId が違う → undefined
- テスト（hub か sessions の今の試験の下支えで書ける所）: 件のセッションに対し、case-home の `sessions/<子孫の pid>.json` を置くと `claudeSessionId` が付く。件でないセッションの case-home の道は `caseHomeOf` が undefined。ほかのセッションの `claudeSessionId` か `claude agents --json` の行と同じ番号のときは付かない。`claude agents --json` が失敗している間は付かない。件に付いた番号を、後から件でないセッションが正しく知ると、件から外れる。保存の一覧から復元した件の番号がほかのセッションか `claude agents --json` の行と同じなら、次の回で外れる。`claude agents --json` の行にだけある（agent-console の外で動く）セッションと同じ番号が件に付いていたら、次の回で外れる。件の行が `claude agents --json` に出ても、:577 では件に付けず、件の番号が回ごとに変わらない。`clearCaseClaudeSessionId` は番号が無い件では `notify` しない。`readCaseClaudeSessionId` が投げるように差し替えても、件でないセッションの状態が不明にならない。書けない形なら、`case-agents.test.ts` と `caseHomeOf` の単体のテストだけにして、そのことを PR 本文に書く

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
