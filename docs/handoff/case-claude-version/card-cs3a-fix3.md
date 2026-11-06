# 便CS3a 直し3 — 実装カード（CI の e2e の赤への対応）

正本の設計: Sales Anchor docs/handoff/conversation-consent/design.md §14-14（第12版）。親カード: card-cs3a.md（§2 の触らない範囲はそのまま守る）。直し1: card-cs3a-fix1.md。直し2: card-cs3a-fix2.md。
土台: release/case-claude-version-probe の 6636d63e06ae7c9f8b0873be60503e89c0f06f82 の次の commit（このカードを足した commit）。
このカードに無いことはしない。迷ったら停止して `NEEDS_DECISION:` で返す。見張りに止められたら言い換えず `BLOCKED:` で返す。

## なぜ
GitHub の CI（run 42245943441 ほか、この branch の全 run）で e2e が 1 件だけ赤:
`tests/e2e/console.spec.ts:736`「段階2 K3: よく使う指示を…」の :785 で、dataDir のファイル一覧に次の 3 つが増えている。
- `case-say-claude-versions.json`（D5 の記録）
- `case-say-claude-versions.key`（D5 の MAC 鍵）
- `routine-audit.jsonl`（probe の監査・知らせ n1〜n5 の監査）

e2e の app のサーバーは `AGENT_CONSOLE_PORT: ""`（playwright.config.ts:46）で本番のポートの扱いになり、`isPickerSetupEnabled`（server/picker-extension.ts:37-38）が true になるので、server/index.ts:163-166 の startupCleanup と probe の予約が動く。これは設計どおりの動き。試験の期待する一覧を更新し忘れた（設計者 Opus の漏れ）。製品のコードは変えない。

## G1 試験の期待を新しい保存先に合わせる
- 場所: tests/e2e/console.spec.ts の :783-788 だけ。
- 鍵 `case-say-claude-versions.key` は起動の load で必ず作られる（server/case-say-versions.ts:119-130,167-179）。期待の一覧（:785 の配列）に足す（並びは sort 後の位置）。
- 記録 `case-say-claude-versions.json`・監査 `routine-audit.jsonl` は probe の進み具合で、この時点で有るか無いかが決まらない。書き込み途中の一時ファイル `case-say-claude-versions.json.<uuid>.tmp`（server/json-store.ts:32）も一瞬だけ現れうる。そこで :785 の filter で次の名前を外す（activity・boards・schedule.json と同じ扱い）:
  - `n.startsWith("case-say-claude-versions.json")` の名前
  - `routine-audit.jsonl`
- 権限の確かめを足す:
  - 鍵: `statSync(path.join(DATA_DIR, "case-say-claude-versions.key")).mode & 0o777` が `0o600`。
  - 記録: `existsSync(path.join(DATA_DIR, "case-say-claude-versions.json"))` のときだけ、mode & 0o777 が `0o600`。
- :783-784 のコメントを直す: 保存先の数と「v0.53.0 の件の版の記録の鍵 case-say-claude-versions.key」を足し、記録の本体と監査は probe の進み具合で有無が変わるので一覧から外す、と書く。
- import に `existsSync` が無ければ、既存の `node:fs` の import に足す。
- ほかの試験・ファイルは変えない。

## 確かめ
- `npm ci`・`npm run typecheck`（171 から増やさない）・`npm run lint`。
- e2e は手元・クラウドで回せなければ回さなくてよい（GitHub の CI で見る）。回せたら結果を書く。
- 版は 0.53.0 のまま。CHANGELOG・README は変えない。

## 提出
- `git fetch origin` → `git switch release/case-claude-version-probe` → `git log -1 --format=%H` が本カードの commit であることを確かめる。
- commit の文の終わりに `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。一時ファイル・秘密・ホームの絶対パスを入れない。
- `git push origin release/case-claude-version-probe`（force・rebase・reset 禁止）。PR は作らない。マージはしない。

## 最後の返事
1行目は `DONE <新しい HEAD の40桁>`／`BLOCKED: <理由>`／`NEEDS_DECISION: <問い>` のどれか。2行目から: 変えた file:line、typecheck の数、lint の結果、push の結果1行、`git diff --stat <本カードの commit>..HEAD`。

END OF CARD
