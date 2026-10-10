# 実装カード: agent-console 段階1

- 設計: docs/handoff/stage1/design.md（必読。§2 KGI・§5 SSOT・§6 安全・§7 デザインシステムが受入条件）
- 調査: docs/handoff/stage1/recon.md
- ブランチ: `feat/stage1`（`design/stage1` から作成。PR の base は `main`）
- 実装担当: Claude Sonnet / 審査: Claude Opus

## 0. 進め方の約束（違反しそうなら止まって報告）

- 推測で実装しない。ライブラリの API・設定は Context7（resolve-library-id → query-docs）で確認し、確認した内容を `docs/handoff/stage1/impl-notes.md` に URL/ライブラリ ID 付きで記録する。Context7 が使えなければその事実を書き、公式 README を WebFetch で確認。
- TDD: 解析・検証ロジックはテストを先に書く（RED→GREEN）。
- 本物の `claude` をテストで起動しない（利用量・規約）。テストは差し替え可能な設定（§3）でダミーコマンドを使う。
- `~/.claude/`・`~/.claude.json`・`/Users/tanizawashingo/salesanchor` に書き込まない（salesanchor は git fetch / git show / git archive の読み取りのみ）。
- フックや権限判定で止められたら、言い換え再試行せず BLOCKED: で報告。迷ったら NEEDS_DECISION:。
- 削除系コマンド（rm -rf 等）はフックで止まる。生成物の掃除が必要なら上書き生成で対処し、削除は行わない。
- コミットは `feat/stage1` のみ。main への push・マージはしない。PR 作成は §8 の形式で。
- 最終報告の 1 行目は DONE / BLOCKED: / NEEDS_DECISION:。CI の完了待ちはしない（push と PR 作成まで）。

## 1. 技術構成（版は npm view で最新安定版を確認して固定し、impl-notes に記録）

- Node 24（ローカル v24.12.0）、TypeScript、ESM（"type": "module"）。
- サーバー: Node 標準 `http` ＋ `ws`、`node-pty@1.1.0`。実行は `tsx`（開発）／`tsc` ビルド後の `node`（本番起動）。
- フロント: Vite＋React 18（Sales Anchor と同系統: react/react-dom ^18.3.1、vite ^8、@vitejs/plugin-react ^6、typescript ^5.7）、`@xterm/xterm`、`@xterm/addon-fit`、`i18next`、`react-i18next`、`@heroicons/react`（SA 金型の依存。recon §V-4）。
- テスト: vitest（単体）、@playwright/test（e2e、Chromium）。

## 2. ファイル構成

```
package.json / tsconfig*.json / vite.config.ts / vitest.config.ts / playwright.config.ts
agent-console.config.json          # 役割一覧・パス（§3）
scripts/sa-sync.mjs                # Sales Anchor origin/main の frontend/src を .sa-cache/ へ展開（§5）
scripts/check-design-governance.mjs# 設計 §7 の検査
scripts/postinstall.mjs            # node-pty spawn-helper に実行権
server/
  index.ts        # 起動（127.0.0.1・トークン生成・URL 表示）
  config.ts       # 設定読込と検証（必須キー欠落で起動中止）
  auth.ts         # トークン・Origin 検査
  sessions.ts     # セッション管理（node-pty、リングバッファ 1MB）
  ring-buffer.ts
  agents.ts       # `claude agents --json` 実行（子プロセス・パイプ）と解析、pid 照合
  process-tree.ts # ps -axo pid=,ppid= から子孫 pid 集合
  worktree.ts     # new-worktree.sh 呼出・ブランチ名検証・git worktree list --porcelain 解析
  ledger.ts       # active-work.d の列挙と ledger-lookup.sh 呼出・状態集計
  tokens.ts       # .sa-cache の展開元 SHA 読取
  http.ts / ws.ts
src/
  main.tsx / App.tsx / i18n.ts
  locales/ja.json
  pages/ConsolePage.tsx           # 画面（金型のみ使用）
  components/                     # アプリ固有の金型（Xxx.tsx＋Xxx.css＋Xxx.test.tsx）
    SessionList/ TerminalPane/ LedgerBoard/ NewSessionForm/ StatusDot/
tests/unit/*.test.ts  tests/e2e/*.spec.ts  tests/fixtures/
.github/workflows/ci.yml
```

