# 設計書: 同時に開ける窓の上限と、使っていない窓を休ませる（window-limit）第1.0版
作成: Claude Opus（設計）2026-10-26。状態: 設計案作成済み・自己審査済み（同一 AI による審査。独立した第二者審査ではない）・PO 承認待ち。実装未着手。

## 1. 目的（PO の言葉）
- 原文（2026-10-26）: 「agent consoleでは新しいセッションも過去の会話も含めて全てopusだけが展開して、sonnetは全てクラウドで作業を指せる仕組みにしたい、そうすればCPUやRAMが軽くなると考えるがどうか？」
- Opus の回答と PO 決定（2026-10-26「1」）: Sonnet の実装と試験はクラウドで動かす（運用は決定済み）。加えて、作業画面に「同時に開ける窓の数の上限」と「しばらく使っていない窓を休ませる」仕組みを入れる設計案を作る。窓を閉じる（休ませる）前に必ず PO に確かめる。
- 背景の実測（2026-10-26、PO の Mac、`ps`。生出力 /tmp/CC報告ファイル/cpu/claude-procs-now.txt）: claude の窓 9 本、すべて `--model opus`。CPU 合計 85.3%（32.1・23.7・15.4・8.7・2.1・1.6・0.8・0.5・0.4）、RSS 合計 932MB（263・215・157・122・58・53・23・22・19）。最長の経過 5 日 19 時間。Sonnet の窓は 0 本（Sonnet は Opus の窓の中のサブエージェントとして動いていた）。

## 2. 変更前 → 変更後（利用者に見える変化）
| 場所 | 前 | 後 |
|---|---|---|
| 新しい窓を開く・過去の会話を再開 | 16 本まで開ける（設定できない） | 設定の上限（この Mac では 6）まで。超えると「上限です。休ませられる窓が N 本あります」と案内し、休ませる確認へ進めるボタンを出す |
| 窓の一覧 | 動いている窓と止まった窓 | 30 分以上ずっと待機中（idle）の窓に「休ませられます」の印。休ませた窓は「休止中」として一覧に残り、「起こす」ボタンで同じ会話の続きから開き直す |
| 休ませる操作 | 無い（閉じるだけ） | 行の「休ませる」、または一覧の上の「候補をまとめて休ませる」→ 確認画面（対象の名前を全部並べる）→ 休ませる。**自動では休ませない** |
| 新しい窓の役割 | Opus・Sonnet・shell | Opus・shell（Sonnet の役割を外す。Sonnet の作業はクラウドへ） |
| 作業画面の再起動・更新 | 開いていた窓を開き直す | 開いていた窓は従来どおり開き直す。休止中の窓は休止中のまま一覧に戻す（勝手に起こさない） |

## 3. 事実（根拠）
recon: docs/handoff/window-limit/recon.md（基準 origin/main 21df257、v0.46.2）。以下はその要約と追加確認。
- 上限は `SessionManager` の `maxSessions` 1 か所で、作成・再開・復元・予約・定期実行・引き継ぎの全入口が使う（recon §1-1、`server/sessions.ts:15,275,296,316,325`）。config にキーが無く、本番は options なしで生成（`server/index.ts:75`）。
- 閉じる処理は `closeRunning`（SIGHUP → 5 秒猶予 → 子孫に SIGKILL、`sessions.ts:523-543`）。閉じると `Session` ごと消え、復元リスト `open-sessions.json` は「今開いている窓の写し」なので claudeSessionId も残らない（recon §2、`restore.ts:72-85`）。
- 続きから開く仕組みは既にある: `restore({id, claudeSessionId})` が役割の `restoreCommand` を `AC_RESUME_ID` 付きで起動（`sessions.ts:324-331`）。同じアプリ id を引き継げる（`:331,388-391`）。v0.3.8 から本番で使用中（docs/CHANGELOG.md 0.3.8）。
- 一言も入力していない窓は `claude agents --json` に出ず sessionId が取れない（v0.3.8 design.md:16、2026-10-12 に 3 回実測）。
- 窓の状態は 10 秒ごとの標本（`agentsPollMs`、`hub.ts:145`）。標本ごとの「アプリ id → 状態」を `onAgentsSampled` で購読できる（`hub.ts:181-189`、定期実行の自動クローズが既に使用 `index.ts:107`）。窓ごとの「最後に動いた時刻」は `Session` には無い（recon §3）。
- 既存の自動クローズは定期実行が開いた窓だけ（idle 累計 10 分、`routine-closer.ts:8,42`）。
- 未処理の予約・名前予約がある窓は `hasPendingWork`（`hub.ts:245`）で分かる。
- 役割の設定（origin/main `agent-console.config.json`）: `opus-designer`（ccopusgo）、`sonnet-impl`（`claude --model sonnet`）、`shell`。`reserveRoles`・`routineManagerRoles` は未設定。
- 閉じる確認は SA の金型 `ConfirmModal`（`ConsolePage.tsx:640-649`）。文言は `src/locales/ja.json` の `ac.*`。
- Context7: 本件は agent-console 内部のコードと Claude Code の `--resume` だけで、新しいライブラリの仕様に依存しない。`--resume` の振る舞いは v0.3.8 以来の本番実績に依る。

