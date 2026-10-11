# 段階1.5 実装メモ

実装: Claude Sonnet / 2026-10-11

## §1 Chrome `--app` 実機確認（設計 §9 条件1）

環境: Chrome は確認前から起動中（`pgrep -x "Google Chrome"` → 51043、確認後も同じ 51043。新しいプロセスは増えず、既存プロセスに転送された）。

1. 一時ポートの最小 HTTP サーバー（node、スクラッチ）を起動。
2. `open -na "Google Chrome" --args --app=http://127.0.0.1:<port>/probe` を実行（exit 0）。サーバー側のアクセスログ（生）:
   ```
   2026-10-11T01:12:48.215Z GET /probe ua=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/
   2026-10-11T01:12:48.444Z GET /favicon.ico ua=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/
   ```
3. `osascript` での窓の取得は macOS の権限判定で失敗した（Apple Events の送信権限が無い）:
   `execution error: Google ChromeにApple Eventsを送信する権限がありません。 (-1743)`。権限は変更していない（実環境を変えない約束）。
4. 代替の観測: probe ページ自身が報告する表示モード（`/report` への POST の生出力。`window.close()` で自分の窓を閉じる）。
   - `--app` で開いた窓: `{"locationbar":true,"toolbar":true,"menubar":true,"standalone":true,"minimalUi":false,"browser":false,"chromeH":76,"historyLength":1,"opener":false}`
   - 対照（通常の `open -a "Google Chrome" <URL>`）: `{"locationbar":true,"toolbar":true,"menubar":true,"standalone":false,"minimalUi":false,"browser":false,"chromeH":0,"historyLength":1,"opener":false}`
   - `matchMedia('(display-mode: standalone)')` が `--app` のときだけ true。`window.locationbar.visible` などは両方 true で、判別には使えなかった。
   - 生ログ: `/tmp/CC報告ファイル/orca-selfbuilt/s15-app-probe-control.log`
5. 判定: 既存の Chrome 起動中でも、`open -na … --args --app=URL` は URL を開き、ページから見て `display-mode: standalone`（アプリ窓）になる。ただし「見た目が通常タブでない」ことを画面や AppleScript では確認できていない（権限が無いため）。PO 実機での目視 1 回が必要（K1 の PO 実機確認に含める）。
6. 後始末: probe サーバーは停止済み。窓は 2 つ開いた（1 つ目は script 無しの静的ページで、閉じる手段が無い）。1 つ目の「probe」窓だけ PO が手で閉じる必要がある（⌘W）。2 つ目（`--app`）と対照のタブはページが `window.close()` で閉じた（閉じたかは目視で未確認）。

## 実装状況

| カード §2 | 状況 |
|---|---|
| 1 キーチェーン読込 | 完了（`server/keychain.ts`・`server/secret.ts`、テスト付き） |
| 2 /api/pair・/pair・セッション | 完了（`server/auth.ts`・`server/http.ts`） |
| 3 認証を Cookie か Bearer に、`?t=` 廃止、Origin、/healthz | 完了 |
| 4 起動ログ | 完了（開発時のみペアリング URL。本番は秘密・セッション・コードを出さない） |
| 5 フロント | 完了（Cookie 認証、ペアリング失敗画面、版表示） |
| 6 plist 雛形 | 完了（`ops/launchd/local.agent-console.server.plist.template`） |
| 7 ac-install/update/rollback/uninstall＋lib | 完了（下記の方針、`tests/unit/scripts.test.ts`） |
| 8 起動アプリ | 完了（`ops/launcher/AgentConsole.applescript`・`launch.sh`、テスト付き）。osacompile は実機で構文確認 |
| 9 CI audit | 完了（`npm audit --audit-level=moderate`・`npm audit signatures`、ローカルで両方 exit 0） |
| 10 version 0.2.0・CHANGELOG | 完了 |
| 11 README | 完了 |

### 項目 7 の方針（設計者判断 2026-10-11）
スクリプト本文に再帰・強制の削除コマンドを書く Bash コマンドが agent-danger-hook に拒否された。Write ツールでフックを避けることはせず、設計者の判断で「削除を一切使わず Trash へ移す」設計にした。
- 移動先: `$AC_TRASH`（既定 `$HOME/.Trash`）の `agent-console-<種類>-<YYYYmmdd-HHMMSS>`。
- 対象: 撤去する plist・起動アプリ、失敗した版の一時ディレクトリ（種類 `failed-<tag>`）、置き換える旧 plist・旧起動アプリ、`--purge` の versions/・current・logs。
- 移動元はマーカー（`.agent-console-home`）のある AC_HOME 配下か、LaunchAgents・Applications 配下に限る（`ac_trash`）。テストモードでは Trash も含め一時ディレクトリ以外を拒否する。
- 例外: キーチェーンの秘密の削除（`--purge`）は元に戻せない。pid・ロック・一時ファイルなど自分が作った単一ファイルは通常のファイル削除を使う（再帰・強制ではない）。
- テストで「元の場所に無く Trash に有る」ことと、スクリプトに再帰削除のコマンドが無いことを検証。

