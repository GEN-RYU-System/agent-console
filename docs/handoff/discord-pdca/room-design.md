---
mode: handoff
---

# design: 件のセッションを本体ごと部屋に入れる（discord-pdca 第25版の追補）

> この文書は何か：Discord の不具合の件を扱う AI のセッションを、AI の本体（claude）と手伝い役（git など）ごと、macOS の囲い（部屋）の中で起動し、外への通信を受付（門番の中継）1か所に絞る設計です。親の設計 `design.md` の §4-5 の囲いの部分を置き換えます。親のほかの節（受け口・予約・3回で止まる・全停止など）は変えません。

- 親: `docs/handoff/discord-pdca/design.md`。この文書が親の行を指すときは、**第24版（agent-console origin/main 50de8d5）の行番号**で書く（第25版の行を足したので、作業中の親では1つずつ後ろにずれる）。掛かる行: `:353`（使えない状態の扱い）・`:356`（読み取りの拒否の書き方）・`:364`（Bash の読み取り）・`:377`（権限の規則）・`:383`（設定の置き場）・`:384`（起動の確かめ）・`:385`（起動の形）・`:387`（起動コマンド）と、§9 の K11（`:608`）・K17（`:614`）。
- 関係する ADR（Sales Anchor）: ADR-1039（件のセッションの囲い。許可した行き先へは送れる弱さを書く）・ADR-1034 R4（見張りを弱めない）・ADR-113（handoff の型）。衝突は無い。外への通信の許可先は、§4-4 の (a) が成り立つかぎり Bash の子に対して増やさない。成り立たないときは §7 の分岐で PO に聞く。
- 状態: 設計案（Opus 作成）・第5版・設計審査済み（第4版が APPROVE。条件の直しを第5版で入れた）。PO の実装の承認はまだ。実装は §7 の段階 P の結果で分岐を1つに決め、この文書を直して審査を通してから、カードで渡す。

## 1. 目的と成功条件（KGI）

目的: 件のセッションの中で動くもの（AI の本体・手伝い役・AI が打つ命令・見張りのフック）が、どれも同じ部屋の中で動き、今の Bash の囲いが塞いでいる物を本体にも同じだけ塞ぐこと。便2b-3b の run1 で、AI の本体が自分で打つ git が4回、囲いの外で動いた（K17 の不合格。カード PR #86 の「試験を止めた記録」）。これを、名前の一覧で1つずつ追う形ではなく、部屋ごと閉じる形で無くす。

| 基準 | 検証方法 |
|---|---|
| G1 部屋の外で動く物が無い | 件のセッション（対話の形・tmux）を1回動かす。その間、`sandbox-exec` の pid の子孫の全部のプロセス（git に限らない）を 0.05 秒ごとに拾い、各々に `sandbox_check(pid,"file-write-create",1,<部屋の外の既存ファイル>)` を掛けて全部 1。加えて、W・case-home を作業の置き場か引数に持つプロセスのうち、`sandbox-exec` の子孫でない物が 0 件。除くのは、agent-console サーバーの pid と、親 pid がサーバーの pid であるプロセス（写しの確かめ `checkCaseClone` の git・gh など。`sessions.ts:335`）だけで、除いた物は pid・命令・親 pid を記録に残す。同じ回で、部屋なしの対照の git が 0 になることを確かめる |
| G2 外への通信は受付だけ | 受付の記録に、通した行き先と断った行き先が残る。部屋の中から受付を通さない接続（直接・IP・`--noproxy`・DNS・生のソケット）が全部失敗（親 K17 の7つの道を本体の起動の形で1回ずつ）。Bash の `curl` から `api.anthropic.com` が断られる（§4-4 の (a) のとき。(b) のときは通ったことを記録し、PO の答えの記録と照らす） |
| G3 書き込みの拒否が本体にも効く | 親 `:383` の書き込みの拒否の一覧・保護の道（§4-1 の 3。一番上と入れ子の `W/sub/.git/hooks/x`・`W/sub/.claude/settings.json` の両方）・ホームの下（`~/.claude/settings.json`・`~/.claude/agents/`・`~/.claude.json`・`~/.zshrc`）・case-home の中の本体が読む設定（§4-2）・件の設定（`D/cases/<id>/settings.json`・`case.json`）・活動の記録（`D/activity/`）への、Bash からの書き込みが全部拒否。回り道（`mv W/.git W/g` → `W/g/hooks/x` に書く → 戻す）が最初の `mv` で拒否。ハードリンクの回り道（`ln <W の外の既存ファイル> W/x` のあと `W/x` に書く）が拒否。大文字小文字を変えた保護の道（`W/sub/.Claude/agents/x`・`W/.GIT/hooks/x`）への書き込みが拒否。W の中で `rm`・`mv` が通る |
| G4 読めない物が読めない | Bash の `cat`・`python3` で、`~/.ssh`・`~/kb/01-private`・本店 M・ほかの件の R と T・ほかの件の `D/cases/<別の id>/` と `D/case-home/<別の id>/`・`D/open-sessions.json`・`D/boards/`・`D/bin/ac-board.mjs`・`/private/tmp/CC報告ファイル` のほかの置き場・`os.tmpdir()` の下・親 `:356` の秘密の置き場が全部拒否。Keychain の読み出しは §4-3 の5つの道を全部試し、shingo-ops の項目はどの道でも出ない |
| G5 普段の仕事が通る | 部屋の中で、commit（lint-staged が動く形）・stash の push と pop・push・rebase・PR 作成・`npm test` が通る。`ac-case` の呼び出しは便3 の受入に入れる（今は無い）。部屋の中で見張りが動き、拒むべき Edit（W の外）を拒み、許すべき Edit（W の中）が通る。部屋の中で、担当（Agent）が打つ dataDir の命令を ac-routine-guard が拒み、`kill` でサーバーの番号を止める命令を server-kill-guard が拒む。活動の出来事（§4-6）が画面のその件に出る |
| G6 部屋が無ければ始まらない | `room.sb` が無い・受付が待ち受けていない・case-home が無い・macOS の版が記録と違う（§9）の4つを1つずつ作り、どれでもセッションが開かない（503）。テストで1回ずつ |
| G7 部屋の外で動かす道が塞がる | 部屋の中から次が全部失敗: `osascript`（Terminal への命令）・`open`（アプリと `.command`）・`launchctl submit`・`launchctl bootstrap`・`kill <サーバーの pid>`・`ps eww` でのほかのプロセスの環境変数の読み取り・`tmux -L agent-console` への接続・`SSH_AUTH_SOCK` への接続・`pbpaste` |

## 2. 今の作り（変更前）と、変えたあと

### 2-1 変更前（事実）

