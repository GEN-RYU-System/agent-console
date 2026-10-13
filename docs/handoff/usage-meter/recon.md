# usage-meter recon（design.md §0 の事実を、実コードで再確認したもの）

出典の事実（statusLine の rate_limits）は design.md §0 と step0.md の実測。ここでは現状コードの置き場を、origin/main (4a56a02) 基準で示す。

- hooks の設定を足す・外す・点検する本体: /Users/tanizawashingo/agent-console-wt/usage-meter/server/activity-hooks.ts（statusLine は今回追加。変更前は hooks のみ）
- CLI: /Users/tanizawashingo/agent-console-wt/usage-meter/scripts/ac-hooks.mjs（install|uninstall|check）
- 命令の置き方の前例: hooks/ac-board.mjs と server/activity-setup.ts の installBoardCommand（変更前 origin/main）
- ビルドの写し: /Users/tanizawashingo/agent-console-wt/usage-meter/scripts/copy-board-command.mjs:9（ac-board.mjs のみだったものに ac-statusline.mjs を追加）
- 口の入口: /Users/tanizawashingo/agent-console-wt/usage-meter/server/http.ts:181（handleBoard の呼び出し。その次に handleUsage を追加）
- 画面の置き場: /Users/tanizawashingo/agent-console-wt/usage-meter/src/pages/ConsolePage.tsx:421（<footer>）
- ~/.claude/settings.json に statusLine は無い: design.md §0（実機の設定は触っていない）
- 既存 ADR: 本リポジトリに docs/adr は無い（agent-console）。設計の正本は design.md。
