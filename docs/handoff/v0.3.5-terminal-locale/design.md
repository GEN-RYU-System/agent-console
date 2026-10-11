# 設計: v0.3.5 端末のコピーで日本語が化ける不具合の修正

- 状態: 設計者（Opus）作成。2026-10-11 の PO 報告（「ターミナルの文字をコピペすると化ける」、例「ccopusgo縺ｧ襍ｷ蜍輔＠縺ｾ縺励◆」）への不具合修正。PO の常時指示「確立したなら進める」に基づき、原因を再現で確定してから進める。
- 調査: docs/handoff/v0.3.5-terminal-locale/recon.md（実装担当 Sonnet が作成）
- 対象ADR: なし（画面の変更なし）

## 0. 原因（事実・再現済み 2026-10-11 22:2x）
- アプリが起動した Claude（pid 45781）の環境を `ps eww` で見ると、`LANG`・`LC_ALL`・`LC_CTYPE` が無く、`__CF_USER_TEXT_ENCODING=0x1F5:0x1:0xE` だけがある。サーバー（LaunchAgent で起動）にも LANG は無い。ログイン用シェル（ターミナル.app）では `LANG=ja_JP.UTF-8`。
- 同じ条件（`env -u LANG -u LC_ALL -u LC_CTYPE __CF_USER_TEXT_ENCODING=0x1F5:0x1:0xE pbcopy`）で「ccopusgoで起動しました」をコピーすると、`pbpaste` の結果は「ccopusgo縺ｧ襍ｷ蜍輔＠縺ｾ縺励◆」になり、PO の報告と1文字違わず一致した。`LANG=ja_JP.UTF-8` を付けると「テスト」は正しく戻った。
- つまり、端末内のプログラム（Claude のコピー機能など）が pbcopy を使ったとき、UTF-8 ではない文字コードとして解釈されている。
- 該当箇所: server/sessions.ts:62-67 buildChildEnv は親（サーバー）の環境を引き継ぎ、TERM だけを足している。

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 アプリが起動する端末の子プロセスで `LANG` が設定値（既定 ja_JP.UTF-8）になる|統合試験：端末で `printf %s "$LANG"` を実行して出力を確認|
|K2 LANG を設定で変えられる。不正な値（空、改行入り、キー名が不正）は設定エラーになる|config の試験|
|K3 サーバーの環境に LANG が無くても K1 が成り立つ（LaunchAgent の状態を再現）|試験で process.env から LANG を外して確認|
|K4 既存の試験・CI が全部通る|CI 両 OS|
|K5（導入後・実測）新しく開いた端末の Claude の環境に `LANG=ja_JP.UTF-8` がある。PO がコピーした日本語が化けない|`ps eww` で確認／PO の目視|

## 2. 対象と対象外
- 対象: agent-console.config.json に `terminalEnv`（例 `{"LANG": "ja_JP.UTF-8"}`）を追加。server/config.ts（型・検証）、server/sessions.ts（子の環境に重ねる）、試験、版 0.3.5、CHANGELOG。
- 対象外: LaunchAgent の plist（導入時にしか書き換えられず、更新では反映されないため）、ccopusgo.zsh、すでに開いている端末（環境は起動時に決まるので、開き直すまでは直らない）。

## 3. 仕組み
- 子の環境 = buildChildEnv(process.env) → config.terminalEnv を重ねる → TERM → extraEnv の順。terminalEnv は TERM と extraEnv（AC_ 系）より前に置き、既存の固定値を上書きしない。
- 検証: キーは `^[A-Z_][A-Z0-9_]*$` に合うものだけ。値は空でなく、制御文字を含まない文字列だけ。CHILD_ENV_BLOCKLIST にあるキーと TERM は指定できない（設定エラー）。

## 4. SSOT
- 端末の言語設定の正本は config の terminalEnv だけにする。コードには ja_JP.UTF-8 を書かない（既定値は config にだけ置く）。

## 5. 安全
- 設定ファイルは版に同梱されたもので、画面からは変えられない。秘密の値は入れない（README に明記）。

## 6. 代替案
- plist の EnvironmentVariables に書く: 更新（ac-update）では plist を書き換えないので、PO の再導入が必要になる → 不採用。
- ccopusgo などの起動コマンドごとに LANG を付ける: 役割ごとに重複する。シェル役にも効かない → 不採用。

## 7. リスクと対処
- ja_JP.UTF-8 がない環境（CI の ubuntu）: 試験では値がそのまま渡ることだけを確認し、ロケールの有無には依存しない。

## 外部・過去事例の参照と我々への応用
- macOS の `man pbcopy`: 入出力の文字コードは LANG などのロケール環境変数に従う。今回の再現結果と一致するため、これに従う（man の該当記述は recon で原文を引く）。
- 過去事例: 段階1.5の launchd 起動では PATH を当てにせず node の絶対パスを使った（docs/handoff/stage1-5/recon.md）。launchd の環境が対話シェルより少ないという点は同じで、今回は LANG がそれに当たる。

## 維持の仕組み
- 守り手: 設計者（Opus）。K1・K3 の試験で、端末の LANG を固定する。