## 認証まわりの判断（カードに無い細部）

- セッション ID・ペアリングコードはサーバー内ではハッシュで保持し、全件を定数時間で比較する。
- `POST /api/pair` は Bearer のみ（Cookie では発行できない＝セッションの自己延命を防ぐ）。
- 無効なコードの `/pair` は、SPA の index.html を 401 で返す（画面は SA の Callout で案内）。
- ペアリング応答の 303 に `Cache-Control: no-store`・`Referrer-Policy: no-referrer` を付与。
- pty の子プロセス env から `AGENT_CONSOLE_TOKEN`・`AGENT_CONSOLE_AUTH`・`AC_SECURITY` を除去。
- `AGENT_CONSOLE_PORT` でポートだけ上書きできる（導入前の自己診断を別ポートで行うため）。
- 導入時の秘密保存は `security -i`（コマンドを標準入力から読む）。`add-generic-password -w <値>` を引数に出さない（man security: `-i`）。

## テスト
- TDD の例外: ペアリングの統合テスト（`tests/unit/pairing.integration.test.ts`）とフロントのテストは実装と同時に作成。auth・keychain は RED を確認してから実装。

## 修正ラウンド1（レビュー M1〜M3・L1〜L9 と CI 失敗への対応）

設計の改訂（design.md §4-3, §4-4, §6, §8。コミット 8768c3b）を先に別コミットで行い、その後に実装した。

### A. CI の失敗（server-process.test.ts「dev/fixed mode」で 404、期待 401）
- 根拠: CI ログ（run 38102704905）`AssertionError: expected 404 to be 401`。旧実装は使用済みコードの `GET /pair?code=` に「SPA の index.html を 401 で返す」作りで、サーバーは `process.cwd()/dist` から配信する。CI では `npm test` が `npm run build` より前に走るため `dist` が無く、`serveStatic` が 404 を返した。ローカルでは `dist` が既にビルド済みで通っていた。
- 対処: (1) ペアリングを `POST /api/pair/redeem`（JSON の 401）に移したため、テストは画面（`dist`）に依存しない API だけを使う。(2) `GET /pair` は常に SPA（静的配信）で、コードを消費しない（テストで検証）。

### B. 相互認証（M1）
- 流れ: launcher が `cnonce` を送る → サーバーが `snonce` と `HMAC(secret, "server|cnonce|snonce")` を返す → launcher が検証（不一致なら何も送らず中止）→ `HMAC(secret, "client|snonce|cnonce")` を `POST /api/pair` に送り 1 回限りコードを得る。snonce は 30 秒・1 回限り（証明が誤りでも消費）。`Bearer`（秘密）による `/api/pair` は廃止。
- HMAC は `ops/launcher/pair-proof.mjs`（秘密は標準入力）。`server/pair-proof.ts` と形式が一致することをテスト（`pair-proof.test.ts`）。
- 実機相当の確認（一時ポート・スタブ秘密・キーチェーン不使用。生出力: `/tmp/CC報告ファイル/orca-selfbuilt/s15-r1-mutual-auth-demo.txt`）: 本物のサーバー（keychain モード）に対して launcher が通り、コードが 1 回だけ引換えられる。`/healthz` に 200 を返すだけの偽サーバーに対しては、`pair-proof: サーバーの証明が一致しません…` で中止し、偽サーバーが受け取ったのは `GET /healthz` と `POST /api/pair/challenge`（cnonce のみ）だけ。秘密・クライアント証明は送っておらず、`open` も呼ばれない。さらに実 Chrome の `--app` 窓で、コードが画面側で引換えられた（5 秒後に自分で引換えると 401）。

### C. Cookie の廃止（M2）
- セッショントークンはタブの sessionStorage（`ac.session`）。API は `Authorization: Bearer`、WebSocket は `Sec-WebSocket-Protocol: ac.<token>`（ws の `handleProtocols` で受理した値を応答に返す）。セッション最長 12 時間。`POST /api/logout` でサーバー側失効、画面にログアウト（SA Button）。Set-Cookie は全応答で 0 件（統合テスト・e2e で検証）。別タブには共有されない（e2e）。
- `GET /pair` は常に SPA。画面が `POST /api/pair/redeem`（Origin 必須）でコードを引換え、`history.replaceState` で `/` にする。StrictMode の二重実行でも 1 度しか引換えない（テスト）。

