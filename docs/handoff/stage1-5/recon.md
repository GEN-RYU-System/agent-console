# 段階1.5 調査記録（recon）

調査日: 2026-10-11。調査: Claude Sonnet（読み取りのみ）、確認: Claude Opus。生出力の一時保存先: `/tmp/CC報告ファイル/orca-selfbuilt/s15-recon.md`（man ページ全文も同ディレクトリ）。

## A. ログイン時の自動起動（launchd）
- 前例: Sales Anchor 「ops/launchd/jp.salesanchor.reaper-onlogin.plist」（origin/main）は RunAtLoad=true / KeepAlive=false / WorkingDirectory / StandardOutPath / StandardErrorPath、`/bin/bash -lc` で起動。実機配置版には毎日 03:00 の StartCalendarInterval が追加されている。
- node の実体は /usr/local/bin/node（nvm ではない）。launchd 起動時の PATH に /usr/local/bin が含まれるかは未確認 → ProgramArguments に node の絶対パスを書く（PATH に依存しない）。
- `man launchd.plist`: Label, ProgramArguments, RunAtLoad, KeepAlive, WorkingDirectory, StandardOutPath, StandardErrorPath, EnvironmentVariables, ProcessType の原文取得済み。`man launchctl`: bootstrap / bootout / kickstart / print の原文取得済み。
- 記憶メモ: launchd 一撃実行は RunAtLoad=true / KeepAlive=false / WorkingDirectory 必須。macOS に flock は無いので排他は mkdir ロック＋`trap EXIT INT TERM`。

## B. Dock から開く
- Chrome 154.0.8037.99（この Mac）。
- Chromium `chrome/common/chrome_switches.h:87-89` に `kApp = "app"`「Specifies that the associated value should be launched in "application" mode.」。
- `man open`: `--args` 以降はアプリの argv にそのまま渡す。`-n` は新規インスタンス。`open -na "Google Chrome" --args --app=URL` が既存 Chrome 起動中にアプリ窓になるかは未確認（実装時に実機で確認する）。
- PWA（アプリとしてインストール）: MDN（2026-10-06）「localhost / 127.0.0.1 は HTTPS 要件の対象外」、service worker 必須ではない、manifest 必須項目は name / icons(192, 512) / start_url / display。インストール済みアプリと通常タブで Cookie・storage を共有するかは文書に記載なし（未確認）→ 段階1.5 では PWA を使わず `--app` 窓を使う。
- `man osacompile`: `-o` 出力先、`-e` スクリプト行、`-s` stay-open。TN2065（2018-05-11）: `do shell script` は常に /bin/sh、対話シェル設定を読まない、親の環境を継承。

## C. 認証
- 現行: 起動ごとにランダム 32 バイトのトークン（server/auth.ts:14-21）。URL クエリ `?t=` または `Authorization: Bearer` で照合（server/auth.ts:39-44、定数時間比較）。Host・Origin は `127.0.0.1:<port>` と完全一致（server/auth.ts:45-52）。起動ログに URL とトークンを出力（server/index.ts:41）。Cookie 実装なし。
- MDN: localhost では Secure 属性の https 要件が無視される。127.0.0.1 についての明記は無い（未確認）→ Secure 属性は使わない。HttpOnly・SameSite=Strict・Path=/ を使う（いずれも http で有効）。
- `man security`: add-generic-password（-s サービス, -a アカウント, -w 値, -U 更新, -T 許可アプリ）、find-generic-password -w（値のみ出力）。作成したアプリ（/usr/bin/security）からの読み出しは既定で警告なし。
- `man curl`: `-H @-` で標準入力からヘッダを読む（7.55.0 以降）、`-K -` で設定を標準入力から読む → 秘密をコマンド引数に書かずに渡せる。

## D. 版
- package.json version 0.1.0、git タグ 0 件、dependabot.yml なし。sa-sync と build の所要時間は未計測。

## E. 依存の安全性
- `npm audit`: 脆弱性 0 件。`npm audit signatures`: 119 件すべて検証済み。
- install スクリプトを持つ依存: esbuild / fsevents / node-pty。
- Dependabot の書式は取得済み。private リポジトリでの利用条件は取得ページに記載なし（未確認）→ 段階1.5 では使わず、CI の `npm audit` と `npm audit signatures` で代替する。