- 【事実】件の設定は `server/case-sandbox.ts` の `buildCaseSettings`（:136-178）が作り、`writeCaseFiles`（:192-228）が `<dataDir>/cases/<id>/settings.json` と `case.json` に書く。呼び出しは `server/sessions.ts:337` の1か所。どちらにも鍵の値は入らない（道・一覧・許可先だけ。:145-177・:205）。
- 【事実】Bash の囲いの一覧は5つ: 書き込みの拒否 `CASE_DENY_WRITE`（:66-79）・道具の読み取りの拒否 `CASE_DENY_READ`（:81-91）・囲いの読み取りの拒否 `CASE_DENY_READ_SANDBOX`（:94-102。ホーム H・`/private/tmp/CC報告ファイル`・`/private/tmp/claude-<uid>`・`os.tmpdir()`・本店 M・T の親を丸ごと塞ぎ、`CASE_DENY_READ` を後ろに足す）・開け直し `CASE_ALLOW_READ`（:116-129）・書ける場所 `CASE_ALLOW_WRITE`（:104）。行き先は `CASE_ALLOWED_DOMAINS`（:131）。mach-lookup は `com.apple.SecurityServer`・`com.apple.securityd*` の2つ（:167）。`allowLocalBinding: true`（:166）・`enableWeakerNetworkIsolation: true`（:162）。
- 【事実】claude は `ops/shell/ccdiscord.zsh` の `ccdiscordcase`（:4-52。起動の引数は :47、最後は :51 の `command "$claude_bin" …` で exec ではない）から、tmux（`sessions.ts:598` の `newSession`）か node-pty（`sessions.ts:609`）で起動する。`sandbox-exec` で包んでいない。囲いは Claude Code の Bash の囲いだけ。
- 【事実】本体の中で動く本体以外の物: 本体は `--settings "$AC_CASE_SETTINGS"`（`ccdiscord.zsh:47`）で件の settings.json を読む。見張り（PreToolUse の先頭。`onFailure: "block"`。`case-sandbox.ts:142`）は node で `ops/case/case-guard.mjs`（置き場は `sessions.ts:220` の `caseGuardPath`）を動かし、`case.json` を読む（`case-guard.mjs:116`）。活動のフックは `<dataDir>/hooks/activity-hook.mjs` で、`<dataDir>/activity/events-YYYYMMDD.jsonl` に追記する（`hooks/activity-hook.mjs` の `appendRecord`）。サーバーはこのファイルを読むだけで、活動を HTTP で受ける入口は無い（`server/activity-routes.ts:5` は読み出しの GET だけ）。dataDir の既定は `~/Library/Application Support/agent-console`（`config.ts:41`）で、ホームの下。
- 【事実】件の設定のフックは、記録用10個のほかに同期の見張り3種を全部含む（`buildCaseSettings` が `addHandlers({}, …)` で `HOOK_SPECS` を丸ごと入れる。`case-sandbox.ts:139`、`server/activity-hooks.ts:53-72`。置き場は `D/hooks/<名>`。`specHookPath` :91-93）。調べた記録は /private/tmp/CC報告ファイル/discord-pdca-bin2/129-recon-guards/out.txt。
  - `ac-routine-guard.mjs`: 担当（agent_id あり）が ac-routine・合言葉・dataDir に触る命令を拒む。読むのは標準入力と自分の道（realpath）だけ。読めない入力は通す（`hooks/ac-routine-guard.mjs:7`・:43-53）。
  - `server-kill-guard.mjs`: 本番のサーバーを名前や番号で止める命令を拒む。読むのは標準入力と自分の道だけ（`hooks/server-kill-guard.mjs:1-8`・:169-179）。
  - `board-guard.mjs`（Stop）: 作戦ボードの書き忘れを1回だけ知らせる。読む物は `D/open-sessions.json`（全セッションの名前・作業の置き場・枝・会話の番号。`server/session-store.ts:15-23`）・`D/bin/ac-board.mjs`（読み込んで使う）・`D/boards/<番号>.json`・会話の記録（transcript）。書く物は `D/board-guard/<番号>` と `D/board-guard/errors.log`。どこで失敗しても終了コード 0 で止めない（`hooks/board-guard.mjs:3`・:98-121・:131-145）。
  - ボードを書く `ac-board.mjs write` は、Bash から `D/boards/<番号>.json` に直接書く。鍵は使わない（`hooks/ac-board.mjs:3`・:121-155・:188-202）。今の件の設定の書ける場所は W・R・T だけ（`case-sandbox.ts:104`）なので、【事実】今の件のセッションは Bash からボードを書けない（書ける場所の一覧に D が無い）。
- 【事実】Claude Code の公式資料は、囲いが掛かるのは Bash の命令だけと書き、全体を隔てるにはコンテナ・VM の比較へ案内している（写し: /private/tmp/CC報告ファイル/discord-pdca-bin2/81-recon2b3/doc-sandboxing.md:20、doc-permission-modes.md:56・:663）。
- 【事実】本体の git は絶対パス `/Library/Developer/CommandLineTools/usr/bin/git` で呼ばれる（/private/tmp/CC報告ファイル/discord-pdca-bin2/124-room-proxy/ の T3）。`PATH` の差し替えでは捕まえられない。`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`・`includeGitInstructions` は会話の始めの git の情報を外すだけで、本体の git 全部を止める設定は資料に無い。
- 【事実】srt（@anthropic-ai/sandbox-runtime 0.0.81。写しは 124 の `srt-pkg/package/dist/sandbox/`。以下 `msu.js` は `macos-sandbox-utils.js`、`su.js` は `sandbox-utils.js`）の部屋の作り:
  - 土台が `(deny default)`（`msu.js:756`）。signal と process-info は同じ囲いの中だけ（:764-765）。mach-lookup は名前を挙げた物だけ（:772-792。`com.apple.securityd.xpc` は :785、`trustd.agent` は weaker のときだけ。条件 :789・規則 :792）。AppleEvents と lsopen は既定で切る（:797-805）。sysctl・`com.apple.SecurityServer`（:907）・/dev の ioctl（:909-922）が後ろに続く。
  - 読み取りは「全部許す → 拒否 → 開け直し → 開け直しに入れ子の拒否を再掲（`lateReadDenyFilters`）」（:639-651）。注記「後ろに勝つ（last-match-wins）」は :648-649 と :683。注記「開け直しの塊のあとには拒否だけを足す。`(allow file-read* …)` の層を足すと、上の拒否を全部見直す必要がある（REVIEW INVARIANT）」は :628-632。ディレクトリの `file-read-metadata` の許可（:666-667。realpath が塞いだ道をたどれるように）。移動の塞ぎ（関数は :585-609、呼び出しは :670）。書ける場所への `file-write-unlink`・`file-write-create` の開け直し（:671-690。注記「個別の操作の拒否は、後ろの `allow file-write*` で上書きされない」は :675-676）。書ける場所の中の読み取りの拒否の道の移動の塞ぎを最後に置く（:1009-1020）。端末は `allowPty` のとき `/dev/ptmx` と `^/dev/ttys` 全部（:1021-1034）。AppleEvents と lsopen は `allowAppleEvents` のときだけの塊（:795-807）。利用者が足す mach-lookup は `*` で終わると前方一致になる（:808-815）。`allowLocalBinding` のときは bind と inbound が `*:*`、outbound が `localhost:*`（:951-954）。
  - 保護の道は作業の置き場の一番上と入れ子の両方（`msu.js:22-46` の `macGetMandatoryDenyEntries`。危ないファイル `su.js:12-22`・危ない置き場 `su.js:27` と `getDangerousDirectories`（:33-39）・`.git/hooks`・`.git/config` を、そのままの名前と `**/<名>`・`**/<名>/**` で）。比べる前に小文字にそろえる関数がある（`su.js:41-50`）。【未確認】macOS の部屋の規則で、大文字小文字の違う道（`.Claude/agents` など）が拒否に当たるか。
- 【事実】Keychain の測りの記録: 親第24版 `:736`（0-21）は、`~/Library/Keychains` を開けたままだと python から `security` で shingo-ops の項目が取り出せた（終了コード 0）、Keychains の読み取りの拒否を足すと取り出せなかった（44）。`:737`（0-22）は gh の読み取りが通ることだけを確かめ、ほかの道は【未確認】。123 の 06-keychain は、SecurityServer の mach-lookup を塞ぐと `security` が rc=44 で失敗した（部屋なしは rc=0）。
- 【未確認】Claude Code の Bash の囲いが srt と同じ部屋の作りを使っているか。段階 P の P0 で、件のセッションの Bash の中から実際に掛かっている部屋の規則を取り出せるかを試し、取り出せたら srt の出力と比べる（取り出せなければ「同じ」とは書かない）。

