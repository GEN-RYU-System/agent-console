# v0.3.7 名前のダブルクリック変更と、作業中の名前変更の予約: recon

調査日 2026-10-12 / 基準 origin/main 013aad17c773fe4752b72595b6c38e809c7451c6 / worktree /Users/tanizawashingo/agent-console-wt/rename-queue。製品コードは変更していない。
引用のパスは worktree 直下からの相対（フルパス = /Users/tanizawashingo/agent-console-wt/rename-queue/ + 相対パス）。行番号は 013aad1 時点。

PO 承認（2026-10-12）: (1) 名前をダブルクリックで変えられる・鉛筆も残す (2) Claude が作業中・許可待ち・状態不明のときは名前を予約し、待機になったら自動で /rename を送る。

既存 ADR 検索: このリポジトリに docs/adr/ は無い（docs/ は CHANGELOG.md と handoff/ のみ）。対象 ADR は SA 側の ADR-067・ADR-144（§j）。

## 依頼文との相違（先に）
- 【事実】依頼文の「SessionSummary」という型は無い。型名は `SessionView`（サーバー `server/hub.ts:10`、画面 `src/types.ts:3`）。
- 【事実】`src/locales/en.json` は存在しない。`src/locales/` は `ja.json` のみ（`ls src/locales` → `ja.json`）。
- 【事実】hub の取得間隔に「定数」は無い。設定値 `agentsPollMs`（`agent-console.config.json:8` = 3000）。画面側の定数は `LEDGER_POLL_MS`・`RECONNECT_MS`・`RENAME_CONFIRM_MS`。
- 【事実】`.sa-cache` は gitignore（`.gitignore:3`）のため新 worktree には無い。(h) は `/Users/tanizawashingo/agent-console/.sa-cache/`（SOURCE = 6c1c5e82418e3ba38c10702f2a74161fd24a7e80）を読んだ。

## (a) hub の定期取得と判定

取得の起動と間隔 `server/hub.ts:55-64`
```
55:  start(): void {
56:    this.stoppers.push(
57:      startPolling(() => this.pollAgents(), this.config.agentsPollMs, (err) => this.onPollError("agents", err)),
```
間隔の設定値: `agent-console.config.json:8: "agentsPollMs": 3000,`（型 `server/config.ts:35`、必須数値キー `server/config.ts:47`、代入 `server/config.ts:148`）。試験用: `tests/unit/helpers/harness.ts:92: agentsPollMs: 60000`、`tests/fixtures/e2e-env.ts:85: agentsPollMs: 1000`。
周期実行は前回完了後に次を予約し、多重起動しない `server/poll.ts:1-12`（`if (!stopped) timer = setTimeout(() => void tick(), intervalMs);`）。

取得 → 区切り判定 → 配信 `server/hub.ts:80-99`
```
81:  async pollAgents(): Promise<void> {
83:    this.agents = await fetchAgents(this.config.claudeBin);
84:    await this.detectBreaks();
85:    await this.publish();
86:  }
89:  private async detectBreaks(): Promise<void> {
90:    if (this.agents === null) return;
91:    const table = await readProcessTable().catch(() => []);
92:    for (const s of this.sessions.list()) {
93:      const agent = agentForSession({ exited: s.exited, pids: descendantPids(s.term.pid, table) }, this.agents);
94:      const isBreak = this.tracker.observe(s.id, agent?.status ?? null);
95:      if (isBreak && agent && (agent.status === "waiting" || agent.status === "idle")) {
96:        this.sendNotification?.(breakBody(agent.name ?? s.name, agent.status));
```
取得失敗時 `server/hub.ts:71-78`: `this.agents = null;` にして publish（状態「不明」）。
snapshot 生成 `server/hub.ts:135-156`（name は Claude 側優先: `:143`、`state: stateForSession(...)` `:148`、`canInput: inputVerdict(info, this.agents).ok` `:151`、`this.lastNames = new Map(...)` `:154`）。
通知 `server/hub.ts:168-176`: `const payload = JSON.stringify(snap); if (payload === this.lastPayload) return;` 変化があるときだけ全購読者へ送る。
SessionManager の変化（作成・終了・名前変更・除外）でも publish: `server/hub.ts:50`。
`fetchAgents` は `claude agents --json` を execFile、失敗は null `server/agents.ts:102-110`（timeout 15000）。

