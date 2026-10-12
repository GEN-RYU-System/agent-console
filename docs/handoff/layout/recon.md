# 画面の並べ方 recon（上部タブ・よく使う指示・セッション行・並び順）

基準: `origin/main` cee6737（v0.6.1）の worktree `release/layout`。製品コードは変更していない。
SA の金型は本店の .sa-cache（本リポジトリ外。/Users/tanizawashingo/agent-console/.sa-cache/frontend/src/、worktree には無い）。以下 SA のパスは「.sa-cache/frontend/src/ 配下（本リポジトリ外）」。
再利用した過去の調査: v0.7.0 端末の画面の改善 recon の章 E・F（別 worktree terminal-ux の docs/handoff/v0.7.0-terminal-ux/recon.md、本リポジトリ外）。行番号は今の main で取り直した（取り直した結果、E・F の記述と食い違う点は無かった。ただし governance の行番号は E の「:99-100」が今の main では :97-101）。

---

## A. 上部タブ

### 現状の使い方
- 【事実】`src/pages/ConsolePage.tsx:328-339` `<Tabs variant="underline" size="sm" activeKey={centerTab} onChange={setCenterTab} items={[端末, 変更(件数), PR, 部品(未送信数)]} />`。className・style は渡していない。import は `:8`。
- 【事実】CSS の読み込み順 `src/main.tsx:3-4` `import "@sa/index.css"; import "./tokens.app.css";`。

### SA の Tabs（本リポジトリ外）
- 【事実】components/Tabs.tsx:37-44（本リポジトリ外） props は `items, activeKey, onChange, variant?, size?, className?` のみ。`className` は `role="tablist"` のコンテナ div の class 末尾に連結される（:58-70）。タブ個別のボタンは class 固定（`comp-tabs__tab` ＋ active/disabled、:80-86）で className も style も渡せない。ラベルは `<span class="comp-tabs__label">`（:96）、件数は SA の Badge（:97-101）。
- 【事実】components/Tabs.css:67-71（本リポジトリ外） `.comp-tabs--sm .comp-tabs__tab { height: var(--comp-tab-h-sm); padding: 0 var(--comp-tab-px-sm); font-size: var(--font-xs); }`。md は :61-65（`--comp-tab-h-md` / `--comp-tab-px-md` / `--font-sm`）。下線 `.comp-tabs--underline .comp-tabs__tab { border-bottom: var(--comp-tab-underline-w) solid transparent; margin-bottom: -1px }`（:86-89）。コンテナ `.comp-tabs` は `display:flex; align-items:center; overflow-x:auto`（:20-27）、`.comp-tabs--underline` は `border-bottom:1px solid var(--border); gap:0`（:34-37）。
- 【事実】トークン tokens.css（本リポジトリ外）: `--comp-tab-h-sm: 28px`（:528）、`--comp-tab-h-md: var(--height-tab-item)`（:529）、`--height-tab-item: 36px`（:271）、`--comp-tab-px-sm: var(--space-3)`（:532）、`--comp-tab-px-md: var(--space-4)`（:533）、`--comp-tab-underline-w: 2px`（:536）。
- 【事実】**24px に当たる SA のトークン**: tokens.css:20（本リポジトリ外） `--font-2xl: 1.5rem; /* 24px — KPI値・大見出し */`。（`--font-xl` 20px、`--font-3xl` 32px も同じ並び）。
- 【事実】**56px に当たる SA のトークン**: `--topbar-height: 56px`（tokens.css:171、トップバー用）、`--comp-table-row-h-relaxed: 56px`（:512、表の行用）。タブ用には無い（タブの最大は `--height-tab-bar: 54px`、:270、受信箱のバー用）。

