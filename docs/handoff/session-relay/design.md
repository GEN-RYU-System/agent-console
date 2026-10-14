# ボタン1つで次のセッションへ引き継ぐ・名前が英語に戻る不具合（session-relay）設計 第4版

- 状態: 設計案 第4版（Opus 2026-10-14）。第1版〜第3版は Fable 審査で REVISE、第4版は REVISE（中1件 N21）で本文を直した第4版の改（§12〜§15 に対応表）。Fable 第4版の改 APPROVE（review-design5）。PO 実装承認: 2026-10-14 PO「3から順番にy,」（file-viewer → keep-login → session-relay → board-guard の順）。実装は Sonnet、工程0 から。
- 調査: recon.md（同じフォルダ）。行番号は基準 origin/main 0a8266c。コードの写しは /tmp/CC報告ファイル/session-relay/r3/code.txt・code2.txt。

## 1 目的（PO の言葉は recon.md の冒頭）
- A（不具合）: アプリで名前を付けて開いたセッションが、Claude が立ち上がった後も、その名前のまま一覧に出る。
- B（新機能）: 一覧のボタン1つで、今のセッションに引き継ぎ書を書かせ、名前の末尾の数字を1つ増やした新しいセッションを開き、引き継ぎ書を読ませて続きに着手させ、画面を新しいセッションに切り替える。

## 2 対象と対象外
- 触る: server/sessions.ts、server/hub.ts、server/launch.ts、server/relay.ts（新規）、server/http.ts、server/config.ts、server/index.ts、src/types.ts、src/api.ts、src/components/SessionList/SessionList.tsx、src/pages/ConsolePage.tsx、src/locales/ja.json、tests/fixtures/e2e-env.ts、試験（§11）、docs/CHANGELOG.md、README.md、版の4か所。
- 触らない: 役割の command（agent-console.config.json の各役割。`-n` は足さない）、hooks/ac-statusline.mjs、server/restore.ts の保存の形、ws.ts、会話の量（%）の表示（次の版で検討）、古いセッションを自動で閉じること、resume()（再開の選択リスト）、アカウント切り替えの端末。
- i18n: このリポジトリの文言は src/locales/ja.json だけ（src/i18n.ts:3-4,19,21、en.json は無い）。新しい文言は ja.json に足す。

## 3 端末への書き込みを1つずつにする（書き込みの印）
### 変更前
- server が端末に書く所は 3 つあり、互いを見ていない: 送信の予約（hub.ts:377 貼り付け → :378 待つ → :381 Enter）、定期実行・予約の指示（hub.ts:393-401 submitText、同じ2回書き）、改名（hub.ts:215 `/rename …\r`）。2回書きの間に別の書き込みが入ると、入力が連結されて壊れる。
### 変更後
- Hub に `private readonly writing = new Set<string>()`（セッション id）と次の2つを足す。
  - `tryBeginWrite(id): boolean` … 印が無ければ付けて true、有れば false。
  - `endWrite(id): void` … 印を外す。
- 2回書きの処理は印を取ってから書き、finally で外す:
  - flushChatQueueOnce: 印は hub.ts:370 の current の判定の直後、:374 で予約を "sent" にする前に取る。取れなければ予約を "sent" にせず、chatSentGuard も立てずに戻る（次の定期取得で再び試す）。取れたら :381 の Enter（または :378-380 の早い return）まで持ち、finally で外す。
  - submitText（hub.ts:393-401）。取れなければ 200ms ごとに最大 10 秒待ち（hub.ts の定数 WRITE_WAIT_POLL_MS・WRITE_WAIT_MAX_MS）、取れなければ false。
- 1回書き（`/rename …\r`）は、印が有れば書かない:
  - applyRename の呼び出し元 requestRename（hub.ts:199-208）: 印が有れば pendingRenames に入れて "queued" を返す。applyRename（hub.ts:211-220）の中で印を取るときは、:212 の `this.pendingRenames.delete(sessionId)` より前に tryBeginWrite を呼ぶ（取れなければ delete せず "queued" を返す。返り値の型は RenameMode hub.ts:39 に広げる）。hasClaude が false の道（:218 sessions.rename、端末に書かない）は印を見ない。
  - flushPendingRenames（hub.ts:223-242）と §4 の flushInitialNames: 印が有ればその回は飛ばす。