## 3. 設定（agent-console.config.json）

```json
{
  "port": 4319,
  "salesanchorRoot": "~/salesanchor",
  "newWorktreeScript": "scripts/new-worktree.sh",
  "ledgerLookupScript": "scripts/ledger-lookup.sh",
  "ledgerDir": ".claude-pipeline/active-work.d",
  "claudeBin": "claude",
  "agentsPollMs": 3000,
  "ledgerPollMs": 60000,
  "ringBufferBytes": 1048576,
  "roles": [
    { "id": "opus-designer", "labelKey": "role.opusDesigner", "command": ["/bin/zsh", "-ic", "ccopusgo"], "needsWorktree": false },
    { "id": "sonnet-impl", "labelKey": "role.sonnetImpl", "command": ["/bin/zsh", "-ic", "claude --model sonnet"], "needsWorktree": true },
    { "id": "shell", "labelKey": "role.shell", "command": ["/bin/zsh", "-i"], "needsWorktree": false }
  ]
}
```
- 環境変数 `AGENT_CONSOLE_CONFIG` で別ファイルを指定可能（テスト用）。パス先頭の `~` は os.homedir() で展開。
- `needsWorktree:false` の作業場所は `salesanchorRoot`。

## 4. 振る舞い（受入条件との対応）

1. 起動（K8）: `npm start` → `127.0.0.1:<port>` のみで待受（他アドレスで listen しない）。`crypto.randomBytes(32)` のトークンを生成し `http://127.0.0.1:<port>/?t=<token>` を標準出力。静的ファイル以外の HTTP API と WS は、トークン（クエリ `t` または `Authorization: Bearer`）不一致で 401。WS は `Origin` が `http://127.0.0.1:<port>` 以外なら 403。
2. 新規セッション（K2）: API `POST /api/sessions {name, roleId, branch?}`。name は 1〜40 文字（制御文字禁止）。`needsWorktree` の役割は branch 必須で `^release/[a-z0-9][a-z0-9-]{1,60}$`。`execFile('bash', [<salesanchorRoot>/<newWorktreeScript>, branch], {cwd: salesanchorRoot})`（シェル文字列連結禁止）。exit≠0 なら標準出力/エラーを UI に返し作成中止。成功後 `git -C <salesanchorRoot> worktree list --porcelain` を解析し branch `refs/heads/<branch>` の worktree パスを確定（無ければエラー）。その cwd で `pty.spawn(command[0], command.slice(1), {cwd, cols, rows, env: process.env})`。
3. 端末（K2/K3）: WS で入出力。出力は ring-buffer（ringBufferBytes 上限、古い順に捨てる）に蓄積し、接続時に全量を先に送る。画面側 xterm は表示中の 1 本だけ生成（scrollback 2000）、切替時に dispose。リサイズを転送。
4. 状態（K1）: agentsPollMs ごとに `execFile(claudeBin, ['agents','--json'])`。出力から ANSI エスケープを除去し `\r\n`→`\n`、JSON 配列を解析（不正なら前回値を保持し状態「不明」）。各セッションの pty pid の子孫 pid 集合（process-tree）に含まれる `pid` の行を当該セッションの状態とする（busy→作業中、waiting→待ち、idle→待機、該当なし→「Claude 未起動」、pty 終了→停止）。未知キーは無視。
5. 台帳（K4）: ledgerPollMs ごと＋手動更新。`<salesanchorRoot>/<ledgerDir>/*.md` の 1 行目 `branch: ` を読み、各 branch で `execFile('bash',[ledgerLookupScript, branch],{cwd: salesanchorRoot})`。exit0 の出力行の 4 列目（`|` 区切りで trim）を状態とし、状態ごとに列（IN_PROGRESS, REVIEW, DONE, その他）にカード表示。exit1/2 は「未登録/衝突」列。並列実行は同時 8 本まで。
6. デザイン（K6）: 起動前に `scripts/sa-sync.mjs` が `git -C <salesanchorRoot> fetch origin main` → `git archive origin/main frontend/src | tar -x -C .sa-cache`、`.sa-cache/SOURCE` に `git rev-parse origin/main` を書く。失敗したら起動中止（フォールバックなし）。Vite で `@sa` エイリアス → `.sa-cache/frontend/src`。`src/main.tsx` で `@sa/index.css` を import。SA の翻訳資源の場所を `.sa-cache` 内で特定して i18n に読み込み（無ければ NEEDS_DECISION）、アプリ固有キーは `src/locales/ja.json`。
7. 画面: 左＝SessionList（名前・役割・StatusDot）＋「新しいセッション」ボタン（SA Button）。中央＝TerminalPane。右＝LedgerBoard（列ごとの件数バッジ＝SA Badge、カード＝SA Card）。下部に SA 展開元 SHA と `claude --version`。新規作成は SA Modal 内の NewSessionForm（SA TextField / Select / Button）。
8. 書込禁止（K5）: サーバーコードに `~/.claude` / `.claude.json` へのファイル書込経路を作らない（検査: `grep -R "\.claude" server` の結果を impl-notes に記録）。

