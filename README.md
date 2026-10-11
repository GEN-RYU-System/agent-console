# agent-console

Local console for running parallel Claude Code sessions (Orca-inspired, lightweight).

- 設計・調査・実装メモ: `docs/handoff/stage1/`
- 起動: `npm ci && npm start`（Sales Anchor の origin/main を `.sa-cache/` へ展開 → ビルド → `127.0.0.1:4319`。URL にトークンが出る）
- テスト: `npm test`（単体）/ `npm run test:e2e`（要 `npm run build`）
- 設定: `agent-console.config.json`（`AGENT_CONSOLE_CONFIG` で別ファイル指定）