checkInput `server/hub.ts:106-114`（要求時に取り直す。定期取得の値は使わない）
```
109:  async checkInput(sessionId: string): Promise<InputVerdict> {
110:    const session = this.sessions.get(sessionId);
111:    if (!session) return { ok: false, reason: "session not found", hasClaude: false };
112:    const [rows, table] = await Promise.all([fetchAgents(this.config.claudeBin), readProcessTable().catch(() => [])]);
113:    return inputVerdict({ exited: session.exited, pids: descendantPids(session.term.pid, table) }, rows);
```

inputVerdict `server/agents.ts:66-88`
```
80:export function inputVerdict(session: SessionProcessInfo, rows: AgentRow[] | null): InputVerdict {
81:  if (session.exited) return { ok: false, reason: "session is stopped", hasClaude: false };
82:  if (rows === null) return { ok: false, reason: "claude state is unknown", hasClaude: false };
83:  const agent = agentForSession(session, rows);
84:  if (!agent) return { ok: true, hasClaude: false };
85:  if (agent.status !== "idle") return { ok: false, reason: `claude is ${agent.status}`, hasClaude: true };
86:  if (agent.waitingFor !== undefined) return { ok: false, reason: "claude is waiting for input", hasClaude: true };
87:  return { ok: true, hasClaude: true };
```
理由文言（409 本文）: `session is stopped` / `claude state is unknown` / `claude is busy|waiting|unknown` / `claude is waiting for input`。
状態の型 `server/agents.ts:19`: `SessionState = "working" | "waiting" | "idle" | "no-claude" | "stopped" | "unknown"`。`stateForSession` は `:90-100`（busy→working、waiting→waiting、idle→idle、行なし→no-claude、exited→stopped、rows null→unknown）。
AgentStatus は `server/agents.ts:6: "busy" | "waiting" | "idle" | "unknown"`、`waitingFor?: string` は `:13`（空文字は undefined に正規化 `:47`）。

【事実】`SessionState` の idle でも `waitingFor` があると `canInput` は false（state と canInput は 1 対 1 ではない）。
【事実】Claude が動いていないシェル（no-claude）は canInput true（`agents.ts:84`）。

## (b) rename API

`server/http.ts:204-228`
```
204:  const sessionMatch = /^\/api\/sessions\/([^/]+)\/(read|rename|send-check)$/.exec(url.pathname);
205:  if (method !== "POST" || !sessionMatch) return false;
206:  const [, id, action] = sessionMatch;
207:  const session = sessions.get(id);
208:  if (!session) throw new SessionNotFoundError("session not found");
...
215:  if (action === "rename") {
216:    const name = validateName(jsonBody(await readJsonBody(req)).name);
217:    const verdict = await hub.checkInput(id);
218:    if (!verdict.ok) throw new SessionConflictError(verdict.reason ?? "cannot input now");
219:    if (verdict.hasClaude) {
220:      // Claude の名前が正本。人が押したときだけ /rename を送る
221:      sessions.write(session, `/rename ${name}\r`);
222:      sendJson(res, 200, { mode: "claude" });
223:    } else {
224:      sessions.rename(id, name);
225:      sendJson(res, 200, { mode: "app" });
```
エラー対応 `server/http.ts:352-364`: SessionInputError/WorktreeError/BadRequestError → 400、SessionNotFoundError → 404、`if (err instanceof SessionConflictError) { sendJson(res, 409, { error: err.message }); ...}`（`:360-361`）。
クラス定義 `server/sessions.ts:14-16`（`SessionInputError` / `SessionConflictError` / `SessionNotFoundError`）。
`validateName` `server/sessions.ts:44-50`（文字列、trim 後 1〜40 字 = `MAX_NAME_LENGTH` `:9`、制御文字不可）。
`sessions.rename` `server/sessions.ts:150-156`（アプリ側の名前だけ変更、`this.notify()`）。
`sessions.write` `server/sessions.ts:211-213`: `if (!session.exited) session.term.write(data);`（exited なら黙って捨てる）。
【事実】サーバーに「予約」を持つ場所は現状無い。rename は同期的に 200 か 409 を返し、状態を保持しない。
【事実】`/rename ${name}\r` は 1 回の write。画面の人の入力（WebSocket 経由）とは別経路で、割り込み防止はサーバー側に無い（`:221`）。

