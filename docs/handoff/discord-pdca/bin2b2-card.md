# 便2b-2 囲いの外で git を動かす前に「git の繋がり」を確かめる（v0.46.3）作る係への指示書

- 設計: `docs/handoff/discord-pdca/design.md` 第14版 §4-5「filter の道と git の繋がりの確かめ」・§2 K17・§8 便2b-2・§15。ADR-1039（Sales Anchor・Accepted）
- 目的: 件の worktree の `.git` ファイルや `commondir`・`gitdir` が書き換えられ、git が偽の設定（filter の命令入り）を読む作業場所では、常駐サーバーが差分の表示・PR の状態の git を動かさない。あわせて PR #78 の審査の LOW 3件（試験の弱さ）を直す
- この便に入れないもの: Sales Anchor の自動回収・disk-janitor（Sales Anchor 側の別のカード）、役割・起動関数・受け口の消化（便2b-3・2b-4）。正しい作業場所での差分の表示・PR の状態の結果は変わらない
- 調べた実物（origin/main f4e14c8 = v0.46.2）:
  - `server/workplace.ts:22-35` の `resolveWorkplace`: :25 で `deps.config.salesanchorRoot` を本店にし、:26-27 で `git worktree list` と `classifyCwd` に照合、:28 で本店でも worktree でもなければ `SessionConflictError`（409）にして git を動かさない。:34 で `{ sessionId, dir: verdict.real, known }` を返す
  - 呼ぶ所: `server/diff-routes.ts:31-37`（差分の一覧・1ファイルの差分・コメント）と `server/hub.ts:626`（PR の状態。`locatePr` → `resolveTarget(wp.dir)`）。`server/hub.ts:683` は定期の見回りで `SessionConflictError` を黙って飛ばす
  - 試験の入口: `tests/unit/diff.integration.test.ts:229-245`（409 の試験。`h.sessions.restore({ …, cwd })` で作業場所を決め、`/api/sessions/<id>/diff` などを叩く）、`tests/unit/pr.integration.test.ts:69-74`（`newPlace` が `git worktree add` で worktree を作る）・:290-299（409 の試験）
  - 試験の弱さ（PR #78 の審査の LOW）: `tests/unit/diff.integration.test.ts:360` の D-fsm は対照で印ができなくても `console.warn` だけで通る。:370-384 の D-sub は D-fsm の作ったリポジトリ・`f.txt`・`core.fsmonitor` の `--unset`（:377）に頼る。`tests/unit/pr.integration.test.ts:504-524` は `remote get-url`・`rev-parse` が fsmonitor を呼ばないので、上書きを外しても通る（見分ける力がない）
  - 下調べの試験（git 2.39.3。台本 /private/tmp/claude-501/-Users-tanizawashingo-salesanchor/a85af4bf-dc0b-4a6a-af02-abf376f27ef6/scratchpad/exp-link/run.sh、生出力 /tmp/CC報告ファイル/discord-pdca-bin2/53-exp-link/out.txt）: `.git/worktrees/<名>/commondir` を filter の定義入りの偽の置き場に向けると、本番と同じ上書きと差分の引数でも印ができる。元の置き場の `config` に定義を書いても印ができる（対照）

## 決めたこと
- `server/git-safe.ts` に `export async function checkGitLink(dir: string, mainRoot: string): Promise<string | null>` を足す。問題なければ `null`、落ちたら理由の短い英語（例 `"commondir points elsewhere"`）を返す。例外は投げない（読めないファイルは「落ちた」にする）。P = `dir`、C = `realpath(mainRoot/.git)`:
  1. `lstat(mainRoot/.git)` が本物のディレクトリ（シンボリックリンクでない）。でなければ落とす
  2. `realpath(dir) === realpath(mainRoot)` なら、`lstat(dir/.git)` が本物のディレクトリで実パスが C なら `null`
  3. それ以外は worktree として: `lstat(dir/.git)` が本物のファイル（シンボリックリンクでない）。中身の末尾の改行を除いたものが `gitdir: <G>` の1行（改行が中に無い）。G が相対なら `dir` を起点に解く。`path.dirname(realpath(G)) === path.join(C, "worktrees")`
  4. `realpath(G)/commondir` の中身（末尾の改行を除く。相対なら `realpath(G)` を起点）の実パスが C
  5. `realpath(G)/gitdir` の中身（末尾の改行を除く。相対なら `realpath(G)` を起点）の実パスが `realpath(dir/.git)`
  6. `realpath(G)/config` と `realpath(G)/config.worktree` が無い（`lstat` が ENOENT）
- `resolveWorkplace` の :28 の後（`verdict.real` が決まった後、`known` を作る前）で `checkGitLink(verdict.real, root)` を呼び、`null` でなければ `SessionConflictError(\`git link check failed: ${reason}\`)` を投げる。409 の扱い・hub の見回りが黙って飛ばすことは今のまま
- ファイルの先頭の説明に1行足す（囲いの外で作業場所に向けて git を動かす前に繋がりを確かめる。設計 §4-5）

## 守ること
- 下に書いた変更だけ。ほかの振る舞い・文・既存の試験の期待は変えない（LOW の直しで書き換える3つの試験を除く）
- `tests/unit/helpers/harness.ts`・`tests/unit/helpers/ac-env.ts` は変えない
- 作り物のリポジトリ・偽の置き場・印は `os.tmpdir()` の下に作り、試験の終わりに消す
- 実装の前に確かめる: `server/diff.ts` と `server/pr-status.ts` が git を向ける `dir` が、どの呼び方でも同じ要求の中の `resolveWorkplace` の `dir` から来ていること（`grep -rn "listChanges\|readFileDiff\|resolveTarget" server/`）。そうでない呼び口があれば作らずに止まって報告する

