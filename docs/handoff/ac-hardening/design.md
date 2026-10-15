# 設計 v2: ac-routine の締め付け（水準A：うっかり防止と記録）＋画面での一時承認＋定期実行セッションの自動クローズ

作成: Opus（Planner）2026-10-14。状態: 設計案 v3（review-3 APPROVE。MEDIUM 2件は反映済み。PO の実装承認待ち）。v2 は design-v2.md。
対象: GEN-RYU-System/agent-console。基準は origin/main 078c9e4（recon 時）。review-1 時点で origin/main は c67cb0e。実装カードで差分を再確認する。
根拠: recon /tmp/CC報告ファイル/ac-routine-cli/hardening-recon/、審査 /tmp/CC報告ファイル/ac-hardening/review-1.md、前段の設計 /tmp/CC報告ファイル/ac-routine-cli/design.md v5。v1 は design-v1.md として残してある。

## 0. PO の依頼と決定
- 依頼（2026-10-14）: (1) 定期実行で開いたセッションは閉じる。(2) 見張りの穴には技術的なブロックが必要。(3) 逆に、技術的に承認できる仕組みも必要。
- 追加の指示（2026-10-14、PO の原文）: 「Opusが許可を出す仕組みにしたい」。→ §3-3a を主の経路にする。画面のボタン（§3-3）は、PO の予備の経路として残す。
- 決定（2026-10-14、PO の回答は「y」）: 水準A「うっかり防止と記録」で作る。わざと抜け道を使う操作は防がない。その限界は文書に明記し、操作は記録に残す。別の Mac 利用者に分ける案（水準B）は採らない。
  - 質問の文面: /tmp/CC報告ファイル/ac-hardening/po-question-1.md

## 1. 到達範囲（水準Aで止まるもの・止まらないもの）
| 経路（担当＝サブエージェントから） | 結果 | 止める層 |
|---|---|---|
| (a) `cd bin && node ./ac-routine.mjs …` | 403 | 第1層 |
| (b) repo の runCommand を import して呼ぶ | 403 | 第1層 |
| (c) glob で書いて実行 | 403 | 第1層 |
| (d1) 親の callerSessionId を付けて curl | 403 | 第1層（第2層も、宛先付きなら先に止める） |
| (d2) 別の opus-designer セッションの id を名乗って curl | **通る**。監査に1行残る | 止めない（残る弱点 R3） |
| (e) サーバーの秘密（キーチェーン）を読んで、/api/routines・一時承認の受け口に Bearer で入る | **通る見込み**。画面用の /api/routines には監査が無い | 止めない（残る弱点 R3） |
| (f) dataDir の reserve-token を、素直なパスで Read・cat する | hook で拒否 | 第2層 |
| (g) 担当が `ac-routine approve` で承認を出す | hook で拒否 | 第2層 |
| (h) 担当が迂回して承認の宛先を直接呼ぶ | **通る**。監査に approvalIssued が残る | 止めない（R3） |
- (d2) の前提: 別の opus-designer セッションの id は、`claude agents --json` で取れる（hardening-recon の A4-agents-summary.txt に9本）。だから、週次報告で監査の callerSessionId を見る。
- (e) について: 秘密を読めるかの測定（文字数だけを数える）は、自動判定に「認証情報の探索」として止められたので行っていない。設計は「読める」と仮定する。
- 残る弱点 R3 は、README の「限界」の節に書く。週次保守の報告で、監査の件数を見る（§7）。

