# 段階1 実装メモ

実装日: 2026-10-11 / 実装: Claude Sonnet

## 固定した版（npm view 2026-10-11 時点で確認）

| パッケージ | 版 | 備考 |
|---|---|---|
| node-pty | 1.1.0 | カード指定 |
| ws / @types/ws | 8.22.0 / 8.18.2 | |
| @xterm/xterm / @xterm/addon-fit | 6.0.0 / 0.11.0 | |
| react / react-dom | 18.3.1 | カード指定（npm 最新は 19.3.0 だが SA に合わせ 18 系） |
| vite / @vitejs/plugin-react | 8.3.4 / 6.1.2 | |
| typescript | 5.9.3 | カード指定 ^5.7（最新 7.0.2 は SA と揃わないため 5 系） |
| i18next / react-i18next | 26.4.3 / 17.0.16 | SA は ^26.1.0 / ^17.0.7 |
| @heroicons/react / lucide-react | 2.2.0 / 1.55.0 | SA の金型の依存 |
| vitest | 5.0.3 | |
| @playwright/test | 1.64.0 | |
| jsdom | 26.1.0 | 最新 30.1.2 は Node ^24.15 を要求し、ローカル 24.12.0 で EBADENGINE。26 系に固定 |
| tsx | 4.23.15 | |

## Context7 で確認した API

| 対象 | Context7 ID | 確認内容 |
|---|---|---|
| node-pty | /microsoft/node-pty | `spawn(file, args, {name, cols, rows, cwd, env})`、`onData`/`onExit`、`resize(cols, rows)`（正でない値は例外）、`kill()` |
| ws | /websockets/ws | `new WebSocketServer({noServer:true})` と `server.on('upgrade')` 内で `handleUpgrade`、認証失敗時は `HTTP/1.1 401` を書いて socket.destroy |
| xterm.js | /xtermjs/xterm.js | `new Terminal({scrollback})`、`FitAddon` を `loadAddon` → `open` → `fit()` |
| Vite | /vitejs/vite/v8.0.10 | `resolve.alias`（find/replacement）|
| Playwright | /microsoft/playwright/v1.61.1 | `webServer`（command/url/env）、`context.newCDPSession(page)`（Chromium のみ） |

（Context7 に react-i18next の個別確認はしていない。`i18n.use(initReactI18next).init({resources, lng})` は SA の `frontend/src/i18n.ts` と同じ形で、実行テストで動作確認。）

## カードと実物の差分・判断

- 翻訳資源: SA の `frontend/src/locales/ja.json`（単一の大きな辞書）を `.sa-cache` から読み、`src/locales/ja.json`（キー `ac.*`・`role.*`）を deep merge。SA 側に `role`（単数）・`ac` キーは無いことを確認済み（`roles` は有り・衝突なし）。
- e2e のためにサーバーへ環境変数 `AGENT_CONSOLE_TOKEN`（32 文字以上）での固定を追加。未設定なら従来どおり `randomBytes(32)`。理由: Playwright の webServer は標準出力のトークンを受け取れない。
- 端末の等幅フォントは SA のトークンに `--font-mono` が無いため xterm の `fontFamily: "monospace"`（総称名）を使用。
- sa-sync は上書き展開のみ（削除なし）。SA 側でファイルが消えても `.sa-cache` に残る場合があるため、気になる場合は人手で `.sa-cache` を作り直す。
- ledger 行の「4 列目」は表の先頭の `|` を除いた 4 番目（ブランチ名・担当機能エリア・開始日時・状態）。
- `claude agents --json` のスタブ（tests/fixtures/claude-stub.sh）は pid を固定できないため、役割コマンドの argv0 に目印（`agent-console-e2e-role`）を付け、ps から pid を探して状態ファイルの値を返す。CRLF と末尾エスケープも混ぜている。
- ディレクトリ構成のうち `server/hub.ts`（agents/台帳の定期取得と配信）はカード一覧に無い追加ファイル。

## K5 検査（カード §4-8）

`grep -R "\.claude" server` の出力（`.` が任意 1 文字のため識別子 `claudeBin` / `claudeVersion` が一致）:

```
server/hub.ts:    const rows = await fetchAgents(this.config.claudeBin);
server/http.ts:      claudeVersion: meta.claudeVersion,
server/config.ts:    claudeBin: o.claudeBin as string,
server/index.ts:  const meta = { saSource: await readSaSource(), claudeVersion: await fetchClaudeVersion(config.claudeBin) };
```

