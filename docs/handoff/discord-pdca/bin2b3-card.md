# 便2b-3a 件ごとの写し・件のセッションの囲いの設定・Claude の道具の見張り・役割 discord-case と起動関数・秘密の登録の入力の直し（v0.46.4）作る係への指示書

- 設計: `docs/handoff/discord-pdca/design.md` 第20版 §4-5（「件ごとの写し」・「Claude の道具の囲い」・「外への通信を塞ぐ」・(a') の書ける場所・「読み取りの拒否の書き方」・起動コマンド・gh の名義・使えない状態の扱い）・§8 便2b-3a・§9 K17・§15。ADR-1039（Sales Anchor・Accepted）
- 目的: ①件のセッション（役割 `discord-case`）を開くとき、サーバーが件ごとの設定（権限・囲い・見張りのフック）を作り、それが無ければ開かない。②件のセッションは `--restricted` で開き、PO のユーザー設定と Sales Anchor のプロジェクトの設定（フックを含む）を読ませない。Claude の Read・Edit・Write などの道具も、件の作業場所と報告の置き場の外へは書けず、外を読めない。②'件の作業場所は linked worktree でなく、本店から切り離した丸ごとの写し（clone）にし、件ごとの一時の置き場を使う（設計第18版。PO 2026-10-26「1」）。③秘密の登録の台本（`scripts/ac-discord-secret.sh`）を、貼り付けが効かなかった入力画面から、端末で打つ読み取りに替える。④PR #80 の審査の LOW（L-1・L-2・L-4・L-5）を直す
- この便に入れないもの: 本物のセッションを開く試験（K11・K13・K17。便2b-3b。お金が掛かる）、`discord-measure`（便3）、受け口からの起動・順番待ちの消化・`launch_failed` の出来事・指示書 `S:docs/ai-agents/ops-incident-agent.md`（便2b-4）、終わった件の設定の片付け（便2b-4。作成の途中の失敗の片付けはこの便）。今ある役割（opus-designer・sonnet-impl・shell）の振る舞いは変えない
- 入れる順番: 作る係は PR を作るところまで。審査・マージ・タグ・入れるのは設計者
- 調べた実物（origin/main bb8c0c4 = v0.46.3。生の写し /tmp/CC報告ファイル/discord-pdca-bin2/81-recon2b3/raw-opus12.txt・raw-opus13.txt）:
  - `server/config.ts:5-21` の `RoleConfig`（`command`・`needsWorktree`・`resumeCommand?`・`resumeScope?`・`restoreCommand?`・`reservable?`）、:143-165 の `parseRole`（:152 `reservable` の型の検査、:153 `base`、:155-157 `resumeScope requires resumeCommand`）
  - `server/sessions.ts:183-192` の constructor（`options: SessionManagerOptions`）、:264-287 `create()`（:279 `createWorktree`、:281 `spawnSession(name, role, branch, cwd)`。今は途中で失敗しても片付けない）、:293-298 `resume()`（:295 `role cannot resume sessions`）、:304-313 `createAccountLogin()`、:324-335 `restore()`（同期。:331 で `knownId` を渡す）、:380-434 `spawnSession`（同期。:388 `knownId?`、:390 で id を決め、:391 `openTerminal(..., knownId === id)` の最後の引数が様子見 probe）、:440-468 `openTerminal`（:446 `if (probe)` で `probeSession`。tmux のとき :458 で `extraEnv` を `newSession` の env に入れる。env は tmux の引数に載る）。`server/terminal-host/tmux-protocol.ts:56` で tmux の誤りが「届かない」に分けられると、claude を起動せず pid 0 でつなぎ直しになる
  - `server/launch.ts:45-56` `validateLaunchTarget`（どの役割でも受ける）、`server/routines.ts:105-108` がそれを使う
  - `server/activity-hooks.ts:53` `HOOK_SPECS`、:91-93 `specHookPath`、:96-103 `buildHandler(nodePath, hookPath, spec)`、:164 `addHandlers(settings, nodePath, hookPath)`（HOOK_SPECS の全部の handler を足した新しい設定を返す）。`server/activity-setup.ts` の `hookPathIn(dataDir)`。`scripts/ac-hooks.mjs:40`・:76 はユーザー設定に `nodePath: process.execPath, hookPath: hookPathIn(dataDir)` で入れている
  - `server/git-safe.ts:37-43` `readLinkTarget`（`readFile` がシンボリックリンクを辿る）、:69（`readLinkTarget(G/gitdir)` と `realOrNull(dotgit)` がどちらも null だと一致扱い）
  - `scripts/ac-discord-secret.sh:18`（`osascript` の入力画面）、:22-32（空・空白・引用符・バックスラッシュの拒否）、:34-37（`security -i` で保存・`find-generic-password` で確かめ）。`scripts/lib/ac-common.sh:50-59` `ac_guard_test_paths`（`AC_STUB_LOG` があるときを試験の印とする）
  - `tests/unit/ac-discord-secret.test.ts`（6つの it。`AC_OSASCRIPT` で入力画面を差し替え）
  - `tests/unit/diff.integration.test.ts:489` 付近（L-main。`expect([409, 500]).toContain(...)`）。PR #80 の審査 L-4: 今の実装では本店の確かめが一覧の例外になり必ず 500
  - `tests/unit/pr.integration.test.ts:505-531`（PR #80 で fsmonitor の試験を commondir の試験に置き換えた。fsmonitor の試験は v0.46.2 の `git show f4e14c8:tests/unit/pr.integration.test.ts` の :504-524 にある）
  - `agent-console.config.json:32-52` の roles（opus-designer・sonnet-impl・shell）
  - 第18版の調べ（生の写し /tmp/CC報告ファイル/discord-pdca-bin2/87-recon-clone/・88-recon-clone2/summary.md）: `server/sessions.ts:268-282` の `create()` は `role.needsWorktree` なら `createWorktree`（`server/worktree.ts:44-64`。枝の名前は `release/…` だけ。:10）。`server/restore.ts:121-137` は `listWorktrees(root)` と `classifyCwd` で照らし、外れれば `missingCwd`。`server/resume-targets.ts:26-31`・:44-52 `classifyCwd`（本店・一覧の worktree・それ以外 outside）。`server/launch.ts:100-104` も `classifyCwd`。`server/workplace.ts:20-37` `resolveWorkplace`（diff-routes.ts:31・:44・:48、hub.ts:626）。`server/git-safe.ts:46-75` `checkGitLink` は `.git` がファイルであることを求めるので写しは落ちる。本店の `core.hooksPath` は `frontend/.husky/_`（husky が手元で作る置き場で git に入っていない。git に入っているのは `frontend/.husky/pre-commit`・`pre-push`）、`scripts/new-worktree.sh:115` が worktree に書くのは `frontend/.husky`、手元の user は shingo-cc、origin は `https://github.com/shingo-ops/salesanchor.git`（資格なし）。写しの中の origin/main は本店の手元の main（古い）。S:frontend/.husky/pre-commit:3-26 は `~/worktrees/` か `<M>/.claude/worktrees/` の下でないと commit を止める。`git clone --no-hardlinks --local` は pack のリンクの数 1・319M・写し 7.23 秒＋取り出し 12.92 秒
  - ccopusgo の形（PO の `~/.claude/shell/ccopusgo.zsh`。写し raw-ccopusgo.txt）: 指示書2つの読めること・空でないことを確かめ、`"\n\n"` でつないで `--append-system-prompt` に渡す
  - 公式資料（Context7 は月の上限で使えず、直接読んだ。/tmp/CC報告ファイル/discord-pdca-bin2/81-recon2b3/doc-* と 84-verify-review83/）: フックの `onFailure: "block"`（doc-hooks.md:902-945。v2.1.295 以降。手元 2.1.310）、止めるフックは許可の規則より先に効く（doc-permissions.txt:653）、Write・Edit・Read の入力の道は `file_path`（doc-hooks.md:1830-1858）、`--restricted`（doc-cli-reference.md:125。v2.1.248 以降。ユーザー・プロジェクト・ローカルの設定を読まず、管理の設定と `--settings` だけ。組み込みの道具を作業場所に閉じ込め、命令を動かす道具は `--tools` で名指ししないと外れる）、`--tools`（:138。MCP には効かないので `--disallowedTools "mcp__*"`。:87）、`permissions.blockReadsOutsideWorkingDirectories`（doc-settings-reference.md:1038-1075。linked worktree の元の `.git` を読めて書ける形に開け直し、`/private/tmp` は塞がない＝84-verify-review83/facts2.txt:3・:5。だから使わない）、`sandbox.filesystem.allowRead`（:1473-1492。ホームを `denyRead` で塞いで開け直す公式の形。ぴったりの `denyRead` は広い `allowRead` の中でも塞がれたまま）、`--add-dir` の場所から読まれる `.claude/agents`・skills・プラグインの設定（doc-permissions:702-710、doc-sub-agents:170・:251）、囲いの中の命令の `$TMPDIR` は利用者ごとの一時の置き場（doc-sandboxing.md:245）

## 決めたこと
- 道の記号（どれも realpath にそろえる）: M = 本店（`config.salesanchorRoot`。写しの元。囲いの中からは読めず書けない）、W = 件の写し `H/worktrees/discord-cases/<セッション id>`、P = `realpath("/tmp")` + `/acc`（件の一時の置き場の親）、T = `P/<セッション id の先頭8字>`（件の一時の置き場）、D = `config.dataDir`、H = `os.homedir()`、R = `realpath("/tmp")` + `/CC報告ファイル/discord-case/<セッション id>`（`os.tmpdir()` ではない。macOS では `/private/tmp/...`）、GH = `D/case-gh/<セッション id>`
- 新しいファイル `server/case-sandbox.ts`（純粋な関数と、ファイルを書く関数を分ける）:
  - `export const CASE_DENY_WRITE = (p) => [...]`: `W/.git/hooks`・`W/.git/config`・`W/.git/commondir`・`W/.git/objects/info/alternates`・`W/.claude`・`W/.mcp.json`・`R/.claude`・`D/cases`・`D/case-gh`・`D/hooks`・`/private/tmp/claude-<uid>`・`M`（`<uid>` は `process.getuid()`）。囲いの `filesystem.denyWrite` と権限の `Edit(//…)` の deny の両方をこの1つの配列から作る（正本は1つ）
  - `export const CASE_DENY_READ = (p) => [...]`: `D/reserve-token`・`H/.claude-access.env`・`H/.claude/channels`・`H/.claude/projects`・`H/Library/Keychains`・`H/.config/gh`・`D/cases`・`H/.config/git/credentials`・`H/.git-credentials`。囲いの `filesystem.denyRead` と権限の `Read(//…)` の deny の両方をこの1つの配列から作る（秘密の置き場。下の `CASE_ALLOW_READ` の広い開け直しの中でも塞がれたまま。doc-settings-reference.md:1475）
  - `export const CASE_DENY_READ_SANDBOX = (p) => [H, "/private/tmp/CC報告ファイル", "/private/tmp/claude-<uid>", realpath(os.tmpdir()), M, P, ...CASE_DENY_READ(p)]`（P はほかの件の T を読ませないため。自分の T は `CASE_ALLOW_READ` で開け直す。設計第19版・審査 89 M-2）（`<uid>` は `process.getuid()`。囲いの `filesystem.denyRead` にはこちらを入れる。権限の `Read(//…)` の deny は `CASE_DENY_READ` のまま。Claude の読む道具は `--restricted` と見張りの許す一覧で守る）
  - `export const CASE_ALLOW_WRITE = (p) => [...]`: `W`・`R`・`T`（設計第18版。写しの `.git` は W の中なので本店の `.git` は入れない）
  - `export const CASE_ALLOW_READ = (p) => [W, R, GH, T, H/.gitconfig, H/.config/git/config, H/.config/git/ignore, H/.config/git/attributes, nodeHome]`（囲いの中の命令に、塞いだホームの中から開け直す場所。`nodeHome` は `realpath(process.execPath)` の2つ上で、H の下にあるときだけ入れる。H の下でなければ入れない。`nodeHome` が H そのもの、または H の直下（`path.dirname(nodeHome) === H`）なら `CaseSandboxUnavailableError` を投げる（開け直しがホーム丸ごとになるため。審査 86 L-2））
  - `export const CASE_ALLOWED_DOMAINS = ["api.github.com","github.com","api.salesanchor.jp","127.0.0.1","localhost"]`
  - `export function buildCaseSettings(p): object`（p は M・W・T・D・H・R・GH・`guardScript`・`nodeBin`・`caseFile`・`hookPath`）。`nodeBin` は呼ぶ側が `process.execPath` を渡す（PATH の上の node を使わない）。返す形:
    - `permissions.defaultMode: "dontAsk"`、`permissions.disableBypassPermissionsMode: "disable"`、上の段の `disableAutoMode: "disable"`
    - `permissions.blockReadsOutsideWorkingDirectories`: 入れない（設計第17版。linked worktree の元の `.git` を書ける形に開け直すため。facts2.txt:5。写しになっても、`/private/tmp` を塞がないので使わない）
    - `permissions.additionalDirectories`: 入れない（R は起動の `--add-dir` で渡す。2か所に書かない）
    - `permissions.allow`: `Bash`・`Agent`・`Edit(//<W>/**)`・`Edit(//<R>/**)`・`Read(//<R>/**)`（絶対の道は先頭を `//` にする。`<W>` は先頭の `/` を除いた realpath をつなぐ）
    - `permissions.deny`: `CASE_DENY_WRITE` の各道の `Edit(//<道>/**)` と `Edit(//<道>)`、`CASE_DENY_READ` の各道の `Read(//<道>/**)` と `Read(//<道>)`、`Bash(security *)`・`Bash(security)`・`Bash(gh auth *)`・`Bash(gh auth)`・`Bash(gh pr merge *)`・`Bash(gh pr merge)`・`Bash(ac-reserve *)`・`Bash(ac-reserve)`・`Bash(ac-routine *)`・`Bash(ac-routine)`
    - `sandbox`: `enabled: true`・`failIfUnavailable: true`・`allowUnsandboxedCommands: false`・`enableWeakerNetworkIsolation: true`・`network.allowedDomains: CASE_ALLOWED_DOMAINS`・`network.strictAllowlist: true`（`--settings` から効くかは便2b-3b で確かめる。効かなくても見張りと deny が守る）・`network.allowLocalBinding: true`・`network.allowMachLookup: ["com.apple.SecurityServer","com.apple.securityd*"]`・`filesystem.allowWrite: CASE_ALLOW_WRITE`・`filesystem.denyWrite: CASE_DENY_WRITE`・`filesystem.denyRead: CASE_DENY_READ_SANDBOX`・`filesystem.allowRead: CASE_ALLOW_READ`
    - `hooks`: まず `addHandlers({}, nodeBin, hookPath).settings`（`server/activity-hooks.ts:164`。agent-console の動きの記録と見張りのフックを、ユーザー設定と同じ組み立てで入れる。手で写さない）を取り、その `hooks.PreToolUse` の先頭に件の見張りの組 `{ matcher: "*", hooks: [{ type: "command", command: nodeBin, args: [guardScript, caseFile], onFailure: "block", timeout: 10 }] }` を足す
  - `export async function writeCaseFiles(p, sessionId): Promise<{ settingsPath, ghDir, caseFile }>`: `D/cases/<id>/settings.json`（`buildCaseSettings` の結果）、`D/cases/<id>/case.json`（`{ worktree: W, report: R, tmp: T, denyWrite: CASE_DENY_WRITE, denyRead: CASE_DENY_READ }`。見張りのフックが読む）、`GH/config.yml`（`version: "1"` の1行）、`GH/hosts.yml`（`github.com:` の下に `user: shingo-cc` と `users:` の `shingo-cc:` だけ。トークンは書かない）を作り、R の置き場を作る。T は P と T を recursive 無しの `mkdir`（0o700）で作る: P が無ければ作り、すでにある（EEXIST。2つの件が同時に作るときも）なら `lstat` で本物のディレクトリ（シンボリックリンクでない）で `uid` が `process.getuid()` と同じことを確かめ（違えば `CaseSandboxUnavailableError`）、T がすでにあれば失敗にする。ディレクトリは 0o700、ファイルは 0o600。GH は件のセッションの gh が読むので `CASE_DENY_READ` に入れない（書けないように `CASE_DENY_WRITE` には `D/case-gh` で入れる）
  - `export async function removeCaseFiles(D, sessionId)`: `D/cases/<id>` と `D/case-gh/<id>` だけを消す（`fs.rm(…, { recursive: true, force: true })`。道は `D/cases/` と `D/case-gh/` の下で、id が UUID の形のときだけ。そうでなければ何もしない）
  - `removeCaseFiles(D, sessionId, { tmp })` は、`tmp: true` のときだけ `T` も消す（P を `lstat` で本物のディレクトリかつ自分の持ち物と確かめたうえで、道が `P/` の直下で名前が id の先頭8字と同じときだけ。P は消さない）。`writeCaseFiles` は自分の途中の失敗では自分が作った物だけを消してから投げ、T を作れなかったとき（すでにある・P がリンク）は T に触らない。`create()` の片付けは、`writeCaseFiles` が終わったあとの失敗でだけ `tmp: true` を渡す（すでにあった別の件の T やリンクの先を消さない。審査 90 L-2）
- 新しいファイル `server/case-clone.ts`（囲いの外で、常駐サーバーが件の写しを作り、確かめる。git はどれも `execFile("git", [...])` の引数の配列で、環境は `{ ...process.env, GIT_TERMINAL_PROMPT: "0" }`（置き換えない。置き換えると PATH と資格の道が消え、試験の insteadOf も効かない。審査 89 L-2）。待ちの上限（`timeout`）は fetch 120 秒・clone 300 秒・ほかは 30 秒。shell を通さない）:
  - `export function caseCloneDir(H, id): string` = `H/worktrees/discord-cases/<id>`（id は UUID の形のときだけ。違えば例外）
  - `export async function createCaseClone({ M, H, id }): Promise<string>`（W を返す）。順に: ①`checkMainLink(M)`（`server/git-safe.ts:25-35`）が null でなければ例外 ②`git -C M fetch origin main` ③`sha = git -C M rev-parse --verify origin/main^{commit}`（写しの中の origin/main は本店の手元の main で古いので、本店の origin/main の sha を使う） ④`H/worktrees/discord-cases` を `mkdir(…, { recursive: true, mode: 0o700 })`、W がすでにあれば例外 ⑤`git clone --no-hardlinks --local --no-checkout -- M W` ⑥`url = git -C M config --get remote.origin.url`（`remote get-url` は insteadOf を展開するので使わない）。`https://github.com/` で始まり `@` を含まないときだけ `git -C W remote set-url origin <url>`、違えば例外 ⑦`git -C W switch -c release/discord-case-<id の先頭8字> <sha>` ⑦'`git -C W config branch.<枝>.remote origin`・`git -C W config branch.<枝>.merge refs/heads/<枝>`（`W/.git/config` は囲いの中から書けないので、上流を先に書く。審査 89 M-1） ⑧`git -C W config core.hooksPath frontend/.husky`（new-worktree.sh と同じ値） ⑨`git -C M config --local user.name`・`user.email` を読み、どちらかが空なら例外、`git -C W config user.name …`・`user.email …` に写す ⑩台帳の登録（審査 89 H-1。Sales Anchor の pre-push の検査 S:scripts/validate-pr-ownership.sh:69-95 と S:scripts/ledger-lookup.sh は台帳を W の中で読む）: `W/.claude-pipeline/active-work.md` が本物のファイルでなければ例外。`W/.claude-pipeline/active-work.d/release-discord-case-<id の先頭8字>.md` を `fs.writeFile(…, { flag: "wx", mode: 0o644 })` で作る。その前に `W/.claude-pipeline/active-work.d` を `lstat` で本物のディレクトリ（シンボリックリンクでない）と確かめ、違えば例外（審査 90 L-3）。中身は S:scripts/new-worktree.sh:149-153 と同じ形の5行: `branch: <枝>`・空行・`| ブランチ名 | 担当機能エリア | 開始日時 | 状態 | PR# | main | 備考 |`・`|-----------|--------------|---------|------|-----|------|------|`・`| <枝> | Discord の件 <id の先頭8字> | <YYYY-MM-DD HH:MM（手元の時刻）> | IN_PROGRESS | | | |`（最後に改行）。このファイルは件の PR に入ってよい（Sales Anchor のふつうの作業と同じ。設計第19版）。①〜⑩のどこかで失敗したら、W が `caseCloneDir(H, id)` と同じ道のときだけ `fs.rm(W, { recursive: true, force: true })` してから投げ直す。Sales Anchor の `scripts/new-worktree.sh` は呼ばない
  - `export async function checkCaseClone(W, M): Promise<string | null>`（落ちた理由か null）: ①`lstat(W/.git)` が本物のディレクトリ（シンボリックリンクでない） ②`W/.git/commondir` と `W/.git/objects/info/alternates` が無い ③`git -C W rev-parse --absolute-git-dir` が `realpath(W/.git)` と同じ ④`git -C W config --local --get core.hooksPath` が `frontend/.husky` ⑤`git -C W config --local --get remote.origin.url` が `git -C M config --local --get remote.origin.url` と同じ ⑥（第20版。審査 90 M-1）`git -C W config --file W/.git/config --list --name-only` の鍵を全部小文字にし、どれも許す一覧 `core.repositoryformatversion`・`core.filemode`・`core.bare`・`core.logallrefupdates`・`core.ignorecase`・`core.precomposeunicode`・`core.hookspath`・`remote.origin.url`・`remote.origin.fetch`・`user.name`・`user.email` か、`branch.<名前>.remote`・`branch.<名前>.merge` の形であること（一覧は `server/case-clone.ts` の定数 `CASE_CLONE_CONFIG_KEYS` 1つに置く）。`--includes` は付けない（include の鍵そのものを一覧の外として落とす）。`-c core.fsmonitor=false -c core.hooksPath=/dev/null` は ③の `rev-parse` だけに付ける。④⑤⑥に `-c` を付けない（【事実】`-c` の値は `config --get` の結果に混ざる。`-c core.hooksPath=/dev/null config --get core.hooksPath` は `/dev/null` を返す。/tmp/CC報告ファイル/discord-pdca-bin2/89-review-ac83d/test-c-config.txt。審査 89 H-2）
- 新しいファイル `ops/case/case-guard.mjs`（見張りのフック。node だけで動き、依存を足さない）:
  - 引数1つ（case.json の道）。標準入力の JSON の `tool_name` と `tool_input` を読む。どこかで例外になれば終了の番号 2（`onFailure: "block"` にも重ねる）。止めるときは理由の短い英語を標準エラーに1行出して終了の番号 2、通すときは何も出さず 0
  - 道の解き方（下の 1. 2. で共通）: 文字列でない・絶対の道でない → 止める。字面で `.`・`..` を縮めない（`path.resolve`・`path.normalize` を使わない）。`fs.realpathSync` にそのまま渡し、無い道なら、末尾から1つずつ名前を外して一番近いある親の realpath を取り、外した名前をそのままつなぐ（外した名前に `..` があれば止める）。`worktree`・`report`・一覧の道も起動の時に realpath にそろえてある
  - 「X の下」の判定: 解いた道が X と同じか、`X + "/"` で始まる
  - ハードリンク: 解いた道にすでに本物のファイルがあり、`fs.statSync(道).nlink >= 2` なら、下の 1. 2. のどちらでも止める（realpath はハードリンクを見分けない）
  - 判定（上から順に）:
    1. `tool_name` が `Edit`・`Write`・`NotebookEdit`: 道は `tool_input.file_path`、無ければ `tool_input.notebook_path`。`denyWrite` のどれかの下なら止める。`worktree` か `report` の下なら通す。それ以外は止める
    2. `Read`・`Glob`・`Grep`: 道は `tool_input.file_path`（Read）、`tool_input.path`（Glob・Grep。無いときは作業場所 W として扱う）。Glob の `tool_input.pattern` が文字列でない、`/` か `~` で始まる、または `..` を含む → 止める。道が `denyRead` のどれかの下 → 止める。`worktree`・`report`・`tmp`（T）の下なら通す（許す一覧。T は Claude 自身の一時ファイルの置き場。審査 90 M-2）。それ以外（ホーム・`/Users` などの祖先、ほかの件の `P/<別>` を含む）は止める
    3. 名前が `mcp__` で始まる、`WebFetch`・`WebSearch` → 止める
    4. `Agent`・`Task`: `tool_input` の鍵が `description`・`prompt`・`subagent_type`・`model`・`run_in_background` だけなら通す。ほかの鍵（`isolation`・`name`・`team_name`・`mode` など、知らない鍵を含む）が1つでもあれば止める
    5. `Bash`・`TodoWrite`・`ToolSearch` → 通す
    6. それ以外の名前 → 止める（知らない道具は通さない）
- `server/config.ts`: `RoleConfig` に `caseSandbox?: boolean` を足す（説明の注釈を1行）。`parseRole` で、`r.caseSandbox !== undefined && typeof r.caseSandbox !== "boolean"` は起動の誤り。`caseSandbox === true` のとき、`needsWorktree` が false でない（第18版。件は Sales Anchor の worktree を作らないので、画面が枝の名前を聞かない形にする）・`reservable` が false でない・`resumeCommand` か `resumeScope` がある、のどれかなら起動の誤り（`config: roles[i] caseSandbox requires needsWorktree:false, reservable:false and no resumeCommand`）。`reserveRoles`・`routineManagerRoles` に `caseSandbox` の役割が入っていたら起動の誤り
- `server/launch.ts`: `validateLaunchTarget` で、役割が `caseSandbox: true` なら断る（今の誤りの返し方と同じ形。理由 `role cannot be scheduled`）。定期実行の登録で件の役割が選べない
- `server/sessions.ts`:
  - `SessionManagerOptions` に `sandboxExecPath?: string`（試験用。既定 `/usr/bin/sandbox-exec`）・`caseShellPath?: string`（既定 `realpath(process.cwd())/ops/shell/ccdiscord.zsh`）・`caseGuardPath?: string`（既定 `realpath(process.cwd())/ops/case/case-guard.mjs`）・`caseHomeDir?: string`（試験用。既定 `os.homedir()`。H と W の置き場に使う）・`caseTmpRoot?: string`（試験用。既定 `realpath("/tmp")`。T の置き場に使う）を足す
  - `spawnSession` の引数の最後に `isNew?: boolean` を足す。`isNew === true` なら `openTerminal` の probe を false にする（`knownId === id && isNew !== true`）。今の呼び出しは渡さないので振る舞いは変わらない
  - `create()`: 役割が `caseSandbox` のときは、`needsWorktree` の分岐より前で別の道に入る。枝の名前が渡されていたら `SessionConflictError("case role does not take a branch")`。`const id = randomUUID()`、`const W = await createCaseClone({ M, H, id })`、`await checkCaseClone(W, M)` が null でなければ `SessionConflictError(\`case clone check failed: ${reason}\`)`、`writeCaseFiles(...)`、`spawnSession(name, role, "release/discord-case-<id の先頭8字>", W, role.command, {}, undefined, id, true)` で開く。`checkCaseClone`・`writeCaseFiles`・`spawnSession` のどこかが投げたら、`removeCaseFiles(D, id)` と、W が `caseCloneDir(H, id)` と同じときだけ W の削除をしてから同じ誤りを投げ直す（作成の途中の失敗は写しも残さない。終わった件の写しの片付けは便2b-4）
  - `spawnSession` の頭（:390 で id を決めた直後、`openTerminal` の前）に、`role.caseSandbox === true` のときの確かめを置く。どれも同期の関数（`existsSync`・`realpathSync`・`accessSync`・`readFileSync`）で書く。①`D/cases/<id>/settings.json` と `case.json` がある ②`realpath(cwd)` が `case.json` の `worktree` と同じ ③`sandboxExecPath` が実行できる（`accessSync(…, X_OK)`）④`caseShellPath` と `caseGuardPath` が読める ⑤`case.json` の `report`（R）がディレクトリとしてある（`/tmp` は再起動で消える。作り直さない） ⑥`case.json` の `tmp`（T）がディレクトリとしてある ⑦`nodeHome` の条件（上の `CASE_ALLOW_READ`）。1つでも落ちたら `CaseSandboxUnavailableError("sandbox unavailable: <理由>")` を投げる（新しい誤りの型。http の層で 503）。通ったら `extraEnv` に `AC_CASE_SETTINGS`（settings.json の道）・`AC_CASE_GH_DIR`（GH）・`AC_CASE_REPORT`（R）・`AC_CASE_TMP`（T）・`AC_CASE_SHELL`（`caseShellPath`）・`AC_DISCORD_CASE`（`manual-<id>:1`）を足す（どれも道か印だけ。秘密は入れない）。この確かめは `create`・`resume`・`restore`・`createAccountLogin` のどの道からも通る
  - `resume()` は今のまま（件の役割は `resumeCommand` を持たないので :295 で拒まれる）
- `server/restore.ts`: :121-137 の照らしで、その項目の役割が `caseSandbox` のときは `classifyCwd` を使わず、`D/cases/<id>/case.json` が読めて `worktree` が `realpath(item.cwd)` と同じことと `await checkCaseClone(item.cwd, M)` が null であることで照らし、落ちたら今と同じ `missingCwd` にする（理由を記録に1行）。件でない役割は今のまま
- 差分の表示・再開の一覧・定期実行の起動（`resolveWorkplace`・`listResumeTargets`・`launchAndSend`）は変えない。件の写しは `classifyCwd` で outside になり 409 か断りになる（既知の制約。便2b-4 で決める。PR 本文の「残ること」に書く）
- `server/http.ts`: `CaseSandboxUnavailableError` を 503 と本文 `{ error: "sandbox unavailable" }` に変える（今の誤りの型を http に変える所と同じ形で1つ足す）
- `server/workplace.ts`（ふつうの worktree の守り。第17版から変えない）: `listWorktreeEntries` を呼ぶ前に `checkMainLink(root)` を呼び、null でなければ `SessionConflictError(\`git link check failed: ${reason}\`)`（409。設計 §4-5「落ちたとき」）。これで L-main が 409 の1通りになる
- `server/git-safe.ts`（ふつうの worktree の守り。第17版から変えない）:
  - L-2: `readLinkTarget` の頭で `lstat(file)` が本物のファイル（シンボリックリンクでない）でなければ null
  - L-1: :69 の比べの前に `realOrNull(dotgit)` を変数に取り、null なら `"gitdir back-link mismatch"` を返す
- 新しいファイル `ops/shell/ccdiscord.zsh`（`ccdiscordcase` 関数1つ。`ccopusgo` と同じ作りで、違いは次のとおり）:
  - 引数は受け取らない。`AC_CASE_SETTINGS`・`AC_CASE_GH_DIR`・`AC_CASE_REPORT`・`AC_CASE_TMP` が空・読めない、`${AC_SANDBOX_EXEC:-/usr/bin/sandbox-exec}` が実行できない、指示書 `~/.claude/prompts/salesanchor-designer.md`・`~/.claude/prompts/salesanchor-ops-incident-agent.md` のどちらかが読めない・空、のどれかなら、理由を標準エラーに1行出して 2 で終わる（claude を開かない）
  - 版の確かめ: `"${AC_CLAUDE_BIN:-claude}" --version` の先頭の `X.Y.Z` を取り、2.1.295 より小さい・読めないなら 2 で終わる（比べは数の3つ組で。文字列の比べにしない）
  - 囲いの外で `GH_TOKEN="$(gh auth token -u shingo-cc)"` を取り、空なら 2 で終わる。`export GH_TOKEN GH_CONFIG_DIR="$AC_CASE_GH_DIR" GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='!gh auth git-credential' GIT_CONFIG_KEY_2=core.fsmonitor GIT_CONFIG_VALUE_2=false`（3つ目は Claude Code 自身が動かす git にも fsmonitor を使わせないため。審査 90 M-1）。値を画面・記録に出さない（`set -x` を使わない）
  - `export CLAUDE_CODE_TMPDIR="$AC_CASE_TMP"`（ほかのセッションと共有の一時の置き場を使わせない。設計第18版・審査 86 H-2）
  - `cd` しない。`command "${AC_CLAUDE_BIN:-claude}" --restricted --tools "Bash,Read,Edit,Write,Glob,Grep,Agent,TodoWrite" --settings "$AC_CASE_SETTINGS" --add-dir "$AC_CASE_REPORT" --strict-mcp-config --disallowedTools "mcp__*" WebFetch WebSearch --permission-mode dontAsk --model opus --effort medium --append-system-prompt "$prompt"`。`AC_RESUME_ID` が UUID の形なら `--resume "$AC_RESUME_ID"` を足す（形が違えば足さずに新しい会話）。`--chrome`・`--setting-sources`・`--dangerously-skip-permissions` は付けない
- `agent-console.config.json` の roles に足す: `{ "id": "discord-case", "labelKey": "role.discordCase", "command": ["/bin/zsh", "-c", "source \"$AC_CASE_SHELL\" && ccdiscordcase"], "restoreCommand": ["/bin/zsh", "-c", "source \"$AC_CASE_SHELL\" && ccdiscordcase"], "needsWorktree": false, "reservable": false, "caseSandbox": true }`。`-i` は付けない（PO の `~/.zshrc` を読ませない）。`src/locales/ja.json` に `role.discordCase` の言葉（例「不具合の件（Discord）」）を1つ足す（ほかの言語ファイルがあれば同じキー）
- `scripts/ac-discord-secret.sh`: :18-20 を置き換える。案内を標準エラーに出し、端末から `IFS= read -rs value < "$src"` で受ける（打った文字は画面に出ない）。`src` は、`AC_STUB_LOG` があるとき（`ac_guard_test_paths` と同じ試験の印）だけ `${AC_SECRET_INPUT:-/dev/tty}`、ないときは必ず `/dev/tty`。読めなかったら「取り消しました（保存していません）」。読んだあと標準エラーに改行を1つ。:4 の注釈を「値は端末で受け取り（画面に出さない）。macOS の端末の1行は 1024 バイトまで」に直す。:22 以降の拒否・保存・確かめは変えない
- 版を 0.46.4 に（`package.json`・`package-lock.json` の2か所・`extension/manifest.json`）。`docs/CHANGELOG.md` に1行（件の役割 discord-case と件ごとの写し・囲いの設定・Claude の道具の見張り・`--restricted` の起動・秘密の登録を端末の入力に変更・git の繋がりの確かめの直し・戻し方 `bash scripts/ac-update.sh v0.46.3`）。README に、件の役割の節（何を塞ぐか・件ごとに本店から切り離した写しを `~/worktrees/discord-cases/` に作る・ユーザーとプロジェクトの設定を読まない・設定の置き場・使えないときは 503 で開かない・秘密の登録は端末で打つ）を足す

## 守ること
- 下に書いた変更だけ。今ある役割・入口の振る舞いと、既存の試験の期待は変えない（下の「試験」で書き換えると書いたものを除く）
- 作り物の置き場・印は `os.tmpdir()` の下に作り、試験の終わりに消す。本物の `~/Library/Application Support/agent-console`・`~/.claude`・Keychain には触らない
- 本物の claude・gh・security を試験で動かさない（差し替えの台本を使う）
- 実装の前に確かめる（生出力を保存）: `grep -rn "spawnSession\|\.restore(\|\.resume(\|createAccountLogin\|SessionConflictError\|validateLaunchTarget\|needsWorktree" server/ src/` で、セッションを開く道が上の「調べた実物」の4つだけで、どれも `spawnSession` を通ること。`needsWorktree` を見て枝の名前を求める所（画面・http の作成の入口）を全部記録すること。違う道があれば作らずに止まって報告する。`.github/workflows/ci.yml` の動く OS と、`zsh` があるか

## 変更
1. `server/case-sandbox.ts`（新規）・`server/case-clone.ts`（新規）
2. `ops/case/case-guard.mjs`（新規）
3. `ops/shell/ccdiscord.zsh`（新規）
4. `server/config.ts`: `caseSandbox`
5. `server/sessions.ts`: options・`spawnSession` の `isNew` と確かめ・`create()` の件の道と失敗の片付け。`server/restore.ts`: 件の照らし
6. `server/http.ts`: 503
7. `server/launch.ts`: 件の役割を定期実行で断る
8. `server/workplace.ts`: 本店の確かめを先に
9. `server/git-safe.ts`: L-1・L-2
10. `scripts/ac-discord-secret.sh`: 端末の入力
11. `agent-console.config.json`・`src/locales/ja.json`: 役割 discord-case
12. 版の置き場・`docs/CHANGELOG.md`・README
13. 下の試験

## 試験
- `tests/unit/case-sandbox.test.ts`（新規）:
  - `buildCaseSettings` の `permissions.deny` の Edit の道の集まりが `CASE_DENY_WRITE` と、Read の道の集まりが `CASE_DENY_READ` と、`sandbox.filesystem.denyWrite`・`denyRead`・`allowWrite`・`allowRead` がそれぞれ同じ配列と一致する（正本1つの確かめ）
  - `defaultMode` が `dontAsk`、`disableBypassPermissionsMode`・`disableAutoMode` が `disable`、`allow` に道を付けない `Edit`・`Write`・`Read`・`WebFetch`・`WebSearch` が無い
  - `CASE_DENY_WRITE` に `W/.git/hooks`・`W/.git/config`・`W/.git/commondir`・`W/.git/objects/info/alternates`・`W/.claude`・`W/.mcp.json`・`R/.claude`・`D/hooks`・`/private/tmp/claude-<uid>`・`M` がある。`permissions.blockReadsOutsideWorkingDirectories` が無い
  - `sandbox.filesystem.denyRead` が `CASE_DENY_READ_SANDBOX` と同じで H と `CASE_DENY_READ` の全部を含み、`allowRead` が `CASE_ALLOW_READ` と同じで、`allowRead` に `CASE_DENY_READ` のどの道も（同じか、その祖先として）入っていない。`nodeHome` は H の外の node の道を渡すと入らない。`nodeHome` が H そのもの・H の直下になる node の道を渡すと `CaseSandboxUnavailableError`。`allowRead` に `H/.config/git` そのものが無く、3つのファイルだけがある。`CASE_DENY_READ` に `H/.config/git/credentials`・`H/.git-credentials` がある。`denyRead` に M と P がある。`allowRead` に T があり P が無い。`denyWrite` に P が無い
  - `hooks.PreToolUse` の先頭が件の見張り（`matcher: "*"`・`onFailure: "block"`・`command` が渡した `nodeBin`・`args[1]` が case.json の道）。`addHandlers({}, nodeBin, hookPath)` の `hooks` のほかの全部の組がそのまま入っている（同じ関数の結果と比べる）
  - `allowWrite` が W・R・T の3つだけ（M とその下を含まない）。`allowedDomains` が5つだけ
  - `writeCaseFiles`: 4つのファイルができ、権限が 0o600、`hosts.yml` に `shingo-cc` だけで `oauth_token` を含まない。R と T ができる（T は P の直下）。P がシンボリックリンク → `CaseSandboxUnavailableError` で、リンクの先は消えない。T がすでにある → 失敗し、すでにあった T の中身は消えない（`create()` を通した形でも確かめる）。P がすでにある本物のディレクトリ → 通る。台帳の置き場 `W/.claude-pipeline/active-work.d` がシンボリックリンクの M → `createCaseClone` が投げ、W が無い。`case.json` に `tmp` がある。`removeCaseFiles` で3つの置き場が消え、UUID でない id では何も消えない
- `tests/unit/case-guard.test.ts`（新規。`spawnSync(process.execPath, [guard, caseFile], { input })` で動かす。W・R・偽の D・偽の H は一時の置き場）:
  - Edit・Write: W の中のファイル（ある・まだ無い）→ 0。R の中 → 0。`R/.claude/agents/x.md` → 2。W の中のファイルで、W の外のファイルへのハードリンク（`fs.linkSync` で作る）→ 2（Read も 2）。W の外（偽の H の下）→ 2。`W/.git/config` → 2。`W/.git/hooks/pre-commit` → 2。`W/.git/commondir` → 2。`W/.claude/settings.json` → 2。W の中のシンボリックリンクが W の外を指す → 2。`W/a/../../x`（字面では W の外）→ 2。相対の道 → 2。`file_path` が数 → 2。`file_path` 無し → 2
  - NotebookEdit: `notebook_path` が W の中 → 0、外 → 2
  - Read・Grep・Glob: T の中 → 0。偽の P の下のほかの件 `P/<別>/x` → 2。Edit・Write: T の中 → 2（審査 90 M-2）
  - Read: 偽の `D/reserve-token` → 2。偽の `H/.claude/projects/x` → 2。偽の `H/.ssh/id` → 2。W の中 → 0。R の中 → 0
  - Grep・Glob: `path` が偽の H（祖先）→ 2。`path` が `/` → 2。`path` が偽の `H/Library/Keychains` → 2。`path` 無し → 0。Glob の `pattern` が `/etc/**` → 2、`~/x` → 2、`../x` → 2、`src/**` → 0。ディレクトリのリンクの数では止めない: Grep の `path` が W → 0、Glob の `path` が `W/src`（中にディレクトリを1つ作り、リンクの数が2以上の状態）→ 0（審査 86 M-1）
  - Agent: `{description, prompt, subagent_type}` → 0。`isolation: "worktree"` を足す → 2。`name` を足す → 2。知らない鍵 → 2
  - `mcp__x__y`・`WebFetch`・`WebSearch` → 2。`Bash`・`TodoWrite` → 0。知らない名前（`EnterWorktree`）→ 2
  - 壊れた JSON・case.json が無い → 2
- `tests/unit/case-clone.test.ts`（新規。一時の置き場に、元になる bare のリポジトリ B と、B から作った M を作る。M の `remote.origin.url` は `https://github.com/test/repo.git`、試験の間だけ `process.env` の `GIT_CONFIG_COUNT`・`GIT_CONFIG_KEY_0=url.<B の file:// の道>.insteadOf`・`GIT_CONFIG_VALUE_0=https://github.com/test/repo.git` で B に向ける。M の手元の main を B の main より1つ古くしておく。H は一時の置き場）:
  - `createCaseClone`: W = `H/worktrees/discord-cases/<id>` ができ、`checkCaseClone(W, M)` が null。`W/.git/objects/pack` の pack のリンクの数が 1。枝が `release/discord-case-<id の先頭8字>` で、HEAD が B の main の sha（M の手元の main ではない）。`core.hooksPath` が `frontend/.husky`。user.name・user.email が M と同じ。`remote.origin.url` が `https://github.com/test/repo.git`。`branch.<枝>.remote` が `origin`、`branch.<枝>.merge` が `refs/heads/<枝>`。台帳のファイルができ、1行目が `branch: <枝>` で、S:scripts/ledger-lookup.sh:21 と同じ規則（`|` で区切った2つ目の欄の前後の空白を除いたものが枝の名前と同じ行）で行が1つ見つかる（試験の M には `.claude-pipeline/active-work.md` と `.claude-pipeline/active-work.d/.gitkeep` を入れておく。Sales Anchor の台本は写さない。本物の ledger-lookup.sh は便2b-3b で動かす）
  - M に `.claude-pipeline/active-work.md` が無い → 投げ、W が無い
  - M の user.email が空 → 投げ、W が無い。W がすでにある → 投げ、すでにある W の中身は消えない。M の origin が `https://x@github.com/…` → 投げ、W が無い。id が UUID でない → 投げる。M の `.git` がシンボリックリンク → 投げる（`checkMainLink`）
  - `checkCaseClone`: 次をそれぞれ1つだけ仕込むと null でない — `W/.git` をシンボリックリンクに替える・`W/.git/commondir` を書く・`W/.git/objects/info/alternates` を書く・`core.hooksPath` を替える・`remote.origin.url` を替える・`core.fsmonitor` を足す。`W/.git/config` に `include.path`（中身に `core.fsmonitor`）を足す・`filter.x.clean` を足す → null でない（審査 90 M-1）。`createCaseClone` で作ったままの写しは null（clone が書く鍵が許す一覧に収まる確かめ）。正しい写しで、試験の process の環境に `GIT_CONFIG_COUNT`（`core.hooksPath=/dev/null`）を足しても null のまま（`--local` で読んでいる確かめ）
- `tests/unit/config.test.ts` に足す: `caseSandbox: true` の正しい役割は読める。`needsWorktree:true`・`reservable` 無し・`resumeCommand` あり・`caseSandbox: "yes"` はそれぞれ起動の誤り。`reserveRoles` に件の役割 → 起動の誤り。`agent-console.config.json` そのものが読めて、`discord-case` が `caseSandbox: true`・`reservable: false`・`resumeCommand` 無し
- `validateLaunchTarget` の試験（今の launch の試験のファイルに足す）: `discord-case` → 断る。`opus-designer` → 今のまま受ける
- `tests/unit/sessions.case.test.ts`（新規。今の sessions の試験の作り（`tests/unit/helpers/harness.ts` など）を使う。`sandboxExecPath`・`caseShellPath`・`caseGuardPath` を一時の置き場の差し替えにする）:
  - （M は case-clone の試験と同じ作りの一時のリポジトリ、`caseHomeDir`・`caseTmpRoot` は一時の置き場）件の役割の `create()` で、W・`D/cases/<id>/settings.json`・`case.json`・T ができ、開いたセッションの id が同じで、cwd が W、`extraEnv` に6つの変数が入る（値は道か印だけ）。様子見（probe）が呼ばれない。Sales Anchor の worktree の作成（`createWorktree`）が呼ばれない
  - 件の役割に枝の名前を渡す → `SessionConflictError`（http で 409）、W ができない
  - 写しの作成が落ちる形（M の `remote.origin.url` を `https://x@github.com/test/repo.git` にする）→ 投げ、`H/worktrees/discord-cases/` の下と `D/cases`・`D/case-gh`・T の置き場に何も残っていない（試験用の差し替えの口は足さない）
  - `sandboxExecPath` が無い → `create()` が `CaseSandboxUnavailableError`、セッション0件、`D/cases/<id>`・`D/case-gh/<id>`・T・W が残っていない。HTTP の作成の入口で 503
  - `restore()` で settings.json が無い id → 投げる。`case.json` の worktree と違う `cwd` → 投げる。`case.json` の `report` が無い → 投げる。`case.json` の `tmp` が無い → 投げる
  - `server/restore.ts` の起こし直し: 件の項目で、cwd が `case.json` の worktree と違う → `missingCwd`。`W/.git/commondir` を書いた写し → `missingCwd`。正しい写し → 開く（`classifyCwd` を通らない）。件でない項目は今のまま
  - `resume()` → `role cannot resume sessions`
  - 件でない役割は今のまま開く（確かめを通らない。`restore()` の probe も今のまま）
- `tests/unit/ccdiscord-zsh.test.ts`（新規。`zsh -c 'source <ccdiscord.zsh> && ccdiscordcase'` を、差し替えの `claude`（`--version` には決めた版を出し、それ以外は受けた引数を印のファイルに書く）・`gh`（作り物の値を出す）と一時の HOME で動かす）:
  - 正しい条件で、`claude` の引数に `--restricted`・`--tools Bash,Read,Edit,Write,Glob,Grep,Agent,TodoWrite`・`--add-dir <R>`・`--permission-mode dontAsk`・`--settings <道>`・`--strict-mcp-config`・`--disallowedTools mcp__* WebFetch WebSearch` があり、`--chrome`・`--setting-sources` が無い。作り物のトークンの値が引数に無い（環境変数だけ）
  - 差し替えの `claude` が受けた環境の `GIT_CONFIG_COUNT` が 3 で、`GIT_CONFIG_KEY_2=core.fsmonitor`・`GIT_CONFIG_VALUE_2=false`
  - `AC_RESUME_ID` が UUID → `--resume <id>`。形が違う → 付かない
  - 差し替えの `claude` が受けた環境の `CLAUDE_CODE_TMPDIR` が `AC_CASE_TMP` と同じ
  - 版が 2.1.294 → 2。2.1.295 → 開く。2.10.0 → 開く（数で比べている確かめ）。版が読めない → 2
  - `AC_CASE_SETTINGS` が空・`AC_CASE_REPORT` が空・`AC_CASE_TMP` が空・`AC_SANDBOX_EXEC` が無い道・指示書の片方が無い・`gh` が空を返す → どれも 2 で、`claude` の印ができない
- `tests/unit/ac-discord-secret.test.ts`: 6つの it の `AC_OSASCRIPT: fakeOsascript(...)` を `AC_SECRET_INPUT: <一時のファイル>`（中身はその it の値と改行）に置き換え、`AC_STUB_LOG` も一時の置き場に設定する。取り消しの it は、中身が空のファイル（`read` が失敗する）にする。期待（保存・出ない・拒否・確かめ）は変えない。`fakeOsascript` の関数は消す。1つ足す: `AC_STUB_LOG` が無く `AC_SECRET_INPUT` だけがあるとき、そのファイルを読まない（端末の無い試験では取り消しになり、保存の印ができない）
- `tests/unit/git-safe.test.ts` に足す: `G/commondir` がシンボリックリンク（中身が C を指す）→ 落ちる（L-2）。G の `gitdir` がシンボリックリンク → 落ちる（L-e）。W の `.git` の実体が無い（`realOrNull(dotgit)` が null）→ 落ちる（L-1）
- `tests/unit/diff.integration.test.ts` の L-main: `expect([409, 500]).toContain(...)` を `expect(res.status).toBe(409)` にし、本文に `git link check failed` を含むことを足す（L-4）
- `tests/unit/pr.integration.test.ts`: v0.46.2 の fsmonitor の試験（`git show f4e14c8:tests/unit/pr.integration.test.ts` の :504-524）を、今の commondir の試験とは別の it として戻す（L-5）。今の commondir の試験はそのまま残す
- これらがすべて `npm test`（`.github/workflows/ci.yml`）で走ることを確かめる

## 完了の確認（生出力を /tmp/CC報告ファイル/discord-pdca-bin2/82-impl2b3a/ に保存）
1. `npm run typecheck`  2. `npm run lint`  3. `npx vitest run tests/unit/case-sandbox.test.ts tests/unit/case-clone.test.ts tests/unit/case-guard.test.ts tests/unit/config.test.ts tests/unit/sessions.case.test.ts tests/unit/ccdiscord-zsh.test.ts tests/unit/ac-discord-secret.test.ts tests/unit/git-safe.test.ts tests/unit/diff.integration.test.ts tests/unit/pr.integration.test.ts` と launch の試験のファイル  4. `npm test`
5. 見分ける力の確かめ（それぞれ一時的に外して 3 を走らせ、落ちることを確かめてから戻す。生出力も保存。戻した後の `git diff` で外した跡が無いこと）:
   - `spawnSession` の件の確かめを外す → sessions.case の 503 と restore の試験が落ちる
   - case-guard の 1. の「それ以外は止める」を「通す」に替える → W の外の Edit の試験が落ちる
   - case-guard の 2. の許す一覧を外す（拒否の一覧だけにする）→ Grep の祖先の試験が落ちる
   - case-guard の 4. の鍵の検査を外す → Agent の `isolation` の試験が落ちる
   - case-guard のハードリンクの検査を外す → ハードリンクの試験が落ちる
   - `buildCaseSettings` の Edit の deny を `CASE_DENY_WRITE` でない手書きの配列（1つ少ない）にする → 正本1つの試験が落ちる
   - ccdiscord.zsh の `--restricted` を外す → 引数の試験が落ちる
   - case-guard のハードリンクの検査の `isFile()` を外す → Grep の `path` が W の試験と Glob の `W/src` の試験が落ちる
   - `checkCaseClone` の ②（commondir・alternates）を外す → その試験と restore の commondir の試験が落ちる
   - `createCaseClone` の ③ を M の手元の main に替える → HEAD の sha の試験が落ちる
   - `createCaseClone` の `--no-hardlinks` を外す → pack のリンクの数の試験が落ちる
   - ccdiscord.zsh の `CLAUDE_CODE_TMPDIR` を外す → その試験が落ちる
   - `checkCaseClone` の ④⑥ を `--local` 無しに戻す（`-c` を付ける形）→ 環境に `GIT_CONFIG_COUNT` を足した試験が落ちる
   - `createCaseClone` の ⑩ を外す → 台帳の試験が落ちる
   - `checkCaseClone` の ⑥ を `core.fsmonitor` だけの確かめに戻す → `include.path` と `filter.x.clean` の試験が落ちる
   - case-guard の判定 2. から `tmp` を外す → T の中の Read の試験が落ちる
   - `create()` の片付けで常に `tmp: true` を渡す → すでにあった T が消えない試験が落ちる
   - `createCaseClone` の ⑦' を外す → 上流の試験が落ちる
   - `CASE_DENY_READ_SANDBOX` から P を外す → その試験が落ちる
   - `workplace.ts` の本店の確かめを外す → L-main が落ちる
6. 1コミット（共著者行 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）、PR は `--base main`、本文に「この指示書のどこを満たしたか」「本物のセッションは開いていない（便2b-3b）」「Evaluator は画面のファイル変更が言葉1つのため省く」「触ったファイルの全部（docs を含む）」を書く

## 想定分岐
- セッションを開く道が4つ以外にあった・`spawnSession` を通らない道があった → 作らずに止まって報告する
- `needsWorktree: false` の役割を「本店で開く役割」として扱う所（cwd を本店にする・再開の範囲を main にする・画面の表示）が `create()` のほかにあった → 件の役割をそこから外す最小の直し（`caseSandbox` を見て先に分ける）を入れ、PR 本文に書く。直しが3か所を超えるなら止まって報告
- `server/restore.ts` の照らしの流れが同期で `await` を入れられない → 形を大きく変えずに入れられないなら止まって報告
- http の作成の入口や画面に、写しの作成（20秒ほど）より短い待ちの上限がある → 上限を変えずに止まって報告
- `createCaseClone` で作ったままの写しの `W/.git/config` に、許す一覧に無い鍵が入る（git の版による）→ 一覧を広げずに止まって、鍵の名前と生出力を報告する
- 試験の M の `.claude-pipeline/active-work.md` を git に入れると、ほかの試験（M を使う既存の試験の作り）が変わる → 件の試験の M だけに入れる。既存の試験の作りは変えない
- 試験の環境で `GIT_CONFIG_COUNT` の insteadOf が `git clone --local` に効かない（M からの写しは本店の道を使うので本来は要らない。要るのは M の fetch だけ）→ M の fetch だけに効いているかを生出力で示し、効かなければ止まって報告
- CI が ubuntu で `zsh` が無い → `ci.yml` の該当の job に `sudo apt-get install -y zsh` の1段を足す（試験を飛ばさない）。足すと決めたことを PR 本文に書く
- tmux の `newSession` が `extraEnv` を受け取らない形だった・direct（node-pty）の道で `extraEnv` が渡らない → 両方に渡す最小の直しを入れ、PR 本文に書く。直しが3行を超えるなら止まって報告
- `hooks` の `command` と `args` の形が今の Claude Code の設定の型で通らない（試験で設定を読む道が無いので、公式資料 doc-hooks.md:902-945 の例と、`buildHandler` の形と同じにする）→ 例と違う形にしない。迷ったら止まって報告
- `addHandlers` が空の設定 `{}` を受け取れない・`hookPathIn` が `server/activity-setup.ts` から出ていない → 形を変えずに使える呼び方を探し、無ければ止まって報告（手でフックの一覧を写さない）
- realpath が macOS の `/private` 付きと無しで食い違う → 比べる両方を realpath にそろえる（文字列の手直しはしない）
- 既存の試験が新しい確かめで落ちる → 確かめを緩めずに止まって、どの条件で落ちたかを報告する
- `role.discordCase` を足すと言葉のファイルの数の検査（キーの一致）が落ちる → ほかの言語ファイルにも同じキーを足す
- `validateLaunchTarget` の誤りの返し方が役割ごとの理由を持てない形だった → 今の返し方の中で最小の形にし、PR 本文に書く
- CI の macOS で既存の不安定な試験が落ちる → 同じ試験が main でも落ちているかを `gh run list` で確かめ、PR 本文に書く
