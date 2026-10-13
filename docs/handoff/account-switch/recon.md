# 調査: Claude アカウントの切り替えと表示（account-switch）

- 調査日: 2026-10-13。基準: agent-console origin/main f897ff6（v0.15.0）。Claude Code 2.1.296。
- 調査は Sonnet（読み取り専用）が実施し、設計者（Opus）が受け取った。生出力は各項の引用のとおり。
- Context7 MCP は "Monthly quota exceeded" で使えなかったため、公式文書 code.claude.com を直接取得した（起動指示で許可された代替）。

## A. 今のアプリ

- 画面下部の「ログアウト」は agent-console 自身の画面セッションを失効させるだけ。Claude・GitHub のアカウントには触れない。
  - src/pages/ConsolePage.tsx:253-257 `handleLogout` → src/api.ts:161-168 `logout()` → server/http.ts:147-155 `POST /api/logout` → `deps.auth.revokeSession`
  - README.md:194「画面下部の「ログアウト」でサーバー側のセッションを失効させる」
- 今のユーザー（メール等）を取得・表示している箇所は 0 件（`git grep` で account|email|profile|whoami 等。ヒットは src/locales/ja.json:412 のエラー文言のみ）。
- Claude を動かす箇所は node-pty の spawn 1 か所: server/sessions.ts:268-274。env は `{ ...buildChildEnv(process.env, terminalEnv), ...extraEnv }`（:273）で、親の HOME をそのまま引き継ぐ。アカウント別の切替機構は無い。
- 新しい会話: server/http.ts:165-170 `POST /api/sessions` → server/sessions.ts:163-184 `create`（role は config 固定のコマンド。画面の文字列はコマンドに入れない: sessions.ts:187-188）。
- 画面に返す roles は command を含まない: server/http.ts:137。roles は NewSessionForm の選択肢にすべて出る（src/components/NewSessionForm/NewSessionForm.tsx の `<Select options={roles.map(...)}>`）。
- 会話の終了: server/sessions.ts:295-298 `term.onExit` → `exited = true`。一覧では「停止」→「一覧から外す」（src/components/SessionList/SessionList.tsx:149-173）。
- claude CLI を読み取りで呼ぶ作法: server/agents.ts:100-119（`execFileAsync(claudeBin, [...], { timeout: 15000 })`、失敗は null / 空文字）。claudeVersion は起動時 1 回だけ（server/index.ts:68）。
- 定期取得の手本: src/components/UsageMeter/UsageMeter.tsx:63-93（60 秒ごと、`closed` フラグで後始末）、server/usage-routes.ts:10-14、src/api.ts:127-128。
- フッター: src/pages/ConsolePage.tsx:421-444。確認ダイアログの手本: :445-454（`ConfirmModal` from `@sa/components/ConfirmModal`）。
- 設定: agent-console.config.json は git 管理（`git ls-files`）。roles の型 server/config.ts:5-19、検証 :111-139, :236-246。
- 設計原則: docs/handoff/stage1/design.md:58-69 §5「データの正本（SSOT）— アプリは複製を持たない」、:85「秘密情報を読まない（~/.claude.json、OAuth、キーチェーンに触れない）」。
- 金型・トークンの強制: `npm run lint` = scripts/check-design-governance.mjs（色直値 :86-87、px 直書き :95-125、style 内数値 :127-149、src/pages の生要素 :164-166、tsx の日本語直書き :168-176）。i18n は src/locales/ja.json のみ（en.json 無し）。
- 試験: claude の偽物 tests/fixtures/claude-stub.sh（31 行）は `--version` と `agents` だけ。`auth` の分岐は無い。フッター e2e は tests/e2e/console.spec.ts:232-238。

## B. Claude Code の公式仕様（実物 CLI と公式文書）

- `claude auth status --json` の実物出力（キー）: loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, configDirectory, email, orgId, orgName, subscriptionType。
- 終了コード: ログイン 0 / 未ログイン 1（https://code.claude.com/docs/en/cli-reference 「Exits with code 0 if logged in, 1 if not.」）。未ログインでも JSON は出る（実測: 仮フォルダで loggedIn false、終了コード 1）。
- `claude auth login --help`: `--claudeai`（既定）/ `--console` / `--email <email>` / `--sso`。
- 端末なし（パイプ）で `claude auth login` を起動した実測（仮フォルダ、20 秒で打切り、完了させていない）:
  - 出力「Opening browser to sign in」「If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...」「Paste code here if prompted >」
- ログインの共有（https://code.claude.com/docs/en/errors 「Not logged in」）: 「If you sign in with your claude.ai account in another Claude Code window that uses the same configuration directory, an interactive session showing this message starts using that login on its own.」
- 複数会話の共有（https://code.claude.com/docs/en/troubleshoot-install）: 「Parallel sessions on one machine share a saved login and coordinate its renewal」
- 2 アカウントを同時に保つ公式の方法は設定フォルダを分けること（https://code.claude.com/docs/en/authentication 「give each account its own configuration directory」）。ただし `CLAUDE_CONFIG_DIR` を変えると「every `~/.claude` path on this page lives under that directory instead」（https://code.claude.com/docs/en/claude-directory）＝ CLAUDE.md・rules・agents・skills・settings.json（hooks）・記憶・履歴がすべて別になる。仮フォルダの実測でも、ログイン設定のファイル（ホームの .claude.json にあたるもの）が新フォルダ側に作られた。
- 今の ~/.claude にあるもの: settings.json の hooks 8 イベント・個別 hook 23 本、agents 7、rules 2、skills 2、plugins 10、MCP（~/.claude.json）2。
- 長期トークン（`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`）: 「can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors」。保存はしない（利用者が環境変数に置く）。
- statusLine に渡る JSON にはアカウントのキーは無い（https://code.claude.com/docs/en/statusline）。

## C. 公式に書かれていないこと（未確認）

- ログイン中に別アカウントで `claude auth login` したとき、上書きされるか／先に logout が要るか。
- claude.ai ログインの `logout` がサーバー側でトークンを無効にするか。
- 端末画面（node-pty）から `claude auth login` を最後まで完了できるか（パイプでの起動と URL 表示までは確認済み）。
- 切り替えた直後に、動いている会話が新しいアカウントで動くまでの時間。
- 関連する公開 issue（anthropics/claude-code、すべて open）: #89785 Multi-account support and account switching / #22872 Switching between personal and work accounts / #91669 Persistent login prompts despite repeated auth logout/login cycles。

## D. 既存 ADR・設計の検索

- agent-console には ADR ディレクトリが無い（docs/design/ は空）。設計は docs/handoff/<topic>/。アカウント・ログイン切替を扱う既存設計は 0 件。
- 関連: docs/handoff/stage1/design.md（SSOT・秘密を読まない）、docs/handoff/stage1-5/design.md:64（画面のログアウト）、docs/handoff/usage-meter/design.md（下の帯の利用量バー）。