### D. タグの検証（M3）
- 到達性: `gh api repos/<repo>/compare/main...<SHA> --jq .status` が `identical` か `behind` のときだけ進む（`ahead`・`diverged` は中止し Trash へ）。shallow clone でも履歴を取得せずに判定できる。
- `npm ci --ignore-scripts` ＋ `scripts/postinstall.mjs` を明示実行。実測（この Mac、`git archive HEAD` を一時ディレクトリに展開して実行）:
  ```
  npm ci --ignore-scripts → 成功
  spawn-helper 実行権: 前 -rw-r--r-- → postinstall.mjs 後 -rwxr-xr-x
  esbuild 0.28.2（@esbuild/darwin-arm64 あり）で `node -e "require('esbuild')"` 成功
  sa-sync → build: ✓ built in 525ms
  node-pty: pty output: "PTY_OK"
  起動した dist-server の /healthz: {"ok":true,"version":"0.2.0","commit":""}（git 履歴の無い archive のため commit は空。クローンでは SHA が入る）
  ```
  esbuild・node-pty とも `--ignore-scripts` で問題なく動いたので NEEDS_DECISION は不要。
- 導入・更新・切戻しの出力にタグのコミット SHA を表示し、画面下部にも短縮 SHA（`/api/state` の `commit`）を表示。

### E. `rm` の全廃（L1）
- スクリプト（`scripts/`・`ops/launcher/`）から `rm`（`-f` 含む）と `unlink` を除去。単一ファイルも Trash へ。pid・ロックはファイルを作らず空ディレクトリ（`rmdir` で消せる）、診断プロセスの pid はシェル変数、起動アプリは osacompile の標準入力で渡す（一時ファイル無し）。テストは `rm` の全形・`unlink`・`-delete` を検出（コメント行は除く、`rmdir` は許可）。

### F. ロックの原子化（L2）
- `mkdir lock` 成功の直後に `lock/pid-<pid>`（空ディレクトリ）を作る。回収は「pid-<n> があり、そのプロセスが不在」または「pid-<n> が無く、作成から 10 分超」のみ。各段（`rmdir pid-<n>`・`rmdir lock`・`mkdir lock`）のどれかが失敗した側は中止する。テスト: 生きた保持者・新しい保持者無しロックは回収しない、古いものは回収する、同時に 2 つ取得しにいって勝つのは 1 つだけ（実プロセス）。

### G. 成功判定（L3）
- `/healthz` の本文 `{"ok":true,"version":"<package.json>","commit":"<git rev-parse HEAD>"}` が期待の版・コミットと完全一致したときだけ成功。自己診断（別ポート）・更新・切戻し・導入すべて。テスト: kickstart が何もせず旧プロセスが 200 を返し続けても更新は失敗して元に戻る、別プロセスが診断ポートで 200 を返しても自己診断は通らない。

### H. キーチェーン記述（L5）
- design.md §6・§8 を事実に修正（`-T` 無しで `security` が作成した項目は同じユーザーの任意のプロセスが読み出せ得る＝未検証。保護は別ユーザー・ファイル直読みに対するもので、同一ユーザーのマルウェアは対象外）。実機での読み出し確認は未実施（キーチェーンに触れない約束）。

### I. その他
- 本番では `AC_*` の差し替えを無視（スクリプトは `AC_STUB_LOG` が無ければ `unset`、サーバーの `AC_SECURITY` は `securityBinFor` が同条件）。`AC_LAUNCHER_NODE`（起動アプリが導入時の node の絶対パスを渡す）だけは常に有効。launcher 自体は本物の `security` に触れずに確認できないため、挙動ではなく静的に検査。
- ペアリングコードは使用後すぐ無効（auth・統合テストで確認済み）。
- launcher テストの不安定: 原因は vitest 既定のテスト時間 5 秒に対し、全体並列実行時の起動待ち（1 秒単位の待ち）が長引いたこと。各テストに 40 秒の明示タイムアウトと 20 秒の起動待ちを設定。偽サーバーではなく本物のサーバーを使うように変更。
- 隠れた不具合を 1 件発見: 全角括弧の直前の `$変数`（例 `$version）`）を bash が変数名の一部として読み、`set -u` のエラーが `if !` の中で黙って握りつぶされて処理が続いた。`${変数}` に修正し、静的テスト（非 ASCII の直前の `$変数` を禁止）を追加。