### 2-2 変えたあと

```
agent-console サーバー（部屋の外）
 ├─ 受付（中継。127.0.0.1:<固定の番号>。許可した行き先への CONNECT だけ通す）
 ├─ 活動の受け口（localhost。接続元の pid からどの件かを決めて受け、今の活動の記録のファイルに書く）
 └─ 件のセッションを開く
      /usr/bin/sandbox-exec -f <dataDir>/cases/<id>/room.sb -D TTY=<端末> claude …（ccdiscordcase の最後で exec）
        └─ 部屋（Seatbelt。土台は全部拒否）。claude 本体・見張り・手伝い役・Bash の子が全部この中
             ・書ける場所: W・R・T と、case-home の中の本体が書く物（§4-2）だけ
             ・読める場所: 今の Bash の囲いと同じ（ホームを丸ごと塞いで開け直す）＋名前を挙げた物（§4-1 の表）
             ・つながれる先: 受付の番号と agent-console の番号（ac-case・活動の受け口）の2つだけ
             ・ほかのプロセスへの signal・process-info・AppleEvents・lsopen は部屋の中だけ／切る
```

- Claude Code の Bash の囲いは切る（`sandbox.enabled: false`）。【事実】部屋の中では Claude Code の Bash の囲いが立ち上がらない（入れ子で `sandbox_apply: Operation not permitted`・rc=71。/private/tmp/CC報告ファイル/discord-pdca-bin2/123-seatbelt-recon/ の 04c）。切ると、外の部屋だけで Bash の子の書き込みが拒まれた（同 04c2）。
- 道具（Read・Edit・Write）の許可と拒否（`permissions`）・見張りのフック・`--restricted` は今のまま残す（2重の1枚目）。囲いの拒否は部屋が受け持つ（2枚目）。

## 3. 選んだ形と、ほかの案

| 案 | 中身 | 判断 |
|---|---|---|
| A 自前の部屋＋受付（採る） | `case-sandbox.ts` が Seatbelt の設定を作る。土台・既定の許可・移動の塞ぎ・保護の道の形は srt の作り（§2-1）を出典つきで写す。サーバーに小さな受付を置く | 採る。足す依存が無い。一覧の正本は今の5つのまま。本体と Bash の子を受付で見分ける (a)（§4-4）は自前の受付でしか作れない。【事実】試しで、本体ごと入れて動くこと・子に引き継がれること・受付だけに絞れることを確かめた（124 の T1〜T3）。ただしその部屋は全部許しの土台に拒否を足した形（124 の R1.sb:1-2）で、【未確認】全部拒否の土台とホームを丸ごと塞いだ部屋で動くかは P2 で確かめる |
| B srt を入れて claude を包む | srt の CLI の中で claude を起動する | 今は採らない。【事実】0.0.81・2026-10-20 公開・「beta research preview」。README に claude 本体を中に入れる使い方の記載が無い。srt の受付は行き先の名前で絞るだけで、本体と子を見分けられない。依存を足すには architect の審査が要る |
| C コンテナ・VM | 公式資料が案内する形 | 今は採らない。Mac の上で claude のログイン・git・gh・件の写しをコンテナに持ち込む作りが大きい。A が段階 P の止める条件（§7）に当たったときの次の候補 |
| D 本体の git の形を一覧で認める（第8版の手順書） | git の引数を5つの条件で照らす | やめる。絶対パスで呼ばれ、引数の形が増えるたびに追う形になる（run1 で4回漏れた） |
| E 本体の git は外のままと認める | — | やめる。K17 の不合格を受け入れることになる |

- srt から写す部分の扱い: srt は Apache-2.0。写した規則の上に、出典（パッケージ名・版・ファイル・行）を注記で書く。写したあとは srt の版に合わせて自動で変わらない。srt の新しい版の差分を見るのは §9 の点検。

## 4. 作り（How）

### 4-1 部屋の設定（room.sb）を作る関数

- 置き場: 新しい純粋な関数 `buildCaseRoomProfile`（`server/case-sandbox.ts`）。入力は今の `CaseParams`（W・R・T・M・D・H・GH など）と、受付と agent-console の番号、case-home の道、見張りの台本の道。出力は文字列。`writeCaseFiles` が `<dataDir>/cases/<id>/room.sb` に書く。
- 正本: 今の5つの一覧と `CASE_ALLOWED_DOMAINS` を使い、部屋のための別の一覧を作らない。部屋だけで足すのは次の5つの新しい定数で、どれも `case-sandbox.ts` に1つずつ置く:
  - `CASE_ROOM_BASE`: srt から写す土台と既定の許可（`msu.js:753-922` のうち mach-lookup を除いた物）。
  - `CASE_ROOM_MACH`: mach-lookup の名前の一覧。名前を完全に書き、前方一致（`*`）は使わない。srt の :772-792・:907 の一覧から始め、升1・升3（§4-3）では `com.apple.SecurityServer` と `com.apple.securityd.xpc` を外す。`com.apple.trustd.agent` は今の設定が `enableWeakerNetworkIsolation: true` なので同じに足す（gh の TLS に要る。`msu.js:789`）。P2 で足した物は理由と一緒に表で残す。
  - `CASE_ROOM_READ_NAMED`: 読み取りで名前を挙げて開ける物（下の表）。
  - `CASE_PROTECTED_WRITE`: 保護の道（下の 3）。
  - `CASE_MAIN_ONLY_DOMAINS = ["api.anthropic.com"]`: 受付が本体だけに通す行き先（§4-4）。
  受付の通す行き先は `CASE_ALLOWED_DOMAINS` からローカルの2つを除いた物と `CASE_MAIN_ONLY_DOMAINS`。
- 部屋の中で動く本体以外の物と、読み書きの扱い（§2-1 の事実から決まる）:

| 物 | 置き場 | 読む | 書く | 理由と弱さ |
|---|---|---|---|---|
| 件の設定 | `D/cases/<id>/settings.json` | 許す（ファイル1つの名前で） | 拒否 | 本体が `--settings` で読む。中身は道と一覧だけで鍵は入らない（§2-1）。Bash の子からも読めるようになるが、読めるのは自分の件の分だけ |
| 見張りの一覧 | `D/cases/<id>/case.json` | 許す（ファイル1つ） | 拒否 | 見張りが読む。中身は道と一覧だけ。同上 |
| 部屋の設定 | `D/cases/<id>/room.sb` | 拒否 | 拒否 | `sandbox-exec` が部屋に入る前に読むので、中から読める必要が無い |
| 見張りの台本 | サーバーの版の置き場の `ops/case/case-guard.mjs` | 許す（ファイル1つ） | 拒否 | 見張りを node で動かすのに要る。中身は版の置き場の公開の台本 |
| 活動のフック | `D/hooks/activity-hook.mjs` | 許す（ファイル1つ） | 拒否 | フックを動かすのに要る |
| 担当の見張り | `D/hooks/ac-routine-guard.mjs` | 許す（ファイル1つ） | 拒否 | 件のセッションも担当（Agent）を使えるので要る。読むのは標準入力と自分の道だけ（§2-1） |
| 停止の見張り | `D/hooks/server-kill-guard.mjs` | 許す（ファイル1つ） | 拒否 | 同上 |
| ボードの見張り | `D/hooks/board-guard.mjs` と、それが触る `D/open-sessions.json`・`D/bin/ac-board.mjs`・`D/boards/`・`D/board-guard/` | 拒否 | 拒否 | 件の設定から外す（下の「ボードの見張りの扱い」）。開けると全セッションの一覧が部屋から見え、ボードは鍵なしで書けるので、ほかのセッションのボードを書けてしまう |
| 活動の記録 | `D/activity/` | 拒否 | 拒否 | 件のフックはファイルに書かず、サーバーの活動の受け口へ送る（§4-6）。共有の記録に Bash の子が偽の行を書けないように |
| 件の置き場 | `D/case-home/<id>/`（§4-2） | 許す（その件の置き場の中だけ） | 本体が書く物の名前だけ許す（§4-2） | 本体の会話の記録・設定の置き場。ほかの件の `case-home` は読めない（G4） |
| 件の命令 | ac-case（親第24版 `:578` の便3 で `hooks/ac-case.mjs` を新しく作る。【事実】今は無い） | この便では開けない。便3 で、置き場のファイル1つだけを開ける形で足す | 拒否 | `D/bin`・`D/hooks` を丸ごとは開けない（`ac-board.mjs` が入っている） |
| node | `caseNodeHome`（`case-sandbox.ts:107-113`） | 許す（今の `CASE_ALLOW_READ` のまま） | 拒否 | 今と同じ |
| claude | `claude_bin`（`ccdiscord.zsh:5`。既定は `claude`）。【事実】`~/.local/bin/claude` は `~/.local/share/claude/versions/2.1.311` へのリンク（129 の記録） | リンクは metadata だけ、先のファイルは読み取りと実行を許す（ファイル1つずつ。サーバーが件の作成のときに絶対の道を realpath で解いて room.sb に書き、同じ道を `AC_CLAUDE_BIN` で起動関数に渡す。PATH で探させない） | 拒否（`versions/` の中も） | 本体を動かすのに要る。本体の自動の入れ替えで先が変わると、次の起動で部屋の道と合わず起動が落ちる（安全側）。【未確認】本体が `versions/` に書こうとして止まるか。P2 で見る。ホーム丸ごと・`~/.claude` は止める条件 |
| 件の鍵 | 親 `:242` の `dataDir/case-token`（【事実】実装はまだ無い） | この便では開けない。【事実】今の Bash の囲いでも読めない（H を塞ぎ、D から開け直すのは GH だけ。`case-sandbox.ts:95`・:121）。便3 で開けると今より広がる（親 `:356` の予定の弱さ）ので、便3 の審査で決める | 拒否 | ac-case の名乗りに使う。活動の受け口は使わない（§4-6） |

- 部屋の外で読む物は表に入れない: `ccdiscordcase` が起動の前に読む指示のファイル（`ccdiscord.zsh:7-8`・:43-44）と gh の鍵（:29-33）は、`sandbox-exec` に入る前に読み終わる。
- ボードの見張りの扱い: 【事実】今の件のセッションは、ボードの見張りに1回止められても、Bash から `D/boards/` に書けない（§2-1。書ける場所に D が無い）。見張りは1回だけ止めて2回目は通す（`board-guard.mjs` の印）。つまり今も、件のセッションでは知らせを受けても応えられない。部屋の中では `D/open-sessions.json` を読めないので、黙って素通りになる。そこで件の設定（`buildCaseSettings`）だけ、`HOOK_SPECS` から board-guard を除いて入れる（ほかの役割は今のまま）。これは安全の見張りではなく書き忘れの知らせだが、見張りを1つ外す変更なので、親 `:385` のとおり PO に1件確かめる（§7）。外さない答えなら、件用に `D/open-sessions.json` を開ける形は採らず、止めて PO に戻す。
- 見張りが部屋の中で黙って効かなくなることへの対処: case-guard は読めなければ止める（`onFailure: "block"`）。ac-routine-guard と server-kill-guard は読めないと通す作りなので、G5 で「部屋の中で各見張りが拒むべき命令を拒む」を1回ずつ確かめ、落ちたら件を開かない（P2 の止める条件）。vitest で、件の設定のフックの一覧が `HOOK_SPECS` から board-guard を除いた物と一致し、各見張りの道が `CASE_ROOM_READ_NAMED` に入っていることを確かめる。

- 規則の順（【事実】Seatbelt は同じ細かさなら後ろの規則が勝つ。`msu.js:648-649`。ただし個別の操作の拒否は後ろの `file-write*` の許可で上書きされない。:675-676。どちらが勝つかの最後の判定は G3・G4 の実測で決める）:
  1. `(version 1)` `(deny default)` と `CASE_ROOM_BASE`・`CASE_ROOM_MACH`。srt の `allowAppleEvents` の塊（:795-807）と利用者が足す mach-lookup（:808-815）は写さない（AppleEvents は切る・mach の名前は `CASE_ROOM_MACH` に完全な名前で書く）。
  2. 読み取り（srt の :639-690・:1009-1020 の形を写す）: 全体を許し、`CASE_DENY_READ_SANDBOX` と `CASE_DENY_READ` を拒否、`CASE_ALLOW_READ` と `CASE_ROOM_READ_NAMED`（ファイルは `(literal …)`、件の置き場だけ `(subpath …)`）を開け直しの塊にまとめ、そのあと `lateReadDenyFilters` と同じ形で、開け直しの道の中にある拒否だけを再び拒否する。【事実】srt の REVIEW INVARIANT（:628-632）は、開け直しの塊のあとに `(allow file-read* …)` を足すなと書く。この形はそれに沿う（開け直しの塊の後ろは拒否だけ）。【事実】`lateReadDenyFilters` は literal の拒否を、literal の許可の道の真下にあるときだけ再拒否する（`msu.js:294`。glob の拒否は全部再拒否 :299-305）。`D/cases`（`case-sandbox.ts:88`）の祖先になる開け直しの道は無い（`CASE_ALLOW_READ` の D の下は GH = `D/case-gh/<id>` だけ。:62・:121）ので、`D/cases/<id>/settings.json` などの literal の開け直しは後勝ちで効く。vitest で「どの拒否の道についても、開け直しの道がその祖先でない（または再拒否に出る）」と「`CASE_ROOM_READ_NAMED` のどの道も再拒否の道に入らない」を確かめる。端末の読み書きの許可（srt では最後の pty の塊。:1030-1033）は、読み取りの分を開け直しの塊に入れ、書き込みの分は規則の順 3 に置く（開け直しの塊の後ろに `(allow file-read*` を置かない）。そのあとディレクトリの `file-read-metadata` の許可（:666-667）、移動の塞ぎ（:670）、書ける場所（W・R・T と case-home の中の本体が書く物）への `file-write-unlink`・`file-write-create` の開け直し（:671-690。移動の塞ぎは H の下全体に両方を拒否する :586・:670。これが無いと case-home に新しいファイルを作れず、 W の中で `rm`・`mv`・git の lock の改名が拒まれ G5 が落ちる）を写す。書ける場所の中の読み取りの拒否の道の移動の塞ぎ（:1009-1020）を最後に置く。
  3. 書き込み: `CASE_ALLOW_WRITE`（W・R・T）・case-home の中の本体が書く物（§4-2）・`/dev/null` と端末（下の端末の扱い）を許し、そのあと `CASE_DENY_WRITE` と `CASE_PROTECTED_WRITE` を拒否。`CASE_PROTECTED_WRITE` は、W・R・case-home のそれぞれについて、srt と同じ形（そのままの名前と `**/<名>`・`**/<名>/**`）で: 危ないファイル（`.gitconfig`・`.gitmodules`・`.bashrc`・`.bash_profile`・`.zshrc`・`.zprofile`・`.profile`・`.ripgreprc`・`.mcp.json`。`su.js:12-22`）・危ない置き場（`.vscode`・`.idea`・`.claude/commands`・`.claude/agents`。`su.js:27`・:33-39）・`.git/hooks`・`.git/config`。大文字小文字の違う名前（`.Claude/agents` など）が拒否に当たるかは【未確認】で、G3 で確かめる。当たらなければ、名前を大文字小文字を問わない形（正規表現）で書き直し、書けなければ止めて PO に戻す。加えて公式資料の保護の道のうち srt に無い物（`.claude` の設定・skills・hooks、裸のリポジトリに変える `HEAD`・`objects`・`refs`・`config`。写し 81-recon2b3/doc-sandboxing.md:537-547）と、ホームの `~/.claude/`・`~/.claude.json`。
  4. 移動の塞ぎ: 3 の拒否の道とその祖先（W・R・case-home の根まで）への `file-write-unlink` と名前の変更を拒否（`msu.js:585-609` の写し）。
  5. 通信: 全部拒否のあと、外への接続は `(remote ip "localhost:<受付>")` と `(remote ip "localhost:<agent-console>")` だけを許す。Unix ソケットへの接続は許さない。localhost での待ち受け（bind・inbound）は、P2 で `npm test` に要ると分かったときだけ許す。【事実】今の `allowLocalBinding: true` は、srt では bind と inbound が `*:*`、外への接続が `localhost:*` になる（`msu.js:951-954`）。部屋はこのうち外への `localhost:*` を写さず、上の2つの番号だけにする（今より狭い）。外への `localhost:*` は §7 の止める条件。