- 印は「書く直前に同期で」見る。checkInput などの await の後、端末に書く直前（applyRename の中など、await を挟まない所）で tryBeginWrite を呼ぶ。await の前に見た結果は使わない（await の間に他の処理が印を取り得るため）。1回書きも tryBeginWrite で取り、書いたら endWrite で外す。
- 受け入れる危険: 人が端末に直接打つ文字（ws.ts:36 → sessions.write）は印を見ない（今も同じ）。印の間に人が打った文字は混ざり得る。今の改名の予約と同じ水準として受け入れる。
### 受入
- K1: 単体試験で、送信の予約の貼り付けと Enter の間（hub.ts:378 の pasteSubmitDelayMs の待ちの間）に requestRename が来ても `/rename` は書かれず予約になり、Enter の後の定期取得で1回書かれる。印が他に取られている間の flushChatQueueOnce は予約を "queued" のまま残し、印が外れた後の定期取得で送る。
- K2: 単体試験で、submitText の pasteSubmitDelayMs の待ちの間に requestRename・flushPendingRenames・flushInitialNames が走っても `/rename` を書かない（requestRename は予約になる）。待ちの作り方は tests/unit/chat-queue-ps.integration.test.ts:27-28,35-50 とその harness に倣う。
- submitText の「印が取れないとき最大 10 秒待つ」道は試験しない（時間に頼る試験になるため。コードの読みで確かめる）。

## 4 A: 初回の名前合わせ
### 変更前
- 起動直後の Claude は cwd のフォルダ名からの自動名（例 "work-06"）を持ち、hub.ts:553 で Claude 側の名前が優先されるので、アプリの名前が負ける（recon S1）。
- `-n` を使わない理由: 役割の command は役割ごとに固定の配列（agent-console.config.json:33 は `/bin/zsh -ic ccopusgo`、:42 は `claude --model sonnet`）で、セッションごとに変わる名前を渡す仕組みが無い。`/rename` は既存の改名（hub.ts:211-220）と同じ経路なので、こちらを使う。
### 変更後
- Session（sessions.ts:59-74）に `initialName?: string` を足す。
- spawnSession（sessions.ts:372-）の後、呼び出し元ごとに次のとおり入れる:
  - create()（:262）: 入れる（値は渡された名前）。
  - restore()（:320）: 次の3つを全部満たすときだけ入れる。① 入力の `manualInitialName` が true でない ② claudeSessionId を使った起動でない（:322-323 の useRestore が false）③ 結果の session.reattached が true でない（動いていた tmux へのつなぎ直しでない）。
  - resume()・createAccountLogin(): 入れない。
- restore() の入力の型に `manualInitialName?: boolean` を足す。
- Hub に `flushInitialNames()` を足し、pollAgents（hub.ts:154-160）の `await this.flushPendingRenames();`（:158）の直後で呼ぶ。各セッションについて:
  1. initialName が無い → 飛ばす。
  2. 終了している → initialName を消す。
  3. pendingRenames に同じ id がある（後から PO が改名した）→ initialName を消す。
  4. createdAt から 10 分を過ぎた → initialName を消す（送らない）。
  5. 書き込みの印が有る → この回は飛ばす。
  6. まず this.agents だけで見る（agentForSession・inputVerdict、ps は1回分の表を使う。flushPendingRenames と同じ）。Claude が見つからない・ok でない → この回は何もしない（checkInput を呼ばない）。Claude が見つかり、その name が initialName と同じ → initialName を消して終わる（書かない）。
  7. Claude が見つかり ok で、name が initialName と違うときだけ checkInput で取り直し、ok かつ hasClaude なら `/rename <initialName>\r` を1回書いて initialName を消す。
- launchAndSend（launch.ts:82-94）: restore を `manualInitialName: true` で呼び、waitReady の後に次の順で送る: `hub.sendName(id, name)` → `waitName` → waitReady → `req.stillWanted()`（false なら今と同じく not_ready）→ submitText。
  - sendName: 印を取って `/rename <name>\r` を1回書き、外して true。取れなければ書かずに false。false のときは waitName を飛ばして次へ進み、console.warn を1行出す（名前は合わないが指示は送る。開いた直後の新しいセッションで印が取られていることは通常無い）。
  - waitName: `hub.displayNames().get(id)`（hub.ts:441-443、直近の snapshot の表示名）が name になるまで、timing.namePollMs ごと・最大 timing.nameTimeoutMs 待つ。超えても次へ進む。
  - LaunchTiming（launch.ts:17）に `namePollMs`・`nameTimeoutMs` を足す。本番の既定は 3000・15000（routines.ts:50・reservations.ts:131 の既定値に足す）。
  - waitReady（launch.ts:70-79）は export する。