### アプリの CSS からタブの高さ・余白・文字を当てる方法（事実の並び。優先は付けない）
- 【事実】方法 1: コンテナへ className を渡し、そのコンテナの上で SA のカスタムプロパティを上書きする。`.comp-tabs--sm .comp-tabs__tab` は `var(--comp-tab-h-sm)` 等で値を読むので（Tabs.css:67-71）、コンテナ側で `--comp-tab-h-sm`・`--comp-tab-px-sm` を再宣言すれば子孫のタブボタンに継承される（CSS カスタムプロパティは継承される）。font-size だけは Tabs.css:70 が `var(--font-xs)` を直に読んでいるので、`--font-xs` をコンテナ上で上書きする形になる（`--font-xs` は SA 全体の共通トークンで、コンテナの中の Badge（件数）の文字などにも波及する。Badge が `--font-*` を読むかは【未確認】）。
- 【事実】方法 2: className をコンテナに付け、子孫セレクタ `.ac-tabs .comp-tabs__tab { height: …; font-size: …; padding: … }` で指す。詳細度は (0,2,0)。Tabs.css の `.comp-tabs--sm .comp-tabs__tab` も (0,2,0) で同じなので、勝敗は読み込み順（`src/main.tsx:3-4` でアプリの CSS が @sa/index.css（本リポジトリ外） の後。ただし `src/pages/ConsolePage.css` は `src/pages/ConsolePage.tsx:41` の import でバンドルされる順序に依存し、【未確認】）。SA の stylelint の `no-descending-specificity` への言及が Tabs.css:12-16 にあるが、アプリ側の stylelint は無い（`package.json` の lint は `scripts/check-design-governance.mjs` のみ）。
- 【事実】どちらの方法でも、値に使える形は次のとおり。(a) SA の既存トークン（`var(--font-2xl)` は使える。高さ 56px は `var(--topbar-height)` を流用すると意味が違うトークンを借りることになる）。(b) `src/tokens.app.css` に `--ac-` を新設して `var(--ac-tab-h)` で参照。(c) px 直書き（`scripts/check-design-governance.mjs:111-116` が違反にする。0 と border/outline の 1px のみ許可）。
- 【事実】`--font-2xl` を参照する宣言は governance に問題なし（`var(…)` の中身は長さ判定から除外、:107-108 相当の `withoutVar` 処理。`scripts/check-design-governance.mjs:107` 付近）。

### governance（tokens.app.css に長さ・var() を許すために変える箇所）
- 【事実】`scripts/check-design-governance.mjs:10` `const APP_TOKEN_FILE = "src/tokens.app.css";`
- 【事実】`:97-102`（`if (file === APP_TOKEN_FILE) { … continue; }`）が対象。中身:
  - `:99` 宣言の prop が `--ac-` で始まらなければ違反。
  - `:100` `else if (!isFontStack(rawValue)) report(…"の値は font stack（…）のみ")`。**ここが「値は font stack のみ」の判定**で、`56px` や `var(--x)` はここで違反になる。
  - `:101` `continue;` により、このファイルは :103 以降の長さ・色の検査を一切受けない（font stack のみ通すので結果的に安全）。
- 【事実】`isFontStack`（`:33-42`）: カンマ区切り 2 個以上、最後が総称名（`GENERIC_FAMILIES`、:30）、各項目が引用付き名か英字の名前で色名でない。
- 【事実】長さの判定は `LENGTH`（`:86`）。通常の CSS（:103 以降）は `px|rem|em` 直書きを 0 と border/outline 1px 以外は違反（:111-116）、色名・hex・rgb は別規則（:79-83 付近、`scanLines` で styleFiles 全体、tokens.app.css も対象）。
- 【事実】この判定を変える際に影響を受ける既存の試験 `tests/unit/design-governance.test.ts`:
  - `:176-178` `--ac-font-mono: Menlo, "Courier New", monospace` が通る（status 0）。
  - `:180-188` tokens.app.css に `--other: 1;` と `color: var(--x);` は違反（status 1）。
  - `:190-` `values in src/tokens.app.css`: font stack 受理 2 件（:194-199）。**拒否 7 件**（`:203-` 付近）のうち `--ac-gap: 17px;`（case 2）、`--ac-gap: 0;`（case 3）、`--ac-font-mono: 12px, monospace;`（case 6）、`--ac-font-mono: var(--x);`（case 7）が、長さ・var() を許すと結果が変わる、または拒否の理由が変わる試験。`--ac-bg: red;`（case 1）・`--ac-font-mono: red, monospace;`（case 4）・`Menlo, Monaco;`（case 5）は色名・総称名欠落で、規則次第で維持できる。
  - `:41-` 以降の `extension/` の検査（K9）は別ファイル対象で関係しない。