## (c) 終了（exited）と除外（remove）の後始末

終了 `server/sessions.ts:191-194`
```
191:    term.onExit(() => {
192:      session.exited = true;
193:      this.notify();
194:    });
```
除外 `server/sessions.ts:200-208`
```
201:  remove(id: string): void {
203:    if (!session) throw new SessionNotFoundError("session not found");
204:    if (!session.exited) throw new SessionConflictError("session is still running");
205:    for (const ws of session.clients) ws.close();
206:    this.sessions.delete(id);
207:    for (const l of this.removedListeners) l(id);
208:    this.notify();
```
除外リスナー: `onRemoved` 定義 `server/sessions.ts:93-96`、購読は hub の 1 か所のみ `server/hub.ts:52: sessions.onRemoved((id) => this.tracker.forget(id));`
`BreakTracker.forget` `server/notify.ts:71-74`（`last` と `unread` の Map を削除）。メモリのみで保存しない `server/notify.ts:40-44` 付近。
除外 API `server/http.ts:143` (`DELETE /api/sessions/:id`)。除外の試験 `tests/unit/daily-use.integration.test.ts:127-133`（`forget` が呼ばれることを spy で確認）。
【事実】exited になったとき hub 側に専用の後始末は無い（`onExit` は `exited=true` と notify のみ）。exited の間は `inputVerdict` が `session is stopped`（agents.ts:81）、`stateForSession` が `stopped`。
【事実】予約を hub / tracker に持つなら、除外時の掃除は `onRemoved`（hub.ts:52）に足す形が既存と同型。終了時の掃除は現状フックが無い（【推測】予約を捨てる契機は exited の観測（snapshot の state=stopped）か `onExit` への追加）。

## (d) snapshot の型

サーバー `server/hub.ts:10-29`
```
10:export interface SessionView {
11:  id: string;
12:  name: string;
...
16:  state: SessionState;
...
19:  unread: number;
21:  hasClaude: boolean;
23:  canInput: boolean;
26:export interface Snapshot { sessions: SessionView[]; agentsAvailable: boolean; }
```
画面 `src/types.ts:3-15`（フィールド同一: id, name, roleId, branch, cwd, state, createdAt, unread, hasClaude, canInput。`:12` のコメント「Claude 起動中は idle のときだけ」）。`ConsoleState` `src/types.ts:23-32`。`SessionState` は画面側にも同一の union（`src/types.ts:1`）。
受信 `src/pages/ConsolePage.tsx:54-55`: WebSocket `/ws/events` の `JSON.parse` を `{ sessions: SessionView[]; agentsAvailable: boolean }` として `setState((prev) => ({...prev, ...snap}))`（実行時の検証は無い）。
【事実】予約の有無を画面に出すには SessionView に項目を足す必要がある（現状に項目なし）。足すと型が server/hub.ts と src/types.ts の 2 か所、ならびに SessionView を手書きしているテスト（`SessionList.test.tsx:10-11`、`RenameForm.test.tsx:8`、`ConsolePage.test.tsx:8,173,230`）に波及する。項目を任意（`?`）にすれば既存テストは変えずに済む【推測】。

## (e) 画面側

