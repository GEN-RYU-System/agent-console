# 便1b 同梱設定の上限をいったん 16 にする（v0.47.1）作る係への指示書

- 設計: `docs/handoff/window-limit/design.md` §10 便1b（PO 2026-10-26「3」）
- 目的: v0.47.0 は同梱設定の `maxSessions` が 6。PO の Mac では窓が 11 本開いており、更新の再起動で上限を超える 5 本が `overLimit` で開き直されない（design.md §8「旧版へ戻したとき」と同じ仕組み）。窓を失わずに導入するため、同梱設定の値だけをいったん 16 にする。6 に下げるのは窓が減ってから別の便で行う
- 変えないもの: 設定の読み方・上限の判定・画面・`sonnet-impl` を外したこと・それ以外の試験
- 作る係は、枝を push するところまで。PR を作る・マージする・導入するのは設計者
- 調べた実物（origin/main 2d5b7ad = v0.47.0）:
  - `agent-console.config.json:32` `"maxSessions": 6`
  - `tests/unit/config.test.ts:311` 試験名 `K10: the shipped config has no sonnet-impl role and maxSessions 6`、:314 `expect(raw.maxSessions).toBe(6);`
  - 版: `package.json`・`package-lock.json`（2 か所）・`extension/manifest.json` が 0.47.0
  - `docs/CHANGELOG.md:5` が 0.47.0 の行

## 決めたこと
- `agent-console.config.json` の `"maxSessions": 6` を `"maxSessions": 16` にする。ほかは変えない
- `tests/unit/config.test.ts:311` の試験名の末尾 `maxSessions 6` を `maxSessions 16` に、:314 を `expect(raw.maxSessions).toBe(16);` にする
- 版を 0.47.1 に（上の 4 か所）
- `docs/CHANGELOG.md` の 0.47.0 の行の上に 1 行: 「0.47.1 同梱の設定の同時に開ける窓の数を、いったん 16 にした（窓が 11 本開いた状態で 6 の版を入れると、更新のときに 5 本が開き直されないため）。6 に下げるのは窓が減ってから。ほかの動きは 0.47.0 と同じ。戻し方は `bash scripts/ac-update.sh v0.47.0`（窓が 6 本以下のとき）または `v0.46.3`。設計は docs/handoff/window-limit/design.md §10 便1b。」

## 守ること
- 上の 4 種類の変更だけ。ほかのファイル・試験は変えない
- 実物が上の「調べた実物」と違えば、作らずに止まって報告する

## 試験
- CI と同じ手順（`.github/workflows/ci.yml`。Sales Anchor は `git clone --depth 1 https://github.com/shingo-ops/salesanchor.git` を salesanchorRoot にした設定で sa-sync）で typecheck・lint・test・build。origin/main でも落ちる試験（環境由来）は、origin/main で同じく落ちることを示して報告する。e2e・tmux が動かせなければそう書く（CI で見る）

## 報告
- 枝 `release/window-limit-bin1b`（origin/main から作る）に commit して push。枝名・HEAD の 40 桁 sha・`git diff --stat origin/main...HEAD`・流した試験の命令と結果を書く
- 最後の行は DONE / BLOCKED: <理由> / NEEDS_DECISION: <内容> のどれか