- routines（routines.ts:90）・reservations（reservations.ts:230）は launchAndSend を通るので、変更は launch.ts の1か所。
### 受入
- K3: 名前「テスト5」で新しいセッションを作る → Claude の入力待ちから 30 秒以内に一覧の名前が「テスト5」になり、指示を1回送った後も「テスト5」のまま（実機のみ。e2e の stub は名前を1つしか持てない、tests/fixtures/claude-stub.sh:13-15）。
- K4: 単体試験で、pendingRenames が有れば `/rename` は予約の名前で1回だけ書かれる。ok かつ hasClaude になるまで書かれない。名前が同じなら書かれず checkInput も呼ばれない。10 分で消える。
- K5: 単体試験で、restore が claudeSessionId 付き・reattached・manualInitialName のときは initialName が入らない。
- K6: 新しい試験ファイル tests/unit/launch-name.test.ts で、本物の Hub.prototype.sendName を call する偽の hub（書き込みを配列に記録する sessions.write）を使い、launchAndSend の書き込み順が「/rename <名前>\r → 指示の貼り付け → Enter」であることと、sessions.restore（偽物）の引数に manualInitialName: true があることを見る（「manualInitialName なら initialName が入らない」は K5 で見る）。既存の routines・reservations の試験の偽の hub は `sendName: () => true` のままにし、K6 には使わない。

## 5 B: 引き継ぎ
### 5-1 使える条件（server/config.ts）
- config に `relayDir?: string` と `relayHandoffTimeoutMs?: number`（既定 1800000＝30 分）を足す。`~` は expandHome（config.ts:116-120）と同じ扱い。
- relayDir が config に無いとき: 本番のポート（AGENT_CONSOLE_PORT が未設定か空）なら既定 `~/CC報告ファイル-keep/relay`。ポートを指定して起動したサーバー（自己診断・e2e）では引き継ぎを使えない（409 "relay not configured"）。e2e は tests/fixtures/e2e-env.ts（:109 からの config を書く所）で一時フォルダの relayDir を渡す。
- この判定は parseConfig（純関数）には入れない。server/relay.ts に `resolveRelayDir(config, env): string | null`（config.relayDir があればそれ。無ければ env.AGENT_CONSOLE_PORT が未設定か空のときだけ既定。式は picker-extension.ts:37-39 と同じ）を置き、index.ts が process.env で呼んで RelayManager に渡す。
### 5-2 入口（server/http.ts）
- `POST /api/sessions/:id/relay` → 202 `{ relayId }`。本文は受けない（名前・文は server が決める）。
- セッションが無い → SessionNotFoundError（404、http.ts:452-454 の既存の写像）。
- 409 は SessionConflictError で返す（http.ts:456-458。理由の文字列は括弧内）: 引き継ぎを使えない（relay not configured）／セッションが終了（session is stopped）／hasClaude でない・checkInput が ok でない（not idle）／役割が config.roles に無い・アカウント切り替え（role cannot relay）／送信の予約が残っている（chatQueueOf(id) が空でない）・名前の変更の予約が残っている（pending work）／このセッションが進行中の引き継ぎの古い側か新しい側（relay in progress）／hasCapacity が false（too many sessions）。
### 5-3 新しい名前（server/relay.ts の nextRelayName、純関数）
- 新しい名前は引き継ぎの受け付け時（202 を返す前）に1回だけ決め、RelayView の newName に入れて以後変えない（途中で古いセッションの名前が変わっても使わない）。
- 入力は今の表示名（`hub.displayNames().get(id)`、hub.ts:441-443。無ければ session.name）。最初に無害化する: 制御文字（`/[\u0000-\u001f\u007f]/g`）を除き、前後の空白を除く。空になればアプリ側の名前（session.name）を使う。
- 末尾が「MM/DD HH:mm」の形（定期実行・予約が付ける日時、launch.ts:56-62）のとき: 末尾に " 2" を付ける。例: "設計 09/15 10:30"→"設計 09/15 10:30 2"、その次は "… 3"。
- それ以外で末尾が半角数字のとき: その数字に 1 を足す。桁は元の桁数を下回らないよう 0 で埋める。例: "Agent Console2"→"Agent Console3"、"v9"→"v10"、"x009"→"x010"。
- 末尾が半角数字でないとき: "2" を付ける。例: "設計"→"設計2"。全角数字は数字として扱わない。
- 40 字（UTF-16 の長さ、launch.ts:8）を超えるときは、数字より前の部分をコードポイント単位で後ろから縮める（絵文字の途中で切らない）。
- 最後に validateName（sessions.ts:79-85）を通す。
### 5-4 引き継ぎ書の置き場所
- relayDir を 700 で作る（既にあれば mode を変えない）。1回ごとのフォルダ `<relayDir>/<YYYYMMDD-HHmmss JST>-<古いセッション id の先頭 8 字>/` を 700 で作る。中の `HANDOFF.md` を Claude に書かせる。フォルダは消さない。
### 5-5 流れ（server/relay.ts の RelayManager。進行は server 側にあり、画面を閉じても続く）
- RelayManager のコンストラクタは `(deps: { config, sessions, hub, relayDir: string | null }, now: () => Date = () => new Date(), timing: RelayTiming = 本番値)`（routines.ts:50 と同じ作法）。RelayTiming は `{ pollMs: 3000, quietMs: 60000, readyPollMs: 3000, readyTimeoutMs: 120000, namePollMs: 3000, nameTimeoutMs: 15000, handoffTimeoutMs: config.relayHandoffTimeoutMs, doneKeepMs: 600000 }`。下の手順の時間はすべてここから取る（固定値を書かない）。
- 進行の記録 RelayView: `{ relayId, oldSessionId, oldName, newName, phase, newSessionId?, reason? }`。phase は "handoff" | "launching" | "sending" | "done" | "failed"。phase が変わるたびに `hub.setRelays(list)` を呼ぶ（hub.setRestoreNotices hub.ts:193 と同じ形で、publish する）。
1. phase "handoff": 古いセッションに submitText で次の決まった文を送る（`<パス>` は 5-4 の絶対パス）。submitText が false なら failed "send_failed"。
   「このセッションの作業を次のセッションに引き継ぎます。<パス> に Markdown で引き継ぎ書を書いてください。書く項目: 目的と PO の言葉の原文／決まったこと／今の状態（作業場所・ブランチ・PR・動いている担当）／終わっていない作業と次の一手（順番つき）／注意点と守るルール／読むべきファイルのパス。書き終えたら、そのパスだけを返答してください。新しい作業は始めないでください。」