- 【推測】`--ac-` の値に「長さ（正の数＋単位）」「`var(--font-…)` など SA トークン参照」を許すと、:111-116 の「px 直書き禁止」の趣旨（直値を置く場所を tokens.app.css の 1 か所に限る）との整合を試験で決めることになる。どこまで許すかは設計判断。

---

## B. よく使う指示

### 画面（v0.7.0 recon F-1 を再確認）
- 【事実】`src/components/QuickPrompts/QuickPromptBar.tsx:15-33`（props は :6-12 `prompts, canSend, onSend, onEdit`）。`<div className="ac-quick" data-testid="quick-prompt-bar" role="toolbar">` の中が、`<span className="ac-quick__title">{t("ac.quick.title")}</span>`（今は span でボタンではない）、`<div className="ac-quick__buttons">`（全件を `Button variant="outline" size="sm"` で描く）、編集の `Button variant="ghost"`（`t("ac.quick.edit")` ＝「指示を編集」）。表示件数の上限・「常に表示」の概念は無い。
- 【事実】バーの CSS `src/components/QuickPrompts/QuickPrompts.css:1-8` `.ac-quick { display:flex; align-items:center; gap; padding; border-bottom; background }`。`:16-23` `.ac-quick__buttons { display:flex; flex:1; flex-wrap: wrap; align-items:center; gap: var(--space-2); min-width:0 }`。**折り返しは `flex-wrap: wrap`（:19）**。`.ac-quick` と `.ac-quick__buttons` に `overflow` の指定は無い（`grep -n overflow QuickPrompts.css` は :53-54 の `.ac-quick-editor__preview` のみ）。タイトル `.ac-quick__title`（:10-14）は `flex:none`。
- 【事実】呼び出し `src/pages/ConsolePage.tsx:90-92`（state）、`:114-115`（`fetchQuickPrompts` で読み込み）、`:340-347`（端末タブのときだけ `<QuickPromptBar>`）、`:421-423`（`<Modal open={quickEditorOpen} … title={t("ac.quick.editTitle")} size="md"><QuickPromptEditor prompts onChanged={loadQuickPrompts} /></Modal>`）。
- 【事実】編集 `src/components/QuickPrompts/QuickPromptEditor.tsx:23-138`。項目ごとに「↑」「↓」（`moveQuickPrompt`、:75-94）、編集、削除。保存は画面ではなくサーバー。

### 保存形式 `server/quick-prompts.ts`
- 【事実】ファイル quick-prompts.json（:6）、`FORMAT_VERSION = 1`（:12）、`MAX_ITEMS = 40`（:9）、ラベル 1〜40 文字、本文 8KB 以内、ファイル 0o600・ディレクトリ 0o700（:10-11）。項目 `QuickPrompt { id, label, text }`（:16-20）。保存形 `{ "version": 1, "items": [...] }`（:86）。
- 【事実】`parseFile`（:43-53）: `version !== FORMAT_VERSION` または items が配列でなければ `Error("quick-prompts.json: unsupported format")`（:47）。各項目から `id, label, text` の 3 つだけを取り出す（:48-52）＝未知のキーは読み込みで落ちる。`update`（:113-121）も `{id,label,text}` を作り直す＝label/text 以外のフィールドは引き継がれない。
- 【事実】ファイルが無い → 空配列（`load`、:71-78）。壊れた/対応外 → 例外で上書きしない（:79-80、試験 `tests/unit/quick-prompts.test.ts:47-56`）。
- 【事実】項目を足す場合の読み込みの扱い: 今のコードは版違いを例外にするだけで、**旧形式（version 1）を新形式へ読み替える処理は quick-prompts.ts に無い**。version を 2 に上げて読む側が 1 と 2 の両方を受ける分岐は未実装。
- 【事実】同種の先例（open-sessions.json）: `server/session-store.ts:9` `FORMAT_VERSION = 1`、`:45-51` `parseFile` は `version !== FORMAT_VERSION` で `Error("open-sessions.json: unsupported format")`。**ここにも旧版の読み替えは無い**。さらに `save`（:88-98）は書く前に `this.read()` を呼び（:90）、読めない（版違いを含む）ファイルは上書きしない。試験 `tests/unit/session-store.test.ts:36-37` が `{version: 2, items: []}` を「例外で上書きしない」と固定している。→ 【事実】version を上げると、旧版のアプリが新版ファイルを読んで落ちる/上書きしない作りになっている（ロールバック時の影響）。version を上げずに任意のキー（例 `pinned?`）を足す場合は、parseFile が取り出す 3 つ以外を落とす仕組み（:48-52）と、update が作り直す仕組み（:113-121）の両方を変える必要がある。
- 【事実】API（`server/http.ts`）: `GET /api/quick-prompts`（:182-183）、`POST`（:186-188）、`PUT /:id`（:198-200、body の label と text だけ渡す）、`DELETE`（:204）、`POST /:id/move`（:192-194）。画面側 `src/api.ts:60-69`。