SessionList `src/components/SessionList/SessionList.tsx:32-84`
```
40:          <Button variant="ghost" size="sm" layoutClassName="ac-session__select" aria-current=... onClick={() => onSelect(s.id)}>
47:            <span className="ac-session__line" data-testid="session-line-1">
49:              <span className="ac-session__name" data-testid="session-name">{s.name}</span>
60:          {s.state !== "stopped" && (
61:            <Button variant="ghost" size="sm" iconOnly aria-label={t("ac.rename.open")} title={t("ac.rename.open")}
67:              disabled={!s.canInput}
68:              onClick={() => onRename(s.id)}
```
Props（`:11-18`）: `onSelect, onRemove, onRename: (id: string) => void`。名前は `<Button>` 内の `<span data-testid="session-name">`。ダブルクリック先の名前 span は選択ボタン（`onClick=onSelect`）の子なので、dblclick は先に click が 2 回 onSelect を呼ぶ【事実: DOM の click→click→dblclick の順は標準仕様。コードの onSelect は `ConsolePage` の handleSelect】。
鉛筆は `disabled={!s.canInput}` で、作業中は押せない（`SessionList.test.tsx:53-56`）。予約を許すなら、この disabled 条件の扱いが変わる。

SessionList.test.tsx（`src/components/SessionList/SessionList.test.tsx`、105 行、8 件）で rename を見るもの:
- `:53-56` 作業中は鉛筆が disabled
- `:58-65` idle のとき鉛筆を押すと onRename("a")
- `:78-93` K3 鉛筆・外すボタンは右端、aria-label・title、`comp-btn--sm`（`:86`）、`rows[0].lastElementChild?.contains(rename)`（`:89`）
- フィクスチャ `:8-12`（SessionView を全項目手書き）

ConsolePage.tsx
- `:39: const RENAME_CONFIRM_MS = 10000;`
- `:85-88` state: `renameTargetId`, `renameBusy`, `renameError`, `renameNotice`
- `:161-180` handleRename
```
161:  const handleRename = async (name: string): Promise<void> => {
162:    if (renameTargetId === null) return;
163:    const targetId = renameTargetId;
164:    const before = sessionsRef.current.find((s) => s.id === targetId)?.name;
...
168:      const { mode } = await renameSession(targetId, name);
169:      setRenameTargetId(null);
170:      if (mode === "claude") {
171:        // Claude 側の名前が変わらなければ案内する（/rename を受け付けない状態など）
172:        setTimeout(() => {
173:          if (sessionsRef.current.find((s) => s.id === targetId)?.name === before) setRenameNotice(targetId);
174:        }, RENAME_CONFIRM_MS);
...
177:      setRenameError(err instanceof Error ? err.message : String(err));
```
- `:230` `const renameTarget = state.sessions.find((s) => s.id === renameTargetId);`
- `:251-255` renameNotice の Callout（`ac.rename.notReflectedTitle/Body`）。`renameNotice` は id を持つが、どの行かは表示に使っていない（Callout は 1 つだけ）。
- `:262-265` SessionList へ `onRename={(id) => { setRenameNotice(null); setRenameError(null); setRenameTargetId(id); }}`
- `:312-314` `<Modal open={renameTarget !== undefined} onClose=... title={t("ac.rename.title")} size="sm">` の中に `<RenameForm key={renameTarget.id} session=... busy={renameBusy} error={renameError} onSubmit=.../>`
- `:275` `canSend={activeSession?.canInput === true}`（よく使う指示バー）
- `:142-145` handleRemove は `removeSession(id).catch(...)`。
【事実】`setTimeout` の 10 秒確認は clear されない（アンマウント・セッション切替でも発火）。

RenameForm `src/components/RenameForm/RenameForm.tsx`
```
19:  const [name, setName] = useState(session.name);
20:  const blocked = !session.canInput;
32:          helperText={session.hasClaude ? t("ac.rename.hintClaude") : t("ac.rename.hintApp")}
35:          maxLength={40}
37:          disabled={blocked}
40:        {blocked && <Callout variant="info" title={t("ac.rename.busyTitle")}>{t("ac.rename.busyBody")}</Callout>}
46:        <Button type="submit" disabled={blocked} loading={busy} loadingText={t("ac.rename.sending")}>
```
`blocked` が TextField と送信ボタンの両方を無効にする（`:20,37,46`）。試験 `src/components/RenameForm/RenameForm.test.tsx:20-24`（blocked 時に「変更」が disabled・「作業中は変えられません」表示）。