2. 3 秒ごとに見る。まず `hub.peekInput(oldId)`（§11。直近の取得結果で見る、`claude agents` を走らせない）で見て、ok のときだけ checkInput を呼んで取り直す（§4 手順6・7 と同じ作法）。下の「ok でない状態を見た」は peekInput の結果で数えてよい。次の全部で完了: HANDOFF.md が有り大きさが 0 より大きい／checkInput が今 ok／「送った後に一度 ok でない状態を見た」または「送ってから 60 秒過ぎた」（短い間に書き終えて作業中を一度も見られなかった場合の道）。許可待ちは、PO が古いセッションで許可すれば続く。relayHandoffTimeoutMs を超えたら failed "handoff_timeout"（ファイルが途中まであっても新しいセッションは開かない）。古いセッションが終了したら failed "gone"。
3. phase "launching": hasCapacity を見直す（false なら failed "full"）。`sessions.restore({ role: 古い役割, name: 新しい名前, cwd: 古い cwd, branch: 古い branch, manualInitialName: true })`。worktree は新しく作らず（sessions.ts:320-327）、claudeSessionId は渡さない（新しい会話）。例外は catch し、SessionInputError の "too many sessions" なら failed "full"、それ以外は failed "start_failed"。
4. waitReady（120 秒）。false なら failed "not_ready"（開いたセッションは残す）。
5. phase "sending": sendName → waitName → waitReady → submitText で次の文を送る（sendName が false の扱いは §4 の launchAndSend と同じ）。waitReady が false なら failed "not_ready"、submitText が false なら failed "send_failed"（どちらも開いたセッションは残す）。
   「前のセッション「<古い名前>」からの引き継ぎです。<パス> を読み、書かれた次の一手から続きに着手してください。」（<古い名前> は 5-3 の無害化を通した物）
