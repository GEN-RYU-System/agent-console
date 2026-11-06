# 件の claude の版を人の手なしで確かめる 便CS3a — 実装カード

正本の設計: Sales Anchor の docs/handoff/conversation-consent/design.md の §14-14（第12版。§14-14-1〜§14-14-15）。Architect 4回目 APPROVE。PO 承認: 版の一覧を dataDir の記録へ移す「1」（2026-11-06）・守りはうっかり防止の水準「1」（2026-11-06）・「記録も残るようにして」（2026-11-06）。PO の委任（実装からマージ・反映まで）に基づき Opus が出すカード。
ADR: Sales Anchor の ADR-1033 What 6 の例外（便CS3c。本カードの前に本線へ入れる）。
土台: agent-console origin/main aabdeef（v0.52.0）。設計の行番号はすべて aabdeef の物。
読んだ節（Sales Anchor docs/handoff/design-partner-card-ops/guards/）: 00-common.md（1行1命令・出力に上限・sleep で待たない・報告に無い出力を成功と扱わない）、05-pr.md と 09-gh.md（PR は作らない。push だけ）。照合: 本カードは cd から始まる手順の命令を持たない（クラウドの写しで動くため）。git は1命令ずつ。待ちは無い。
このカードに無いことはしない。迷ったら停止して `NEEDS_DECISION:` で返す。見張りに止められたら言い換えず `BLOCKED:` で返す。

## 0 作る物（一言）
件の claude の版の○×を、サーバーが自分で開く「probe の件」で機械的に確かめ、サーバーだけが書く dataDir の記録に残す。case-say の判定 4b は、件を開く前に取った実体の指紋（sha256・size）が記録の使える項目と一致するかで決める。この便の間は過渡期として「記録の使える項目 ∪ config の caseSayClaudeVersions」で通す。

## 1 作る物の詳細（設計の節へ）
次の各項目は設計の節の文のとおりに作る。設計と実物の行が合わないときは停止して NEEDS_DECISION:。
| 項目 | 設計の節 | 主に触るファイル |
|---|---|---|
| D5 記録・鍵・MAC | §14-14-3 D5・§14-14-6 の 1・R1 | server/case-say-versions.ts（新。`CaseSayVersionStore`）・server/json-store.ts は使うだけ |
| D2 起動前の指紋 | §14-14-3 D2 | server/sessions.ts（createCase・spawnSession・prepareCaseRoom・caseClaudeReal の値を `{ real, size, sha256 }` に） |
| D3' 状態ファイルの version・probe の件だけの hook 2 本・受け口 | §14-14-3 D3' | server/case-agents.ts・server/case-sandbox.ts（buildCaseSettings と writeCaseFiles に任意の引数 `{ versionProbe: true }`）・server/http.ts（`POST /api/agent/case-probe-activity`） |
| D4 probe の件 | §14-14-3 D4 | server/case-say-probe.ts（新。台本・判定・片付け）・server/sessions.ts（入力の拒否・枠）・server/restore.ts:94・server/ws.ts・server/hub.ts（enqueueChat・submitText・名前の変更の拒否） |
| 判定 P0〜P5・E1〜E4 | §14-14-4 の表 | server/case-say-probe.ts |
| D1 4 つの出し先・n1〜n6 | §14-14-3 D1 | server/hub.ts（Snapshot に caseVersionNotices）・server/notify.ts は使うだけ・server/http.ts（/api/state に caseSayVersions）・画面の案内（src。文言は src/locales/ja.json） |
| 起動時の再確認と片付けの順 | §14-14-6 の 3・§14-14-3 D4 の (1)〜(5) | server/index.ts・server/terminal-host/tmux-runner.ts は一覧を受けるだけ |
| 4b の置き換え（過渡期） | §14-14-4 末尾・§14-14-9 | server/hub.ts:538-542 |
| 断りの理由 2 つ | §14-14-2・D1 | `claude_version_probing`・`version_probe_session`（README の理由の一覧にも） |
| 部屋の deny | §14-14-3 D5 | server/case-sandbox.ts:70-87 CASE_DENY_WRITE・:89-100 CASE_DENY_READ に記録と鍵 |
| 監査 action 2 つと型の直し | §14-14-6 の 8・9 | server/routine-audit.ts（action に caseClaudeVersionProbe・caseClaudeVersionNotice、outcome に "aborted"、欄 startedAt・endedAt・sha16・failedCheck・trigger・probeCaseId・counts・paneSamples、:2 の注記の例外、callerSessionId は null） |
| 監査に書けなかったとき | §14-14-6 の 9（n6・usable を書かない） | server/case-say-probe.ts |
| README | §14-14-2 の README の行 | 「claude の版の一覧」節（:309-318）を「版はサーバーが自分で確かめる」節に置き換える。過渡期の間 config の一覧も効くことを1行書く |
| 版 | CHANGELOG の決まり | package.json・package-lock.json の先頭2か所・extension/manifest.json を 0.53.0。docs/CHANGELOG.md の先頭に 0.53.0 の1行（戻し方 `bash scripts/ac-update.sh v0.52.0`） |
| 本カード | — | docs/handoff/case-claude-version/card-cs3a.md（Opus が置いた。中身は変えない） |