- 端末: room.sb は件の作成のときに書くが、端末の名前は起動のあとに決まり、起こし直しでも変わる。そこで規則は `(param "TTY")` を使い、`ccdiscordcase` が `sandbox-exec -D TTY="$(tty)"` で渡す。【事実】`sandbox-exec` は `-D key=value` を持つ（`man sandbox-exec`。/private/tmp/CC報告ファイル/discord-pdca-bin2/127-verify/out.txt）。【未確認】規則の `(param "TTY")` が効くか。P2 で確かめ、効かなければ srt と同じ `^/dev/ttys` 全部にするかを §7 の止める条件で判断する。
- 道はすべて realpath（`/tmp` ではなく `/private/tmp`）で書く。【事実】realpath で書いた拒否は効いた（123 の 03-nested.txt:1-3）。【未確認】realpath でない書き方が効かないこと。P2 で1回試し、結果にかかわらず realpath で書く。【事実】通信の先は `*` か `localhost` に番号の形しか書けない（123 の 05-net.txt）。空白を含む道（`Application Support`）は文字列の引用で書く。
- テスト（vitest）: 5つの今の一覧と5つの新しい定数（`CASE_PROTECTED_WRITE` を含む）の全部の道が規則に入る・書き込みの拒否が許可より後ろ・読み取りの開け直しの塊の後ろに `(allow file-read*` が無い（REVIEW INVARIANT）・`CASE_ROOM_READ_NAMED` が件の置き場のほかはファイル1つずつで、どれも再拒否の道に入らない・書ける場所の unlink と create の開け直しが入る・移動の塞ぎが拒否の道ごとに入る・mach-lookup に `*` が無い・AppleEvents と lsopen の許可が無い・受付の一覧が上の式と一致する・件の設定のフックに board-guard が無く、ほかの見張りの道が開け直しに入る、を1件ずつ確かめる。

### 4-2 claude 自身の状態の置き場（case-home）

- 部屋が1つなので、本体に書かせる場所は Bash の子からも書ける。ホームの `~/.claude/` と `~/.claude.json` を書けるようにすると、件のセッションがほかのセッションの設定（フック・担当・MCP の設定）を書き換えられる。これは今より弱くなるので採らない。
- 採る形（§7 の P1 の升が「置き場を替えられる」のとき）: 件ごとの置き場 `CLAUDE_CONFIG_DIR=<dataDir>/case-home/<id>/` を起動関数で渡す。書けるのは、その中の本体が書く物（会話の記録・やることの記録・一時の物など。P2 で拒否の記録から挙げて名前で書く）だけ。本体が読む設定（`settings.json`・`agents/`・`hooks/`・`commands/`・`skills/`・`.claude.json` の設定の部分・`CLAUDE.md`）は書き込みの拒否に入れる。【未確認】`--restricted` のもとで本体が case-home のどのファイルを読むか・`.claude.json` を本体が書き続けるか。P2 で測り、本体が設定のファイルを書く必要があると分かったら、§7 の止める条件で判断する。
- case-home は件の作成で作り、作成の途中の失敗と、件の片付け（便2b-4）で消す。作るのは `writeCaseFiles`（今の `made` の片付けの並びに足す）。

### 4-3 ログインの鍵（Keychain）

- 【事実】§2-1 の Keychain の測りの記録のとおり、Keychains を開けると python から shingo-ops の項目が取り出せた記録がある。部屋で `~/Library/Keychains` の読み取りを塞ぐと claude のログインが通らず（「Not logged in」）、読めるように戻すと通った（124 の T2-claude1.json・T2-claude2.json）。
- 【事実】今は `~/Library/Keychains` の読み取りの拒否（`case-sandbox.ts:86`、親 `:356`）で shingo-ops の項目を守っている。`Bash(security *)`・`Bash(gh auth *)` の拒否は名前の形なので、絶対パスで抜けられる（親 §7 の 0-4）。gh の置き場は `GH_CONFIG_DIR` で替えられる（`ccdiscord.zsh:34`）。
- Keychain の読み出しの5つの道（G4 と升2 の測りで使う）: ① `/usr/bin/security`（絶対パス） ② python から security ③ node から security ④ 絶対パスの gh に、Bash の子が自分で作った `GH_CONFIG_DIR`（`hosts.yml` に shingo-ops）を渡し、`auth token -u shingo-ops` ⑤ `git credential-osxkeychain get`（host=github.com）。
- P1 で2つを測り、次の表で決める（カードに書く）:

| | 鍵の環境変数（`CLAUDE_CODE_OAUTH_TOKEN`）で通る | 通らない |
|---|---|---|
| 置き場を替えても Keychain でログインが見つかる | 升1: 鍵の環境変数を採る。Keychain の読み取りと `com.apple.SecurityServer`・`com.apple.securityd.xpc` の mach-lookup を部屋で塞ぐ（123 の 06-keychain の rc=44 が根拠）。鍵の弱さ（下）を PO に1件聞く。受けない答えなら升2の測りへ | 升2: Keychain を開ける。部屋の中から5つの道で shingo-ops の項目と claude のログインの項目を読む。5つのどれか1つで shingo-ops の項目が出たら升2は採らず C 案へ（止めて PO に戻す）。claude の項目だけ読めるなら、その弱さを PO に1件聞く |
| 見つからない | 升3: 升1と同じ形。鍵の弱さを PO に1件聞き、受けない答えなら升4へ | 升4: 置き場を替えられないので、§4-2 が成り立たない。止めて C 案か PO に戻す |

- 鍵の環境変数の弱さ（升1・升3）: 鍵は Bash の子から `env` で見える（GH_TOKEN と同じ）。受付は github.com を通すので、公開のリポジトリの PR・issue に鍵を書ける。鍵の発行は PO の手の操作（ログイン）なので、作るか・どこに置くか・この弱さを受けるかを PO に1件聞く。K11（親 `:608`）の「秘密の値で検索して一致0件」の対象にこの鍵を足す。
- 鍵は `ccdiscordcase` の中で取る（GH_TOKEN と同じ。`ccdiscord.zsh:29-33` の形）。サーバーの環境・tmux の引数（`server/terminal-host/tmux-runner.ts:84` の `-e K=V`）には載せない。
- どの升でも `~/.claude/.credentials.json`（ある場合）は読み取りの拒否に入れる。
- 再開: P1 で、置き場を替えた件で `--resume`（`ccdiscord.zsh:48-50`）が会話を見つけられるかも確かめる。見つけられなければ、件の再開は開かない（503）と決め、親 §4-4 の再開の扱いに書き足す。