6. phase "done"、newSessionId を記録する。古いセッションは閉じない。
- 終わった記録（done・failed）は 10 分後に消す。進行の記録はメモリだけ。
- 受け入れる限界: server を再起動すると進行中の記録は消える（tmux で古いセッションは生き残り、引き継ぎ書は書き終わるが、新しいセッションは開かれず、画面にも何も出ない）。PO はもう一度ボタンを押せる（新しいフォルダに書き直す）。
### 5-6 画面
- 型: server の Snapshot（hub.ts:61）と画面の ConsoleState（src/types.ts:45）に `relays?: RelayView[]` を足す。空のときはキーを省く（terminalNotices と同じ、hub.ts:571）。手書きの ConsoleState を使う既存の試験は変えなくてよい。
- src/api.ts に `relaySession(id)`（POST /api/sessions/:id/relay）を足す。
- 一覧の行（SessionList.tsx の閉じるボタン :150-162 の左）:
  - 引き継ぎのボタン: `s.state === "idle" && s.hasClaude` で、かつ進行中の引き継ぎ（phase が handoff・launching・sending）の古い側・新しい側のどちらでもない行だけ。Button variant="ghost" size="sm" iconOnly、アイコンは lucide-react の ArrowRightLeft、aria-label・title は t("ac.relay.open")、data-testid="relay-session"。
  - 進行中の行（古い側・新しい側の両方）: Badge variant="info" size="sm"、t("ac.relay.running")、data-testid="relay-badge"。
  - SessionList の props に `relayBusyIds: ReadonlySet<string>` と `onRelay: (id: string) => void` を足す。
- ConsolePage: relayTargetId の state を足し、ConfirmModal（:504 の閉じる確認と同じ props の形。ただし壊す操作ではないので danger は付けない）を出す。題 t("ac.relay.title")、本文 t("ac.relay.body", { name })、確定 t("ac.relay.confirm")、取消は既存と同じ。確定で relaySession を呼ぶ。409 などの失敗は既存の closeError と同じ形の Callout で出す（t("ac.relay.error")）。
- done を受けたとき、選択中が古いセッションなら新しいセッションを選ぶ（同じ relayId で1回だけ。処理した relayId を useRef の Set で持つ）。
- failed は一覧の上に Callout variant="warning"（題 t("ac.relay.failedTitle")、本文 t("ac.relay.failed.<reason>", { name: oldName })）。閉じるボタン（t("ac.relay.dismiss")）で、その relayId を画面側で隠す。
- 新しい色・余白の直値は書かない（npm run lint の scripts/check-design-governance.mjs が見る）。
- ja.json に足すキー: ac.relay.open「次のセッションへ引き継ぐ」、ac.relay.running「引き継ぎ中」、ac.relay.title「次のセッションへ引き継ぐ」、ac.relay.body「「{{name}}」に引き継ぎ書を書かせてから、名前の数字を1つ増やした新しいセッションを開いて続きを渡します。今のセッションは閉じずに残ります。」、ac.relay.confirm「引き継ぐ」、ac.relay.error「引き継ぎを始められませんでした」、ac.relay.failedTitle「引き継ぎが止まりました」、ac.relay.dismiss「閉じる」、ac.relay.failed.send_failed「「{{name}}」に文を送れませんでした」、.handoff_timeout「「{{name}}」の引き継ぎ書が時間内にできませんでした」、.gone「「{{name}}」が終了しました」、.full「セッションの数が上限のため、新しいセッションを開けませんでした」、.start_failed「新しいセッションを起動できませんでした」、.not_ready「新しいセッションが入力待ちになりませんでした（開いたセッションは残っています）」。
### 受入
- K7: 画面の単体試験で、ボタンは idle かつ hasClaude の行だけに出て、working・waiting・no-claude・stopped と、進行中の引き継ぎの両側の行には出ない。両側の行にはバッジが出る。
- K8: nextRelayName の単体試験: 5-3 の例すべて、40 字を超える名前の縮め、絵文字を途中で切らない、制御文字（ESC など）を含む名前は除いて扱う、空になればアプリ側の名前。
- K9: RelayManager の単体試験（偽の hub・sessions、作法は tests/unit/routines.test.ts:30-50）で、5-5 の順に書かれ、HANDOFF.md ができる前は launching に進まず、新しいセッションは古い cwd・branch・役割・新しい名前・manualInitialName=true で開かれ、最後の文にパスと無害化した古い名前が入る。作業中を一度も見ないまま 60 秒過ぎたら完了する。
- K10: 失敗の単体試験: 5-2 の 409 の各条件でフォルダを作らない。handoff_timeout・gone・full（hasCapacity と restore の例外の両方）・start_failed・not_ready（手順4と5）・send_failed（手順1と5）がそれぞれの reason になる。
- K11: e2e で、一時フォルダの relayDir を渡したサーバーでボタンを押すと、その一時フォルダにだけフォルダができ、stub の古いセッションに文が送られる（stub は書かないので、K11 は 409 の無い開始と送信までを見る）。relayDir を渡さないポート指定のサーバーでは 409 になる。
- K12: typecheck・lint・単体・e2e が通る。ja.json に 5-6 のキーが全部ある。
- K13: PO の目視。実際のセッションでボタンを押し、①古いセッションが引き継ぎ書を書く ②名前の数字が1つ増えた新しいセッションが開く ③新しいセッションが引き継ぎ書を読んで続きに着手する ④画面が新しいセッションに切り替わる ⑤古いセッションが残る、の5点が○。

