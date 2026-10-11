# 設計: v0.3.1 アプリアイコン

- 状態: 設計者（Opus）作成。PO 承認: 2026-10-11 見本（sample-1024/128）に「y」。
- 調査: docs/handoff/v0.3.1-icon/recon.md（実装担当 Sonnet が作成）
- 対象ADR: ADR-067（デザイントークン）, ADR-144（UIガバナンス）。アイコンは画面の部品ではないため、トークンの対象外（理由: macOS が表示する画像で、CSS を経由しない）。

## 1. 目的（PO の言葉）
Dock と Finder の Agent Console が、汎用のスクリプトの絵ではなく、PO が選んだ見本の絵で表示される。

## 2. 成功条件（○×で判定）
|基準|検証方法|
|---|---|
|K1 導入後の「~/Applications/Agent Console.app/Contents/Resources/applet.icns」がリポジトリの「ops/launcher/icon/AgentConsole.icns」と同じバイト列|`cmp` の終了コード 0（テストと導入後の実測）|
|K2 icns に 16〜512 の @1x/@2x の 10 枚が入っている|`iconutil -c iconset` で展開し 10 ファイル（CI macOS）|
|K3 icns は SVG から1コマンドで作り直せる|`ops/launcher/icon/build-icns.sh` 実行で同じ構成の icns ができる（バイト一致までは求めない）|
|K4 既存の起動・ペアリング・更新・巻き戻しが壊れない|既存の vitest / playwright / スクリプト試験が全て通る（CI 両 OS）|
|K1b 作り直した起動アプリの署名が有効|`codesign --verify --deep --strict` 終了コード 0（試験）|
|K1c 更新・巻き戻しでも起動アプリが作り直され、切替先の版の絵になる。icns の無い版へ戻すと標準の絵で、その旨が出力される|一時 HOME での試験|
|K5 PO の画面で Dock・Finder のアイコンが見本の絵|PO が目視（更新後、Dock の古い絵が残る場合は README の手順）|

## 3. 対象と対象外
- 対象: SVG（正本）、作成スクリプト、生成した icns、起動アプリ作成処理での icns 差し替え、版 0.3.1、CHANGELOG、README。
- 対象外: 画面内のロゴ表示、ファビコン、ccopusgo の再開（別件・PO 回答待ち）、段階2の LOW 修正（変更は一度に1つ）。Dock の強制再起動（`killall Dock`）は自動で行わない。

## 4. 仕組み
- 正本は「ops/launcher/icon/agent-console-icon.svg」1つ。icns はそこから作る生成物で、導入時に Chromium を必要としないようリポジトリに置く（導入は `npm ci --ignore-scripts` のみで完結させる既存方針を保つ）。
- 起動アプリを osacompile で作った直後に、生成済み icns を「Contents/Resources/applet.icns」へ複製し、アプリの更新時刻を更新して Finder に再読込させる。osacompile が使うアイコンのファイル名は実物（Info.plist の CFBundleIconFile）で確認する。
- 版・巻き戻し（recon 後に設計者 Opus が改訂）: 実物では起動アプリを作るのは導入時だけ（scripts/lib/ac-common.sh:272 ac_build_launcher_app、呼び出しは scripts/ac-install.sh:36 のみ）。更新・巻き戻しでもアイコンを切り替えるため、ac-update.sh と ac-rollback.sh でも版の切替が成功した後に起動アプリを作り直す（ac_build_launcher_app を再利用し、処理を二重に書かない）。icns は切替先の版のディレクトリから取る。切替先に icns が無い場合（v0.3.0 以前）は標準の絵のまま作り、その旨をログと画面出力に出す（黙って続けない）。導入時（ac-install.sh）に icns が無ければ失敗させる。
- 署名: osacompile は生成物に ad-hoc 署名を付け、applet.icns を差し替えると `codesign --verify --deep --strict` が失敗する（recon の実測）。差し替え後に `codesign --force --sign -` で ad-hoc 署名をし直し、`codesign --verify --deep --strict` が終了コード 0 であることを試験する。新しい鍵や証明書は使わない。

## 5. SSOT
- 絵の正本は SVG のみ。icns は生成物で、手で編集しない。
- 起動アプリはこれまで通り導入スクリプトだけが作る。

## 6. 安全
- 新しい通信・権限・秘密情報なし。osacompile 後の複製のみ。

## 7. 代替案
- A 導入時に SVG から毎回生成: Chromium の取得が導入に必要になり重い → 不採用。
- B（採用）生成済み icns を同梱: 導入が軽く、正本は SVG で一本化。
- C Adobe Stock 画像: PO が「似た雰囲気で作る」を選択 → 不採用。

## 8. リスクと対処
- Dock が古い絵を保持する: README に「Dock から外して付け直す」を記載。自動で Dock を再起動しない。
- SVG と icns のずれ: CI で icns の構成（10 枚）を検査し、作り直しは build-icns.sh の1経路に限る。

## 外部・過去事例の参照と我々への応用
- Apple の iconutil（man iconutil）: iconset フォルダの命名（icon_16x16.png 〜 icon_512x512@2x.png）から icns を作る公式手段。これに従う。
- 過去事例: 段階1.5 で起動アプリを osacompile で作る方式を採用済み（docs/handoff/stage1-5/design.md）。今回はその作成直後に1工程足すだけにする。
- 適用限界: Apple の推奨する角丸・余白の正確な数値は未確認。PO の目視承認を判定とする。

## 維持の仕組み
- 守り手: 設計者（Opus）。絵を変えるときは SVG を直し build-icns.sh で icns を作り直して同じ PR に含める。
- CI（macOS）で icns の 10 枚構成を検査する。
