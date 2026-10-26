# 便2b-2 囲いの外で git を動かす前に「git の繋がり」と「本店の繋がり」を確かめ、作業場所の作成の台本を道具の写しから動かす（v0.46.3）作る係への指示書

- 設計: `docs/handoff/discord-pdca/design.md` 第14版 §4-5「filter の道と git の繋がりの確かめ」（(b) 6条件・(b') 本店の繋がり・(c) 古い本店の台本を動かさない）・§2 K17・§8 便2b-2・§11・§15。ADR-1039（Sales Anchor・Accepted）
- 目的: ①件の worktree の `.git` ファイルや `commondir`・`gitdir` が書き換えられた作業場所では、差分の表示・PR の状態の git を動かさない。②本店の `.git/commondir`・`config.worktree` が仕込まれた本店では、作業場所の一覧・作成・台帳の照会の git と台本を動かさない。③作業場所の作成の台本（`scripts/new-worktree.sh`）を、古い本店の写しではなく道具の写し（`~/.salesanchor-tools`）から動かす。あわせて PR #78 の審査の LOW 3件と PR #79 の審査の M-1・L-1〜L-3（試験の弱さ）を直す
- この便に入れないもの: Sales Anchor の自動回収・disk-janitor・`new-worktree.sh`・起動設定（Sales Anchor 側の別のカード `docs/handoff/discord-pdca/bin2b2-sa-link-card.md`）、囲いの書ける場所の絞り（設計 §4-5 の (a')。便2b-3）、役割・起動関数・受け口の消化（便2b-3・2b-4）。正しい作業場所・正しい本店での結果は変わらない
- 入れる順番: Sales Anchor の PR が先にマージされ、道具の写しが取り直されてから、この版を入れる（設計 §4-5 (c)）。作る係は PR を作るところまで。入れるのは設計者
- 調べた実物（origin/main f4e14c8 = v0.46.2）:
  - `server/workplace.ts:22-35` の `resolveWorkplace`: :25 で `deps.config.salesanchorRoot` を本店にし、:26 で `listWorktreeEntries(root)`、:27 で `classifyCwd`、:28 で本店でも worktree でもなければ `SessionConflictError`（409）。:34 で `{ sessionId, dir: verdict.real, known }` を返す。一覧が失敗すれば例外のまま（500）
  - `server/resume-targets.ts:25-28` の `listWorktreeEntries`: `git -C root worktree list --porcelain`（上書き無し）。呼ぶ所は `server/workplace.ts:26`・`server/launch.ts:51,101`・`server/restore.ts:109`・`server/resume-targets.ts:89`
  - `server/worktree.ts:39-51` の `createWorktree(root, script, branch)`: :42 で `bash <root>/<script> <branch>` を `cwd: root` で動かし、失敗は `WorktreeError`。:47 で `git -C root worktree list --porcelain`。呼ぶ所は `server/sessions.ts:279` だけ（`createWorktree(this.config.salesanchorRoot, this.config.newWorktreeScript, branch)`）
  - `server/ledger.ts:111-119` の `lookupBranch(root, script, branch)`: `bash <root>/<script> <branch>` を `cwd: root` で動かし、失敗は `classifyLookupFailure` で `{ kind: "error" }` など。呼ぶ所は `server/ledger.ts:180`
  - `server/config.ts`: :132 `STRING_KEYS`（必須の文字列）、:135 `expandHome`、:183-187 `parseDataDir`（`undefined` なら既定、空でない文字列でなければ起動の誤り）、:286-300 返す形
  - `server/git-safe.ts`: `SAFE_GIT_CONFIG` と `safeGitArgs(dir, args)`
  - 試験の入口: `tests/unit/diff.integration.test.ts:229-245`（409 の試験。`h.sessions.restore({ …, cwd })`）、`tests/unit/pr.integration.test.ts:69-74`（`newPlace`）・:290-299（409）・:504-524（fsmonitor の試験）、`tests/unit/helpers/harness.ts:170-182`（`git init` した `root`、`scripts/slow-worktree.sh`、`salesanchorRoot: root`）、`tests/fixtures/e2e-env.ts:115-117`、`tests/unit/server-process.test.ts:55-56`、`tests/unit/config.test.ts:6-17`、`tests/unit/ledger.test.ts:64-98`（`makeRoot` は `git init` していない一時の場所）、`tests/unit/worktree.test.ts`、`tests/unit/server.integration.test.ts:277`（`WorktreeError` の試験）
  - 下調べの試験（git 2.39.3。台本 /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/a85af4bf-dc0b-4a6a-af02-abf376f27ef6/scratchpad/exp-link/run.sh、生出力 /tmp/CC報告ファイル/discord-pdca-bin2/53-exp-link/out.txt）と PR #79 の審査（/tmp/CC報告ファイル/discord-pdca-bin2/56-review79/review-out.txt の T1）: worktree の `commondir`、または本店の `.git/commondir` を filter の定義入りの偽の置き場に向けると、本番と同じ上書きと差分の引数でも印ができる

## 決めたこと
- `server/git-safe.ts` に2つ足す。どちらも問題なければ `null`、落ちたら理由の短い英語（例 `"main commondir present"`）を返す。例外は投げない（読めない・無いは「落ちた」。ただし「無いことを確かめる」条件の ENOENT は合格）:
  - `export async function checkMainLink(mainRoot: string): Promise<string | null>`:
    1. `lstat(mainRoot/.git)` が本物のディレクトリ（シンボリックリンクでない）
    2. `lstat(mainRoot/.git/commondir)` が ENOENT
    3. `lstat(mainRoot/.git/config.worktree)` が ENOENT
  - `export async function checkGitLink(dir: string, mainRoot: string): Promise<string | null>`。まず `checkMainLink(mainRoot)` を呼び、落ちたらその理由を返す。P = `dir`、C = `realpath(mainRoot/.git)`:
    1. `realpath(dir) === realpath(mainRoot)` なら、`lstat(dir/.git)` が本物のディレクトリで実パスが C なら `null`
    2. それ以外は worktree として: `lstat(dir/.git)` が本物のファイル（シンボリックリンクでない）。中身の末尾の改行を1つ除いたものが `gitdir: <G>` の1行（中に改行が無い）。G が相対なら `dir` を起点に解く。`path.dirname(realpath(G)) === path.join(C, "worktrees")`
    3. `realpath(G)/commondir` の中身（末尾の改行を1つ除く。相対なら `realpath(G)` を起点）の実パスが C
    4. `realpath(G)/gitdir` の中身（同じ扱い）の実パスが `realpath(dir/.git)`
    5. `realpath(G)/config` と `realpath(G)/config.worktree` が無い（`lstat` が ENOENT）
- 呼ぶ所（どれも git・台本を動かす**前**）:
  - `server/workplace.ts`: :28 の後（`verdict.real` が決まった後、`known` を作る前）で `checkGitLink(verdict.real, root)`。`null` でなければ `SessionConflictError(\`git link check failed: ${reason}\`)`（409）。hub の見回りが黙って飛ばすことは今のまま
  - `server/resume-targets.ts` の `listWorktreeEntries`: git の前で `checkMainLink(root)`。`null` でなければ `throw new Error(\`main link check failed: ${reason}\`)`（今の「一覧の失敗は例外」と同じ扱い。呼ぶ側は変えない）
  - `server/worktree.ts` の `createWorktree`: `isValidBranch` の後、台本の前で `checkMainLink(root)`。`null` でなければ `WorktreeError(\`main link check failed: ${reason}\`)`
  - `server/ledger.ts` の `lookupBranch`: 台本の前で `checkMainLink(root)`。`null` でなければ `{ kind: "error", message: \`main link check failed: ${reason}\` }` を返す
- 作業場所の作成の台本を道具の写しから動かす:
  - `server/config.ts`: 任意の設定 `salesanchorToolsRoot` を足す。`parseDataDir` と同じ形の関数 `parseToolsRoot`（`undefined` なら `expandHome("~/.salesanchor-tools")`、空でない文字列でなければ `config: salesanchorToolsRoot must be a non-empty string` で起動の誤り、文字列なら `expandHome`）。型（:64 付近）と返す形（:286-300）に足す。`STRING_KEYS` には入れない（任意のため）
  - `server/worktree.ts`: `createWorktree(root: string, scriptRoot: string, script: string, branch: string)` にする。台本は `path.join(scriptRoot, script)`。`cwd` は今のまま `root`（作業の場所は本店）。台本を動かす前に `stat(path.join(scriptRoot, script))` が普通のファイルであることを確かめ、でなければ `WorktreeError(\`new-worktree script missing: ${path.join(scriptRoot, script)}\`)`。台本の後の :47 の `git -C root worktree list --porcelain` は、`listWorktreeEntries(root)`（中で `checkMainLink` を通る）に置き換える（確かめと使う時のすき間を小さくする。PR #79 の再審査 L-7）。失敗は今と同じく `WorktreeError` にする（`listWorktreeEntries` の例外の文を `WorktreeError` の文に入れる）。返す場所の探し方（一覧から branch が一致する行の path）は変えない。この置き換えで `worktree.ts` → `resume-targets.ts` → `sessions.ts` → `worktree.ts` の import の輪ができ、`worktree.test.ts` が `sessions.ts`（node-pty）まで読み込むようになり、`resume-targets.ts` の 10秒の時間切れ（`GIT_TIMEOUT_MS`）が新しく付く。使う所がどれも関数の中なので動きに害は無いとして、この3つを受け入れる（「ほかの振る舞いは変えない」の例外。PR 本文に書く。PR #79 の3回目の審査 N-4）
  - `server/sessions.ts:279`: `createWorktree(this.config.salesanchorRoot, this.config.salesanchorToolsRoot, this.config.newWorktreeScript, branch)`
  - 台帳の照会の台本（`ledgerLookupScript`）は今のまま本店から動かす（この便では動かす場所を変えない。中は `rev-parse` だけ。設計 §4-5 (b') の確かめで守る）
- ファイルの先頭の説明に1行ずつ足す（`server/git-safe.ts`: 囲いの外で git を動かす前に繋がりを確かめる。設計 §4-5。`server/worktree.ts`: 台本は道具の写しから動かす。設計 §4-5 (c)）

## 守ること
- 下に書いた変更だけ。ほかの振る舞い・文・既存の試験の期待は変えない（下の「試験」で書き換えると書いたものを除く）
- `tests/unit/helpers/harness.ts`・`tests/fixtures/e2e-env.ts`・`tests/unit/server-process.test.ts` は、設定に `salesanchorToolsRoot: root`（その試験の本店と同じ場所）を1行足すことだけ許す。`tests/unit/helpers/ac-env.ts` は変えない
- 作り物のリポジトリ・偽の置き場・印は `os.tmpdir()` の下に作り、試験の終わりに消す
- 実装の前に確かめる（生出力を保存）: `grep -rn "listChanges\|readFileDiff\|resolveTarget\|createWorktree\|lookupBranch\|listWorktreeEntries" server/`。`server/diff.ts`・`server/pr-status.ts` が git を向ける `dir` が、どれも同じ要求の中の `resolveWorkplace` の `dir` から来ていること、`createWorktree`・`lookupBranch`・`listWorktreeEntries` の呼ぶ所が上の「調べた実物」と同じであること。違う呼び口があれば作らずに止まって報告する

## 変更
1. `server/git-safe.ts`: `checkMainLink`・`checkGitLink` を足す
2. `server/workplace.ts`: import と :28 の後の確かめ
3. `server/resume-targets.ts`: `listWorktreeEntries` の確かめ
4. `server/worktree.ts`: 確かめ・`scriptRoot`・台本の有無の確かめ
5. `server/ledger.ts`: `lookupBranch` の確かめ
6. `server/config.ts`: `salesanchorToolsRoot`
7. `server/sessions.ts:279`: 呼び方
8. 設定の見本や設定の表があれば `salesanchorToolsRoot` を書き足す。探し方は `git grep -ln newWorktreeScript -- '*.json' '*.md' ':!docs/handoff'`（`config.example.json` はリポジトリに無い。PR #79 の再審査 L-6）。見つかった README の設定の表などに1行
9. 版を 0.46.3 に（`package.json`・`package-lock.json` の2か所・`extension/manifest.json`）。`docs/CHANGELOG.md` に1行（作業場所の git の繋がり・本店の繋がりが合わないときは git と台本を動かさない・作業場所の作成の台本を道具の写しから動かす（新しい任意の設定 `salesanchorToolsRoot`）・試験の直し・入れる前に Sales Anchor の対応の PR と道具の写しの取り直しが要る・戻し方 `bash scripts/ac-update.sh v0.46.2`）

## 試験
変える1行を決めるときは、**同じ長さの書き換え**にする（例: 中身 `1\n` の追跡しているファイルを `2\n` にする）。git の stat の情報だけで「変わっていない」と決められて filter が呼ばれない形を避けるため（PR #79 の審査 M-1）。
- `tests/unit/git-safe.test.ts` に足す（`os.tmpdir()` の下に `git init` した本店と `git worktree add` した worktree）。それぞれ1つの it:
  - `checkMainLink`: 正しい本店は `null`。`.git` がシンボリックリンク → 落ちる。`.git/commondir` がある → 落ちる。`.git/config.worktree` がある → 落ちる。`.git` が無い → 落ちる（例外を投げない）
  - `checkGitLink`: 本店そのものと正しい worktree は `null`。detached の worktree（`git worktree add --detach`）も `null`。本店の `.git/commondir` がある → 落ちる（worktree に向けても）
  - worktree の `.git` がシンボリックリンク／ディレクトリ／2行ある／`gitdir:` で始まらない／無い → 落ちる
  - `.git` が本店の `.git/worktrees` の外の gitdir（中身を写した偽の置き場）を指す → 落ちる
  - `commondir` が偽の置き場を指す → 落ちる。`gitdir` が別の場所を指す → 落ちる。`G/config`・`G/config.worktree` がある → 落ちる
- `tests/unit/diff.integration.test.ts` に describe を1つ足す。本店はこのファイルの共通の `root`（:37-67 の `beforeAll` で作るもの）。**共通の `root` に新しい commit を足さない・`origin/main` を動かさない**（ほかの describe の基準がずれるため。PR #79 の再審査 M-3）。偽の置き場の作り方は3つの試験で共通の関数にする: `root/.git` の中身を写し `worktrees` を除いたもの。その `config` に `[filter "evil"]` と `clean = touch <印>; cat`、`info/attributes` に `*.txt filter=evil` を書く。この describe はファイルの末尾に置き、各 it は `try`/`finally` で、仕込んだ `commondir`・worktree・枝を必ず戻す:
  - 変える1行: 追跡している `a.txt`（:47 で `a1\na2\na3\n` を commit 済み）を使う。worktree では `a1\nA2\na3\n` に同じ長さで書き換える。本店では :58 の未 commit の書き換え（`a2`→`A2`。同じ長さ）が既にあるので、新しく変えない
  - 偽の置き場は、各 it の中で `worktree add` の**後**に作る（先に作ると写しにその枝の ref が入らず、worktree の HEAD が解けない。PR #79 の3回目の審査 N-3）
  - L-common: `git(root, "worktree", "add", "-q", "-b", "release/link-common", <dir>)`。`<dir>/a.txt` を上のとおり書き換える。worktree の `commondir` を偽の置き場の絶対パスに書き換える
    - 対照: その worktree で `git -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --merge-base origin/main --no-renames --no-ext-diff --no-textconv --ignore-submodules=all --numstat -z` を `execFileSync` で1回動かし、**印ができること**を `expect` で確かめてから印を消す
    - `h.sessions.restore({ …, cwd: <dir> })` のセッションで、`/api/sessions/<id>/diff` と `/diff/file?path=a.txt` が 409、本文に `git link check failed` を含み、印ができない
    - 試験の終わり（`finally`）に `commondir` を元に戻し、worktree を `git worktree remove --force` で消し、枝を `git branch -D` で消す
  - L-dotgit: 同じく worktree の `.git` ファイルを偽の gitdir（`root/.git/worktrees/<名>` の中身を写し、`commondir` を偽の置き場に向けたもの）に向ける。同じ2つの入口が 409、本文に `git link check failed`、印ができない（この回の対照は取らない。下調べで印ができなかったため）。枝は `release/link-dotgit`。試験の終わり（`finally`）に worktree の `.git` ファイルを元の中身に戻してから `git worktree remove --force` で消し、枝を `git branch -D` で消す（PR #79 の3回目の審査 N-2）
  - L-main: 本店の `root/.git/commondir` を偽の置き場の絶対パスにして（本店の `a.txt` は :58 の書き換えのまま）、本店そのものを `cwd` にしたセッションの `/api/sessions/<id>/diff` が 409 または 500 で、印ができない。対照: 同じ状態で本店で上の上書き付きの `git diff` を1回動かし**印ができること**を確かめてから印を消す。試験の終わり（`finally`）に `commondir` を消す（本店のファイルは変えていないので戻すものは無い）
- `tests/unit/worktree.test.ts` に足す（今のこのファイルには純粋な試験しか無く、`git init` した本店を作る関数が無い。このファイルの中に、`os.tmpdir()` の下で `git init -q -b main`・1回 commit した本店を作る小さな関数を作る。本店の場所は `diff.integration.test.ts` の冒頭と同じく `realpathSync(mkdtempSync(...))` にする（macOS の `/private` の食い違いで `pwd` の比べが落ちないように。PR #79 の3回目の審査 N-5）。PR #79 の再審査 L-10）:
  - `createWorktree(root, scriptRoot, script, branch)` が `scriptRoot` の台本を `cwd: root` で動かす（台本は `pwd` と `$0` を印のファイルに書き、`git -C "$PWD" worktree add` で worktree を作る。印の中身で cwd が `root`、`$0` が `scriptRoot` の下であることを確かめる）。`root/scripts/` に同じ名前の別の台本を置き、それが動かないこと（そちらの印ができない）
  - `scriptRoot` に台本が無い → `WorktreeError`（`new-worktree script missing`）、台本の印ができない
  - 本店の `.git/commondir` がある → `WorktreeError`（`main link check failed`）、台本の印ができない
- `tests/unit/resume-targets.test.ts` に1つ: 本店の `.git/commondir` がある → `listWorktreeEntries` が `main link check failed` で投げる
- `tests/unit/ledger.test.ts`: `makeRoot` で `mkdirSync(path.join(root, ".git"))` を足す（空の本物のディレクトリ。今の試験が確かめで落ちないため）。1つ足す: `root/.git/commondir` がある → `loadLedger` の結果で `release/a` が IN_PROGRESS に出ず、`errors` に `main link check failed` を含む行がある、台本の印（台本に `touch <印>` を入れる）ができない
- `tests/unit/config.test.ts` に1つ: `salesanchorToolsRoot` を書かないと `os.homedir()` の下の `.salesanchor-tools`、`"~/x"` なら展開、`""`・数値なら起動の誤り
- `tests/unit/pr.integration.test.ts`: :504-524 の試験を置き換える。`newPlace` で作った worktree の追跡しているファイルを同じ長さで変え、`commondir` を上と同じ偽の置き場に向け、`getPr`・`refreshPr` が 409、`calls()` が `[]`、印ができない。対照として、同じ worktree で上の上書き付きの `git diff` を動かすと印ができることを `expect` で確かめる（PR #79 の審査 L-1。409 と `calls()` だけに頼らない）。試験の終わりに戻す
- LOW の直し（`tests/unit/diff.integration.test.ts`）:
  - D-fsm: :360 の `console.warn` をやめ、`expect(controlFired).toBe(true)` にする
  - D-sub: D-fsm に頼らない。手順は次のとおり（PR #79 の審査 L-2）: ①`mkdtempSync` で新しいリポジトリ R を作り `git init -q -b main`、`f.txt`（`1\n`）を commit ②`git update-ref refs/remotes/origin/main HEAD` ③R の中に入れ子のリポジトリ `sub/`（`git init -q`、1回 commit）を作り、R で `git add sub` して commit ④`sub/.git/config` に `core.fsmonitor`（印を作る命令）を書く ⑤R の `f.txt` を `2\n` にし、`sub` の中にも未 commit の変更を作る ⑥`listChanges(R, "origin/main")` を直接呼び（今の D-fsm・D-sub と同じ呼び方。R は本店の外なので、セッションを通すと :28 の照合で 409 になる。PR #79 の再審査 M-2'）、一覧が `f.txt` だけで、印ができない。:377 の `--unset` の行は消す

## 完了の確認（生出力を /tmp/CC報告ファイル/discord-pdca-bin2/55-impl2b2/ に保存）
1. `npm run typecheck`  2. `npm run lint`  3. `npx vitest run tests/unit/git-safe.test.ts tests/unit/diff.integration.test.ts tests/unit/pr.integration.test.ts tests/unit/worktree.test.ts tests/unit/resume-targets.test.ts tests/unit/ledger.test.ts tests/unit/config.test.ts`  4. `npm test`
5. 見分ける力の確かめ（それぞれ一時的に外して 3 を走らせ、落ちることを確かめてから戻す。生出力も保存。戻した後の `git diff` で外した跡が無いこと）:
   - `server/workplace.ts` の `checkGitLink` の呼び出しを外す → L-common・L-dotgit・pr の置き換えの試験が落ちる
   - `checkGitLink` の中の `checkMainLink` の呼び出しを外す → L-main が落ちる（落ちない場合は、L-main が今の照合や一覧の確かめで止まっていると PR 本文に書き、`listWorktreeEntries` の確かめも外して落ちることを確かめる）
   - `createWorktree` の `scriptRoot` を `root` に戻す → worktree の台本の試験が落ちる
6. 1コミット（共著者行 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）、PR は `--base main`、本文に「この指示書のどこを満たしたか」「Evaluator は画面のファイル変更 0 のため省く」「入れる前に Sales Anchor の対応の PR のマージと道具の写しの取り直しが要る」を書く

## 想定分岐
- L-common・L-main の対照で印ができない（その git では偽の置き場の filter が読まれない）→ 試験を作らずに止まって、生出力の置き場を報告する（下調べと食い違うため）
- D-fsm の対照（上書きなしの `diff` と `status`）で印ができず `expect(controlFired).toBe(true)` が落ちる → 対照の作り（`f.txt` の書き換えが同じ長さか・`core.fsmonitor` の台本が実行できるか）を1回見直す。それでも出なければ、緩めずに止まって生出力を報告する
- 本店の確かめが落ちたとき、PR の見回り（`server/hub.ts:665-690`）は見回りのたびに誤りを1行出し、作業場所の一覧の失敗を握って空を返す所（`server/resume-targets.ts:63,93`・`server/restore.ts:121`・`server/launch.ts:101`）は理由なしの「worktree 無し」になる。どちらも git は動かないので、この便では変えない（PR #79 の再審査 L-8・L-9。PR 本文に「本店が仕込まれたときの表示の改善は別の便の候補」と書く）
- 偽の置き場に向けた worktree が `git worktree list` に載らず、確かめの前に今の照合（:28）で 409 になる → 409 になること自体は合格。ただし PR 本文に「今の照合で止まった」と書き、単体の試験で同じ形が落ちることを確かめる
- L-main で本店の `commondir` を仕込んだ後、`git worktree list` が別の一覧を返して照合の前に 500 以外の形になる → 印ができず、git を動かす入口が 2xx を返さないことを合格にし、出た応答コードを PR 本文に書く
- `realpath` が macOS の `/private` 付きと無しで食い違う → C と比べる側をどちらも `realpath` にそろえる（文字列の前後の手直しはしない）。それでも合わなければ止まって報告
- 既存の試験（本店そのもののセッション、`newPlace` の worktree、e2e）が確かめで落ちる → 確かめの条件を緩めずに止まって、どの条件で落ちたかを報告する（`ledger.test.ts` の `makeRoot` は上で直すと決めたもの）
- `.git/worktrees/<名>/config` が `git worktree add` で作られる版の git だった → 止まって報告（条件5の扱いを設計で決め直す）
- 設定の見本のファイルが無い・README に設定の表が無い → 足さずに PR 本文に「無かった」と書く
- CI の macOS で既存の不安定な試験が落ちる → 同じ試験が main でも落ちているかを `gh run list` で確かめ、PR 本文に書く
