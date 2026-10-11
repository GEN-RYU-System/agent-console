# v0.2.1 設計（ライト/ダーク切替）

- 調査: docs/handoff/v0.2.1/recon.md ／ 対象ADR: ADR-033, ADR-067, ADR-144
- PO 承認: 「ダークモードにする方法→実装したい」（2026-10-11）。保存方式は設計者決定（localStorage）。

## 1. 目的
画面下部から、ライト/ダークを切り替えられる。選んだ表示は次回起動でも保つ。

## 2. KGI
| 基準 | 検証方法 |
|---|---|
| K1 フッターの切替ボタンで `<html>` の class に `force-dark` が付く・外れる | 単体 ThemeToggle.test.tsx、e2e |
| K2 再読込後も選択が保たれる（localStorage `theme`） | e2e（reload 後も force-dark） |
| K3 端末背景がダークの `--bg-surface` 値になる | e2e（xterm の背景色 = トークンの計算値、ライトと異なる） |
| K4 Set-Cookie 0 件・document.cookie に書かない | 単体・e2e（cookies 空） |
| K5 localStorage が使えなくてもライトで表示が崩れない | theme.test.ts |
| K6 CSP に `base-uri 'self'; form-action 'self'` | pairing.integration.test.ts、e2e |
| K7 既存テスト・デザイン検査が通る | npm test / lint / test:e2e |

## 3. SSOT
| 項目 | 正本 |
|---|---|
| テーマ: 閲覧者ごとの表示設定（localStorage）。SA の規則に合わせる | キー `theme`・値 `light|dark`・クラス `force-dark` は SA の frontend/src/contexts/ThemeContext.tsx。実装は src/theme.ts の 1 か所 |
| ダークの色 | SA のトークン（`:root.force-dark`）。このアプリは色を持たない |
| 切替ボタン・アイコン | SA の IconToggleButton と THEME_ICONS |
| 文言 | SA 辞書の `nav.switchToDark` / `nav.switchToLight` |

## 4. 外部・過去事例の参照と我々への応用
- 外部: ブラウザ側のテーマ保存は localStorage が一般的（MDN Web Storage API。Cookie と違い要求ごとに送られず、オリジン単位で分離される）。
- 過去事例: agent-console 段階1.5 の Cookie 全廃（docs/handoff/stage1-5/design.md K5）。応用: テーマも Cookie を使わず localStorage にして Set-Cookie 0 件を保つ。SA ThemeContext の cookie 方式をそのまま写さない。
- 過去事例: 描画後にクラスを付けるとライトが一瞬映る（SA ThemeContext.tsx:67 のコメント「チラつき防止」）。応用: main.tsx で描画前に反映する。

## 5. 弊害と戻し方
- SA とは設定が同期しない（オリジンが違う）。戻し方: 版 0.2.0 へ ac-rollback.sh。
- 弊害: localStorage 不可の環境では毎回ライトに戻る（表示は崩れない）。

## 6. 維持の仕組み（守り手:）
- 守り手: CI（e2e のテーマ試験・Set-Cookie 0 件の試験・CSP 試験）と `npm run lint`（色直値の検査）。SA の規則が変わったら src/theme.ts 冒頭のコメントの file:line を見直す。