## 2 触らない範囲（設計 §14-14-9 の末尾のとおり）
PO の件へ送る文（hub.ts:140・:571・README:302）、共通の HOOK_SPECS（activity-hooks.ts:53-72）、buildCaseSettings を引数なしで呼んだ出力、handleCaseActivity（http.ts:455-470）と活動の記録（server/activity.ts）、GUARD_IFS と hooks/ac-routine-guard.mjs、宛先の決め方（hub.ts:521-537）、判定 1〜3・5〜9、ops/shell/ccdiscord.zsh、ops/case/case-guard.mjs、hooks/activity-hook.mjs、画面のチャット、予約・定期実行、tmux の設定、agent-console.config.json の caseSayClaudeVersions（便CS3b で外す。この便では残す）、tests/unit/case-say.test.ts:360-396（config の試験。便CS3b で外す）。

## 3 先に確かめること（結果を最後の返事に生のまま貼る）
1. `git log -1 --oneline origin/main` の先頭が aabdeef。違えば停止して NEEDS_DECISION:。
2. 土台の単体試験の赤: 手を入れる前に `npm ci` と `npm test` を流し、赤の試験の名前の一覧を残す（後で比べる）。
3. 設計の行の照合: hub.ts:538-542 が 4b、sessions.ts:394 が createCase、case-sandbox.ts:455 が buildCaseSettings、:496 が writeCaseFiles、http.ts:455 が handleCaseActivity、routine-audit.ts:11 が action の型、restore.ts:94 が復元の一覧の filter であること。どれか違えば停止して NEEDS_DECISION:。
4. 想定の分かれ道: (a) 状態ファイルに version キーが無い・形が違う → P0 は「キーがあれば」の条件なので無くても進める。形を試験の偽物で決め打ちしない。(b) `capture-pane` の正規表現（P4）は設計の形のまま入れる（本物の画面での確かめは K55 で Opus が行う）。(c) 指紋の計算を非同期の流し読みで作れない → 停止して NEEDS_DECISION:。(d) 既存の試験が設計の変更で落ちる（K42 など） → 設計 §14-14-2 の試験の行と §14-14-8 K50 のとおりに書き換える。それ以外の既存の試験が落ちたら停止して NEEDS_DECISION:。

## 4 試験（設計 §14-14-8 の K50〜K54・K58・K59 の検証方法の文のとおり）
- K50: tests/unit/case-say.test.ts の K42（:334-357）を記録の形に書き換える。過渡期の「config の一覧にある版も通る」を1件足す。
- K51: tests/unit/case-say-probe.test.ts（新）。偽の tmux・偽の状態ファイル・偽の R・偽の probe の道具の記録で、§14-14-8 K51 に並んだ場面を1つずつ1件の試験にする。
- K52: 同じファイルか tests/unit/case-say-probe-startup.test.ts（新）。
- K53: tests/unit/case-say-versions.test.ts（新）と tests/unit/case-sandbox.test.ts への追加。
- K54: D1 の出し先。macOS 通知は差し替えた送信関数で数える。
- K59: 監査の欄と追記。
- K58: `npm run build`・`npm run typecheck`・`npm run lint`・`npm test`。単体の赤が §3 の 2 の一覧と同じなら進める。増えたら直す。直せなければ停止して NEEDS_DECISION:。e2e は回さない（GitHub の CI で見る）。tests/unit/ccdiscord-zsh.test.ts（K40）は変えない。

## 5 提出
- ブランチ release/case-claude-version-probe（origin にあり、本カードの commit が載っている）。`git fetch origin` のあと `git switch release/case-claude-version-probe`。
- commit は意味のまとまりごとに分けてよい。commit の文の終わりに `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 一時ファイルは commit しない。秘密・ホームの絶対パスを書かない（agent-console は公開）。
- `git log --oneline origin/main..HEAD` で commit の実在を確かめてから `git push -u origin release/case-claude-version-probe`（force 禁止。rebase・reset 禁止）。PR は作らない。マージはしない。
- 途中で停止するときは `git push origin HEAD:wip/case-claude-version-probe` に置いてから返す。

## 6 受領確認と最後の返事
- 受領確認: 最初の返事の1行目に「受領確認 card-cs3a」と書いてから §3 に入る。
- 最後の返事の1行目は次の3つのどれか: `DONE` の後に空白1つと新しい HEAD の40桁／`BLOCKED:` の後に理由／`NEEDS_DECISION:` の後に問い。2行目から: §3 の生の結果、触ったファイルの一覧（§1 の表と照らす）、試験の数（通った・赤）、§3 の 2 の一覧との違い。

END OF CARD
