# 現在地: 作戦ボードに「タスク」を足し、「今の状態」を外す

- 基準: main 4b86c9b（v0.12.0）の時点の実物。設計（design.md）の作成時に確かめた事実を、ここに分けて置く。
- 前提の現在地: docs/handoff/board/recon.md（v0.12.0 の作戦ボード）

## 事実
- 本番は v0.9.1。右の欄には「今の状態」「動いている担当」「終わった担当」「やること」の4つがある。「やること」は TaskCreated の hook から作る。Opus 5.5 では Task の道具が既定で無効なので、この欄は空になる。
- v0.12.0 は「終わった担当」と「やること」をすでに出さない（docs/handoff/board/design.md K1）。「今の状態」は src/components/ActivityPane/ActivityPane.tsx:39 と :55 に残っている。
- ボードの正本は dataDir/boards/<会話の番号>.json の1か所。書くのは、そのセッションの Claude だけ（hooks/ac-board.mjs の write。docs/handoff/board/design.md §3-2・§4）。
- 中身の検査は hooks/ac-board.mjs の1か所で行う。上限は BOARD_LIMITS（hooks/ac-board.mjs:13）。上の段の鍵は theme・kgi・kpis・roadmap の4つだけで（hooks/ac-board.mjs:68-69）、ほかの鍵は拒否する。
- 進み具合の表示（ProgressBar と「完了 N / M」）は、今はロードマップにだけ付いている（docs/handoff/board/design.md §3-3）。
- 「今の状態」を渡している所: RightPane と src/pages/ConsolePage.tsx:419（design.md §10-3）。

## 既存 ADR の確認
- ADR-067（デザイントークン）・ADR-144（UI 部品）が当てはまる。部品は SA の ProgressBar と、素の `<details>` を使う。

## 未確認
- なし（実装の時点の行番号のずれは、実装の担当が main 7d34553 で確かめる）。