## 6 代替案と選んだ理由
- 名前: command に `-n` を足す案は、名前をセッションごとに渡す仕組み（環境変数など）を新しく作る必要があり、役割の設定にも手が入るので採らない。
- 引き継ぎ書: 新しいセッションに古い会話を丸ごと渡す（--resume・/compact）案は、会話の量を減らす目的に合わないので採らない。
- 完了の判定: 時間だけで待つ案は書き終わる前に進む恐れがあるので、ファイル・状態・時間の3つを見る。
- 進行を画面側で行う案は、画面を閉じると止まるので server 側にする。
- 書き込みの印: 送信の予約の印 chatFlushing（hub.ts:98）を使い回す案は、意味（予約の同時実行の防止）が違うので、別の印 writing を足す。

## 7 リスクと対処
- 書き込みの許可待ち: relayDir は作業フォルダの外なので、Claude が許可を求める場合がある【未確認、工程0】。許可待ちは失敗にせず、時間切れまで待つ。
- 引き継ぎ書の中身の質はこの機能では保証しない。項目は 5-5 の決まった文で指定する。
- tmux の中での `/rename` の挙動【未確認、工程0】。
- 人が端末に直接打つ文字と server の書き込みが重なる危険は残る（§3）。
- server の再起動で進行中の引き継ぎが消える（5-5）。
- lucide-react 1.55.0 に ArrowRightLeft が有るか【未確認、工程0】。無ければ実装を止めて Opus に報告する（別のアイコンを推測で選ばない）。

## 8 戻し方
- 前の版のタグで update-when-idle を実行する。保存の形は変えない（relays はメモリだけ。relayDir のファイルは残っても害が無い）。

## 9 維持する仕組み
- K1・K2・K4〜K12 の試験を CI で毎回回す。

## 10 工程
- 工程0（Sonnet、コードは変えない）:
  (a) 本番（127.0.0.1:4319）には操作せず、ポートを指定して起動した試験用のアプリから tmux の中で開いたセッションで、入力待ちの直後に `/rename 名前` を送ると名前が変わり、次の指示の後も保たれるかを見る。
  (b) 同じセッションで「`~/CC報告ファイル-keep/relay-stage0/HANDOFF.md` に1行書いて」と頼み、Claude が許可を求めるかを見る（本番の既定の場所の兄弟フォルダ。作ったフォルダは消さずに残し、報告に書く）。
  (c) `ls node_modules/lucide-react/dist/esm/icons/ | grep arrow-right-left` とその export の有無。
  生出力は /tmp/CC報告ファイル/session-relay/stage0/ に置く。
- 工程1（server）: §3・§4・§5-1〜5-5 と単体試験（K1・K2・K4〜K6・K8〜K10）。
- 工程2（画面）: §5-6、ja.json、画面試験（K7）、e2e（K11）。
- 工程3: 版を上げる（package.json:3、package-lock.json:3,9、extension/manifest.json:4）、docs/CHANGELOG.md（1版1行）、README.md、PR。版はマージ時点の次の空きのマイナー版。

