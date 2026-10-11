# recon: v0.3.1 アプリアイコン

## 起動アプリを作る箇所
- /Users/tanizawashingo/agent-console-wt/icon/scripts/lib/ac-common.sh:272 `ac_build_launcher_app`（osacompile を標準入力で実行）
- 呼び出しは /Users/tanizawashingo/agent-console-wt/icon/scripts/ac-install.sh:36 のみ（変更前）。ac-update.sh / ac-rollback.sh は版の切替と再起動だけで、起動アプリを作り直さない（変更前）。
- 撤去: /Users/tanizawashingo/agent-console-wt/icon/scripts/ac-uninstall.sh:25 が Trash へ移す。

## osacompile の生成物（一時ディレクトリで実測）
- Info.plist: `CFBundleIconFile` = `applet`
- Contents/Resources: `applet.icns`, `applet.rsrc`, `Assets.car`, `Scripts`
- 生成直後 `codesign --verify --deep --strict` = 0。applet.icns を書き換えると `a sealed resource is missing or invalid`（終了コード 1）→ 差し替え後に `codesign --force --sign -` で再署名する。

## 試験の仕組み
- /Users/tanizawashingo/agent-console-wt/icon/tests/unit/helpers/ac-env.ts: 一時 HOME・AC_* 環境変数で差し替え、gh/osacompile/codesign 等をスタブ。AC_STUB_LOG があるテストモードでは一時ディレクトリ以外を拒否（/Users/tanizawashingo/agent-console-wt/icon/scripts/lib/ac-common.sh の ac_guard_test_paths）。
- /Users/tanizawashingo/agent-console-wt/icon/tests/unit/scripts.test.ts に追加（K1/K1b/K1c/K2）。