## 2. 成功条件（○×で判定する）
| # | 基準 | 検証方法 |
|---|---|---|
| S1 | §1 の表の (a)(b)(c)(d1)(f) が、表のとおり 403 または hook の拒否になる。(d2) は通り、監査に callerSessionId 付きの行が残る。 | 単体試験（サーバーの判定、hook の判定関数）と、導入後に実機で各1回 |
| S2 | Opus 本体は、自分のセッションに動いている担当がいなければ、いまどおり add/update/enable/disable/list が成功する。 | 単体試験と実機 |
| S3 | 担当が動いている最中に Opus 本体が add/update/enable/disable を打つと、403 になる。文言は「担当が動いている間は使えない。終わってから再試行するか、`ac-routine approve --reason …` で承認する（定期実行の中では NEEDS_DECISION: で終える）。PO は画面でも承認できる」。監査に1行残る。list は第1層の対象にしない（読み取りのため。監査にも残さない）。 | 単体試験 |
| S4 | PO が画面で「AI の定期実行操作を一時承認（30分・1回）」を押すと、そのセッションの次の add/update/enable/disable 1回だけが、S3 の制限を越えて通る。期限は30分で、使うと消える。監査には、発行の行（approvalIssued）と、使用の行（approvedBy:"ui"）の2行が残る。 | 単体試験と実機 |
| S4b | Opus 本体が `ac-routine approve --reason …` を打つと承認が出て、担当が動いている最中でも、次の書き込み1回だけが通る。承認は10分で切れ、2回目の書き込みは 403 になる。担当が `/bin/ac-routine.mjs approve` を打つと、hook が拒否する。監査に approvalIssued(by:"opus") と approvedBy:"opus" が残る。reason が無いと 400。役割が違うと 403。 | 単体試験（発行・使用・期限切れ・2回目・reason 無し・役割違い・hook の判定関数で担当から、の各1本）と実機 |
| S5 | 一時承認の受け口は、認証の種類が "session"（画面のトークンと Origin）のときだけ受ける。"bearer" と reserve-token は 403 にする。 | 単体試験（3つの認証の種類ごとに1本） |
| S6 | closeWhenIdle が true の定期実行で開いたセッションは、§3-4 の定義で idle が10分続くと自動で閉じる。閉じる前に、最後の返答の先頭500字を、定期実行の履歴に `closed` として残す。 | 単体試験（時刻と標本を差し替える）と実機 |
| S7 | 最後の返答に `NEEDS_DECISION:` か `BLOCKED:` を含むときは閉じず、履歴に `kept`（reason: decision）を残す。Stop の記録が1件も無いときも閉じず、`kept`（reason: no-reply）を残す。 | 単体試験 |
| S8 | 標本に busy・waiting・unknown・取得失敗が1つでもあれば、idle の計時を0からやり直す。waiting のまま60分たったら、`kept`（reason: waiting）を1回だけ残す。 | 単体試験 |
| S9 | 第2層の hook は、関係のない Bash と Read では起動しないか、起動しても無出力で通す。次の3つの形は通る: `npx vitest run tests/unit/ac-routine…`、`grep -n "/api/agent/routines" server/http.ts`、`git show origin/main:hooks/ac-routine.mjs`。 | 単体試験（判定関数）と、第0段の U5 |
| S10 | 週次保守（id 5d459653）が closeWhenIdle:true になっている。 | 画面の定期実行の一覧で確認。監査の update の行 |

## 3. 方式
### 3-1. 第1層: サーバー側で「担当が動いている間は書き込みを拒否」
- 対象: /api/agent/routines の POST、PUT、enabled。list（GET）は対象にしない。
- 判定: 受け付ける直前に activity を refresh する。callerSessionId（claudeSessionId）に running の担当が1つでもあれば 403 にする。
- 根拠（事実）: running は state.starts（PreToolUse の Agent）を回して決まる（server/activity.ts:483-485）。終わりは stops、handbacks、post.status=completed のどれかで決まる（:491）。上限は RUNNING_MAX_AGE_MS=24h（:9）。
- 担当は親のセッションの中で動く。そのため、(a)(b)(c)(d1) は書き方に関係なく止まる。
- fail-closed（Stop の記録が漏れると Opus も止まる）の扱い:
  - 403 の文言（S3）で、`ac-routine approve` と、定期実行の中では NEEDS_DECISION で終えることを案内する。
  - 定期実行の中の Opus は 403 を受けたら、`NEEDS_DECISION:` で終える。そうすれば S7 によりセッションは残り、PO が後から見られる。このことを ROUTINE.md の型に足す（salesanchor 側の別 PR）。
  - U2 で Stop が来ない形が見つかったら、その形を R1 に書く。24h の上限は変えない。
### 3-2. 第2層: hook で、担当に dataDir と直接の宛先を触らせない
- agent_id があるときだけ判定する。repo の文字列は止めない（review-1 H3。v5 §4-1-2 の「実行形に絞る」を守る）。
- Bash で拒否するもの（どれか1つに当たったら拒否）:
  - `/bin/ac-routine.mjs`（既存）
  - `agent-console/reserve-token`
  - `Application Support/agent-console`
  - `127.0.0.1` か `localhost` を含み、かつ `/api/agent/routines` か `/api/routines` か `routine-approval` を含むもの
- Read・Grep・Glob で拒否するもの: パス（Grep と Glob は path 引数）が dataDir の下にあるもの。
- `if` は1つの規則しか書けない（recon B7）。そのため handler を分ける。
  - Bash 用: `if: "Bash(*)"` は使わない。U5 の結果を見て、handler を規則ごとに複数（例: `Bash(*agent-console*)`、`Bash(*127.0.0.1*)`、`Bash(*localhost*)`）にするか、`if` 無しで判定関数を速く保つかを決める。U5 の基準は、無関係な Bash で hook を起動しないか、起動しても中央値150ms以下であること。
  - Read・Grep・Glob: U5 で `if` が効いたツールだけを対象にする。効かないツールは第2層から外す（第1層が本命のため）。
