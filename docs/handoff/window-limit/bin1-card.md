# 便1 同時に開ける窓の上限を設定にし、Sonnet の役割を外す（v0.47.0）作る係への指示書

- 設計: `docs/handoff/window-limit/design.md` 第1.5版 §4-1・§6 K1・K2（ボタン以外）・K10・K11・K12・§10 便1（PO 承認 2026-10-26「1」）
- 目的: 同時に開ける窓の数を設定ファイルの `maxSessions` で決められるようにし、この Mac では 6 にする。一覧の見出しに「開いている N / M」を出す。新しい窓の役割から Sonnet を外す
- この便に入れないもの: 休ませる・起こす・休止中の状態・「まとめて休ませる」ボタン（便2）。`occupiedCount()` は休止中を除く形にしない（休止中がまだ無いため。便2 で足す）
- 作る係は、枝を push するところまで。PR を作る・マージする・導入するのは設計者
- 調べた実物（origin/main bb8c0c4 = v0.46.3。生出力 /tmp/CC報告ファイル/window-limit/bin1-recon.txt）:
  - `server/sessions.ts:15` `const DEFAULT_MAX_SESSIONS = 16;`。:43 options の `maxSessions?: number`。:168 `private readonly maxSessions: number;`。:173 `private pending = 0;`。:187 `this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;`
  - 上限の判定: :275（create）と :296（resume）が `this.sessions.size + this.pending >= this.maxSessions` で `SessionInputError("too many sessions")`。:316-317 `hasCapacity()` が `this.sessions.size + this.pending < this.maxSessions`（:310・:325 が使う）
  - `server/config.ts`: :35-58 `DEFAULT_*` 群、:62 `export interface Config`、:211-215 `parsePositive`（整数を見ない）、:294 からの返す形（:317-334 に `parsePositive` の並び）
  - `server/index.ts:75` `const sessions = new SessionManager(config);`
  - `server/hub.ts:69-82` `export interface Snapshot`、:708-735 `snapshot()`（:735 で返す）。`server/http.ts:172-173` の `/api/state` は `hub.snapshot()` を返す
  - `src/types.ts:61-75` `export interface ConsoleState`（:70 `picksUnsent`、:72 `activityRev`）
  - `src/pages/ConsolePage.tsx:421` `<h1 className="ac-page__title">{t("ac.sessions")}</h1>`。`src/locales/ja.json:4` `"sessions": "セッション"`（文字列。なので新しいキーは `ac.sessions.*` にできない）
  - `agent-console.config.json:32` `"roles": [`、:43-49 `sonnet-impl` の項目
  - 試験: `tests/unit/helpers/harness.ts:228` `new SessionManager(config, { maxSessions: options.maxSessions, closeGraceMs: options.closeGraceMs })`。Config を手で作る所は `tests/unit/helpers/harness.ts` と `tests/unit/helpers/tmux-child-config.ts`
  - 文言キー `role.sonnetImpl`（`ja.json:657`）は試験の役割表（harness・e2e-env・部品の試験）が使う。**消さない**
  - CI の手順（`.github/workflows/ci.yml:44-72`）: npm ci → Sales Anchor を clone して salesanchorRoot に向けた設定を作る → `node scripts/sa-sync.mjs` → typecheck → lint → test → tmux の統合 → build → playwright → e2e

## 決めたこと
- `server/config.ts`
  - `DEFAULT_*` 群に `export const DEFAULT_MAX_SESSIONS = 16;` を足す（`sessions.ts:15` から移す。`sessions.ts` は config から import する）
  - `parsePositiveInt(raw, key, fallback)` を `parsePositive` の下に足す: `undefined` なら fallback。`typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0` なら `config: ${key} must be a positive integer` で投げる
  - `Config` に `maxSessions?: number;`（任意。手で Config を作る試験を壊さないため）。返す形に `maxSessions: parsePositiveInt(o.maxSessions, "maxSessions", DEFAULT_MAX_SESSIONS),`
- `server/sessions.ts`
  - :187 を `this.maxSessions = options.maxSessions ?? config.maxSessions ?? DEFAULT_MAX_SESSIONS;` にする（constructor の第1引数の名前は実物に合わせる）。これで `server/index.ts:75` は変えずに設定の値が効く（設計 §4-1 の「index.ts で渡す」と同じ結果。手で渡す口を増やさない）
  - `occupiedCount(): number { return this.sessions.size + this.pending; }` を public で足し、:275・:296・:317 の 3 か所をこれを使う形にする（`occupiedCount() >= this.maxSessions` で拒否／`occupiedCount() < this.maxSessions` で空きあり）。式の意味は変えない
  - `openCount(): number { return this.sessions.size; }` と `maxSessionCount(): number { return this.maxSessions; }` を public で足す