### 4-4 受付（中継）

- 置き場: agent-console サーバーの中（`server/case-proxy.ts`。新しい）。サーバーと同じ時に起き、同じ時に止まる。サーバーの起き直り（親 K12）で戻る。tmux で残ったセッションは、サーバーが戻るまで外へつながらない（安全側）。
- 番号: 設定の1か所の定数（既定 18124）。セッションごとに変えない（起こし直しで部屋の設定と番号がずれないように）。
- 通すもの: `CONNECT <host>:<port>` のうち、次を全部満たす物だけ。ほかは 403 で、平文の HTTP の転送はしない。
  - 比べる前に host を小文字にし、末尾の点を1つ落とす。IP の直書き（v4・v6）・ASCII でない名前（IDN）・空・`:443` 以外の番号は断る。
  - host が受付の一覧（§4-1）に完全一致する。
  - `CASE_MAIN_ONLY_DOMAINS`（`api.anthropic.com`）は、接続元が本体のときだけ通す（(a)）。
- (a) の本体の見分け方:
  - 引き方: 受けた接続の送り元の番号から、`lsof -nP -iTCP@127.0.0.1:<送り元の番号>`（第1。依存を足さない）でその番号を持つプロセスの pid を引く。`proc_pidinfo` は新しい依存が要るので使わない。
  - 本体の pid の出どころ: `ccdiscordcase` の最後を `exec` にし（§4-5）、`sandbox-exec` も claude を exec する。そのため【推測】pane のプロセスの pid が本体の pid になる。【未確認】P6 で、tmux の `#{pane_pid}` と本体の pid が一致するかを確かめる。作成のときは、サーバーが `newSession` のあとに pane の pid を引いて記録する。起こし直し・つなぎ直しのときは、その場で `#{pane_pid}` を引き直す（`sessions.ts:587-592` の probe の pid が 0 のときは「分からない」）。サーバーが起き直ったときは記録が消えるので、件ごとに引き直す。
  - 分からないとき（pid が 0・引けない・記録が無い）は、`api.anthropic.com` を断る（安全側）。
  - lsof の答えの扱い: 接続の両端が出るので、サーバー自身の pid を除く。残りが0件、または残りの中に別の件の本体に行き着く物や行き着かない物が混ざるときは断る。残りの全部が同じ件の本体に行き着くときだけ、その件とする（§4-6 も同じ）。
  - tmux が使えず node-pty で開いた件（`sessions.ts:600-609`）も、サーバーが起動した子の pid を本体の pid として記録する。【未確認】node-pty の子の pid と本体の pid が一致するか。P6 で確かめ、一致しなければ node-pty で開いた件は外へつながらない（断る側）と書く。
  - pid の使い回し: セッションが終わったら記録を消す。照らすときに pid と一緒にプロセスの開始時刻（`ps -o lstart= -p <pid>`）を記録と比べ、違えば断る。
  - 【未確認】本体の API の通信が本体の pid から出ているか（子のプロセスから出ていないか）。P6 で確かめる。成り立たなければ (b): `api.anthropic.com` を Bash の子にも通す形になるので、「Bash の子が別の API の鍵で api.anthropic.com へ中身を上げられる」を ADR-1039 の弱さに足すかを PO に1件聞く（受けない答えなら C 案）。
- 記録: 1回ごとに `{時刻, セッション id, host, 本体か, 通した/断った}` を今の監査記録に1行（新しい置き場を作らない）。
- 【事実】試しの受付（124 の proxy.py）で、`api.anthropic.com` だけを通して `claude -p` が動いた。断った CONNECT は `mcp-proxy.anthropic.com` 68・datadoghq 7・github.com 2・`downloads.claude.ai` 2・api.mobbin.com 1。`localhost:8931/mcp` の15件は、受付が CONNECT でない要求として断った（124 の T1-proxy-summary.txt）。断っても `claude -p` は動いた。
- 本体の余計な通信を減らす環境変数（`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` など）を起動関数で渡す。【未確認】その名前と効き目は P4 で公式資料（Context7。使えなければ code.claude.com）と実測で確かめる。効かなくても受付で断られるので、守りは変わらない。

### 4-5 起動の形と確かめ

- `ccdiscordcase`（`ops/shell/ccdiscord.zsh`）:
  - 最後の起動（:51 の `command "$claude_bin" …`）を `exec "$sandbox_exec" -f "$AC_CASE_ROOM" -D TTY="$(tty)" "$claude_bin" …` に替える（`sandbox_exec` は :6 で既定 `/usr/bin/sandbox-exec`）。`claude_bin` の先は room.sb に書いた道と同じでないと部屋の中で動かない（§4-1 の表）。`AC_CASE_ROOM` が無い・読めないときは起動しない（今の `AC_CASE_SETTINGS` と同じ扱い）。
  - 足す環境変数: `CLAUDE_CONFIG_DIR`（§4-2）・`TMPDIR="$AC_CASE_TMP"`（Bash の囲いを切ると Claude Code が子の一時の置き場を替えなくなる。写し doc-sandboxing.md:529）・`HTTPS_PROXY`・`HTTP_PROXY`・`https_proxy`・`http_proxy`（受付）・`NO_PROXY=127.0.0.1,localhost`・P4 で決めた物。
  - 消す環境変数: `SSH_AUTH_SOCK`・`TMUX`・`TMUX_PANE`（`unset`）。
  - 道だけを渡し、秘密は引数に載せない（今と同じ）。
- 件の `settings.json`: `sandbox.enabled: false` にし、`sandbox.*` の一覧は書かない（部屋が受け持つ）。`permissions`・フック・`--restricted` は今のまま。
- `spawnSession` の確かめ（親 `:384` の①〜⑦）に足す: ⑧ `room.sb` がある ⑨ 受付が待ち受けている（サーバーの中の受付の状態を同期で見る） ⑩ `case-home/<id>/` がある ⑪ macOS の版が記録と同じ（§9）。1つでも落ちたら 503。
- 信頼の問い（trust dialog）: 対話の形で起動すると、作業の置き場を信頼するかを聞かれて止まる（124 の T3）。サーバーが部屋の外から case-home に信頼済みの印を書いてから起動する。【未確認】印の書き方は P3 で確かめる。書けなければ、印の要らない公式の起動の引数を探し、無ければ止めて PO に戻す。

### 4-6 活動の受け口

