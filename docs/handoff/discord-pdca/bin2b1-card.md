# 便2b-1 囲いの外で動かす git に守りを付ける（v0.46.2）作る係への指示書

- 設計: Sales Anchor `docs/handoff/discord-pdca/design.md` 第13版 §4-5「守り」（:296-304）・§15（:719）。ADR-1039（Accepted）
- 目的: Discord 発のセッションが件の作業場所の中に仕込んだ設定（`core.fsmonitor`・`core.hooksPath`・入れ子のリポジトリ）が、agent-console の常駐サーバーが囲いの外で動かす git で動かないようにする。設計 §4-5 が決めた直す場所のうち agent-console 側の2つ（`server/diff.ts:35`・`server/pr-status.ts:180`）だけをこの便で直す
- 受け口・役割・起動関数（便2b の残り）はこの便に入れない。今の本番の動き（差分の表示・PR の状態）は、入れ子のリポジトリの差分を数えないこと以外は変わらない
- 調べた実物（origin/main a8a0836。生出力 /tmp/CC報告ファイル/discord-pdca-bin2/37-recon-2b1/）:
  - `server/diff.ts:34-37` の `git` 関数が `execFileAsync("git", ["-C", dir, ...args], …)`。呼ぶのは :58 `rev-parse`・:66 `diff --merge-base … --numstat -z`・:67 `ls-files --others --exclude-standard -z`・:119 `diff --merge-base … -- <path>`
  - `server/pr-status.ts:179-182` の `gitOut` が `execFileAsync("git", ["-C", dir, ...args], …)`。呼ぶのは :189 `remote get-url origin`・:194 `rev-parse --abbrev-ref HEAD`
  - `-c core.` の上書き・`--ignore-submodules` は server/ と tests/ に0件
  - 手元の git 2.39.3 で、上の6つの呼び方の前に `-c core.hooksPath=/dev/null -c core.fsmonitor=false` を付けても、すべて終了コード 0 で同じ出力（08-git-experiments.txt）。`diff … --ignore-submodules=all` も終了コード 0

## 決めたこと
- 上書きの正本は新しいファイル `server/git-safe.ts` の1か所にする。中身:
  - `export const SAFE_GIT_CONFIG: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];`
  - `export function safeGitArgs(dir: string, args: readonly string[]): string[]` は `[...SAFE_GIT_CONFIG, "-C", dir, ...args]` を返す
  - ファイルの先頭に1行の説明（囲いの外で作業場所に向けて動かす git はこれを通す。ADR-1039・設計 §4-5）
- `server/diff.ts:35` と `server/pr-status.ts:180` の `["-C", dir, ...args]` を `safeGitArgs(dir, args)` にする
- `server/diff.ts` の `diff` の2か所（:66・:119）の引数に `"--ignore-submodules=all"` を足す（`--no-textconv` の直後）。`rev-parse`・`ls-files`・`remote get-url` には足さない（その引数を受けないため）
- この便で直さないもの（設計が決めた2か所の外）: `server/resume-targets.ts:26`・`server/worktree.ts:47` の `git -C root worktree list`（元のリポジトリに向ける。作業場所の設定を読まない）、`server/index.ts:62`（agent-console 自身の版）。触らない

## 守ること
- 下に書いた変更だけ。ほかの振る舞い・文・既存の試験の期待は変えない
- `tests/unit/helpers/harness.ts`・`tests/unit/helpers/ac-env.ts` は変えない
- 試験の作り物のリポジトリは `os.tmpdir()` の下に作り、試験の終わりに消す（既存の `tests/unit/diff.integration.test.ts:51-60` の作り方に合わせる）

## 変更
1. `server/git-safe.ts`（新規）: 上の「決めたこと」
2. `server/diff.ts`: import を足し、:35 を `safeGitArgs(dir, args)` に。:66・:119 に `"--ignore-submodules=all"`
3. `server/pr-status.ts`: import を足し、:180 を `safeGitArgs(dir, args)` に
4. 版を 0.46.2 に（`package.json`・`package-lock.json` の2か所・`extension/manifest.json`）。`docs/CHANGELOG.md` に1行（差分の表示と PR の状態で動かす git に、作業場所の設定で命令が動かない上書きを付けた・入れ子のリポジトリの差分は数えない・戻し方 `bash scripts/ac-update.sh v0.46.1`）

## 試験
- `tests/unit/git-safe.test.ts`（新規）: `safeGitArgs("/x", ["rev-parse","HEAD"])` が `["-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","-C","/x","rev-parse","HEAD"]` と一致
- `tests/unit/diff.integration.test.ts` に足す（既存の作り物のリポジトリの作り方を使う）:
  - D-fsm: 作り物のリポジトリの `.git/config` に `core.fsmonitor` として「印のファイルを作る小さな台本」（`os.tmpdir()` の下の印の置き場に `touch`）を設定し、作業ツリーのファイルを1つ変える
    - 対照: 同じリポジトリで上書きなしの `git diff --merge-base <base> --numstat` を `execFileSync` で1回動かし、印ができることを確かめてから印を消す
    - 本番の関数（`listChanges` と `readFileDiff`）を動かして、印ができないこと。差分の一覧の結果は今の試験と同じ形で返ること
  - D-sub: 作業ツリーに入れ子のリポジトリ（`git init` して1回 commit したもの）を `git add` して commit した作り物で、入れ子の中のファイルを変えても `listChanges` の結果に入れ子の項目が出ないこと
- `tests/unit/pr.integration.test.ts` に足す: 同じ印の台本を `core.fsmonitor` に設定したリポジトリで、PR の状態の作業場所の解決（`resolveTarget`。今の試験が通している入口を使う）を動かして、印ができないこと（`remote get-url`・`rev-parse` は fsmonitor を呼ばない見込みなので、対照は取らなくてよい。印ができないことだけを確かめる）

## 完了の確認（生出力を /tmp/CC報告ファイル/discord-pdca-bin2/39-impl2b1/ に保存）
1. `npm run typecheck`  2. `npm run lint`  3. `npx vitest run tests/unit/git-safe.test.ts tests/unit/diff.integration.test.ts tests/unit/pr.integration.test.ts tests/unit/diff.test.ts tests/unit/pr-status.test.ts`  4. `npm test`
5. `git grep -n '"-C", dir' origin/main..HEAD -- server/` ではなく、変更後の作業ツリーで `grep -n '"-C", dir' server/diff.ts server/pr-status.ts` が0件
6. 1コミット（共著者行 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）、PR は `--base main`、本文に「この指示書のどこを満たしたか」と「Evaluator は画面のファイル変更 0 のため省く」を書く

## 想定分岐
- D-fsm の対照で、上書きなしでも印ができない（その git の呼び方では fsmonitor が呼ばれない）→ 対照の呼び方を `git status --porcelain` に変えて1回試す。それでも印ができなければ、D-fsm は印の確かめをやめ「上書きありで結果が変わらない」ことだけを確かめ、PR 本文に「この手元の git では fsmonitor の発火を再現できなかった」と生出力の置き場を書く（止まらなくてよい）
- 入れ子のリポジトリの `git add` が既存の作り物の作り方で作れない → D-sub を省き、PR 本文に理由を書く
- `--ignore-submodules=all` を足したことで既存の試験の期待が変わる → 変えずに止まって報告する
- CI の macOS で既存の不安定な試験が落ちる → 同じ試験が main でも落ちているかを `gh run list` で確かめ、PR 本文に書く