### SA の Popover / Modal / その他（本リポジトリ外）
- 【事実】components/Popover.tsx:23-36（本リポジトリ外） props: `children`（トリガー）、`content`、`placement?: "top"|"bottom"|"left"|"right"`（既定 bottom）、`open?`、`onOpenChange?`、`className?`。制御式/非制御式の両対応。トリガーを `<span>` で包みクリックで開閉。パネルは `createPortal(…, document.body)`（:147）、`role="dialog"`（:151）。外側 `mousedown` で閉じる（:110-122）。**Esc の keydown 処理は Popover.tsx に無い**（`grep -n 'keydown\|Escape'` は Popover.tsx でヒットなし、Modal.tsx のみ :73,78,108）。
- 【事実】components/Modal.tsx:24-33（本リポジトリ外） props: `open, onClose, title, size?: "sm"|"md"|"lg"|"xl", dismissOnOverlay?（既定 true）, children, footer?`。Esc で `onClose`（:71-77、`stopPropagation` あり）、Tab のフォーカストラップ（:108）。
- 【事実】Button.tsx（本リポジトリ外）: variant primary/secondary/ghost/danger/outline/tab、size sm/md/lg、`active`, `iconOnly`, `layoutClassName`。className・style は渡せない（`Omit<…, "className"|"style">`）。Badge.tsx（本リポジトリ外）: `variant` neutral/info/success/warning/danger、`appearance` soft/solid、`size` sm/md、`dot`、`icon`、`className`。
- 【事実】SA の components に Checkbox / Switch / Toggle（ボタン以外）に当たるものは無い。`ls components | grep -iE 'check|switch|toggle|radio|menu|dropdown|list|sort'` の結果は IconToggleButton（ハートの白抜き/塗りの押下式）、NavDropdown、NavItemList、SubMenu のみ。「常に表示」の選択に使える候補として IconToggleButton（`pressed, onClick, iconOff, iconOn, aria-label, size, variant, disabled, count`）が既にある（使うかは設計判断）。

---

## C. セッション一覧の行

`src/components/SessionList/SessionList.tsx`（127 行）と `src/components/SessionList/SessionList.css`（54 行）。
- 【事実】1 行 = `:40-47` `<div data-testid="session-row" data-session-id data-state data-unread className="ac-session [--selected]">`（`.ac-session` は `display:flex; align-items:center; gap:var(--space-1); padding:var(--space-1); border; radius`、CSS :1-9）。中は左から:
  1. `:48-85` 行全体を押す `Button variant="ghost" size="sm" layoutClassName="ac-session__select"`（`flex:1; min-width:0; flex-direction:column`、CSS :16-24）。クリックで選択（:53）、ダブルクリックで名前変更（:54-56、`state !== "stopped"` のとき）。`aria-current`（:52）。
     - 1 段目 `:58-75` `<span className="ac-session__line" data-testid="session-line-1">`（`display:flex; gap:space-2; min-width:0`、CSS :26-31）に、`<StatusDot state>`（:59）、名前 `<span className="ac-session__name" data-testid="session-name">`（:60、CSS :33-42 `flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`）、CI バッジ（:61-67 `<span data-testid="ci-badge" data-ci>` ＋ SA `Badge size="sm"`、`s.ci` があるときだけ）、未読バッジ（:68-74 `data-testid="unread-badge"`、`Badge appearance="solid"`、`s.unread > 0` のとき）。
     - 2 段目 `:76-84` `<span className="ac-session__role" data-testid="session-line-2">`（CSS :44-50 `overflow:hidden; ellipsis; nowrap; font-xs; text-secondary`）に役割ラベル（`roleLabel(s.roleId)`、:33-36 の `t(role.labelKey)`。「Opus 設計」は `src/locales/ja.json:319` `role.opusDesigner`）と、予約中の名前 `<span className="ac-session__pending" data-testid="pending-name">`（:79-83、`t("ac.rename.pendingLine",{name})`）。
  2. 鉛筆（名前変更）`:86-97` `Button ghost sm iconOnly`（`state !== "stopped"`）。
  3. 閉じる `:98-110` `Button ghost sm iconOnly data-testid="close-session"`（`state !== "stopped"`）。
  4. 一覧から外す `:111-122` `Button outline sm iconOnly`（`state === "stopped"` のとき、閉じるの代わり）。