## 5. デザイン検査（scripts/check-design-governance.mjs, CI 必須）
①`src/**/*.{css,tsx,ts}` に `#[0-9a-fA-F]{3,8}\b` / `rgb(` / `rgba(` / `hsl(` が 0 件 ②`src/pages/**/*.tsx` に `<button` `<input` `<select` `<textarea` が 0 件 ③`src/**/*.tsx` の JSX テキストに日本語直書き 0 件（`t(` 経由のみ）④`git ls-files .sa-cache` が空。違反は file:line を出して exit 1。

## 6. テスト（最低限）
- 単体: agents 解析（エスケープ混入・不正 JSON・未知キー）、process-tree、ブランチ名検証、porcelain 解析、台帳行の解析と集計、ring-buffer、auth（トークン/Origin）、config 検証。
- e2e（Playwright、テスト用 config: 一時 git リポジトリを salesanchorRoot に、スタブの new-worktree.sh（`git worktree add -b`）と ledger-lookup.sh、claudeBin＝固定 JSON を返すスタブ、役割＝`/bin/sh -c 'echo READY; cat'`）:
  K1 状態表示、K2 作成→入力→出力表示、K3 再読込で出力復元、K4 件数一致、K5 settings.json ハッシュ不変（実ホームの ~/.claude/settings.json の sha256 を前後比較。存在しない CI では skip を明示）、K7 サーバー RSS（`ps -o rss= -p`）と CDP `Performance.getMetrics` の JSHeapUsedSize をダミー 3 セッションで記録し閾値判定、K8 不正トークン 401・不正 Origin 403。
- スタブは `tests/fixtures/` に置く（Sales Anchor のファイルの複製は置かない）。

## 7. CI（.github/workflows/ci.yml, ubuntu-latest と macos-latest）
npm ci → Sales Anchor（public: https://github.com/shingo-ops/salesanchor）を `--depth 1` で clone し `salesanchorRoot` に指定して sa-sync → typecheck → lint（check-design-governance）→ vitest → build → playwright install chromium → e2e。

## 8. PR
- タイトル: `feat: stage1 console (sessions, terminal, ledger board)`、base `main`、Draft で作成。
- 本文は `/Users/tanizawashingo/agent-console/.pr-body-stage1-feat.md` に書き、`cd /Users/tanizawashingo/agent-console && gh pr create --draft --repo shingo-cc/agent-console --base main --head feat/stage1 --title "…" --body-file /Users/tanizawashingo/agent-console/.pr-body-stage1-feat.md` で作成（絶対パス必須。PR 本文検査フックがある）。本文に `### 標準ワークフロー確認`、`対象ADR: ADR-067, ADR-144`、`recon: docs/handoff/stage1/recon.md`、`設計: docs/handoff/stage1/design.md`、`触るファイル:`（`git diff --name-only origin/main...HEAD` の全ファイルを 1 行 1 件）、`削除するファイル: なし` を含める。末尾に `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。
- コミット末尾: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- `.pr-body-*.md` は .gitignore に追加。

## 9. 報告
DONE の場合: PR URL、各 KGI の自己判定（テスト名と結果の生出力の該当行）、K7 の実測値、impl-notes.md の要約、未解決点。