## 4. 設計
### 4-1 上限を設定にする（便1）
- `Config` に任意キー `maxSessions`（正の整数、既定 16＝今と同じ）。`parsePositive` で検証。`new SessionManager(config, { maxSessions: config.maxSessions })` と渡す。`DEFAULT_MAX_SESSIONS` は `config.ts` の `DEFAULT_*` 群へ移す（既定値の置き場を 1 か所にする）。
- 実ファイル `agent-console.config.json` に `"maxSessions": 6`。
- 数えるのは「動いている窓」だけ（休止中は数えない。4-2）。
- `/api/state` に `maxSessions` と `runningCount` を足し、一覧の見出しに「動いている 5 / 6」を出す。
- 同じ便で `roles` から `sonnet-impl` を外す。復元リストに残っている `sonnet-impl` の項目は既存の `unknownRole` 案内で外れる（`restore.ts:12`）。

### 4-2 休ませる・起こす（便2）
- 新しい状態「休止中」: `Session` に `sleeping: true` を持たせ、端末は持たない。`SessionState` に `sleeping` を足す（`agents.ts:19`）。
- `SessionManager.sleep(id)`: 条件をすべて満たすときだけ実行。満たさなければ `SessionConflictError(<理由>)`。
  1. 動いている窓で、状態が `idle`
  2. `claudeSessionId` が UUID、かつ役割に `restoreCommand` がある（＝続きから開ける。shell 役・一言も入力していない窓は対象外）
  3. `hasPendingWork` が偽、定期実行の自動クローズが追跡中でない、引き継ぎ中でない
  - 処理: 既存の `closeRunning` と同じ止め方（SIGHUP → 猶予 → SIGKILL）で端末を止め、`Session` は消さず `sleeping: true` にして残す。
- `SessionManager.wake(id)`: `hasCapacity()` を確かめ、`restore({id, claudeSessionId, roleId, name, cwd, branch})` で開き直す。満席なら 400（画面は 4-3 の案内）。
- 復元リスト: 項目に任意の `sleeping: true` を足す（`version` は 1 のまま。古い版は未知の項目を捨てる＝`server/session-store.ts:28-52` ので、戻したときは休止中の窓も普通に開き直る＝安全側）。起動時の復元は `sleeping` の項目を開かず、休止中として一覧に戻す。
- 休ませられる候補の判定: `onAgentsSampled` で窓ごとに「idle が連続した時間」をメモリで数える（`RoutineCloser` と同じ作り。標本の間隔が `gapLimitMsFor(agentsPollMs)` を超えたら数え直し）。設定 `sleepSuggestMinutes`（既定 30）以上で候補。作業画面の再起動で数え直しになる（許容。候補が遅れて出るだけで、勝手に閉じることは無い）。
- HTTP: `POST /api/sessions/:id/sleep`、`POST /api/sessions/:id/wake`。`/api/state` の各窓に `sleepable: boolean` と `idleMinutes`。
- **自動で休ませる処理は作らない**（PO 決定「閉じる前に必ず確かめる」）。

