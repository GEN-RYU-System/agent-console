# board-guard recon（現在地の事実）

- f255892 時点の事実: design.md §0（工程0の実測は §11）。
- origin/main de5b053（v0.31.0）を合流した後（904256c）の file:line 照合を下に写す（Sonnet 調査、2026-10-15。生出力 /tmp/CC報告ファイル/board-guard/）。
- 既存 ADR: agent-console に専用 ADR は無い（ADR-027 のみ参照）。

# board-guard 設計書の行番号引用 照合結果

- 対象: ~/agent-console-wt/board-guard、ブランチ release/board-guard
- マージ前 HEAD 67a3bda、origin/main de5b053（PR #46）をマージ → マージコミット 904256c（衝突なし、push なし）
- 比較基準: 設計書の f255892 と、現在の HEAD 904256c
- 生出力: merge-raw.txt（git status・fetch・merge）、raw-cites.txt（f255892 側の引用行）、raw-new.txt（HEAD 側の grep）、files-changed.txt（git log f255892..HEAD）
- マージ前の git status --short は空（作業ツリーきれい）。空き容量は df で 7GiB。

## A. 変更の有無（f255892..HEAD、`git log --oneline f255892..HEAD -- <file>`）
| ファイル | 変わったか | コミット |
|---|---|---|
| hooks/board-guard.mjs | 存在しない（新規予定）。履歴0件 | - |
| scripts/board-coverage.mjs | 存在しない（新規予定）。履歴0件 | - |
| hooks/ac-board.mjs | 変更なし（0件） | - |
| hooks/activity-hook.mjs | 変更あり | eb7968b |
| server/activity-hooks.ts | 変更あり | 43fe96b, 062cf74, 339bf00, eb7968b |
| server/activity-setup.ts | 変更あり | 339bf00, 5995c65 |
| server/activity-start.ts | 変更あり | 339bf00, 5995c65 |
| scripts/ac-hooks.mjs | 変更あり | 062cf74, 844be01, 339bf00 |
| tests/unit/activity-hooks.test.ts | 変更あり | 43fe96b, 062cf74, 844be01, 339bf00, eb7968b |
| server/sessions.ts | 変更あり | dc0060e, 60e865e, 8c60c38, ecb0fe1, ae43539 |
| server/hub.ts | 変更あり | b4d796f, dc0060e, bb12ed6, ae43539 |
| server/restore.ts | 変更あり | ae43539 |
| agent-console.config.json | 変更なし | - |
| docs/handoff/board/step0.md | 変更なし | - |
| README.md / docs/CHANGELOG.md / package.json | 変更あり（版 0.19.0 から 0.31.0 まで多数。一覧は files-changed.txt） | - |

注: 設計書 §3 の「版の4か所」は現在の package.json が v0.31.0（88def99）。設計書 §0 の「v0.19.0」とは別。

## B. 引用照合

凡例: 「同じ」= 設計書の行番号に現在も同じ中身。ずれた行は実際の行を書く。

### B-1 hooks/ac-board.mjs（変更なし。全て同じ）
| 設計書 | 中身 | 現在の行 | 生テキスト |
|---|---|---|---|
| :190 | 引数は write だけ | 190（同じ） | `if (argv.length !== 1 \|\| argv[0] !== "write") return reject(USAGE);` |
| :161 | readBoard を export | 161（同じ） | `export function readBoard(dataDir, sessionId) {` |
| :216 | 置き場所が bin/ でなければ | 216（同じ） | `if (path.basename(here) !== "bin") {` |
| :217 | exit 1 | 217（同じ） | `result = { code: 1, stdout: "", stderr: "dataDir/bin に写された ac-board.mjs から実行してください…` |
| :225 | dataDir = 1つ上 | 225（同じ） | `result = runCommand({ argv: process.argv.slice(2), env: process.env, stdinText, dataDir: path.resolve(here, "..") });` |
| :204-211 | isMain | 204-211（同じ） | `function isMain() {` … `return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));` |
| :13 | BOARD_LIMITS | 13（同じ） | `export const BOARD_LIMITS = Object.freeze({ themeChars: 200, kgiItems: 10, …` |