- 文字列の判定は、引用符の位置や glob で迂回できる（review-1 H1）。それでも置くのは、うっかりと、素直なパスでの読み取りを早めに止めるため。
### 3-3a. 一時承認（Opus から。主の経路。PO 指示 2026-10-14「Opus が許可を出す仕組みにしたい」）
- 方式は review-2 H1 の案（イ）「監査付きの上書き」にする。「担当が静か」の判定は置かない。理由: 担当の Bash・Read などの行は activity に記録されない（server/activity-hooks.ts:39-47、hooks/activity-hook.mjs:97-125）。前景の担当は agent_id を結べない（server/activity.ts:487）。記録を足す案（ア）は、すべての道具の呼び出しで hook を起動することになり、S9 と食い違う。水準A（うっかり防止と記録）の範囲では、（イ）で足りる。
- 命令: `ac-routine approve --reason <理由>`。宛先は `POST /api/agent/routines/approval`。reserve-token を使い、callerSessionId を付ける。
  - サーバーでは、AGENT_ROUTINE_PATH（server/http.ts:336）の :id より先に approval を分岐させる。"approval" を routine の id として扱わない。
- 受ける条件（サーバーで確かめるもの）: 役割の照合が通る（opus-designer。既存と同じ）。reason が 1〜200 字。
- 担当からの防ぎ方（サーバーでは確かめない。水準A）: 担当（agent_id あり）が `/bin/ac-routine.mjs` を打つと、第2層の guard が先に拒否する。宛先付きの curl も、第2層の Bash 規則で拒否する。わざと迂回すれば通るが、監査に approvalIssued が残る（R3）。
- 効き目: その claudeSessionId からの add/update/enable/disable の次の1回だけに効く。期限は10分で、使うと消える。役割の照合、上限、reason の必須は越えない。
  - 期限の意図: Opus はその場ですぐ使うので短くする。画面（§3-3）は PO が離席しうるので30分にする。
- 併存の扱い（review-3 M2）: 1つのセッション（claudeSessionId）が持つ承認は、1件だけにする。後から出した承認が、前の承認を上書きする（画面と Opus のどちらからでも同じ。監査には approvalIssued が2行残る）。使った行の approvedBy は、使った承認の by（"opus" か "ui"）にする。だから「次の1回だけ」は常に成り立つ。
- 監査: 発行で `approvalIssued`（by:"opus"、reason、その時点で running の担当の数）、使用で `approvedBy:"opus"` を残す。週次保守で件数を見る。
- 試験: S4b（§2）。
### 3-3. 一時承認（画面から。PO の予備の経路）
- 受け口: `POST /api/sessions/:id/routine-approval`。:id は SessionManager の id。
- 認証: handleApi に認証の種類を渡すよう変える（server/http.ts:513-523）。この受け口は "session" だけを受け、"bearer" と reserve-token は 403 にする。
- 結び先: そのセッションの claudeSessionId（server/hub.ts:410 で定期取得のあとに入る）。まだ入っていなければ、400「Claude セッションが未確定。数秒後に再試行」。
- 効き目: その claudeSessionId からの add/update/enable/disable の次の1回だけが、第1層を越える。役割の照合（opus-designer か）、上限、reason が必須であることは越えない。list は対象外。
- 保持: メモリだけに持つ。期限は30分。サーバーが再起動すると消える。
- 画面: セッションの右の欄にボタンを置く。文言は t() で ja・en の両方に入れ、金型の部品を使う。押した後の30分は「承認中（残り n 分・未使用）」と出す。
- 監査: 発行で `approvalIssued`（sessionId、claudeSessionId、期限）、使用で `approvedBy:"ui"` を残す。
- 残る弱点: (e) のとおり、サーバーの秘密を読めれば bearer で /api/routines に直接入れる。この受け口が bearer を拒否しても、それは変わらない。R3 として明記する。
### 3-4. 定期実行セッションの自動クローズ
- Routine に `closeWhenIdle?: boolean` を足す。既定は false。画面と ac-routine の両方から指定できる。
- 閉じる相手:
  - launchAndSend（server/launch.ts:84-102。c67cb0e 基準）の戻り値に sessionId を足す。後方互換を保つため、既存の項目は残す。reservations も同じ関数を使う。
  - routines の events に sessionId を記録する。