### 4-3 画面（便2）
- 一覧の行: 候補の行に「休ませられます（待機 45 分）」の Badge と「休ませる」ボタン。休止中の行は灰色の点と「休止中」、「起こす」ボタン。
- 一覧の上: 候補が 1 本以上あれば Callout「休ませられる窓が N 本あります」＋「まとめて休ませる」ボタン。
- 確認: `ConfirmModal`。本文に対象の名前を全部並べ、「休ませた窓は『起こす』で同じ会話の続きから開き直せます。作業中の窓は対象にしていません」。
- 満席: 作成・再開が「too many sessions」のとき、既存の失敗表示に「休ませられる窓が N 本あります」とボタンを添える。
- 文言はすべて `t("ac.sleep.*")`。部品は SA の金型（Badge・Button・Callout・ConfirmModal）だけ。

## 5. 対象と対象外
- 対象: agent-console のサーバー（config・sessions・restore・hub・http）、画面（SessionList・ConsolePage・ja.json）、試験、`agent-console.config.json`、CHANGELOG、版（便1 v0.47.0、便2 v0.48.0）。
- 対象外: 予約・定期実行・引き継ぎが満席で `full` になる既存の扱い（変えない）、定期実行の自動クローズ（変えない）、tmux の作り、メモリ計測、salesanchor リポジトリ、~/.claude 配下。窓の自動休止（作らない）。

## 6. 受入条件と検証方法
| 基準 | 検証方法 |
|---|---|
| K1 config に `maxSessions` を書くとその数が上限になる。書かなければ 16 | 単体（config）＋統合（harness に config 経由で渡す） |
| K2 上限に達すると作成・再開が 400、画面に案内と「まとめて休ませる」ボタン | 統合＋e2e |
| K3 休止中の窓は上限に数えない | 統合（上限 2、1 本休ませると 1 本開ける） |
| K4 `sleep` は idle・sessionId あり・restoreCommand あり・未処理なしのときだけ成功。working・waiting・shell 役・sessionId なし・予約あり・定期実行追跡中は 409 で窓は動いたまま | 統合（偽 claude の状態ファイルで各条件） |
| K5 休ませると、その窓のプロセス（端末と子孫）がすべて無くなり、一覧には「休止中」で残る | 統合（子孫 pid の生存確認） |
| K6 起こすと、同じアプリ id・同じ名前・同じ作業場所で、`AC_RESUME_ID`＝休ませる前の sessionId で起動する | 統合（偽 claude が受け取った環境変数を記録） |
| K7 再起動後、休止中の窓は開かずに休止中で一覧に戻る。動いていた窓は従来どおり開き直す | 統合（session-restore の既存試験に追加） |
| K8 待機が `sleepSuggestMinutes` 以上続いた窓だけ候補になる。途中で working になると数え直す | 単体（標本を時刻つきで与える） |
| K9 自動で休ませる経路が無い（sleep を呼ぶのは HTTP の入口だけ） | `grep -rn "\.sleep(" server/` が http.ts の 1 か所だけ |
| K10 新しい窓の役割に Sonnet が出ない | e2e（作成フォームの選択肢） |
| K11 文言はすべて t()、金型以外の部品 0 | `npm run lint`（design-governance） |
| K12 既存の試験・CI（ubuntu・macOS）がすべて緑 | CI |
| K13（導入後・実機）PO の Mac で、休ませた窓を起こすと同じ会話の続きが表示される | PO の目視＋設計者が `claude agents --json` の sessionId を休止前後で照合 |
| K14（導入後・実機）動いている claude の窓が 6 本以下のとき、claude プロセスの CPU と RSS の合計を記録する（基準値: 9 本で CPU 85.3%・RSS 932MB） | 設計者が `ps` を 導入前・休止後 に取り、生出力をファイルに残して比べる（目標値は置かない。4-4 参照） |

### 4-4 効果の見込みについて（事実のみ）
- 1 の実測では、重い窓（CPU 32.1%・RSS 263MB など）と軽い窓（CPU 0.4%・RSS 19MB など）の差が大きい。休ませて軽くなる量は「休ませた窓がどれだけ使っていたか」で決まり、待機中の窓が軽ければ効果は小さい。どの窓が待機中だったかは 1 の実測に含まれないため、効果の大きさは未確認。K14 で測る。

