# recon: v0.3.5 端末のコピーで日本語が化ける不具合

基準: origin/main 21d59cc（変更前）。行番号は変更前のもの。

## 1. 子プロセスの環境の組み立て（事実）
- /Users/tanizawashingo/agent-console-wt/locale/server/sessions.ts:58 `CHILD_ENV_BLOCKLIST`（AGENT_CONSOLE_TOKEN / AGENT_CONSOLE_AUTH / AC_SECURITY / AC_STUB_LOG）
- /Users/tanizawashingo/agent-console-wt/locale/server/sessions.ts:61-68 `buildChildEnv(source)`：親の環境を引き継ぎ（64行）、`env.TERM = "xterm-256color"`（66行）だけを足す。LANG を足す処理は無い。
- /Users/tanizawashingo/agent-console-wt/locale/server/sessions.ts:163-169 `spawn(...)`：`env: { ...buildChildEnv(process.env), ...extraEnv }`（168行）。

## 2. config の型と検証（事実）
- /Users/tanizawashingo/agent-console-wt/locale/server/config.ts:28-42 `interface Config`（notify は41行）。端末の環境を指定する項目は無い。
- /Users/tanizawashingo/agent-console-wt/locale/server/config.ts:77-86 `parseNotify`（省略可の項目の既存の検証の形）。
- /Users/tanizawashingo/agent-console-wt/locale/server/config.ts:95-130 `parseConfig`（128行 `notify: parseNotify(o.notify)`）。
- /Users/tanizawashingo/agent-console-wt/locale/agent-console.config.json:11 `"notify": { "macos": true }`。

## 3. 関係する既存の試験（事実）
- /Users/tanizawashingo/agent-console-wt/locale/tests/unit/child-env.test.ts:1-17 buildChildEnv の単体（トークン除去・TERM）。
- /Users/tanizawashingo/agent-console-wt/locale/tests/unit/config.test.ts:19-59 parseConfig の単体。
- /Users/tanizawashingo/agent-console-wt/locale/tests/unit/server.integration.test.ts:231 `describe("child process environment")`：実 pty で環境を確認する統合試験（K1 の形はこれに倣う）。
- /Users/tanizawashingo/agent-console-wt/locale/tests/unit/helpers/harness.ts:94 の `notify:` がテスト用 Config（型が必須項目を増やすとここも更新が要る）。

## 4. macOS 公式の記述（`man pbcopy` 原文）
```
Encoding:
   pbcopy and pbpaste use locale environment variables to determine the
   encoding to be used for input and output.  For example, absent other
   locale settings, setting the environment variable LANG=en_US.UTF-8 will
   cause pbcopy and pbpaste to use UTF-8 for input and output.  If an
   encoding cannot be determined from the locale, the standard C encoding
   will be used.  Use of UTF-8 is recommended.  Note that by default the
   Terminal application uses the UTF-8 encoding and automatically sets the
   appropriate locale environment variable.
```
設計 §0 の再現結果（LANG 無しで文字化け）と整合する。

## 5. 既存 ADR
docs/adr 相当は当リポジトリに無し（対象ADR: なし）。