- 【事実】`StatusDot`（`src/components/StatusDot/StatusDot.tsx:14-22`）は**丸い印と状態の文字（label）を 1 つの `.ac-status` に持つ**（`data-testid="status"`、丸 `.ac-status__dot--{state}`、文字 `.ac-status__label` に `t("ac.state.*")`）。すなわち今の 1 段目は「丸＋状態の文字＋名前＋CI＋未読」で、状態の文字が名前の幅を食う。状態の文字列は `src/locales/ja.json:23-28`（working「作業中」/ waiting「待ち」/ idle「待機」/ noClaude「Claude 未起動」/ stopped「停止」/ unknown「不明」）。丸の色は `src/components/StatusDot/StatusDot.css:16-19`（working=success、waiting=warning、idle=text-secondary、stopped=error。no-claude と unknown は既定の text-muted、:13）。CI の文言 `src/locales/ja.json:218-220`（「CI 失敗」「CI 実行中」「CI 成功」）。
- 【事実】`StatusDot` を使うのは `src/components/SessionList/SessionList.tsx:59` のみ（`grep -rn StatusDot src tests`、StatusDot 自身のファイルと試験を除く）。
- 【事実】行の高さの縛り: `tests/e2e/console.spec.ts:382-387` `COMPACT_ROW_MAX_PX = 64`、全行 64px 以下（ライト・ダーク。:386-398）。名前は `text-overflow: ellipsis; white-space: nowrap; overflow: hidden`（:400-401）。2 段目に状態バッジと CI バッジを足すとこの 64px 上限に関わる。
- 【事実】SessionView の型 `src/types.ts:3-19`（`state: SessionState` = working/waiting/idle/no-claude/stopped/unknown、`ci?: CiState`、`unread`、`pendingName?`、`canInput`）。

---

## D. 並び順

### 今どこで決まっているか
- 【事実】正本は `server/sessions.ts:114` `private readonly sessions = new Map<string, Session>()` の挿入順。`list()` は `:146-148` `return [...this.sessions.values()]`。並べ替えの処理（sort）は sessions.ts に無い。追加は `:276` `this.sessions.set(session.id, session)`（spawnSession の末尾）、削除は `:287`。
- 【事実】hub の snapshot: `server/hub.ts:324-326` `const views = this.sessions.list().map(…)` → `:355` 付近 `return { sessions: views, … }`。つまり画面に届く順＝ Map の挿入順。画面は `src/pages/ConsolePage.tsx:62-63` の ws `/ws/events` と `fetchState` の `state.sessions` をそのまま `SessionList` に渡し（`:307-308`）、`src/components/SessionList/SessionList.tsx:39` で `sessions.map` するだけ。画面側に並べ替えは無い。
- 【事実】`id` は `server/sessions.ts:254` `randomUUID()` で**起動のたびに新しく振られる**（再起動で変わる）。

### open-sessions.json と復元
- 【事実】`server/restore.ts:72-83` `OpenSessionRecorder.sync()` が `this.sessions.list().filter(s => !s.exited).map(...)` の順（= Map の順）で items を作り、`store.save(items)`（:84）。items 配列の順番＝保存される順。項目は `roleId, name, cwd, branch?, claudeSessionId?`（`server/session-store.ts:12-18`、`normalizeItem` :35-43 が余計なキーを落とす）。**項目に id は無い**。
- 【事実】`restoreOnStartup`（`server/restore.ts:105-152`）は `for (const item of items)`（:123）で items の順に 1 件ずつ `sessions.restore(...)`（:140）、間に `restoreStaggerMs` の待ち（:138）。したがって復元後の Map 順＝ items の順（開けなかった項目は飛ばされ、外れる。:126, 132, 136, 144）。
- 【事実】復元中は書込を止める（`recorder.hold()` :109、`release()` :55-58）。書き込みのきっかけは SessionManager の変更通知（`server/restore.ts:45` `sessions.onChange`）と名前変更通知（:47）。
- 【事実】open-sessions.json の version は `server/session-store.ts:9` で 1、旧版読み替えなし、版違いは読まず上書きもしない（A/B で上述 :45-51, :88-91、試験 `tests/unit/session-store.test.ts:36-37`）。