固定文字列 `grep -RF ".claude" server` も同じ 4 行（`config.claudeBin` / `meta.claudeVersion` のプロパティ参照）に一致し、パスではない。パス用の検査 `grep -RnE "\.claude\.json|\.claude/|~/\.claude" server` は 0 件（`homedir` は `server/config.ts:29-30` の設定パス `~` 展開のみで読取用）。`grep -RnE "writeFile|appendFile|createWriteStream|rename|unlink|copyFile" server` も 0 件（server 配下にファイル書込 API なし）。

## 実測（e2e の出力）

`K7 server_rss_mb=40.5 (limit 150) js_heap_used_mb=5.9 (limit 80)`（ダミーセッション 3 本、macOS arm64、Node v24.12.0）

## 未解決

- 実 Claude での手動 1 回（K2 の後半）は未実施。
- CI（ubuntu/macos）は未確認（push 後の実行結果を見ていない）。ubuntu では node-pty を node-gyp でビルドする想定で、未検証。

## 修正ラウンド1（レビュー・評価への対応）

- WebSocket: term / events 両方に error リスナ、maxPayload を 256KB に明示（`server/ws.ts` の `MAX_WS_PAYLOAD_BYTES`）。超過は ws が 1009 でその接続だけ閉じる。クライアントは入力を 16KB ごとに分割して送る。統合テストで「2MB フレーム送信 → 1009 で閉じる・他セッション継続・API 生存」を検証。リスナを外すと vitest が `Unhandled Errors: RangeError: Max payload size exceeded` を出すことを確認済み。
- ポーリング: `server/poll.ts`（前回完了後に次を予約・例外は捕捉して継続）。agents 取得失敗時は状態「不明」（前回値は保持しない。コメントと実装を一致）。台帳の手動更新と定期更新は 1 本にまとめる。
- 台帳: lookup の exit 0/1/2 以外・スクリプト不在・台帳ファイル読取失敗は `errors` として返し、UI は SA Callout で「台帳を読めません」。未登録列には混ぜない。台帳由来のブランチ名は `isSafeLedgerBranch` で検証してから渡す。
- セッション: 停止は一覧に「停止」と表示し、`DELETE /api/sessions/:id`（停止中のみ。実行中は 409）で外せる。上限は worktree 作成前に枠を確保。
- Host ヘッダ検査（127.0.0.1:port / localhost:port 以外は 421。静的配信・API・WS すべて）。decodeURIComponent 失敗は 400、静的配信の ReadStream error を処理。
- 統合テスト（`tests/unit/server.integration.test.ts`、実 HTTP/WS/PTY）: 静的配信のパストラバーサル、/ws/term の認証・Origin・Host、入力検証、body 上限、1009、停止セッションの削除、上限の予約、台帳エラー。
- デザイン検査を強化（named color、oklch/oklab/lab/lch/hwb/color()、CSS の px/rem/em、インライン style の数値・単位・色名、数値の fontSize/lineHeight/letterSpacing、pages の `<a`）。許可は ADR-067 の例外（%・@media・calc 内の var・opacity 0/1・min-width 0）に加え、SA の金型 CSS が実際に使っている 1px の枠線（border/outline のみ）。ADR-067:111-117 の例外一覧に 1px 枠線は載っていないため、これは SA の金型実装（`Modal.css` など）に合わせた判断。
- 端末: 文字サイズは `--font-sm` を getComputedStyle で数値化、配色は `--bg-surface` `--text-primary` `--bg-active`。`<html>` の class 変化を MutationObserver で監視して再読込。
- 画面幅: 段階1は PC 幅（1280px 以上）専用（design.md §3 に追記）。左右の列幅は % 指定。
- e2e の役割プロセスは argv に目印を持つ node スクリプト（`tests/fixtures/role.mjs`）。sh の exec で目印が消えない。ロケーターは exact＋フォーム内に限定（macOS CI の「起動」が「Claude 未起動」と衝突した件）。

### 端末の文字間隔（NEEDS_DECISION）

原因の切り分け（`/tmp/CC報告ファイル/orca-selfbuilt/fix1-font-experiment.txt`、各 fontFamily で `.xterm-rows` の letter-spacing を実測）:

```
monospace              ls=5.53125px  nrows=54
Menlo                  ls=0px        nrows=47
ui-monospace, monospace ls=5.53125px  nrows=54
monospace, monospace   ls=5.53125px  nrows=54
Courier New            ls=0.00625px  nrows=50
sans-serif             ls=0.84375px  nrows=54
```

総称名 `monospace` だと、xterm（DOM レンダラ）が計算する行の letter-spacing が 5.5px になり、文字間が広がる。実フォント名では 0px。`lang="en"` を端末に付けても直らなかった（試して戻した）。SA のトークンに等幅フォントは無い。直すには実フォント名のスタックが必要なので、置き場所の判断を仰ぐ（案は報告参照）。e2e の回帰テストは `test.fixme` で入れてある。
