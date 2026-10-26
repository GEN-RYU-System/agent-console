# 便2b-3a 件のセッションの囲いの設定・Claude の道具の見張り・役割 discord-case と起動関数・秘密の登録の入力の直し（v0.46.4）作る係への指示書

- 設計: `docs/handoff/discord-pdca/design.md` 第15版 §4-5（「Claude の道具の囲い」・「外への通信を塞ぐ」・(a') の書ける場所・「読み取りの拒否の書き方」・起動コマンド・gh の名義・使えない状態の扱い）・§8 便2b-3a・§9 K17・§15。ADR-1039（Sales Anchor・Accepted）
- 目的: ①件のセッション（役割 `discord-case`）を開くとき、サーバーが件ごとの設定（権限・囲い・見張りのフック）を作り、それが無ければ開かない。②Claude の Read・Edit・Write などの道具も、件の worktree と報告の置き場の外へは書けず、秘密の置き場は読めない（囲いは Bash にしか効かず、PO のユーザー設定に道を付けない許可があるため）。③秘密の登録の台本（`scripts/ac-discord-secret.sh`）を、貼り付けが効かなかった入力画面から、端末で打つ読み取りに替える。④PR #80 の審査の LOW（L-1・L-2・L-4・L-5）を直す
- この便に入れないもの: 本物のセッションを開く試験（K11・K13・K17。便2b-3b。お金が掛かる）、`discord-measure`（便3）、受け口からの起動・順番待ちの消化・`launch_failed` の出来事・指示書 `S:docs/ai-agents/ops-incident-agent.md`（便2b-4）、件の設定の片付け（便2b-4）。今ある役割（opus-designer・sonnet-impl・shell）の振る舞いは変えない
- 入れる順番: 作る係は PR を作るところまで。審査・マージ・タグ・入れるのは設計者
- 調べた実物（origin/main bb8c0c4 = v0.46.3。生の写し /tmp/CC報告ファイル/discord-pdca-bin2/81-recon2b3/raw-opus12.txt・raw-opus13.txt）:
  - `server/config.ts:5-21` の `RoleConfig`（`command`・`needsWorktree`・`resumeCommand?`・`resumeScope?`・`restoreCommand?`・`reservable?`）、:143-165 の `parseRole`（:152 `reservable` の型の検査、:153 `base`、:155-157 `resumeScope requires resumeCommand`）
  - `server/sessions.ts:183-192` の constructor（`options: SessionManagerOptions`）、:264-287 `create()`（:279 `createWorktree`、:281 `spawnSession(name, role, branch, cwd)`）、:293-298 `resume()`（:295 `role cannot resume sessions`）、:304-313 `createAccountLogin()`、:324-335 `restore()`（同期。:331 で `knownId` を渡す）、:380-434 `spawnSession`（:390 で id を決め、:391 `openTerminal`）、:440-468 `openTerminal`（tmux のとき :458 で `extraEnv` を `newSession` の env に入れる。env は tmux の引数に載る）
  - `server/git-safe.ts:37-43` `readLinkTarget`（`readFile` がシンボリックリンクを辿る）、:69（`readLinkTarget(G/gitdir)` と `realOrNull(dotgit)` がどちらも null だと一致扱い）
  - `scripts/ac-discord-secret.sh:18`（`osascript` の入力画面）、:22-32（空・空白・引用符・バックスラッシュの拒否）、:34-37（`security -i` で保存・`find-generic-password` で確かめ）
  - `tests/unit/ac-discord-secret.test.ts`（6つの it。`AC_OSASCRIPT` で入力画面を差し替え）
  - `tests/unit/diff.integration.test.ts:489` 付近（L-main。`expect([409, 500]).toContain(...)`）。PR #80 の審査 L-4: 今の実装では本店の確かめが一覧の例外になり必ず 500
  - `tests/unit/pr.integration.test.ts:505-531`（PR #80 で fsmonitor の試験を commondir の試験に置き換えた。fsmonitor の試験は v0.46.2 の `git show f4e14c8:tests/unit/pr.integration.test.ts` の :504-524 にある）
  - `agent-console.config.json:32-52` の roles（opus-designer・sonnet-impl・shell）
  - ccopusgo の形（PO の `~/.claude/shell/ccopusgo.zsh`。写し raw-ccopusgo.txt）: 指示書2つの読めること・空でないことを確かめ、`"\n\n"` でつないで `--append-system-prompt` に渡す
  - 公式資料（Context7 は月の上限で使えず、直接読んだ。/tmp/CC報告ファイル/discord-pdca-bin2/81-recon2b3/doc-*）: フックの `onFailure: "block"`（doc-hooks.md:902-945。v2.1.295 以降。手元 2.1.310）、止めるフックは許可の規則より先に効く（doc-permissions.txt:653）、Write・Edit・Read の入力の道は `file_path`（doc-hooks.md:1830-1858）

## 決めたこと
- 道の記号（どれも realpath にそろえる）: M = 本店（`config.salesanchorRoot`）、W = 件の worktree、G = W の gitdir（W の `.git` の1行 `gitdir: <G>` を W 起点で解いた realpath）、D = `config.dataDir`、H = `os.homedir()`、R = `realpath(os.tmpdir() ではなく "/tmp")` + `/CC報告ファイル/discord-case/<セッション id>`（macOS では `/private/tmp/...`）
- 新しいファイル `server/case-sandbox.ts`（純粋な関数と、ファイルを書く関数を分ける）:
  - `export const CASE_DENY_WRITE = (p) => [...]`: `M/.git/hooks`・`M/.git/config`・`G/commondir`・`G/gitdir`・`G/config`・`G/config.worktree`・`W/.git`・`D/cases`・`D/case-gh`。囲いの `filesystem.denyWrite` と権限の `Edit(//…)` の deny の両方をこの1つの配列から作る（正本は1つ）
  - `export const CASE_DENY_READ = (p) => [...]`: `D/reserve-token`・`H/.claude-access.env`・`H/.claude/channels`・`H/.claude/projects`・`H/Library/Keychains`・`H/.config/gh`・`D/cases`。囲いの `filesystem.denyRead` と権限の `Read(//…)` の deny の両方をこの1つの配列から作る
  - `export const CASE_ALLOW_WRITE = (p) => [...]`: `W`・`R`・`M/.git/objects`・`M/.git/refs`・`M/.git/logs`・`M/.git/packed-refs`・`M/.git/packed-refs.lock`・`M/.git/gc.pid`・`M/.git/gc.log`・`G`（設計 §4-5 (a')）
  - `export const CASE_ALLOWED_DOMAINS = ["api.github.com","github.com","api.salesanchor.jp","127.0.0.1","localhost"]`
  - `export function buildCaseSettings(p): object`（p は M・W・G・D・H・R・`guardScript`・`nodeBin`・`caseFile`）。返す形:
    - `permissions.defaultMode: "dontAsk"`、`permissions.disableBypassPermissionsMode: "disable"`、上の段の `disableAutoMode: "disable"`
    - `permissions.allow`: `Bash`・`Agent`・`Edit(//<W>/**)`・`Edit(//<R>/**)`・`Read(//<R>/**)`（絶対の道は先頭を `//` にする。`<W>` は先頭の `/` を除いた realpath をつなぐ）
    - `permissions.deny`: `CASE_DENY_WRITE` の各道の `Edit(//<道>/**)` と `Edit(//<道>)`、`CASE_DENY_READ` の各道の `Read(//<道>/**)` と `Read(//<道>)`、`Bash(security *)`・`Bash(security)`・`Bash(gh auth *)`・`Bash(gh auth)`・`Bash(gh pr merge *)`・`Bash(gh pr merge)`・`Bash(ac-reserve *)`・`Bash(ac-reserve)`・`Bash(ac-routine *)`・`Bash(ac-routine)`
    - `sandbox`: `enabled: true`・`failIfUnavailable: true`・`allowUnsandboxedCommands: false`・`enableWeakerNetworkIsolation: true`・`network.allowedDomains: CASE_ALLOWED_DOMAINS`・`network.strictAllowlist: true`・`network.allowLocalBinding: true`・`network.allowMachLookup: ["com.apple.SecurityServer","com.apple.securityd*"]`・`filesystem.allowWrite: CASE_ALLOW_WRITE`・`filesystem.denyWrite: CASE_DENY_WRITE`・`filesystem.denyRead: CASE_DENY_READ`
    - `hooks.PreToolUse`: `[{ matcher: "*", hooks: [{ type: "command", command: nodeBin, args: [guardScript, caseFile], onFailure: "block", timeout: 10 }] }]`
  - `export async function writeCaseFiles(p, sessionId): Promise<{ settingsPath, ghDir, caseFile }>`: `D/cases/<id>/settings.json`（`buildCaseSettings` の結果）、`D/cases/<id>/case.json`（`{ worktree: W, report: R, allowWrite: CASE_ALLOW_WRITE, denyWrite: CASE_DENY_WRITE, denyRead: CASE_DENY_READ }`。見張りのフックが読む）、`D/case-gh/<id>/config.yml`（`version: "1"` の1行）、`D/case-gh/<id>/hosts.yml`（`github.com:` の下に `user: shingo-cc` と `users:` の `shingo-cc:` だけ。トークンは書かない）を作り、R の置き場を作る。ディレクトリは 0o700、ファイルは 0o600。`D/case-gh` は件のセッションの gh が読むので `CASE_DENY_READ` に入れない（書けないように `CASE_DENY_WRITE` には入れる）
  - `export function gitdirOf(W): string`（W の `.git` の1行を読み、realpath にして返す。形が違えば例外。`checkGitLink` を通ったあとでだけ呼ぶ）
- 新しいファイル `ops/case/case-guard.mjs`（見張りのフック。node だけで動き、依存を足さない）:
  - 引数1つ（case.json の道）。標準入力の JSON の `tool_name` と `tool_input` を読む。どこかで例外になれば終了の番号 2（`onFailure: "block"` にも重ねる）。止めるときは理由の短い英語を標準エラーに1行出して終了の番号 2、通すときは何も出さず 0
  - 判定（上から順に）:
    1. `tool_name` が `Edit`・`Write`・`NotebookEdit`: 道は `tool_input.file_path`、無ければ `tool_input.notebook_path`。文字列でない・絶対の道でない → 止める。道の本物の場所（無いファイルは一番近いある親の realpath に残りの名前をつなぐ）が `case.json` の `denyWrite` のどれかの下（同じか、その下）なら止める。`worktree` か `report` の下なら通す。それ以外は止める
    2. `Read`・`Glob`・`Grep`: 道は `tool_input.file_path`（Read）、`tool_input.path`（Glob・Grep。無ければ通す＝作業場所 W で動く）。Glob の `tool_input.pattern` が `/` か `~` で始まる、または `..` を含む → 止める。道の本物の場所が `denyRead` のどれかの下 → 止める。それ以外は通す
    3. 名前が `mcp__` で始まる、`WebFetch`・`WebSearch` → 止める
    4. `Bash`・`Agent`・`Task`・`TodoWrite`・`ToolSearch` → 通す
    5. それ以外の名前 → 止める（知らない道具は通さない）
- `server/config.ts`: `RoleConfig` に `caseSandbox?: boolean` を足す（説明の注釈を1行）。`parseRole` で、`r.caseSandbox !== undefined && typeof r.caseSandbox !== "boolean"` は起動の誤り。`caseSandbox === true` のとき、`needsWorktree` が true でない・`reservable` が false でない・`resumeCommand` か `resumeScope` がある、のどれかなら起動の誤り（`config: roles[i] caseSandbox requires needsWorktree, reservable:false and no resumeCommand`）。`reserveRoles`・`routineManagerRoles` に `caseSandbox` の役割が入っていたら起動の誤り
- `server/sessions.ts`:
  - `SessionManagerOptions` に `sandboxExecPath?: string`（試験用。既定 `/usr/bin/sandbox-exec`）と `caseShellPath?: string`（試験用。既定 `realpath(process.cwd())/ops/shell/ccdiscord.zsh`）を足す。`caseGuardPath`（既定 `realpath(process.cwd())/ops/case/case-guard.mjs`）も同じく
  - `create()`: 役割が `caseSandbox` のとき、`createWorktree` のあと、`const id = randomUUID()` を決め、`checkGitLink(cwd, M)` が null でなければ `SessionConflictError`、`writeCaseFiles(...)` を呼び、`spawnSession(name, role, branch, cwd, role.command, caseEnv, undefined, id)` で開く
  - `spawnSession` の頭（:390 で id を決めた直後、`openTerminal` の前）に、`role.caseSandbox === true` のときの確かめを置く。①`D/cases/<id>/settings.json` と `case.json` がある ②`realpath(cwd)` が `case.json` の `worktree` と同じ ③`sandboxExecPath` が実行できる（`accessSync(…, X_OK)`）④`caseShellPath` と `caseGuardPath` が読める。1つでも落ちたら `CaseSandboxUnavailableError("sandbox unavailable: <理由>")` を投げる（新しい誤りの型。http の層で 503）。通ったら `extraEnv` に `AC_CASE_SETTINGS`（settings.json の道）・`AC_CASE_GH_DIR`（`D/case-gh/<id>`）・`AC_CASE_SHELL`（`caseShellPath`）・`AC_DISCORD_CASE`（`manual-<id>:1`）を足す（どれも道か印だけ。秘密は入れない）。この確かめは `create`・`resume`・`restore`・`createAccountLogin` のどの道からも通る
  - `resume()` は今のまま（件の役割は `resumeCommand` を持たないので :295 で拒まれる）
- `server/http.ts`: `CaseSandboxUnavailableError` を 503 と本文 `{ error: "sandbox unavailable" }` に変える（今の誤りの型を http に変える所と同じ形で1つ足す）
- `server/workplace.ts`: `listWorktreeEntries` を呼ぶ前に `checkMainLink(root)` を呼び、null でなければ `SessionConflictError(\`git link check failed: ${reason}\`)`（409。設計 §4-5「落ちたとき」）。これで L-main が 409 の1通りになる
- `server/git-safe.ts`:
  - L-2: `readLinkTarget` の頭で `lstat(file)` が本物のファイル（シンボリックリンクでない）でなければ null
  - L-1: :69 の比べの前に `realOrNull(dotgit)` を変数に取り、null なら `"gitdir back-link mismatch"` を返す
- 新しいファイル `ops/shell/ccdiscord.zsh`（`ccdiscordcase` 関数1つ。`ccopusgo` と同じ作りで、違いは次のとおり）:
  - 引数は受け取らない。`AC_CASE_SETTINGS`・`AC_CASE_GH_DIR` が空・読めない、`${AC_SANDBOX_EXEC:-/usr/bin/sandbox-exec}` が実行できない、指示書 `~/.claude/prompts/salesanchor-designer.md`・`~/.claude/prompts/salesanchor-ops-incident-agent.md` のどちらかが読めない・空、のどれかなら、理由を標準エラーに1行出して 2 で終わる（claude を開かない）
  - 囲いの外で `GH_TOKEN="$(gh auth token -u shingo-cc)"` を取り、空なら 2 で終わる。`export GH_TOKEN GH_CONFIG_DIR="$AC_CASE_GH_DIR" GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='!gh auth git-credential'`。値を画面・記録に出さない（`set -x` を使わない）
  - `cd` しない。`command claude --model opus --effort medium --permission-mode dontAsk --settings "$AC_CASE_SETTINGS" --disallowedTools WebFetch WebSearch --strict-mcp-config --append-system-prompt "$prompt"`。`AC_RESUME_ID` が UUID の形なら `--resume "$AC_RESUME_ID"` を足す（形が違えば足さずに新しい会話）。`--chrome` は付けない。`claude` の場所は `${AC_CLAUDE_BIN:-claude}`（試験用）
- `agent-console.config.json` の roles に足す: `{ "id": "discord-case", "labelKey": "role.discordCase", "command": ["/bin/zsh", "-c", "source \"$AC_CASE_SHELL\" && ccdiscordcase"], "restoreCommand": ["/bin/zsh", "-c", "source \"$AC_CASE_SHELL\" && ccdiscordcase"], "needsWorktree": true, "reservable": false, "caseSandbox": true }`。`-i` は付けない（PO の `~/.zshrc` を読ませない）。`src/locales/ja.json` に `role.discordCase` の言葉（例「不具合の件（Discord）」）を1つ足す（ほかの言語ファイルがあれば同じキー）
- `scripts/ac-discord-secret.sh`: :18-20 を置き換える。案内を標準エラーに出し、`IFS= read -rs value < "${AC_SECRET_INPUT:-/dev/tty}"` で受ける（打った文字は画面に出ない）。読めなかったら「取り消しました（保存していません）」。読んだあと標準エラーに改行を1つ。:4 の注釈を「値は端末で受け取り（画面に出さない）」に直す。:22 以降の拒否・保存・確かめは変えない。`AC_SECRET_INPUT` が `ac_guard_test_paths` の守りの対象になるかを `scripts/lib/ac-common.sh` で確かめ、ほかの差し替え（`AC_OSASCRIPT`）と同じ扱いにする
- 版を 0.46.4 に（`package.json`・`package-lock.json` の2か所・`extension/manifest.json`）。`docs/CHANGELOG.md` に1行（件の役割 discord-case と囲いの設定・Claude の道具の見張り・秘密の登録を端末の入力に変更・git の繋がりの確かめの直し・戻し方 `bash scripts/ac-update.sh v0.46.3`）。README に、件の役割の節（何を塞ぐか・設定の置き場・使えないときは 503 で開かない・秘密の登録は端末で打つ）を足す

## 守ること
- 下に書いた変更だけ。今ある役割・入口の振る舞いと、既存の試験の期待は変えない（下の「試験」で書き換えると書いたものを除く）
- 作り物の置き場・印は `os.tmpdir()` の下に作り、試験の終わりに消す。本物の `~/Library/Application Support/agent-console`・`~/.claude`・Keychain には触らない
- 本物の claude・gh・security を試験で動かさない（差し替えの台本を使う）
- 実装の前に確かめる（生出力を保存）: `grep -rn "spawnSession\|\.restore(\|\.resume(\|createAccountLogin\|SessionConflictError" server/` で、セッションを開く道が上の「調べた実物」の4つだけで、どれも `spawnSession` を通ること。違う道があれば作らずに止まって報告する。`.github/workflows/ci.yml` の動く OS と、`zsh` があるか

## 変更
1. `server/case-sandbox.ts`（新規）
2. `ops/case/case-guard.mjs`（新規）
3. `ops/shell/ccdiscord.zsh`（新規）
4. `server/config.ts`: `caseSandbox`
5. `server/sessions.ts`: options・`create()`・`spawnSession` の確かめ
6. `server/http.ts`: 503
7. `server/workplace.ts`: 本店の確かめを先に
8. `server/git-safe.ts`: L-1・L-2
9. `scripts/ac-discord-secret.sh`: 端末の入力
10. `agent-console.config.json`・`src/locales/ja.json`: 役割 discord-case
11. 版の置き場・`docs/CHANGELOG.md`・README
12. 下の試験

## 試験
- `tests/unit/case-sandbox.test.ts`（新規）:
  - `buildCaseSettings` の `permissions.deny` の Edit の道の集まりが `CASE_DENY_WRITE` と、Read の道の集まりが `CASE_DENY_READ` と、`sandbox.filesystem.denyWrite`・`denyRead` がそれぞれ同じ配列と一致する（正本1つの確かめ）
  - `defaultMode` が `dontAsk`、`disableBypassPermissionsMode`・`disableAutoMode` が `disable`、`allow` に道を付けない `Edit`・`Write`・`Read`・`WebFetch`・`WebSearch` が無い
  - フックが `matcher: "*"`・`onFailure: "block"`・`args[1]` が case.json の道
  - `allowWrite` に `M/.git` そのもの・`M/.git/config`・`M/.git/hooks` が無く、(a') の一覧がそろう。`allowedDomains` が5つだけ
  - `writeCaseFiles`: 4つのファイルができ、権限が 0o600、`hosts.yml` に `shingo-cc` だけで `oauth_token` を含まない
- `tests/unit/case-guard.test.ts`（新規。`spawnSync(process.execPath, [guard, caseFile], { input })` で動かす。W・R・偽の D・偽の H は一時の置き場）:
  - Edit・Write: W の中のファイル（ある・まだ無い）→ 0。R の中 → 0。W の外（偽の H の下）→ 2。`W/.git` → 2。G の `commondir` → 2。W の中のシンボリックリンクが W の外を指す → 2。相対の道 → 2。`file_path` 無し → 2
  - NotebookEdit: `notebook_path` が W の中 → 0、外 → 2
  - Read: 偽の `D/reserve-token` → 2。偽の `H/.claude/projects/x` → 2。W の中 → 0。Grep の `path` が偽の `H/Library/Keychains` → 2。Glob の `pattern` が `/etc/**` → 2、`src/**` → 0
  - `mcp__x__y`・`WebFetch` → 2。`Bash`・`Agent` → 0。知らない名前（`EnterWorktree`）→ 2
  - 壊れた JSON・case.json が無い → 2
- `tests/unit/config.test.ts` に足す: `caseSandbox: true` の正しい役割は読める。`needsWorktree:false`・`reservable` 無し・`resumeCommand` あり・`caseSandbox: "yes"` はそれぞれ起動の誤り。`reserveRoles` に件の役割 → 起動の誤り。`agent-console.config.json` そのものが読めて、`discord-case` が `caseSandbox: true`・`reservable: false`・`resumeCommand` 無し
- `tests/unit/sessions.case.test.ts`（新規。今の sessions の試験の作り（`tests/unit/helpers/harness.ts` など）を使う。`sandboxExecPath`・`caseShellPath`・`caseGuardPath` を一時の置き場の差し替えにする）:
  - 件の役割の `create()` で、`D/cases/<id>/settings.json`・`case.json` ができ、開いたセッションの id が同じで、`extraEnv` に4つの変数が入る（値は道か印だけ）
  - `sandboxExecPath` が無い → `create()` が `CaseSandboxUnavailableError`、セッション0件。HTTP の作成の入口で 503
  - `restore()` で settings.json が無い id → 投げる。`case.json` の worktree と違う `cwd` → 投げる
  - `resume()` → `role cannot resume sessions`
  - 件でない役割は今のまま開く（確かめを通らない）
- `tests/unit/ccdiscord-zsh.test.ts`（新規。`zsh -c 'source <ccdiscord.zsh> && ccdiscordcase'` を、差し替えの `claude`（受けた引数を印のファイルに書く）・`gh`（作り物の値を出す）と一時の HOME で動かす）:
  - 正しい条件で、`claude` の引数に `--permission-mode dontAsk`・`--settings <道>`・`--strict-mcp-config`・`--disallowedTools WebFetch WebSearch` があり、`--chrome` が無い。作り物のトークンの値が引数に無い（環境変数だけ）
  - `AC_RESUME_ID` が UUID → `--resume <id>`。形が違う → 付かない
  - `AC_CASE_SETTINGS` が空・`AC_SANDBOX_EXEC` が無い道・指示書の片方が無い・`gh` が空を返す → どれも 2 で、`claude` の印ができない
- `tests/unit/ac-discord-secret.test.ts`: 6つの it の `AC_OSASCRIPT: fakeOsascript(...)` を `AC_SECRET_INPUT: <一時のファイル>`（中身はその it の値と改行）に置き換える。取り消しの it は、中身が空のファイル（`read` が失敗する）にする。期待（保存・出ない・拒否・確かめ）は変えない。`fakeOsascript` の関数は消す
- `tests/unit/git-safe.test.ts` に足す: `G/commondir` がシンボリックリンク（中身が C を指す）→ 落ちる（L-2）
- `tests/unit/diff.integration.test.ts` の L-main: `expect([409, 500]).toContain(...)` を `expect(res.status).toBe(409)` にし、本文に `git link check failed` を含むことを足す（L-4）
- `tests/unit/pr.integration.test.ts`: v0.46.2 の fsmonitor の試験（`git show f4e14c8:tests/unit/pr.integration.test.ts` の :504-524）を、今の commondir の試験とは別の it として戻す（L-5）。今の commondir の試験はそのまま残す
- これらがすべて `npm test`（`.github/workflows/ci.yml`）で走ることを確かめる

## 完了の確認（生出力を /tmp/CC報告ファイル/discord-pdca-bin2/82-impl2b3a/ に保存）
1. `npm run typecheck`  2. `npm run lint`  3. `npx vitest run tests/unit/case-sandbox.test.ts tests/unit/case-guard.test.ts tests/unit/config.test.ts tests/unit/sessions.case.test.ts tests/unit/ccdiscord-zsh.test.ts tests/unit/ac-discord-secret.test.ts tests/unit/git-safe.test.ts tests/unit/diff.integration.test.ts tests/unit/pr.integration.test.ts`  4. `npm test`
5. 見分ける力の確かめ（それぞれ一時的に外して 3 を走らせ、落ちることを確かめてから戻す。生出力も保存。戻した後の `git diff` で外した跡が無いこと）:
   - `spawnSession` の件の確かめを外す → sessions.case の 503 と restore の試験が落ちる
   - case-guard の 1. の「それ以外は止める」を「通す」に替える → W の外の Edit の試験が落ちる
   - `buildCaseSettings` の Edit の deny を `CASE_DENY_WRITE` でない手書きの配列（1つ少ない）にする → 正本1つの試験が落ちる
   - `workplace.ts` の本店の確かめを外す → L-main が落ちる
6. 1コミット（共著者行 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）、PR は `--base main`、本文に「この指示書のどこを満たしたか」「本物のセッションは開いていない（便2b-3b）」「Evaluator は画面のファイル変更が言葉1つのため省く」「触ったファイルの全部（docs を含む）」を書く

## 想定分岐
- セッションを開く道が4つ以外にあった・`spawnSession` を通らない道があった → 作らずに止まって報告する
- CI が ubuntu で `zsh` が無い → `ci.yml` の該当の job に `sudo apt-get install -y zsh` の1段を足す（試験を飛ばさない）。足すと決めたことを PR 本文に書く
- tmux の `newSession` が `extraEnv` を受け取らない形だった・direct（node-pty）の道で `extraEnv` が渡らない → 両方に渡す最小の直しを入れ、PR 本文に書く。直しが3行を超えるなら止まって報告
- `hooks` の `command` と `args` の形が今の Claude Code の設定の型で通らない（試験で設定を読む道が無いので、公式資料 doc-hooks.md:902-945 の例と同じ形にする）→ 例と違う形にしない。迷ったら止まって報告
- realpath が macOS の `/private` 付きと無しで食い違う → 比べる両方を realpath にそろえる（文字列の手直しはしない）
- `ac_guard_test_paths` が `AC_SECRET_INPUT` の差し替えを本番で拒まない作りだった → 本番（`AC_HOME` が試験用でない）では `AC_SECRET_INPUT` を無視して `/dev/tty` を使う形にし、PR 本文に書く
- 既存の試験が新しい確かめで落ちる → 確かめを緩めずに止まって、どの条件で落ちたかを報告する
- `role.discordCase` を足すと言葉のファイルの数の検査（キーの一致）が落ちる → ほかの言語ファイルにも同じキーを足す
- CI の macOS で既存の不安定な試験が落ちる → 同じ試験が main でも落ちているかを `gh run list` で確かめ、PR 本文に書く
