# v0.3.9 restore-guard design

参照: docs/handoff/v0.3.9-restore-guard/recon.md、docs/handoff/v0.3.8-session-restore/design.md（v0.3.8 の承認範囲内の修正）。

## 対象

- tests/unit/server-process.test.ts: 子プロセスの config に一時 dataDir、env に AGENT_CONSOLE_RESTORE=off。
- server/restore.ts: isRestoreEnabled を「AGENT_CONSOLE_RESTORE が off でなく、かつ AGENT_CONSOLE_PORT が未設定（空文字も未設定）」のときだけ有効にする。
- tests/unit/restore-guard.test.ts（新規）: 真偽表、既定 dataDir の文字列を試験が持たないことの固定。
- 版 0.3.9、docs/CHANGELOG.md と README.md に1行ずつ。

## 対象外

- 本番の app・dataDir・plist（読むだけ）。復元の仕組みそのもの、ac_diagnose の変更（すでに AGENT_CONSOLE_RESTORE=off を付けている）。

## 成功条件

|基準|検証方法|
|---|---|
|server-process 試験の子の config の dataDir が一時ディレクトリの下にある|tests/unit/server-process.test.ts の新しい試験が config.json を読んで確認|
|試験の子が復元リストを書かない|同試験で一時 dataDir に open-sessions.json が無いことを確認|
|isRestoreEnabled の真偽表（なし=有効、off=無効、port あり=無効、両方=無効、port 空文字=有効、OFF・on=有効）|tests/unit/restore-guard.test.ts|
|試験・fixtures が既定 dataDir の文字列を持たない（許可は scripts.test.ts の拒否試験のみ）|tests/unit/restore-guard.test.ts の走査|
|本番の LaunchAgent は AGENT_CONSOLE_PORT を使わず影響を受けない|plist の EnvironmentVariables を読む（AUTH と PATH のみ）|
|既存の unit と e2e が通る|npm test と npm run test:e2e の終了コード 0|

## 代替案

- 試験側の修正だけ: 将来の別の試験・開発起動が同じ事故を起こすため不採用（二重防御として restore.ts 側も直す）。
- 復元を HOME 判定で無効化: 環境依存が増えるため不採用。ポート上書きという既存の明示的な印を使う。

## 外部・過去事例

- v0.3.8 の自己診断サーバー欠陥: 別ポートの一時サーバーが本番と同じ dataDir を読み、前回のセッションを二重に開く欠陥。AGENT_CONSOLE_RESTORE=off で対処した（0.3.8）が、環境変数を付け忘れた起動（試験・検証）は防げなかった。今回はポート上書きでも無効にして付け忘れを塞ぐ。
- 一般則: 試験は本番のデータ置き場を共有しない（一時ディレクトリを明示指定）。

## 維持の仕組み

- tests/unit/restore-guard.test.ts が、試験から既定 dataDir の文字列が出ること、server-process 試験の一時 dataDir と RESTORE=off が外れることを CI で止める。
- 真偽表の試験で、isRestoreEnabled の条件の変更が見える。