### B-2 server/activity-hooks.ts（大きく変わった。行がずれ、構造も変わった）
| 設計書 | 中身 | 現在の行 | 現在の生テキスト / 備考 |
|---|---|---|---|
| :8 | 目印 "/hooks/activity-hook.mjs" | 12 | `export const OWN_HOOK_SUFFIX = \`/hooks/${ACTIVITY_HOOK_FILE}\`;` ほかに 14: `OWN_HOOK_SUFFIXES = [OWN_HOOK_SUFFIX, "/hooks/ac-routine-guard.mjs"]`（2本になった） |
| :11 | BACKUPS_KEPT | 17 | `export const BACKUPS_KEPT = 6;` |
| :24 | HOOK_SPECS | 38-50 | `export const HOOK_SPECS: readonly HookSpec[] = [`。要素は10本（記録用9 + ac-routine guard 1）。HookSpec 型は 20-31 に新設: event / matcher? / file? / async? / timeout? / if? |
| :41-47 | Handler 型は async: true 固定 | 57-64 | `async?: true; timeout?: number; if?: string;` に既になっている（任意化済み） |
| :49-51 | buildHandler | 74-80 | `export function buildHandler(nodePath: string, hookPath: string, spec?: HookSpec): Handler {` spec を受ける。`if (spec?.async !== false) handler.async = true; if (spec?.timeout !== undefined) handler.timeout = spec.timeout;` |
| :53-57 | isOwnHandler | 82-86 | `return typeof first === "string" && OWN_HOOK_SUFFIXES.some((suffix) => first.endsWith(suffix));` 目印が配列に。別に isHandlerOf(handler, spec) が 89-93 に新設 |
| :59 | sameHandler | 95-97 | `function sameHandler(handler: unknown, nodePath: string, hookPath: string, spec: HookSpec): boolean {` spec 引数あり |
| :90 | addHandlers | 141 | `export function addHandlers(settings: Json, nodePath: string, hookPath: string): EditResult {` 中で `for (const spec of HOOK_SPECS)`（144）。引数に種類は無く HOOK_SPECS 固定 |
| :125 | removeHandlers | 191 | `export function removeHandlers(settings: Json): RemoveResult {` |
| :161-168 | findHandler | 235-247 | `function findHandler(settings: Json, spec: HookSpec, hookPath: string): FoundHandler \| null {` spec を受ける。戻りは FoundHandler（matcherOk 付き） |
| :170 | CheckInput | 249-253 | `export interface CheckInput {` settingsPath / hookPath の2項目のまま |
| :177 | checkHooks | 256 | `export function checkHooks(input: CheckInput): HookCheck {`。中で 272: `HOOK_SPECS.map(...)`、282: `HOOK_SPECS.every((spec) => existsSync(specHookPath(...)))` |
| :215-217 | pruneBackups | 296-298 | `function pruneBackups(dir: string): void {` … 298: `names.slice(0, Math.max(0, names.length - BACKUPS_KEPT))` |
| :246-275 | commit（控え→一時→rename→読み直し→戻す） | 327-356 | `function commit(read: ReadSettings, next: Json, now: number): void {` 中身の手順は同じ（控え 337、tmp 342、rename 345、読み直し 351、戻す 353） |
| :288 | installHooks | 369 | `export function installHooks(input: InstallInput): InstallResult {` |
| :307 | uninstallHooks | 388 | `export function uninstallHooks(input: UninstallInput): UninstallResult {` |

追加の事実: HEAD には HookSpec の file / async / timeout / if が既にあり、`{ event: "PreToolUse", matcher: "Bash", file: GUARD_HOOK_FILE, async: false, timeout: 5, if: "Bash(*/bin/ac-routine.mjs*)" }`（49行）が同期 handler の先例。Stop の spec は 45: `{ event: "Stop" }`（activity、async）の1本のみ。設計 §3-2 の「Handler 型・buildHandler・isOwnHandler・sameHandler・findHandler を種類対応にする」は、spec 引数方式で大部分が既に入っている（設計書の記載内容とは前提が違う）。

### B-3 server/activity-setup.ts
| 設計書 | 中身 | 現在の行 | 生テキスト |
|---|---|---|---|
| :11 | hookPathIn | 11（同じ） | `export const hookPathIn = (dataDir: string): string => path.join(dataDir, "hooks", HOOK_FILE_NAME);` |
| :20 | boardCommandPathIn | 30 | `export const boardCommandPathIn = (dataDir: string): string => path.join(dataDir, "bin", BOARD_COMMAND_FILE_NAME);` |
| :38-40 | installHookFile | 48-50 | `export function installHookFile(sourceDir: string, dataDir: string): string {` / `return copyAtomically(sourceDir, HOOK_FILE_NAME, hookPathIn(dataDir));` |
| :43-45 | installBoardCommand | 53-55 | `export function installBoardCommand(sourceDir: string, dataDir: string): string {` |
追加: 23 `installGuardFile`（ac-routine-guard.mjs を dataDir/hooks/ へ）、63 installReserveCommand、73 installRoutineCommand、83 installStatuslineCommand が新設。

