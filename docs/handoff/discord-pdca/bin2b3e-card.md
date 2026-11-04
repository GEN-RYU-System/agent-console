# 便2b-3e 2回目の部屋の受入で落ちた2つを直す（v0.50.1）作る係への指示書

- 設計: `docs/handoff/discord-pdca/room-design.md` 第10.1版 §4-2b（1・2 と受入のやり直し）。前の便 `bin2b3d-card.md`（v0.48.1）
- 目的: ①case-home の `history.jsonl.lock` を部屋で作れるようにする。②起動関数で `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` を渡し、公式の追加機能の一覧の自動登録（`downloads.claude.ai` への通信）を止める
- この便に入れないもの: ほかの部屋の規則（正規表現・順 3 の拒否・順 4）・受付の許可先・`.claude.json` の書き直し（`KEEP_CLAUDE_JSON_KEYS`・`rewriteCaseClaudeJson`）・会話の番号の拾い方・ほかの環境変数・ほかの役割の振る舞い。本物の件を開く試験（設計者がマージのあとに行う）
- 入れる順番: 作る係は PR を作るところまで（Draft にしない。題は `fix: case room history lock and official marketplace autoinstall (v0.50.1)` の形）。審査・マージ・タグ・入れるのは設計者
- 迷ったら止まる: 下の「決めたこと」に無い分岐・行番号が合わない・テストが今の形で書けない、のどれかに当たったら、推測で埋めず、そこで止めて「何が・どこで（file:line）・何を試したか」を報告する

## 調べた実物（行番号は origin/main 02857e2 = v0.50.0 のあと）

- `server/case-sandbox.ts`: `CH_RECORD_FILES` :244・`CH_CLAUDE_JSON_COMPANIONS` :246・`chRecordLit` :320・順 2 の作成・削除の開け直し :322・順 3 の書き込みの許可 :330・`KEEP_CLAUDE_JSON_KEYS` :392（変えない）
- `ops/shell/ccdiscord.zsh`: `CLAUDE_CONFIG_DIR` :61・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` :62・`DISABLE_AUTOUPDATER` :63
- テスト: `tests/unit/case-sandbox.test.ts`（case-home の仲間の試験 :434、literal の確かめ :440）・`tests/unit/ccdiscord-zsh.test.ts`（`/^(CLAUDE|ANTHROPIC)/` の並び :206-207・値の確かめ :208-212）
- 版: `package.json:3`・`package-lock.json` の :3 と :9・`extension/manifest.json:4`（今は全部 0.50.0）

## 決めたこと

### A. 部屋の書き込み（`server/case-sandbox.ts`）

- :244 を `const CH_RECORD_FILES = [".last-cleanup", ".claude.json", "history.jsonl", "history.jsonl.lock"];` にする。ほかの行は変えない（`chRecordLit` を通って :322 と :330 の両方に literal が入る）
- テスト（`case-sandbox.test.ts` の :434 の試験の中）:
  - :440 の `arrayContaining` の並びに `path.join(p.CH, "history.jsonl.lock")` を足す
  - 同じ `for (const form of [reopen, write])` の中で、`${p.CH}/history.jsonl.lock` が `covered` で真、`${p.CH}/history.jsonl.lock/x` と `${p.CH}/history.jsonl.lock2` が偽であること

### B. 起動関数（`ops/shell/ccdiscord.zsh`）

- :63 の次の行に `export CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` を足す（:60 の説明の行に「公式の追加機能の一覧の自動登録も止める」を足してよい）
- テスト（`ccdiscord-zsh.test.ts`）: :207 の並びを `["CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_TMPDIR", "CLAUDE_CONFIG_DIR"]` にする（`.sort()` の結果の順。違えば止めて報告）。:212 の下に `expect(e.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL).toBe("1");`

### C. 版と記録

- `package.json`・`package-lock.json` の2か所・`extension/manifest.json` の版を 0.50.1
- `docs/CHANGELOG.md` の 0.50.0 の行の上に1行: 「0.50.1 部屋の2回目の受入で落ちた2つを直した（case-home の `history.jsonl.lock` を書けるようにした・起動関数で `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` を渡して公式の追加機能の一覧の自動登録を止めた）。戻し方 `bash scripts/ac-update.sh v0.50.0`」

## 確かめ（作る係が PR の前に行う）

- `npm test`（vitest 全部）・`npm run lint`・型の確かめ（今の CI と同じ命令）が通る
- `git diff origin/main --stat` が、上に挙げたファイル（8つ: `server/case-sandbox.ts`・`ops/shell/ccdiscord.zsh`・`tests/unit/case-sandbox.test.ts`・`tests/unit/ccdiscord-zsh.test.ts`・`package.json`・`package-lock.json`・`extension/manifest.json`・`docs/CHANGELOG.md`）だけ
- 公開のリポジトリなので、家の道・利用者の名前・秘密を書かない（道は `<…>` に伏せる）