### 並び順を保存する候補の場所（事実としての制約のみ）
- 【事実】open-sessions.json の items の順番は、すでに「画面の並び」を再現している（Map 順＝ items 順）。別のファイルに並びを持つと、保存場所が 2 つになる（PO 要件「保存は既存の 1 か所に寄せる。分散禁止」）。
- 【事実】並びを入れ替えるには、(a) Map の挿入順を並べ替える手段が SessionManager に無い（`Map` は挿入順固定で、並べ替えは作り直しか、別の順序配列を持つ必要がある）、または (b) 画面側で並べ替え、サーバーには「並びの配列」を保存する、のいずれか。どちらも現状のコードには無い【事実：該当の処理が grep に出ない】。
- 【事実】id は再起動で変わり items に id は無いため、画面で並べ替えた結果をファイルに残すには「現在の Map（= 現在のセッション id の並び）を、そのまま items の順に書き出す」形が、現在の復元の仕組みに素直に乗る（`server/restore.ts:72-83` が Map 順で書く）。items に `position` を足す案は、`parseItem`（`server/session-store.ts:22-32`）と `normalizeItem`（:35-43）が既知のキーしか通さないので、足すならこの 2 か所と version の扱い（上記）が要る。【推測】
- 【事実】その他の「順序」の例: クイック指示は `items` の配列順だけが正本で、`move(id, "up"|"down")` が隣と入れ替える（`server/quick-prompts.ts:131-142`）。

### ドラッグ用の部品
- 【事実】`package.json` の依存（dependencies / devDependencies）に dnd 系（dnd-kit・react-beautiful-dnd・sortablejs 等）は無い（`package.json` 全文確認）。
- 【事実】SA に行の並べ替えを HTML5 drag and drop で実装した例が 1 つある（部品としての金型ではなくページ内の直書き）: .sa-cache/frontend/src/pages/products/ProductsPage.tsx:347-350, 381-382（本リポジトリ外）。`<tr draggable={reorderMode} onDragStart={() => { dragId.current = p.id }} onDragOver={(e) => e.preventDefault()} onDrop={() => onReorderDrop(p.id)}>`（`reorderMode` のときだけ有効、`cursor: grab`）。他の `draggable` は constants/icons.tsx:357（本リポジトリ外）（`draggable={false}`）のみ。dnd-kit・react-beautiful-dnd・sortablejs への参照は SA に無い（`grep -rnE 'draggable|onDragStart|dragstart|@dnd-kit|react-beautiful|sortablejs'`、test/stories 除く）。`components/` に並べ替え用の部品は無い。
- 【事実】本リポジトリ main の `src/`・`extension/`・`tests/` に `draggable|onDrag|onDrop|dragover|dragstart` は無い（grep 結果なし）。HTML5 の drag and drop を使う既存コードは別ブランチ（`terminal-ux` worktree）の `src/components/TerminalPane/TerminalPane.tsx:178-192`（画像の drop。ホスト要素に `dragover`/`drop` を直接 addEventListener）と `src/components/TerminalPane/TerminalPane.ux.test.tsx:148-153` のみ。ファイルの drop 用で、要素の並べ替えには使えない形。
- 【事実】キーボードでの並べ替えの既存例: よく使う指示の「↑」「↓」ボタン（`src/components/QuickPrompts/QuickPromptEditor.tsx:75-94`、`moveQuickPrompt`＝`src/api.ts:68-69`、サーバー `server/quick-prompts.ts:131-142`、API `server/http.ts:192-194`）。セッションの並びにはこれに当たるものは無い。

---

## E. 試験（行の構造・バー・タブに依存するもの）