## 変更
1. `server/git-safe.ts`: `checkGitLink` を足す（上の「決めたこと」）
2. `server/workplace.ts`: import を足し、:28 の後で `checkGitLink` を呼ぶ
3. 版を 0.46.3 に（`package.json`・`package-lock.json` の2か所・`extension/manifest.json`）。`docs/CHANGELOG.md` に1行（作業場所の git の繋がり（`.git` ファイル・commondir・gitdir）が本店と合わないときは差分の表示と PR の状態で git を動かさず 409 にする・試験の直し・戻し方 `bash scripts/ac-update.sh v0.46.2`）

## 試験
- `tests/unit/git-safe.test.ts` に足す（`os.tmpdir()` の下に `git init` した本店と `git worktree add` した worktree を作る）。それぞれ1つの it:
  - 本店そのものと正しい worktree は `null`
  - 本店の `.git` がシンボリックリンク → 落ちる
  - worktree の `.git` がシンボリックリンク／ディレクトリ／2行ある／`gitdir:` で始まらない → 落ちる
  - `.git` が本店の `.git/worktrees` の外の gitdir（中身を写した偽の置き場）を指す → 落ちる
  - `commondir` が偽の置き場を指す → 落ちる
  - `gitdir` が別の場所を指す → 落ちる
  - `G/config`・`G/config.worktree` がある → 落ちる
  - `.git` ファイルが無い → 落ちる（例外を投げない）
- `tests/unit/diff.integration.test.ts` に describe を1つ足す（既存の harness の `root` を本店にする）:
  - L-common: `git(root, "worktree", "add", "-q", "-b", "release/link-common", <dir>)` で worktree を作り `f.txt` を変える。偽の置き場 = `root/.git` の中身を写し `worktrees` を除いたもの。その `config` に `[filter "evil"]` と `clean = touch <印>; cat`、`info/attributes` に `*.txt filter=evil` を書く。worktree の `commondir` を偽の置き場の絶対パスに書き換える
    - 対照: その worktree で `git -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --merge-base origin/main --no-renames --no-ext-diff --no-textconv --ignore-submodules=all --numstat -z` を `execFileSync` で1回動かし、**印ができること**を `expect` で確かめてから印を消す（できなければ試験は落ちる）
    - `h.sessions.restore({ …, cwd: <dir> })` のセッションで、`/api/sessions/<id>/diff` と `/diff/file?path=f.txt` が 409、印ができない
    - 試験の終わりに `commondir` を元に戻し、worktree を `git worktree remove --force` で消す
  - L-dotgit: 同じく worktree の `.git` ファイルを偽の gitdir（`root/.git/worktrees/<名>` の中身を写し、`commondir` を偽の置き場に向けたもの）に向ける。同じ2つの入口が 409、印ができない（この回の対照は取らない。下調べで印ができなかったため）
- `tests/unit/pr.integration.test.ts`: :504-524 の試験を置き換える。`newPlace` で作った worktree の `commondir` を、上と同じ偽の置き場（filter と `info/attributes` 入り）に向け、`getPr`・`refreshPr` が 409、`calls()` が `[]`、印ができない。試験の終わりに戻す
- LOW の直し（`tests/unit/diff.integration.test.ts`）:
  - D-fsm: :360 の `console.warn` をやめ、`expect(controlFired).toBe(true)` にする
  - D-sub: D-fsm に頼らない。自分の `mkdtempSync` のリポジトリを作り（`git init -q -b main`・1回 commit・`update-ref refs/remotes/origin/main HEAD`）、そこに入れ子を `git add` して commit、`--unset` の行は消す。結果の期待は入れ子の項目が出ないこと（`f.txt` のような外のファイルを1つ変えて、一覧がそれだけになること）

## 完了の確認（生出力を /tmp/CC報告ファイル/discord-pdca-bin2/55-impl2b2/ に保存）
1. `npm run typecheck`  2. `npm run lint`  3. `npx vitest run tests/unit/git-safe.test.ts tests/unit/diff.integration.test.ts tests/unit/pr.integration.test.ts`  4. `npm test`
5. 見分ける力の確かめ: `server/workplace.ts` の `checkGitLink` の呼び出しを一時的に外して 3 を走らせ、L-common・L-dotgit・pr の置き換えの試験が**落ちる**ことを確かめてから戻す（その生出力も保存。戻した後の `git diff` で外した跡が無いこと）
6. 1コミット（共著者行 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）、PR は `--base main`、本文に「この指示書のどこを満たしたか」と「Evaluator は画面のファイル変更 0 のため省く」を書く

## 想定分岐
- L-common の対照で印ができない（その git では偽の置き場の filter が読まれない）→ 試験を作らずに止まって、生出力の置き場を報告する（下調べと食い違うため）
- 偽の置き場に向けた worktree が `git worktree list` に載らず、確かめの前に今の照合（:28）で 409 になる → 409 になること自体は合格。ただし PR 本文に「今の照合で止まった」と書き、`checkGitLink` の単体の試験で同じ形が落ちることを確かめる
- `realpath` が macOS の `/private` 付きと無しで食い違う → C と比べる側をどちらも `realpath` にそろえる（文字列の前後の手直しはしない）。それでも合わなければ止まって報告
- 既存の試験（本店そのもののセッション、`newPlace` の worktree）が確かめで落ちる → 確かめの条件を緩めずに止まって、どの条件で落ちたかを報告する
- `.git/worktrees/<名>/config` が `git worktree add` で作られる版の git だった → 止まって報告（条件6の扱いを設計で決め直す）
- CI の macOS で既存の不安定な試験が落ちる → 同じ試験が main でも落ちているかを `gh run list` で確かめ、PR 本文に書く
