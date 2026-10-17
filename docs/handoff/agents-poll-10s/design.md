# design: claude agents の一覧取得を 3秒→10秒ごとにする（agents-poll-10s）

この文書は何か(専門用語なしの1行): agent-console が Claude の窓一覧を取りに行く間隔を延ばし、Mac の負担を減らす設定変更の設計。

状態: PO 承認済み（2026-10-17 チャット「y」）。設定値のみの変更。

## 1. 目的と KGI
| # | 合格条件 | 測り方 |
|---|---|---|
| A1 | `claude agents --json` の起動回数が 40秒あたり 6回 → 4回以下 | 導入後に ps を 0.3秒ごと 40秒間標本し、新しい PID を数える（導入前の実測: 6回/40秒） |
| A2 | 窓の状態（作業中/待ち/待機）が画面に 15秒以内に反映される | 導入後に窓1つで入力を送り、状態表示が変わるまでの秒数を目視 |

## 2. 現在地（観測）
- 設定 agent-console.config.json:8 `"agentsPollMs": 3000`。server/hub.ts:145 が agentsPollMs ごとに pollAgents を呼び、server/agents.ts:119 が `claude agents --json` を起動する。
- 1回の起動: 実時間 0.59秒・CPU 0.39秒・最大メモリ 約150MB（`/usr/bin/time -l` 実測、2026-10-17 10:00 JST）。
- Mac は 8GB で空き 182MB・交換領域 3.5GB 使用中。150MB の確保が 3秒ごとに繰り返され、メモリ不足を悪化させていた。

## 3. 変更
- agent-console.config.json:8 `agentsPollMs` 3000 → 10000（1行）。版を 0.42.3 に上げる（package.json・extension/manifest.json・CHANGELOG）。
- 触らない: server/ のコード、restoreStaggerMs など他の 3000。

## 4. 影響と弊害
- 窓の状態反映が最大 約10秒遅れる（A2 で確認）。
- 自動クローズの標本間隔の上限 gapLimitMsFor は max(10000×5, 60秒)=60秒で変わらない（server/routine-closer.ts:35-36）。

## 5. 代替案
- 採用: 間隔を延ばす（1行・戻しやすい）。
- 不採用: `claude agents` を使わず hooks の記録だけで状態を出す → コード変更が大きい。必要になれば別便。

## 6. 外部・過去事例の参照と我々への応用
同リポジトリ PR #64（メーター 5秒→2秒、v0.42.2）と同じ「設定値＋版上げ」の型で行う。社外の数値事例は本件の成否の根拠にならないため使わない。

## 7. 維持の仕組み
- 守り手: 設定ファイル agent-console.config.json（正本1か所）。点検は Opus（A1・A2）。
- 戻し方: `bash scripts/ac-update.sh v0.42.2`

## 8. Opus 自己審査（同一 AI による審査）
整合: 既存の設定読み込み（server/config.ts:116 の NUMBER_KEYS）で数値として読まれる。3000 を前提にした試験は無い（実装役の grep）。判定: APPROVE。