- 件のセッションの活動のフックは、`D/activity/` に書かず、agent-console の番号の新しい入口（例 `POST /api/agent/case-activity`）へ、フックが受けた標準入力をそのまま送る。フックが件の形かどうかは、件の設定でフックに渡す引数で決める（ほかの役割のフックは今のまま）。
- 記録の置き場は1つ: サーバーは `hooks/activity-hook.mjs` の `buildRecord`（:131-182）と `appendRecord`（:193-223）を読み込んで使い、今の `D/activity/events-YYYYMMDD.jsonl` に今と同じ形の1行を書く。別の置き場・別の形を作らない。共用できる形にするための関数の切り出しは便2b-3c で行い、今のフックの出力が変わらないことを vitest で確かめる。
- どの件か、はサーバーが決める（部屋から送られた値は使わない）。決め方は受付の (a) と同じ形（§4-4）: 受けた接続の送り元の番号から `lsof` で pid を引き、`ps -o ppid=` で親をたどって、サーバーが記録した件の本体の pid（開始時刻も一致）に行き着いたら、その件の出来事とする。行き着かない・引けない・記録が無いときは受けない（401。出来事は落ちるが、ほかのセッションの分に混ざらない）。件の鍵は使わない（親の case-token は全部の件で1つの共有の合言葉なので、どの件かを決められない。親第24版 `:242`）。
- 本文の中の会話の番号（`session_id`）: サーバーが決めた件の会話の番号と違えば受けない。【未確認】サーバーが件の会話の番号をいつ知るか（`D/open-sessions.json` の `claudeSessionId` が最初の出来事より前に入るか）。P6 で確かめ、前に入らなければ「その件で最初に受けた番号に固定し、違う番号は受けない」にし、固定した番号は件の `case.json` と同じ置き場（`D/cases/<id>/`）に書いて、サーバーが起き直っても消えないようにする。【推測】部屋の中からほかのセッションの会話の番号は読めない（H を塞ぎ、`D/open-sessions.json` も塞ぐ）ので、固定の前に偽の番号を出される穴は小さい。G4 でその読めないことを確かめる。
- 入口の作りは今の `/api/agent/*` の形にそろえる（Origin があれば 403。`server/http.ts:388-415`）。
- 弱さ: Bash の子は自分の件の偽の出来事を送れる（本体の子孫なので見分けない）。ほかのセッションの分には書けない（親をたどって別の件の本体に行き着かない限り）。部屋の外へ抜けたプロセス（親が launchd に替わった物）は、たどれないので受けない。§5 に書く。
- 【未確認】lsof で接続元の pid を引けるか・親をたどれるかは P6 で受付と一緒に確かめる。成り立たなければ、この入口は作らず止めて PO に戻す（件の鍵で受ける形は、どの件かを決められないので採らない）。

### 4-7 触らない範囲

- 受け口・予約・3回で止まる・全停止・保守 API・Sales Anchor 側の文書と DB（親の §4-1〜§4-4・§4-6〜）。
- `~/.claude/scripts/review-gate/`・`~/.claude/review-gate/`・ほかの役割の起動の形とフック（件の役割 `caseSandbox: true` だけを変える）。

## 5. 弊害（リスク）と対処

| リスク | 対処 |
|---|---|
| 部屋が1つになり、本体に許した物が Bash の子にも許される | 本体に要る書き込みを case-home の中の名前を挙げた物に寄せる（§4-2）。読み取りの開け直しは §4-1 の表のファイル1つずつと P2 の1つずつ（§7 の止める条件）。鍵は §4-3 の表で決め、G4 で測る |
| 自分の件の settings.json・case.json が Bash の子から読める | 中身は道と一覧だけで鍵が入らない（§2-1）。ほかの件の分は読めない（G4） |
| 自分の件の偽の活動の出来事を送れる | どの件かはサーバーが接続元の pid から決めるので、ほかのセッションの分には書けない（§4-6。P6 で確かめ、成り立たなければ入口を作らない）。画面の表示だけに使われ、判定には使わない |
| 部屋の中で見張りが読めず黙って通す | 見張りの台本をファイル1つずつ開け直す（§4-1 の表）。G5 で各見張りが拒むことを確かめ、落ちたら件を開かない |
| ボードの見張りを件の設定から外す | 今も件のセッションはボードを書けず、知らせに応えられない（§2-1）。外すことを PO に1件確かめる（§7） |
| 写した部屋の規則に、今の囲いにある塞ぎが漏れる | 土台を全部拒否にし、srt の既定の許可・保護の道の入れ子の形を出典つきで写す。G3・G4・G7 で、今の囲いが塞いでいる物を本体の起動の形で1つずつ試す |
| `api.anthropic.com` が Bash の子からも送れる | (a) 受付で本体だけに通す。成り立たなければ (b) を PO に聞く（§4-4） |
| 鍵の環境変数が子から見え、github.com に書ける（升1・升3） | PO に聞く。K11 の検索の対象に足す（§4-3） |
| 許可先（github.com）へは送れる | 今の設計と同じ弱さ（ADR-1039）。増やさない |
| 部屋の拒否が強すぎて本体が動かない | P2 で対話の形の1回を通しで動かし、拒否の記録（`log stream` の Sandbox の行）から要る場所を挙げる。足す前に §7 の止める条件を照らす。足した物は理由と一緒に表で残す |
| 受付が止まると件のセッションが外へつながらない | 安全側に倒れる。起動の確かめ ⑨ で開かない |
| macOS を上げると Seatbelt の動きが変わる | §9 の版の照合で、上げたあとは件のセッションを開かない |
| 戻したあとに、新しい版で作った件が囲い無しで起こし直される | §6 の手順で、戻す前に件を全部閉じて件の設定を消す |

## 6. 戻し方

1. 件のセッションを全部閉じる（画面か保守の入口。閉じたことを一覧で確かめる）。
2. `<dataDir>/cases/*`・`<dataDir>/case-gh/*`・`<dataDir>/case-home/*` を消す（新しい版で作った `sandbox.enabled: false` の件の設定が、前の版の起動関数で開かないように）。
3. `bash scripts/ac-update.sh v0.47.2` で前の版に戻す。受付と活動の受け口はサーバーの中なので一緒に外れる。
4. 前の版で件を1つ作り、Bash の囲いが掛かることを親 `:353` の起動のたびの確かめ（許可外の行き先への接続が失敗）で見る。
- 【事実】前の版の確かめは settings.json と case.json が無ければ件を開かない（`sessions.ts:362`）。2 で消せば、前の版で囲い無しに開く道は無い。
- 実装の便の受入に、この手順を1回回すことを入れる（戻しの試験）。

## 7. 進め方（段階と便）

- 段階 P（試し。Sonnet が手元で行う。製品のコードは変えない。部屋は試しの設定ファイルで作る）:
  - P0 Claude Code の Bash の囲いの規則を取り出せるかと、srt の出力との比較（§2-1 の【未確認】）。
  - P1 ログイン（§4-3 の表の2つの測り）・升2のときの5つの道での Keychain の項目の読み出し（shingo-ops と claude）・置き場を替えた件の `--resume`。
  - P2 §4-1 の部屋（土台は全部拒否・ホームを丸ごと塞ぐ）で対話の形を1回通しで動かし、見張りと活動のフックも動かす。拒否の記録から、本体に要る書き込み・読み取り・mach-lookup・Unix ソケット・localhost の待ち受け・端末の道を全部挙げる。`(param "TTY")` の確かめ。realpath でない書き方の確かめ。case-home の中で本体が読む物と書く物。
  - P3 信頼の問いを部屋の外から済ませる方法。
  - P4 余計な通信を減らす環境変数の名前と効き目。
  - P5 G1 の測り方（子孫の全部のプロセス・0.05 秒ごと）を対話の形で1回。G7 の各道とハードリンクの回り道を1回ずつ。
  - P6 受付で接続元の pid を lsof で引けるか・pane の pid と本体の pid が一致するか・本体の API の通信が本体の pid から出ているか。活動のフックの接続元から親をたどって本体の pid に行き着くか・件の会話の番号をサーバーがいつ知るか（§4-6）。