### B-4 server/activity-start.ts
| 設計書 | 中身 | 現在の行 | 生テキスト |
|---|---|---|---|
| :39 | check（checkHooks 呼び出し） | 39（同じ） | `const check = (): HookCheck => checkHooks({ settingsPath: config.claudeSettingsPath, hookPath: hookPathIn(config.dataDir) });` |
| :44 | installHookFile | 44（同じ） | `installHookFile(opts.hooksSourceDir, config.dataDir);` |
| :49 | installBoardCommand | 54 | `installBoardCommand(opts.hooksSourceDir, config.dataDir);`（49 は今 `installGuardFile(...)`） |
| :117 | 右の欄の案内と e2e へ渡す | 見つからない | f255892 の activity-start.ts は 72 行で 117 行目が存在しない。現在は 87 行。`grep -n e2e server/activity-start.ts` は 0件（f255892 側も 0件）。:117 は activity-start.ts ではない別ファイルの行を指している可能性があるが、どのファイルかは未確認 |

### B-5 scripts/ac-hooks.mjs
| 設計書 | 中身 | 現在の行 | 生テキスト |
|---|---|---|---|
| :8 | アプリは設定を書き換えない | 8（同じ） | `// 設定の書き換えは、実行した人が自分で行う（アプリは設定を書き換えない）。…` |
| :15 | import に ac-board が無い | 15 | `import { hookPathIn, installGuardFile, installHookFile, installRoutineCommand, installStatuslineCommand, statuslineCommandPathIn } from "../server/activity-setup.ts";`（installBoardCommand は今も無い。installGuardFile 等が増えた） |
| :65-78 | install / uninstall / check | 66-82 | 66 `if (command === "install") {`、67 installHookFile、68 installGuardFile、69 installHooks、72 `} else if (command === "uninstall") {`、77 `} else {`、78 checkHooks、79 `console.log(JSON.stringify(result));`、82 `process.exit(result.ok ? 0 : EXIT_FAILED);` |

### B-6 tests/unit/activity-hooks.test.ts
| 設計書 | 中身 | 現在の行 | 生テキスト |
|---|---|---|---|
| :50 | ownHandler（async: true） | 57 | `const ownHandler = (e: Env): object => ({ type: "command", command: e.nodePath, args: [e.hookPath], async: true });` |
| :81-87 | 見分け方の試験 | 89-97 | `it("自分の handler の見分け方: args[0] が /hooks/activity-hook.mjs で終わる command の handler だけ", () => {` 94 に ac-routine-guard.mjs の true 期待が増えた。96: `expect(isOwnHandler("x")).toBe(false);` |
| :92 | 9 つのイベントに足す | 101 | `it("今の設定のキーと、ほかの hook をすべて残して、自分の handler を 9 つのイベント＋ guard に足す（exec の形・空白入りのパス）", () => {` |
| :258 | 9 つそろえば ok | 269 | `it("handler が 10 本そろい、node と hook のファイルがあれば ok", () => {` |
| :312 | TaskCreated の期待 | 395 | `expect(readJson(e.settings).hooks.TaskCreated[0].hooks[0]).toEqual({ type: "command", command: process.execPath, args: [e.hookPath], async: true });` |
| :314-316 | check の終了コードと ok | 397-399 | 397 `const c1 = cli(e, "check");` 398 `expect(c1.status, c1.err).toBe(0);` 399 `expect(JSON.parse(c1.out)).toMatchObject({ ok: true });` |
追加: 18 `const ACTIVITY_HANDLER_COUNT = EVENTS.length;`、404-406 に uninstall 後の check が status 1・reason "missingHandler" の期待。設計書の「handler の形と数（9）」は現在 10 本。