api.ts `src/api.ts:56-57`
```
export const renameSession = (id: string, name: string): Promise<{ mode: "claude" | "app" }> =>
  request(`/api/sessions/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ name }) });
```
409 のときの扱い `src/api.ts:36-44`: `if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status);`（サーバーの reason 文字列がそのまま message になる）。ConsolePage は `err.message` をそのまま `renameError` に表示（`:177`）。
ConsolePage.test.tsx は `renameSession` を vi.fn で差し替え（`:24,47,96`）。

## (f) i18n

【事実】`ja.json` のみ。`en.json` は無い（CLAUDE.md 系の「ja/en 同一キー」規約があっても、このリポジトリには en が無い。【未確認】他の場所で en を持つ決定があるか）。
`src/locales/ja.json:74-87` ac.rename.* 全件
```
"rename": {
  "open": "名前を変える",
  "title": "名前を変える",
  "name": "新しい名前",
  "hintClaude": "Claude に /rename を送って名前を変えます（待機のときだけ）。",
  "hintApp": "このアプリでの表示名を変えます。",
  "busyTitle": "作業中は変えられません",
  "busyBody": "Claude が idle（待機）のときだけ変えられます。作業中・許可待ちなどの間は、終わってからやり直してください。",
  "error": "名前を変えられませんでした",
  "sending": "送信中",
  "submit": "変更",
  "notReflectedTitle": "名前がまだ反映されていません",
  "notReflectedBody": "/rename を送りましたが、Claude 側の名前が 10 秒たっても変わっていません。端末を確認してください。"
}
```
関連: `ja.json:44 "removeSession": "一覧から外す"`、`ja.json:73`（直前）`"notifyHelp"`。
【事実】`hintClaude`（「待機のときだけ」）と `busyTitle/busyBody`（「作業中は変えられません」）は、予約を許すと文言が事実と食い違う。

## (g) 関係する試験

`tests/unit/daily-use.integration.test.ts:138-175`（describe "input safety: /rename and quick prompts only when Claude is idle (M1/L1)"）
- `:139-148` Claude の name が出る・canInput が polled status に追従
- `:150-168` busy / waiting(waitingFor) / idle(waitingFor) で 409 と理由（`claude is busy`/`claude is waiting`/`waiting for input`）、`ringOf(id)` に `/rename` が無いこと、idle で `{ mode: "claude" }` と `/rename next-name` が ring に入ること
- `:170-185` 要求時の状態を使う（polled が古い idle でも busy なら 409）
- `:186-194` Claude 無しは `{ mode: "app" }`、空名・改行は 400
- `:196-204` 状態が読めない（rows が不正 JSON）・停止中は 409
- 道具: `setAgents`（`:58`）、`h.hub.pollAgents()`、`row(pid, status, {waitingFor})`、`ringOf`、`viewOf`、`newSession`（helpers/harness.ts）

`tests/e2e/console.spec.ts:455-490`（"段階2 K2: 名前を変えると /rename が端末に送られ…作業中は変えられない"）
- `:466,473` busy / waiting で鉛筆が `toBeDisabled()`
- `:468-474` API が 409
- `:478-484` idle → 鉛筆 → `rename-form` → 「新しい名前」→ 「変更」→ 端末に `/rename renamed-by-ui`
- `:486-489` NAME_FILE で Claude 側の名前を変えると行の表示が変わる
`:492-503` 10 秒変わらないと「名前がまだ反映されていません」が出る（timeout 15000）。
【事実】e2e の「作業中は鉛筆が disabled」（`:466,473`）は、予約を許す設計にするとそのまま成り立たなくなる。

rename を見ている試験の一覧（`grep -rn "rename\|名前を変える\|canInput" tests src`）
| ファイル | 内容 |
|---|---|
| tests/unit/daily-use.integration.test.ts | `:137-204` API・input safety（上記） |
| tests/e2e/console.spec.ts | `:460-503` 2 本（上記） |
| src/components/SessionList/SessionList.test.tsx | `:53-65,78-93` と fixture `:10-11` |
| src/components/RenameForm/RenameForm.test.tsx | `:8` fixture、`:11-30` 3 件 |
| src/pages/ConsolePage.test.tsx | `:8,173,230` fixture（canInput）、`:24,47,96` renameSession モック |
【事実】ConsolePage.test.tsx は `renameSession` をモックするだけで、rename を呼ぶ・assert する箇所は無い（grep `renameSession|名前を変える` はモック定義 `:24,47,96` のみ）。

## (h) SA の Button 金型は onDoubleClick を渡すか

`/Users/tanizawashingo/agent-console/.sa-cache/frontend/src/components/Button.tsx`
```
39: export type ButtonProps = ButtonOwnProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonOwnProps | "className" | "style">;
41-54: forwardRef(function Button({ variant, size, fullWidth, loading, loadingText, active, iconOnly, children, layoutClassName, disabled, "aria-label": ariaLabel, ...rest }, ref)
59-67: <button ref={ref} className={classes} disabled={disabled || loading} aria-busy=... aria-pressed=... aria-label={ariaLabel} {...rest}>
```
【事実】`onDoubleClick` は `ButtonHTMLAttributes` に含まれ、型で禁止されておらず（除外は ownProps・className・style のみ）、`...rest` が `<button>` に展開されるため受け渡される。
【事実】`disabled` な button では、ブラウザは click 系イベントを発火しない（【未確認】dblclick の扱いはブラウザ依存。試験で確認が必要）。
入力欄の金型: `.sa-cache/frontend/src/components/TextField.tsx` に `TextField`（label 付き）と `TextFieldControl`（裸の input、forwardRef、`variant`/`size` を受ける `:44-62`）がある。行内編集に使うなら `TextFieldControl` が候補【推測】。
governance スクリプト `scripts/check-design-governance.mjs:136` は `src/pages/**/*.tsx` の生 `<button|input|select|textarea|a` を禁止。SessionList は `src/components/` なので対象外だが、ADR-144 §1（生 `<input>` 禁止、TextField を使う）の原則は同じ。

## (i) バージョンと CHANGELOG

- `package.json:3: "version": "0.3.6",`
- `docs/CHANGELOG.md` 先頭項目（`:5`）: `- 0.3.6 左のセッション一覧をコンパクト化: 1件を2行（…）…見た目だけの変更で、機能・API は変わらない。`（版の正本は git タグ `vX.Y.Z`、`docs/CHANGELOG.md:3`）
- 過去の handoff: docs/handoff/ に v0.3.1〜v0.3.6 のディレクトリあり（各 recon.md / design.md）。

## (j) 既存 ADR・設計書

`docs/handoff/stage2/design.md:35-38`（§4-2 名前）
- `:36` 表示名の正本: Claude 起動中は `claude agents --json` の `name`、無ければアプリが付けた名前。
- `:37` 変更: 「要求を受けた時点で `claude agents --json` を取り直し（3 秒前の値を使わない）、status が idle かつ waitingFor が無いときだけ、端末へ `/rename <新しい名前>` と改行（\r）を送る（人がボタンを押したときのみ）。それ以外（busy・waiting・状態を取得できない）は 409 と理由を返す。画面のボタンも同じ条件（サーバーが一覧に載せる canInput）で無効化。」
- `:38` 修正ラウンド1: 「waiting は許可プロンプトの応答待ちを含む可能性があり（未確認）、そこへ Enter を送ると既定の選択肢を押す恐れがあるため、idle のときだけに絞った。」

`docs/handoff/stage2/design.md:93,95`（リスク表）
- `:93` `/rename` を Claude が受け付けない状態で送る → 「要求時に取り直した status が idle（waitingFor 無し）のときだけ有効。送信後 10 秒で name が変わらなければ画面に「反映されていません」」
- `:95` 既知の制約（受容）: 「状態確認（send-check）の応答後〜貼付の間（ミリ秒〜通信 1 往復）に Claude が busy になっても、貼付は WebSocket の人の入力経路なのでサーバー側では止められない（review-stage2-r2 N2）」。窓を小さく保つ対処あり。`:96`「Claude が起動途中で `claude agents` に載る前のシェル、Claude 終了直後のシェルには入力できる」も受容済み。
【事実】予約の自動送信は「人がボタンを押したときのみ」（`design.md:37`）の前提を変える。人の操作の後で、サーバーが判定と書き込みを自分で行う経路になる。判定（checkInput）と書き込み（`sessions.write`）の間の時間差は、`http.ts:217-221` が同一リクエスト内で連続して行う現状でも `await` を 1 回挟む（fetchAgents の完了〜write）。自動送信でも同じ形で、時間差の大きさは現状と同等【推測】。

ADR-067 / ADR-144（SA 側。このリポジトリには無い）
- 本リポジトリでの扱い: 各 handoff の design.md 冒頭に「対象ADR: ADR-067, ADR-144」（例 `docs/handoff/v0.3.6-compact-session-card/design.md:5`、`docs/handoff/v0.3.3-resume-picker/design.md:5`）。強制は `scripts/check-design-governance.mjs:1-2`（ADR-067 / ADR-144 の検査、違反は file:line で exit 1）、`npm run lint`（`package.json` scripts.lint）。
- ADR-144（`/Users/tanizawashingo/salesanchor/docs/adr/ADR-144-ui-component-governance.md:31-47`）: pages 配下は金型優先。生 `<select>` / 生 `<input type=text|search|省略>` / 自作タブ / 色直値は禁止。例外口は `{/* ui-allow: <理由> (#<課題番号>) */}`（理由と番号の両方必須）。金型が無いときは PO 許可を得てから新設（`:59-64`）。
- ADR-067（`ADR-067-design-token-enforcement.md`）: 色・寸法はトークン。許可される例外は %・@media・calc 内の var・opacity 0/1・min-width 0（`scripts/check-design-governance.mjs:2` の記述）。
- 【事実】SessionList.css は `var(--space-*)`・`var(--border)` などのトークンのみ（`src/components/SessionList/SessionList.css:1-30`）。行内編集の入力欄も金型 `TextFieldControl` ＋トークンで作る必要がある。

## 設計に効く事実のまとめ（判断は design.md で）
1. 取得は 3 秒ごと（`agentsPollMs`）。予約の発火は「定期取得で state が idle かつ waitingFor 無し（= canInput）になった時点」を観測して行うのが既存の入口（`hub.ts:81-86` の pollAgents 直後）。ただし送信前の判定は既存どおり `checkInput` で取り直せる（`hub.ts:109-114`）。
2. 予約の保存場所は現状無い。メモリだけなら tracker と同様に `onRemoved`（`hub.ts:52`）で掃除でき、exited には掃除のフックが無い。サーバー再起動で消える（tracker もメモリのみ `notify.ts`）。
3. 鉛筆の disabled（`SessionList.tsx:67`）、RenameForm の blocked（`RenameForm.tsx:20,37,46`）、e2e の toBeDisabled（`console.spec.ts:466,473`）、ja.json の文言（hintClaude / busyTitle / busyBody）は、作業中でも入力できる設計にすると全部が影響を受ける。
4. ダブルクリック先の名前 span は選択ボタンの内側（`SessionList.tsx:40-49`）。Button は onDoubleClick を通せる（§h）が、click ×2 が先に onSelect を呼ぶ。名前の編集中は入力欄を Button の外に出す必要がある（button 内に input は置けない）【推測】。
5. 状態不明（`agents === null`、`stateForSession` = unknown、`inputVerdict` = `claude state is unknown`）のときも予約の対象にする、という PO 承認は、`hasClaude` が false のまま ok=false になる場合（`agents.ts:82`）があり、「Claude 無しシェルの app 名変更」との区別がつかない。予約の送り先（/rename かアプリ名か）は発火時の `hasClaude` で決める必要がある【推測】。
6. 予約中に Claude 側の名前が別途変わる・ユーザーが再度名前を変える・セッションが stopped / 除外されるときの扱いは現状に規定が無い（【未確認】要設計）。