- 観測の定義:
  - `claude agents --json` の標本（agentsPollMs ごと、server/hub.ts:129,:154-156）を使う。
  - 指示を送った（sent）あとから数える。連続する標本がすべて idle で、waitingFor が無い時間が累計10分になったら閉じる。
  - busy、waiting、unknown、取得失敗の標本が1つでもあれば0からやり直す。前の標本との間隔が gapLimitMs（max(agentsPollMs×5, 60秒)）を超えた標本（Mac のスリープなど）も、取得失敗と同じ扱いで0からやり直す（v0.35.0）。
  - 第1層の running の担当がいる間も0からやり直す（U3 の結果によらず入れる。安全側）。
- 返答の元: 既存の chat（Stop の last_assistant_message。server/activity.ts:368-370、chat() :457-462、claudeSessionId で引く）の最後の1件。transcript は読まない。
- 判定:
  - 最後の返答に `NEEDS_DECISION:` か `BLOCKED:` → `kept`（decision）
  - Stop が0件 → `kept`（no-reply）
  - それ以外 → 先頭500字を `closed` として残し、sessions.close（server/http.ts:265-275 と同じ経路）で閉じる
- kept になったセッションは、その後は見ない（PO か Opus が閉じる）。
- 週次保守の報告で、kept の件数と理由を見る。
### 3-5. 今日の試しのセッション
recon A4（21:09）の時点で、すでに開いていない。対応は不要（review-1 L4 で確認済み）。

## 4. 第0段（実装の前に実測する。満たさなければ BLOCKED: で止まる）
全体の設定は変えない。一時の settings を `claude -p --settings <file>` に渡し、隔離した会話で測る（前段のカードと同じ方法）。
- U1: 担当の最初の Bash より前に、PreToolUse(Agent) の行が activity の events に書かれているか。前景で10回、背景で10回試す。止まる条件は、書かれていない回が1回でもあること（この場合は第1層の判定の前に、短い待ちを入れる案を持って戻る）。
- U2: SubagentStop（または completed）が記録されるかを、次の4つの形で見る。止まる条件は無い（結果を R1 に書く）。
  - 前景で正常に終わった
  - 背景で正常に終わった
  - Esc で中断した
  - 親のセッションを閉じた
- U3: 背景の Bash や担当が動いている間に、`claude agents --json` の status が何を返すか。結果を §3-4 の注に書く。
- U5（review-2 L3: repo の ~/agent-console の読み取りも基準に含める）: Read・Grep・Glob・Bash で、`if` の規則が効くか（無関係な呼び出しで hook が起動しないか）。あわせて、node で起動する hook 1回の所要時間（10回の中央値）を測る。
- 生出力は /tmp/CC報告ファイル/ac-hardening/step0/ に保存する。
- U4（秘密を読めるか）は測らない。§1 のとおり「読める」と仮定する。

## 5. 代替案と選ばなかった理由
- 水準B（別の Mac 利用者に分ける）: PO が水準Aを選んだ（§0）。記録に怪しい動きが出たら、改めて PO に諮る。
- 文字列の判定だけを広げる: 迂回できる（code-review-1 M1）。第2層として残すが、本命にはしない。
- callerSessionId を、PID の親子関係で検証する: 呼び出しの元が curl などの別のプロセスになり、Claude のプロセスとの関係が一定しない。水準Aの範囲を超えるので採らない。
- すべての操作を画面承認にする: 「管理職である Opus が判断する」という PO の条件と食い違う。

## 6. リスクと対処
- R1: Stop の漏れで、Opus が最長24時間止まる。→ 一時承認で越える。定期実行の中なら NEEDS_DECISION で残す。U2 の結果を記す。
- R2: CI 待ちなどの途中で idle が10分続き、閉じてしまう。→ 待ちは Claude のターンの中で行う（ROUTINE.md の型）。U3 を測る。running の担当がいる間は数えない。
- R3（残る弱点。PO 承知の上）: わざと別のセッションを名乗る (d2) と、秘密を読む (e) は止めない。(d2) は監査に残る。(e) は画面用の /api/routines を通るので、監査に残らない。週次保守で、定期実行の一覧の変化（作成者・作成日時）を前週と比べて報告する。
- R4: hook の誤爆で、Sonnet の agent-console 開発が止まる。→ §3-2 で repo の文字列を対象から外した。S9 の3つの形を単体試験で固定する。
- R5: 一時承認の押し間違い。→ 1回・30分・セッション限定とし、発行と使用の両方を監査に残す。

## 7. 維持の仕組み
- 監査ファイル routine-audit.jsonl に、拒否、一時承認の発行と使用、自動クローズ（closed と kept）を残す。
- 週次保守の報告で、次を見る。
  - 拒否の件数
  - 一時承認の件数
  - kept の件数と理由
  - 定期実行の一覧の前週からの変化（R3 対策）