## 11 実装の約束（Sonnet 向け）
- 触るファイルと変更:
  - server/sessions.ts: Session（:59-74）に `initialName?: string`。restore() の入力に `manualInitialName?: boolean`。create()・restore() で §4 の条件で initialName を入れる。
  - server/hub.ts: `writing` の Set と tryBeginWrite・endWrite（§3）。flushChatQueue・submitText・requestRename・flushPendingRenames に印を入れる（§3）。flushInitialNames を pollAgents の :158（flushPendingRenames）の直後に呼ぶ（§4）。sendName。Snapshot（:61）に `relays?`、setRelays、snapshot の返り値（:571）に relays を足す。chatQueueOf・pendingRenames を relay の 409 判定に使えるよう、`hasPendingWork(id): boolean`（予約の送信か改名の予約が残っていれば true）を足す。`peekInput(id): Promise<InputVerdict>` を足す（readProcessTable が async のため Promise。this.agents と readProcessTable で inputVerdict を作る。fetchAgents は走らせない。flushPendingRenames hub.ts:233 と同じ式。this.agents が null なら ok でない。5-5 手順2 で null を「ok でない状態を見た」に数えても、完了には HANDOFF.md と checkInput の ok が要るので先へ進みすぎない）。
  - server/launch.ts: waitReady と waitName を export。launchAndSend の restore に manualInitialName: true、§4 の送る順。waitName を足す。
  - server/relay.ts（新規）: nextRelayName、RelayManager（§5-2〜5-5）。RelayManager が waitReady・waitName を使うときは、RelayTiming から `{ pollMs: readyPollMs, timeoutMs: readyTimeoutMs, namePollMs, nameTimeoutMs }` を写した LaunchTiming（launch.ts:17 の型）を作って渡す（launch.ts の既定値を使わない）。
  - server/config.ts: relayDir・relayHandoffTimeoutMs（§5-1）。
  - server/index.ts: RelayManager を作って http の deps に渡す。
  - server/http.ts: `POST /api/sessions/:id/relay`。
  - src/types.ts: RelayView、ConsoleState の relays?。
  - src/api.ts: relaySession。
  - src/components/SessionList/SessionList.tsx・src/pages/ConsolePage.tsx: §5-6。
  - src/locales/ja.json: §5-6 のキー。
  - tests/fixtures/e2e-env.ts: relayDir（一時フォルダ）。
- 足す試験: tests/unit/relay.test.ts（K8〜K10。偽の hub に peekInput を足す）、tests/unit/hub-write-lock.test.ts（K1・K2）、tests/unit/initial-name.test.ts（K4・K5）、tests/unit/launch-name.test.ts（K6。偽の hub は下の「既存の試験への最小の変更」と同じ writing・tryBeginWrite・endWrite の delegate を持つ）、SessionList の画面試験（K7）、tests/e2e の引き継ぎ（K11）。
- 既存の試験への最小の変更（これ以外は変えない）:
  - tests/unit/routines.test.ts:27・reservations.test.ts:15 の TIMING に `namePollMs: 5, nameTimeoutMs: 20` を足す。
  - 偽の hub（routines.test.ts:34、reservations.test.ts:41）に `sendName: () => true`、`displayNames: () => new Map()`、`writing: new Set<string>()`、`tryBeginWrite: (id) => Hub.prototype.tryBeginWrite.call(hub, id)`、`endWrite: (id) => Hub.prototype.endWrite.call(hub, id)` を足す（hub はその偽の hub 自身。Hub.prototype.submitText.call の中の this.tryBeginWrite・this.endWrite がこれを呼ぶ）。
  - Hub の tryBeginWrite・endWrite は private にしない（tsconfig.server.json:16 で tests も typecheck されるため、private だと試験から call できない）。Hub の中では this.writing だけを見る。
- 触らない: §2 の「触らない」すべて。既存の試験の期待値は、§3 の印のために書き込みの順が変わる所以外は変えない（変えたら PR 本文に理由を書く）。
- 迷ったら止まって Opus に報告する（推測で決めない）。

## 15 第4版の審査への対応（/tmp/CC報告ファイル/session-relay/review-design4/review.md）
- 第4版の改の審査（review-design5）は APPROVE。低 N25（Promise）・N26（null）は §11 hub.ts に記載。
- N21（this.agents は private）→ 案(a)を採る: Hub に peekInput を足す（§11 hub.ts）、5-5 手順2、K9 の偽の hub。理由: 引き継ぎ書を待つ間は最大 30 分続き、3 秒ごとに `claude agents` を走らせ続けると負荷が大きいため。
- F8（:27・:15）→ §11。F9（:17）→ §4・§11。F10（題・状態）→ 冒頭。N22（K6 の観測対象・偽の hub の delegate）→ K6、§11 足す試験。N23（waitName の export）→ §11 launch.ts。N24（delete の前に印）→ §3。