- 【事実】`src/components/SessionList/SessionList.test.tsx`:
  - `:15-23` 各行の名前・役割・状態の表示、`:24` onSelect。
  - `:36-51` 閉じる・外すの出し分け（`:51` 行内の「セッションを閉じる」ボタン）。
  - `:56-61` `unread-badge` は未読のある行だけ、`data-unread`。
  - `:64-91` 名前変更（ペンシル、ダブルクリック、`pending-name`）。
  - **`:95-104` K2: 「1 段目に status・名前・未読バッジ、2 段目に役割」**。`session-line-1` の中に `status`・名前・`unread-badge`、`line2.textContent` が `"シェル"` と**完全一致**。→ 2 段目に状態バッジと CI バッジを足す、1 段目から状態の文字を外す、という変更はこの試験と直接ぶつかる。
  - `:106-` K3 右端ボタンの aria-label/title、`:125-` K4 `aria-current`・選択クラス、`:136-151` v0.5.0 K3: `ci-badge`（`.comp-badge--danger/info/success`）が名前の横にある、ci が無ければ出ない。
- 【事実】`src/pages/ConsolePage.test.tsx`: `session-row` を待つ（:221, 275）、タブは `findByRole("tab", { name: /変更/ })` 等（:343-400）。変更タブの textContent が `"変更"`（:371）・`"部品"`（:398）と完全一致、件数が付くと `toContain("1")`/`("7")`（:368, 400）。→ タブの高さ・文字サイズの変更は textContent に影響しないが、タブを別部品に差し替えるとこの `role=tab`・textContent の前提が変わる。`fetchQuickPrompts` のモック（:26, 52, 131-132）と、ボタン押下で `checkQuickPromptSend("s1","p1")`（:291-308）。バーが全件を直接並べる前提。
- 【事実】`tests/e2e/console.spec.ts`:
  - `:380-401` `expectCompactRows`: 行の高さ 64px 以下（`COMPACT_ROW_MAX_PX = 64`、:382-383）と名前の `ellipsis/nowrap/hidden`。
  - `:87-104` `session-row`、`status`（:103 `getByTestId("status")` で状態を読む）、`:410-443` `unread-badge`、`:454-479` `session-name` のダブルクリックと `pending-name`、`:1022-1039` `ci-badge` の文字（`"CI 失敗"`/`"CI 実行中"`/`"CI 成功"`）と、ci 無しは 0 件。
  - `:521-` バー: `getByTestId("quick-prompt-bar")`、`:547` 名前指定のボタン `getByRole("button", { name: "テスト実行", exact: true })` が見える、`:565-570` `bar.getByRole("button")` が `toHaveText(["並び一","並び二","指示を編集"])`、「指示を編集」を押して編集画面で↑↓、Esc で閉じて `["並び二","並び一","指示を編集"]`、`:593`/`:615` 「複数行」「切替確認」のボタンを `quick-prompt-bar` 内で押す。→ バーを 1 行・「よく使う指示」をボタン＋ポップアップに変えると、これらの前提（全件がバーに直接並ぶ・ボタン名「指示を編集」）が崩れる。
  - タブ: `getByRole("tab", { name: /変更/ })`、`/端末/`、`"PR"`（:814, 864, 923-939, 994, 1048）。
  - `:544` dataDir の中身が `["chrome-extension","open-sessions.json","picker-token","quick-prompts.json"]` と完全一致（別の保存ファイルを増やすとこの試験が落ちる）。
- 【事実】並びの保存に関する試験: `tests/unit/session-store.test.ts`（:19-24 round-trip と version が 1、:36-37 版違い・壊れ・項目不足は例外で上書きしない）、`tests/unit/session-restore.integration.test.ts`（中身は未精査【未確認】）、`tests/unit/restore-guard.test.ts`（同左）。
- 【事実】governance の試験: `tests/unit/design-governance.test.ts:176-188, 190-` が A で述べた箇所。

---

## 未確認の一覧
- SA の Badge が `--font-*` を読むか（A: `--font-xs` を上書きした場合の波及）。
- `src/pages/ConsolePage.css` と Tabs.css の読み込み順（A: 子孫セレクタで指す場合の勝敗）。
- `tests/unit/session-restore.integration.test.ts`・`tests/unit/restore-guard.test.ts` の中身。