- P2 の止める条件: 次の場所・許可が本体に要ると分かったら、足さずに止めて C 案か PO に戻す。ホーム丸ごと・ホームの `~/.claude` と `~/.claude.json`・`os.tmpdir()`・`/private/tmp/claude-<uid>`・D（例外は §4-1 の表に名前を挙げた物だけ。つまりファイル1つずつと、その件の `case-home/<id>/`）・本店 M・tmux のソケット・`/var/run/mDNSResponder`・`SSH_AUTH_SOCK`・`/Volumes`・ほかのプロセスへの signal と process-info・AppleEvents・lsopen・外への `localhost:*`・mach-lookup の前方一致・`^/dev/ttys` 全部。これに当たらない物は、秘密の置き場でないことを確かめてから1つずつ足す（ディレクトリを広げない）。加えて、部屋の中で case-guard・ac-routine-guard・server-kill-guard のどれかが拒むべき命令を拒まなかったら止める（§4-1 の見張りの対処）。
- 費用の目安（段階 P）: 有料の呼び出し約10回。1回の実測は 0.063〜0.106 ドル（123 の 04b.json・04c.json・04c2.json）で、対話の通しはさらに多い。上限を 1.5 ドル（約235円。1ドル156.40円・2026-10-23）とし、超えそうなら止めて報告する。
- 設計の確定: P の結果で §4-1（端末）・§4-2・§4-3・§4-4・§4-5 の分岐を1つに決め、この文書を直して審査を通す。PO に聞くのは、升1・升3の鍵か、§4-4 の (b) か、P2 の止める条件に当たったときの、どれか1件ずつ。これとは別に、ボードの見張りを件の設定から外すこと（§4-1）を、実装の承認を求めるときに1件として確かめる（段階 P の結果を待たずに決められるので、段階 P の前でもよい。1回の返事で1件の決まりは守る）。
- 実装（便2b-3c。Sonnet）: §4-1・§4-2・§4-4・§4-5・§4-6。vitest・起動の確かめのテスト・§6 の戻しの試験。活動の受け口は件の鍵を使わないので、親の件の鍵の便を待たない（§4-6）。ac-case の名乗りは親の設計のまま。
- 便2b-3b のやり直し: K11・K13・K17 と G1〜G7 を本物のセッションで。

## 8. 外部事例

- Anthropic `@anthropic-ai/sandbox-runtime`（npm。0.0.81・2026-10-20 公開・Apache-2.0。調べた記録 /private/tmp/CC報告ファイル/discord-pdca-bin2/124-room-proxy/ の T0）: 誰が=Anthropic、何を=プロセスを Seatbelt で包み、内蔵の中継で行き先を名前で絞る、どう=土台を全部拒否にして既定の許可を足す（§2-1 の行）。数の実績（導入数・事故の数）は公開の資料で見つからなかった。成功の証明には使わない。部屋の規則の写し元と、形が同じ向きであることの根拠にだけ使う。
- Claude Code の公式資料（写し /private/tmp/CC報告ファイル/discord-pdca-bin2/81-recon2b3/）: 囲いは Bash だけで、全体を隔てるにはコンテナ・VM の比較へ案内する。→ 本設計が本体ごと包む理由。保護の道の一覧（doc-sandboxing.md:537-547）を §4-1 の 3 に写す。
- 親 §12 の25件（Stripe Minions の「隔てた機械」など）は、隔てた場所で動かす向きの根拠として引き続き使う。限界も親 §12 のとおり。

## 9. 維持の仕組み

- 部屋の設定は件を開くたびに1つの関数から作り直す。一覧を変えたら vitest が落ちる形にする（§4-1）。
- macOS の版の照合: サーバーが起動のときに `sw_vers -productVersion` を読み、`<dataDir>` の記録と違えば件の役割を 503 にして知らせる。人（Opus）が G1・G7 の測りを1回回して合格したら、記録を新しい版に書き換える（書き換えは保守の入口の1つの命令で、監査記録に残す）。
- srt の新しい版: 月に1回の点検で `npm view @anthropic-ai/sandbox-runtime version` を見て、版が変わっていたら写した部分（§4-1 の 1〜4）の差分を読み、直す便を出すかを決める。
- 受付の断った件数は監査記録に残り、便2b-4 の点検で数を見る。許可先を足すときは ADR-1039 の一覧を先に直す（正本は1つ）。
- 守り手: agent-console の設計の担当（Opus）。

## 10. 審査の履歴

- 第1版（2026-10-27）: 新しい Opus の審査役（Architect）が REQUEST_CHANGES（/private/tmp/CC報告ファイル/discord-pdca-bin2/125-review-room/review-out.txt）。HIGH 6・MEDIUM 6・LOW 12。第2版で全部を反映した。
- 第2版（2026-10-28）: 新しい Opus の審査役が REQUEST_CHANGES（/private/tmp/CC報告ファイル/discord-pdca-bin2/126-review-room2/review-out.txt）。前回分は H-5・L-4・L-9 が一部だけで、ほかは直った。新しく HIGH 2・MEDIUM 7・LOW 9。根拠の照合は /private/tmp/CC報告ファイル/discord-pdca-bin2/127-verify/out.txt。第3版で反映した: H-A（部屋の中で動く本体以外の物）は §2-1・§4-1 の表と規則の順 2・§4-6・§7 の止める条件・G3/G4/G5、H-B（Keychain の5つの道）は §4-3・G4、M-A は §4-1 の `CASE_ROOM_BASE`・`CASE_ROOM_MACH`、M-B は規則の順の前提と 2、M-C は 3 の入れ子の形と G3、M-D は §4-4 の (a) の見分け方、M-E は §3 の A、M-F は §2-1 の Keychain の記録、M-G は 5 と P2・§7。L-1 は親の第25版の行、L-2 は §4-1 の端末、L-3 は新しい定数5つ、L-4 は升3、L-5 は `sessions.ts:598`、L-6 は 4、L-7 は G3・P5、L-8 は G1、L-9 は §7。
- 第3版（2026-10-28）: 新しい Opus の審査役が REQUEST_CHANGES（/private/tmp/CC報告ファイル/discord-pdca-bin2/128-review-room3/review-out.txt）。前回分は H-A・M-B が一部だけで、ほかは直った。新しく HIGH 2・MEDIUM 5・LOW 7。根拠の調べは /private/tmp/CC報告ファイル/discord-pdca-bin2/129-recon-guards/out.txt。第4版で反映した: HIGH-1 は §2-1 の見張り3種の事実・§4-1 の表（見張り・ボードの見張りの物・件の置き場・件の命令・claude のリンク）・ボードの見張りの扱い・見張りの対処・§5・§7 の止める条件（D の例外を §4-2 とそろえた）・G4/G5。HIGH-2 は §4-6 を接続元の pid で件を決める形に替え（件の鍵に頼らない）、§5・§7 を直した。MEDIUM-1 は規則の順 2 に :671-690、MEDIUM-2 は §2-1 と規則の順の行番号、MEDIUM-3 は規則の順 2 の並び（開け直しの塊にまとめる）と vitest、MEDIUM-4 は §4-6 の記録の置き場、MEDIUM-5 は §2-1・規則の順 3・G3。LOW-1 は §6、LOW-2 は表、LOW-3 は §4-6、LOW-4 は §2-1・規則の順 3、LOW-5 は表と §4-5、LOW-6 は規則の順 1、LOW-7 は規則の順 5。
- 第4版（2026-10-28）: 新しい Opus の審査役が APPROVE（/private/tmp/CC報告ファイル/discord-pdca-bin2/130-review-room4/review-out.txt）。128 の14件は全部直った。条件として、カードの前に MEDIUM 1・LOW 6 を直す。第5版で反映した: MEDIUM-1 は表の件の命令・件の鍵の行と G5（ac-case と case-token は便3 の物）、LOW-1 は規則の順 2 の理由（msu.js:294）、LOW-2 は unlink・create の開け直しに case-home、LOW-3 は端末の許可の置き場、LOW-4 は trustd と指示のファイルの行、LOW-5 は §4-4 の lsof の答え・node-pty と §4-6 の固定の置き場、LOW-6 は表の claude の道を `AC_CLAUDE_BIN` で渡す。