## 7. 代替案と選んだ理由
- A 一定時間で自動的に休ませる: 不採用。PO 決定「閉じる前に必ず確かめる」に反する。作業中に見えて実は待機中の窓（人が読んでいる最中）を止める恐れ。
- B 上限だけ入れて休止は作らない: 不採用。満席のとき人が窓を選んで閉じるしかなく、閉じた窓の sessionId が残らないため「過去の会話を再開」の一覧から探し直す手間が残る。
- C 休ませた窓を一覧から消し、別の「休止中リスト」ファイルに残す: 不採用。窓の情報の置き場が 2 つになる（復元リストと休止リスト）。今の復元リストに `sleeping` を足して 1 か所に保つ。
- D 選んだ案: 上限の設定化＋人が確かめて休ませる＋同じ会話で起こす。既存の `closeRunning`・`restore()`・`onAgentsSampled`・復元リストを使い、新しい仕組みを最小にする。

## 8. リスクと対処
- 休ませた窓を起こしたときに会話の続きが開けない（sessionId のずれ）: 条件 2 で sessionId が UUID のものだけ対象。K13 で実測。開けなかった場合は通常の新しい会話にはせず、失敗を表示して休止中のまま残す（`restore` の失敗をそのまま返す）。
- 起こすときの読み込みのトークン消費: 会話の長さ次第で未確認。休ませるのは人の判断なので、長い会話は休ませない選択ができる。
- 戻したとき（旧版へ）: 復元リストの `sleeping` は無視され（旧版の `parseItem`・`normalizeItem` は知らない項目を捨てる＝`server/session-store.ts:28-52`）、休止中の窓も開き直る＝窓は失われない。
- 上限 6 で予約・定期実行が `full` で開かない回が増える: 既存の扱い（記録して諦める）のまま。満席の件数は予約・定期実行の履歴で見える。様子を見て上限を設定で変えられる。

## 9. 戻し方
- 便1: `agent-console.config.json` の `maxSessions` を消せば 16 に戻る。`roles` に `sonnet-impl` を戻せば Sonnet の役割が戻る。版を戻す場合は前の版を導入し直す。
- 便2: 前の版を導入し直す（復元リストは互換。8 参照）。

## 10. 工程
- 便1: 4-1（config・SessionManager 生成・/api/state・一覧の見出し・役割）＋ K1・K2（案内文までで、まとめて休ませるボタンは便2）・K10・K11・K12。
- 便2: 4-2・4-3 ＋ K2（ボタン）〜K9・K11・K12。導入後に K13・K14。
- 実装と試験はクラウド（Sonnet）で行う（PO 決定 2026-10-26「1」）。手元の Mac で担当を起動しない。

## 11. 維持する担当・仕組み
- 上限と候補の時間は config の 2 項目だけ。変えるときは設定ファイルを直すだけで、コードは触らない。
- 自動休止が無いこと（K9）は試験で固定する。

## 12. 外部事例
- Google Chrome の Memory Saver（2023 年 2 月、Chrome 110。Windows・macOS・Linux・ChromeOS）: 使っていないタブをメモリから外し、開いたときに読み込み直す。Google は「最大 40%・10GB のメモリ削減」と発表したと報じられている（一次資料の Google の文面は未確認。二次資料: techradar.com「Google Chrome gets memory and energy saver modes」、alternativeto.net 2022-12 の記事）。音声再生中・入力途中のフォームなどは外さない例外がある。
- 適用の限界: ブラウザのタブと Claude の会話では、外したあとに戻す費用（会話の読み込み直し）が違う。数値（40%）は Chrome の最良の場合の値で、本件の効果の証明には使わない。取り入れたのは「使っていないものだけを外し、見た目は残して、触れたら戻す」「作業中のものは例外にする」という作りだけ。

## 13. 自己審査（Architect）
- 判定: APPROVE（設計として実装可能）。同一 AI による審査であり、独立した第二者審査ではない。
- 確かめたこと: 既存の上限・閉じる・復元・標本購読の file:line を recon で確認し、新しい仕組みはそれらの組み合わせに限った。受入条件はすべて試験か実測で ○× が付く。データの置き場は復元リスト 1 か所（案 C を退けた）。PO 決定（自動で閉じない）を K9 で固定。
- 未解決（実装は止めない）: 効果の大きさ（K14）、起こすときのトークン消費、`.sa-cache` の金型の props（recon 未確認。実装時に `npm run sa-sync` 後に確かめる）。
- PO に決めてもらうこと: この設計で進めてよいか（上限 6・候補は待機 30 分以上）。