### テスト先行の例外
- 統合テスト・フロントのテスト・スクリプトのテストの一部は、実装と同時または直後に作成した。auth・pair-proof のテストは先に書いて RED を確認した。

### CI ubuntu 失敗（ロックの経過時間判定: `line 145: File: unbound variable`、run 38104266309）
- 原因: `ac_mtime` が `stat -f %m "$1"`（BSD の書き方）を先に試していた。GNU stat では `-f` は「ファイルシステムの状態を表示」（GNU coreutils マニュアル stat-invocation: 「`-f`/`--file-system`: Report information about the file systems where the given files are located.」）で、`%m` はファイルではなくファイルシステムの書式として扱われ、複数行（`File: …`）を出力して終了コード 0 になる。その出力が算術式に入り、`File:` が未定義変数として `set -u` に引っかかった。macOS の stat では `-f %m` が最終更新のエポック秒（`man stat`: `-f format`）なので、ローカルでは通っていた。
- 対処: GNU 形式を先に試す。`stat -c %Y`（GNU: 「`%Y`: Time of last data modification as seconds since Epoch」）。macOS では `stat -c` は `stat: illegal option -- c` で失敗する（この Mac で実測）ので、次の `stat -f %m` に落ちる。出力が数字だけでなければ失敗にし、呼び出し側は「作成時刻を取得できない場合は回収しない」（安全側）。`find -mmin` も BSD の `man find` に有る（macOS）が、GNU 側をこの環境で確認できないため、両 OS で挙動を確認できた stat の順序入替えを採用した。
- テスト: GNU 風スタブ（`-c %Y` は秒、`-f` は複数行を出して成功）と BSD 風スタブ（`-c` は失敗、`-f %m` は秒）の両方で正しい秒が返ること、使えない出力のときは失敗（回収しない）、実ディレクトリの更新時刻が数字で返ること。

## 修正ラウンド2（再点検 N1・N2・N5）

- N1: `/api/pair/challenge`・`/api/pair`・`/api/pair/redeem` は、Origin ヘッダが付いていて自分以外（`null` や localhost 含む）なら 403（launcher の curl は Origin を付けない）。Content-Type は `application/json`（`; charset=` は可）以外なら 415（no-cors の text/plain 送信を弾く）。保留チャレンジが 64 件に達したら新規を 429（`Retry-After: 30`）で拒否し、古いチャレンジは押し出さない（launcher の snonce が妨害されない）。テスト: auth 単体と統合（64 件で 429・最初のチャレンジでペアリングできる・期限後に回復）。
- N2: セッション認証した WebSocket（events・term）をトークンごとに追跡。ログアウトで該当セッションの接続をサーバー側で閉じる（close コード 1008）。期限切れ（12 時間）は 30 秒ごとの `sweep`（`isSessionValid`）で閉じる。サーバー秘密の Bearer（CLI）の接続は対象外。別セッションの接続は影響を受けない。テスト: 統合（ログアウトで 1008、別セッションは開いたまま、期限切れ＋sweep で 1008、有効なら何もしない）。
- N5: すべての応答に `Referrer-Policy: no-referrer` と `X-Content-Type-Options: nosniff`（エラー・421・404・405 を含む。統合テストで 12 パターン）。HTML 応答にだけ `Content-Security-Policy: default-src 'self'; connect-src 'self' ws://127.0.0.1:<port>; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'`。
  - `style-src 'unsafe-inline'` が必要な根拠: 無しで e2e の CSP 検査を実行すると、`Applying inline style violates the following Content Security Policy directive 'default-src 'self''` が多数出る（xterm の DOM レンダラが実行時に作る `<style>` 要素、React・SA 金型のインライン style）。生出力: `/tmp/CC報告ファイル/orca-selfbuilt/s15-r2-csp-without-style-src.txt`。
  - `img-src data:` が必要な根拠: SA の Select が矢印を data: の SVG（CSS の背景）で描く。無しだと `Loading the image 'data:image/svg+xml,…' violates … 'img-src' was not explicitly set, so 'default-src' is used as a fallback`（e2e の CSP 検査で実測）。
  - スクリプト・接続先は自分のオリジンのみ（`script-src` に unsafe-inline・unsafe-eval を許さない）。e2e「CSP: 画面・端末・モーダルの操作で CSP 違反が 1 件も出ない」で、ペアリング・モーダル・端末入出力まで通して違反 0 件を確認。
- N3 は現状維持（`/healthz` は版とコミットのみ、認証不要）。