## 14 第3版の審査への対応（/tmp/CC報告ファイル/session-relay/review-design3/review.md）
- N13（偽の hub の tryBeginWrite・endWrite、private にしない）→ §11 既存の試験への最小の変更。
- N14（印は書く直前に同期で見る・K1/K2 の形）→ §3、K1・K2。
- N15（K6 の確かめ方）→ K6（新しい試験ファイルで本物の sendName）、§11 足す試験。
- F7（:374）→ §3。F5'（:158）→ §11。N16（10 秒待ちは試験しない）→ §3 受入。N17（LaunchTiming を写す）→ §11 relay.ts。N18（手順2 はまず this.agents）→ 5-5 手順2。N19（newName は受け付け時に固定）→ 5-3。N20 → 記録のみ。

## 13 第2版の審査への対応（/tmp/CC報告ファイル/session-relay/review-design2/review.md）
- N1（印の位置）→ §3 flushChatQueueOnce、K1。
- N2（waitName の時間・名前の読み口・偽の hub）→ §4 launchAndSend、§11 既存の試験への最小の変更。
- N3（偽の hub に writing）→ §11。submitText の待ちは印が取られているときだけ起きるので、既存の試験では待たない。
- N4（RelayManager の now・timing）→ 5-5 の先頭。
- N5（checkInput の呼びすぎ）→ §4 手順6・7、K4。
- N6（無いときは 404）→ 5-2。
- N7（stillWanted の位置）→ §4 launchAndSend。N8（sendName が false）→ §4。N9（danger）→ 5-6。N10（30 分の直書き）→ ja.json の文。N11（表示名の読み口）→ 5-3。N12（env の判定の置き場）→ 5-1 resolveRelayDir。F5 → :158。F6 → :109。
- PO 判断とされた3点（日時付き名前の " 2"、再起動で進行が消える、人の打鍵との混在）は、Opus の設計判断として 5-3・5-5・§3/§7 に書き、PO への実装 y/n の時にまとめて伝える。

## 12 第1版の審査への対応
- F1・R4（en.json が無い）→ §2 の i18n、K12。
- F2（-n を使わない理由）→ §4 の変更前、§6。
- F3（Snapshot と ConsoleState）→ §5-6 の型、§11。
- F4（CHANGELOG の場所）→ §10 工程3。
- R1（書き込みの割り込み）→ §3（印）、5-2 の 409 に予約の残り、§7 に人の打鍵を受け入れる危険として記載。
- R2（起動時の復元）→ §4 の restore() の条件、K5。
- R3-a〜d → 5-5 の各手順の reason、手順2 の 60 秒の道、5-2 の relay in progress、5-6 の両側のバッジ、K9・K10。
- R3-e（再起動）→ 5-5 の受け入れる限界、§7。
- R3-f（日時付きの名前）→ 5-3 の " 2" の規則、K8。
- R5（名前の無害化）→ 5-3、K8。
- R6（工程0 の書き込み先、試験用サーバー）→ §10 工程0 (b)、5-1（ポート指定のサーバーは relayDir を渡さないと使えない）、5-4 で relayDir も 700。
- R7（実装者向けの粒度）→ §11。
- 未確認3件 → §7・§10 工程0。

## 16 工程0の結果（2026-10-14、Sonnet 確認・Opus 判断、生出力 /tmp/CC報告ファイル/session-relay/stage0/）
- (c) lucide-react 1.55.0 に ArrowRightLeft あり（c-ls.txt・c-types.txt）。設計どおり使う。
- (a) tmux 内の claude v2.1.299 で、入力待ちの直後に `/rename relay-stage0-test` を送ると「Session renamed to」が出て、次の指示の後も名前が残った（a-03・a-04、画面表示で確認）。§4 の方式のまま進める。
- (b) auto mode の下では、作業フォルダの外の HANDOFF.md への書き込みで許可を求められなかった（b-01）。auto mode でない場合は未確認。§7 のとおり、許可待ちは失敗にせず時間切れまで待つ設計で両方に対応できるので、設計は変えない。