- 単体試験で S1〜S9 を固定する。
- README の「限界」の節に、R3 を書く。

## 8. 影響範囲（変える予定のファイル。実装カードで file:line まで詰める）
server/http.ts（第1層、handleApi に認証の種類を渡す、画面の承認の受け口、Opus の承認 /api/agent/routines/approval を AGENT_ROUTINE_PATH :336 の :id より先に分岐）、server/activity.ts（動いている担当の照会）、server/routines.ts（closeWhenIdle、events の sessionId、kept・closed）、server/launch.ts（戻り値に sessionId。c67cb0e で launchAndSend は :84-102、戻り値は :101、waitReady の extra 引数は :72-81）、server/reservations.ts（戻り値の受け取りだけ。権限は触らない）、server/agents.ts と server/hub.ts（idle の標本の継続時間）、新規 server/routine-closer.ts、server/routine-audit.ts（項目の追加）、hooks/ac-routine-guard.mjs（判定を広げる）、server/activity-hooks.ts と scripts/ac-hooks.mjs（handler の本数）、src/（承認ボタン、closeWhenIdle の入力欄。金型と t() を使う）、ja・en の文言、tests、README（限界の節）、CHANGELOG、版。
触らないもの: scripts/ac-install.sh とキーチェーン（水準A）、/api/routines の既存の振る舞い（closeWhenIdle の追加だけ）、~/.claude/settings.json（ac-hooks install は利用者が実行する）。
salesanchor 側（別 PR）: ROUTINE.md の指示文に「403 を受けたら NEEDS_DECISION: で終える」を足す。

## 9. 戻し方
版を戻す（ac-rollback.sh）。hook は ac-hooks uninstall で外す。closeWhenIdle は既定 false なので、指定しなければ動かない。

## 10. 外部事例
該当なし。理由: 同じ OS の利用者の中で、親の AI とその担当を見分ける仕組みは、製品ごとの作りに依存する。この構成に直接使える公開事例は見当たらない。根拠には Claude Code の hooks の公式資料（agent_id、if、permissionDecision）だけを使う。

## 11. review-1 への対応表
| 指摘 | 対応 |
|---|---|
| H1 | 水準A（PO の決定）。§1 の表で (d2) を「通る・監査に残る」と明記した。S1 を経路ごとの期待に分けた。 |
| H2 | 測定は自動判定に止められたので行わない。「読める」と仮定し、(e) を R3 に明記した。S5 は、受け口が認証の種類で拒否することに限った。 |
| H3 | Bash の拒否から `ac-routine` と、裸の `/api/agent/routines` を外した。宛先付きと dataDir 側に限った。S9 に3つの形を固定した。 |
| M1 | U1 を PreToolUse(Agent) の行に直した。前景と背景で各10回。 |
| M2 | U2 に Esc と、親を閉じる形を足した。定期実行中の 403 は NEEDS_DECISION で残す。 |
| M3 | §3-3 で、認証（session のみ）、結び先（claudeSessionId、未確定なら400）、消費の対象（書き込み4種、list は除く）を決めた。 |
| M4 | 返答の元は chat（Stop）に固定した。Stop が0件なら kept（no-reply）。launch.ts の戻り値に sessionId を足し、§8 に入れた。 |
| M5 | §3-4 で標本による定義と、やり直しの条件を書いた。waiting は60分で kept。 |
| M6 | U5 を足した。効かないツールは第2層から外す。 |
| M7 | S1、S3、S5、S6、S7 を書き直した。list は第1層の対象外で、監査も無し。 |
| L1 | S10 を足した。 |
| L2 | 発行も監査に残す。 |
| L3 | §8 に launch.ts を足した。ac-install.sh は触らない（水準A）。 |
| L4 | 対応不要。 |

## 12. review-2 への対応表
| 指摘 | 対応 |
|---|---|
| H1 | §3-3a を案（イ）「監査付きの上書き」にした。静かの判定と U6 を削った。§1 の表に (g)(h) を足した。PO の承知は、別途3行で確認する。 |
| M1・M2 | （イ）を選んだので対象外。 |
| M3 | サーバー条件から guard を外し、水準Aの防ぎ方として書いた。approval の分岐を §3-3a と §8 に書いた。 |
| L1 | launch.ts を c67cb0e の行に直した。 |
| L2 | (d2) の前提を §1 に注として書いた。 |
| L3 | U5 に repo の読み取りを含めた。 |
| L4 | 期限の意図を §3-3a に書いた。 |