### B-7 server/sessions.ts / hub.ts / restore.ts
| 設計書 | 中身 | 現在の行 | 生テキスト |
|---|---|---|---|
| sessions.ts:74-85 | buildChildEnv | 98-108 | `export function buildChildEnv(source: Record<string, string \| undefined>, terminalEnv: Readonly<Record<string, string>> = {}): Record<string, string> {` |
| sessions.ts:285 | 子の env を組む | 474（node-pty 経路）、458（tmux 経路: `env: { ...paneEnv, ...extraEnv }`） | 474: `env: { ...this.childEnv(), ...extraEnv },` |
| sessions.ts:229-232 | setClaudeSessionId | 338-343 | `setClaudeSessionId(id: string, claudeSessionId: unknown): void {` |
| hub.ts:402 | detectBreaks | 552 | `private async detectBreaks(): Promise<void> {` |
| hub.ts:408 | setClaudeSessionId 呼び出し | 558 | `if (agent?.sessionId !== undefined) this.sessions.setClaudeSessionId(s.id, agent.sessionId);` |
| restore.ts:45 | onChange | 45（同じ） | `this.sessions.onChange(() => void this.sync());` |
| restore.ts:65 | sync | 65（同じ） | `async sync(): Promise<void> {` |
| restore.ts:81 | claudeSessionId の書き込み | 82 | `...(s.claudeSessionId !== undefined ? { claudeSessionId: s.claudeSessionId } : {}),` |
追加: sessions.ts の env 専用変数は AC_RESUME_ID（322, 331）のみ。AGENT_CONSOLE_TOKEN は除外対象（95 のコメント）。agent-console 起動を示す専用の環境変数は、grep（AGENT_CONSOLE|AC_ in sessions.ts / terminal-host / hub.ts / launch.ts）では AC_RESUME_ID 以外に出ない。

### B-8 その他
| 設計書 | 中身 | 現在 | 備考 |
|---|---|---|---|
| agent-console.config.json:27-50 | roles（opus-designer: ccopusgo、sonnet-impl: claude --model sonnet） | 27-50（同じ。変更なし） | 31 `"id": "opus-designer"`、33 `"command": ["/bin/zsh", "-ic", "ccopusgo"]`、40 `"id": "sonnet-impl"`、42 `"command": ["/bin/zsh", "-ic", "claude --model sonnet"]` |
| docs/handoff/board/step0.md:36-45 | session_id と環境変数の一致実測 | 36-45（同じ。変更なし） | 36 `## (b) CLAUDE_CODE_SESSION_ID と hook の session_id` |
| ~/.claude/prompts/salesanchor-designer.md:42 | ボードを書く指示 | 42（ファイル存在、最終更新 10/13 18:31） | `- テーマ・KGI・KPI・ロードマップ・タスクを決めたとき…node "$HOME/Library/Application Support/agent-console/bin/ac-board.mjs" write へ JSON を…` |
| §0「キーは claudeSessionId・cwd・name・roleId の4つ」 | open-sessions の項目 | server/session-store.ts:18-48 | 4つに加え branch が任意（restore.ts:81 `...(s.branch !== null ? { branch: s.branch } : {})`。これは f255892 でも :80 にあった） |
| §0「routineId は server/ に0件」 | | 現在は server に routineId が出る | server/routine-audit.ts:17 `routineId?: string;`、server/http.ts:400。open-sessions の項目には routineId は無い（session-store.ts の grep で roleId のみ） |
| §0「hub.ts:402 detectBreaks → :408 → sessions.ts:229-232 → restore.ts:45 → :65 → :81」の経路 | | 経路の関数の並びは同じ。行番号は上の表のとおり | |

## C. 設計書 §3 の「新規」「触る」と現状の差（事実のみ）
- hooks/board-guard.mjs、scripts/board-coverage.mjs は HEAD に存在しない（新規のまま）。
- 設計書 §11 が書く「HOOK_SPECS（:24）のまま」「BOARD_GUARD_SPECS を足す」「Handler 型の async を任意に」のうち、Handler の async 任意化と timeout の持ち方、spec 単位の buildHandler / sameHandler / findHandler / checkHooks（HOOK_SPECS の map）は HEAD に既にある（v0.25.0 ac-routine の guard 追加による。339bf00）。
- HEAD の HOOK_SPECS は 10 本。activity の handler 数は tests の `ACTIVITY_HANDLER_COUNT = EVENTS.length`（18）。
- addHandlers / removeHandlers / checkHooks は引数で種類を受けず、HOOK_SPECS 全体を回す作り。
- 設計書 §11 の「activity-start.ts:117」は f255892 でも存在しない行（同ファイル72行）。引用元は未確認。
