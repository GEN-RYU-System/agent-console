# v0.2.1 実装メモ

- 調査: recon.md。SA ThemeProvider は import 不可 → 設計者決定（localStorage、同キー・同クラス）で薄く再実装。
- 追加: src/theme.ts、src/components/ThemeToggle/ThemeToggle.tsx、main.tsx で描画前に反映、ConsolePage のフッターに配置。
- 事実: xterm の背景は `.xterm-viewport` ではなく `.xterm-scrollable-element` に出る（e2e で実測。viewport は黒のまま）。テストはこちらを見る。
- 事実: 既存 e2e「localStorage.length が 0」は、切替操作をするまで書き込まないので維持されている。
- CSP: base-uri / form-action を追加（server/http.ts:220、テスト更新）。
- 検証: typecheck 0 / lint OK / vitest 31 files 326 tests passed（追加分を含む）/ playwright 19 passed / npm audit 0 vulnerabilities / audit signatures 35 packages have verified attestations。