- `server/hub.ts`: `Snapshot` に `maxSessions: number;`・`openCount: number;`（説明の1行コメント付き）。`snapshot()` の返す形に `maxSessions: this.sessions.maxSessionCount(), openCount: this.sessions.openCount()` を足す
- `src/types.ts`: `ConsoleState` に `maxSessions: number;`・`openCount: number;`（同じく1行コメント）
- `src/pages/ConsolePage.tsx:421` の h1 の直後に、SA の金型 `Badge` で `t("ac.openCount", { count: state.openCount, max: state.maxSessions })` を出す。`openCount >= maxSessions` のときは注意の色の variant、それ以外はふつうの variant（どの variant 名があるかは `npm run sa-sync` の後に `.sa-cache` の Badge の型で確かめて選ぶ。生の span・色の直書きは使わない）。`state.maxSessions` が無い（古いサーバーの応答）ときは出さない
- `src/locales/ja.json`: `ac` の直下（`"sessions"` の後）に `"openCount": "開いている {{count}} / {{max}}"`。ほかの言語ファイルは無い（`src/locales/` は ja.json だけ）
- `agent-console.config.json`: `sonnet-impl` の項目（:43-49 を含む1つのオブジェクト）を消し、上の階層に `"maxSessions": 6` を足す。ほかの値は変えない。`reserveRoles`・`routineManagerRoles` などに `sonnet-impl` が書かれていれば止まって報告する（今は無い）
- 設定の表: `git grep -n "agentsPollMs" -- '*.md' ':!docs/handoff' ':!docs/CHANGELOG.md'` で見つかった設定の説明の表に `maxSessions`（同時に開ける窓の数。正の整数。既定 16）を1行足す。見つからなければ足さずに報告する
- 版を 0.47.0 に（`package.json`・`package-lock.json` の2か所・`extension/manifest.json`）。`docs/CHANGELOG.md` の先頭の並びに1行: 「0.47.0 同時に開ける窓の数を設定 `maxSessions`（正の整数・既定16）で決められるようにし、この Mac の設定は 6 にした。一覧の見出しに『開いている N / M』を出す。新しい窓の役割から Sonnet 実装を外した（Sonnet の作業はクラウドで行う）。戻し方は `bash scripts/ac-update.sh v0.46.3`。設計は docs/handoff/window-limit/design.md §4-1 便1。」

## 守ること
- 上に書いた変更と下の試験だけ。ほかの振る舞い・文言・既存の試験の期待は変えない（上限の判定の式の意味、止まった窓を数えること、`too many sessions` の文、400 の扱い）
- `tests/unit/helpers/harness.ts` は、options に `configMaxSessions?: number` を足し、作る config に `...(options.configMaxSessions !== undefined ? { maxSessions: options.configMaxSessions } : {})` を足すことだけ許す
- `src/pages/ConsolePage.test.tsx` など、`ConsoleState` の形の見本を持つ試験は、型が通るよう `maxSessions`・`openCount` を足すことだけ許す
- 部品は SA の金型だけ（ADR-144 と同じ考え。lint の design-governance が見る）。文言は全部 `t()`
- 実装の前に確かめて生出力を残す: `grep -rn "maxSessions\|DEFAULT_MAX_SESSIONS\|hasCapacity\|sessions.size" server/ src/ tests/`。上の「調べた実物」と違う呼び口（上限を別の式で数えている所）があれば、作らずに止まって報告する

## 試験
- `tests/unit/config.test.ts`: `maxSessions` 無し → 16。`6` → 6。`2.5`・`0`・`-1`・`"6"` → それぞれ `config: maxSessions must be a positive integer` で投げる（K1）
- `tests/unit/` の統合試験（上限を扱う既存の試験があればそのファイル、無ければ `tests/unit/max-sessions.integration.test.ts` を新しく）: harness を `configMaxSessions: 2`（options の `maxSessions` は渡さない）で作り、2本開いたあとの create と resume が 400・`too many sessions`。1本閉じれば開ける。止まった（exited）窓 1 本と動いている窓 1 本では開けない（今の振る舞いのまま）。`/api/state` が `maxSessions: 2` と `openCount`（開いている数）を返す（K1・K2）
- 実物の設定ファイルの試験（`tests/unit/config.test.ts` に1つ）: リポジトリの `agent-console.config.json` を `JSON.parse` し、`roles` の id に `sonnet-impl` が無いこと、`maxSessions === 6` であること（K10）
- 画面の試験: `src/pages/ConsolePage.test.tsx` で、状態に `openCount: 5, maxSessions: 6` を与えると「開いている 5 / 6」が出る。`openCount: 6, maxSessions: 6` で注意の variant になる（K2 の表示）
- e2e は既存のものが通ること（上限 16 のまま。新しい e2e は足さない。400 の振る舞いは上の統合試験で見る）
- 全体: CI と同じ手順（`.github/workflows/ci.yml:44-72`。Sales Anchor は `git clone --depth 1 https://github.com/shingo-ops/salesanchor.git` を salesanchorRoot にした設定で sa-sync）で typecheck・lint・test・build を流す。e2e・tmux の統合が動かせない環境なら、動かせなかったことを報告に書く（CI で見る）（K11・K12）

## 報告
- 枝 `release/window-limit-bin1`（origin/main から作る）に commit して push。最終報告に、枝名・HEAD の 40 桁 sha・変えたファイルの一覧（`git diff --stat origin/main...HEAD`）・流した試験の命令と結果（件数・失敗の有無）・実装前の grep の生出力の要点を書く
- 最後の行は DONE / BLOCKED: <理由> / NEEDS_DECISION: <内容> のどれか
