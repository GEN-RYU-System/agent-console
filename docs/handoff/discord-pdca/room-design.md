---
mode: handoff
---

# design: 件のセッションを本体ごと部屋に入れる（discord-pdca 第25版の追補）

> この文書は何か：Discord の不具合の件を扱う AI のセッションを、AI の本体（claude）と手伝い役（git など）ごと、macOS の囲い（部屋）の中で起動し、外への通信を受付（門番の中継）1か所に絞る設計です。親の設計 `design.md` の §4-5 の囲いの部分を置き換えます。親のほかの節（受け口・予約・3回で止まる・全停止など）は変えません。

- 親: `docs/handoff/discord-pdca/design.md`。この文書が親の行を指すときは、**第24版（agent-console origin/main 50de8d5）の行番号**で書く（第25版の行を足したので、作業中の親では1つずつ後ろにずれる）。掛かる行: `:353`（使えない状態の扱い）・`:356`（読み取りの拒否の書き方）・`:364`（Bash の読み取り）・`:377`（権限の規則）・`:383`（設定の置き場）・`:384`（起動の確かめ）・`:385`（起動の形）・`:387`（起動コマンド）と、§9 の K11（`:608`）・K17（`:614`）。
- 関係する ADR（Sales Anchor）: ADR-1039（件のセッションの囲い。許可した行き先へは送れる弱さを書く）・ADR-1034 R4（見張りを弱めない）・ADR-113（handoff の型）。衝突は無い。外への通信の許可先は、§4-4 の (a) が成り立つかぎり Bash の子に対して増やさない。成り立たないときは §7 の分岐で PO に聞く。
- 状態: 設計案（Opus 作成）・第8.1版・段階 P の結果で分岐を1つに決めた（§7 の「段階 P の結果」）。第8版は審査で APPROVE（条件付き・§10）、条件は第8.1版で直した。PO の実装の承認はまだ。

## 1. 目的と成功条件（KGI）

目的: 件のセッションの中で動くもの（AI の本体・手伝い役・AI が打つ命令・見張りのフック）が、どれも同じ部屋の中で動き、今の Bash の囲いが塞いでいる物を本体にも同じだけ塞ぐこと。便2b-3b の run1 で、AI の本体が自分で打つ git が4回、囲いの外で動いた（K17 の不合格。カード PR #86 の「試験を止めた記録」）。これを、名前の一覧で1つずつ追う形ではなく、部屋ごと閉じる形で無くす。

| 基準 | 検証方法 |
|---|---|
| G1 部屋の外で動く物が無い | 件のセッション（対話の形・tmux）を1回動かす。その間、`sandbox-exec` の pid の子孫の全部のプロセス（git に限らない）を 0.05 秒ごとに拾い、各々に `sandbox_check(pid,"file-write-create",1,<部屋の外の既存ファイル>)` を掛けて全部 1。加えて、W・case-home を作業の置き場か引数に持つプロセスのうち、`sandbox-exec` の子孫でない物が 0 件。除くのは、agent-console サーバーの pid と、親 pid がサーバーの pid であるプロセス（写しの確かめ `checkCaseClone` の git・gh など。`sessions.ts:335`）だけで、除いた物は pid・命令・親 pid を記録に残す。同じ回で、部屋なしの対照の git が 0 になることを確かめる |
| G2 外への通信は受付だけ | 受付の記録に、通した行き先と断った行き先が残る。部屋の中から受付を通さない接続（直接・IP・`--noproxy`・DNS・生のソケット）が全部失敗（親 K17 の7つの道を本体の起動の形で1回ずつ）。Bash の `curl` から `api.anthropic.com` が断られる（§4-4 の (a) のとき。(b) のときは通ったことを記録し、PO の答えの記録と照らす） |
| G3 書き込みの拒否が本体にも効く | 親 `:383` の書き込みの拒否の一覧・保護の道（§4-1 の 3。一番上と入れ子の `W/sub/.git/hooks/x`・`W/sub/.claude/settings.json` の両方）・ホームの下（`~/.claude/settings.json`・`~/.claude/agents/`・`~/.claude.json`・`~/.zshrc`）・case-home の中の本体が読む設定と (B)（§4-2。`.claude.json` は書き直しの扱いなので除く）・件の設定（`D/cases/<id>/settings.json`・`case.json`）・活動の記録（`D/activity/`）への、Bash からの書き込みが全部拒否。回り道（`mv W/.git W/g` → `W/g/hooks/x` に書く → 戻す）が最初の `mv` で拒否。ハードリンクの回り道（`ln <W の外の既存ファイル> W/x` のあと `W/x` に書く）が拒否。大文字小文字を変えた保護の道（`W/sub/.Claude/agents/x`・`W/.GIT/hooks/x`）への書き込みが拒否。公式資料の保護の道（写し 81-recon2b3/doc-sandboxing.md:540）について、まだ無い `W/sub/.claude/scheduled_tasks.json` の作成と `W/.claude/workflows/x` への書き込みが拒否（case-home の中のこれらは許可の一覧に無いので既定で拒否）。入れ子の `.claude` の回り道（`mv W/sub/.claude W/sub/c` → `W/sub/c/settings.json` に書く → 戻す）が最初の `mv` で拒否。保護の名前の新しい作成（まだ無い `W/sub/.mcp.json`・`W/sub/.claude/settings.json`）が拒否。case-home の (B)（§4-2）について、Bash から `case-home/<id>/remote-settings.json` に hooks や env を書くことが拒否され、そのあと件を開き直しても case-guard が W の外の Edit を拒む（(B) を「起動前に消す」に替えた場合は、書けたうえで、開き直したあと case-guard が W の外の Edit を拒むことと、ファイルが消えていることを見る）。同じ回の途中の読み直しも見る: 1つのセッションの中で、Bash から (B)（「起動前に消す」に替えた場合）と `.claude.json` の `projects` に許可（`permissions.allow` 類）を書いたあと、同じセッションで W の外への Edit を試し、拒否されること（拒否されなければ止めて PO へ戻す）。W の中で `rm`・`mv` が通る |
| G4 読めない物が読めない | Bash の `cat`・`python3` で、`~/.ssh`・`~/kb/01-private`・本店 M・ほかの件の R と T・ほかの件の `D/cases/<別の id>/` と `D/case-home/<別の id>/`・`D/open-sessions.json`・`D/boards/`・`D/bin/ac-board.mjs`・`/private/tmp/CC報告ファイル` のほかの置き場・`os.tmpdir()` の下・親 `:356` の秘密の置き場が全部拒否。Keychain の読み出しは §4-3 の5つの道を全部試し、shingo-ops の項目はどの道でも出ない |
| G5 普段の仕事が通る | 部屋の中で、commit（lint-staged が動く形）・stash の push と pop・push・rebase・PR 作成・`npm test` が通る。`ac-case` の呼び出しは便3 の受入に入れる（今は無い）。部屋の中で見張りが動き、拒むべき Edit（W の外）を拒み、許すべき Edit（W の中）が通る。部屋の中で、対話の形（tmux）のセッションの担当（Agent）が打つ dataDir の命令を ac-routine-guard が拒み（`T/cc-socks/<pid>.sock` の bind の拒否で担当が動かなくならないかを、この対話の形の1回で見る。§7 の P2）、`kill` でサーバーの番号を止める命令を server-kill-guard が拒む。活動の出来事（§4-6）が画面のその件に出る |
| G6 部屋が無ければ始まらない | `room.sb` が無い・受付が待ち受けていない・case-home が無い・macOS の版が記録と違う（§9）の4つと、room.sb の書き込みに失敗させた場合（前の room.sb が残っていても）を1つずつ作り、どれでもセッションが開かない（503）。テストで1回ずつ |
| G7 部屋の外で動かす道が塞がる | 部屋の中から次が全部失敗: `osascript`（Terminal への命令）・`open`（アプリと `.command`）・`launchctl submit`・`launchctl bootstrap`・`kill <サーバーの pid>`・`ps eww` でのほかのプロセスの環境変数の読み取り・`tmux -L agent-console` への接続・`SSH_AUTH_SOCK` が指すソケットへの接続（部屋の外で取った道を引数で渡して `nc -U` で）・`pbpaste`。加えて対照として、起動関数の unset を外して `TMUX` を残した部屋から `tmux -S <TMUX が指す道> ls` が失敗する（unset の漏れがあっても部屋の通信の規則で塞がることを見る） |

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

- 置き場: 新しい純粋な関数 `buildCaseRoomProfile`（`server/case-sandbox.ts`）。入力は今の `CaseParams`（W・R・T・M・D・H・GH など）と、受付と agent-console の番号、case-home の道、見張りの台本の道。出力は文字列。件を開くたび（作成・再開・起こし直し）に、起動の直前にサーバーが `<dataDir>/cases/<id>/room.sb` に書き直す（同じ置き場の一時の名前に書いてから名前を付け替える形。書きかけの規則で起動しないため。作成のときは `writeCaseFiles`。再開・起こし直しのときも同じ関数を通る呼び出しを起動の確かめ ⑧ の前に置く。どの呼び出しから書くかは実装カードで file:line を決める。書き込みか付け替えに失敗したら起動しない（503）。前に開いたときの room.sb は使わない。残った一時の名前は次に開くときに消す）。
- 正本: 今の5つの一覧と `CASE_ALLOWED_DOMAINS` を使い、部屋のための別の一覧を作らない。部屋だけで足すのは次の5つの新しい定数で、どれも `case-sandbox.ts` に1つずつ置く:
  - `CASE_ROOM_BASE`: srt から写す土台と既定の許可（`msu.js:753-922` のうち mach-lookup を除いた物）。
  - `CASE_ROOM_MACH`: mach-lookup の名前の一覧。名前を完全に書き、前方一致（`*`）は使わない。srt の :772-792・:907 の一覧から始め、升1・升3（§4-3）では `com.apple.SecurityServer` と `com.apple.securityd.xpc` を外す。`com.apple.trustd.agent` は今の設定が `enableWeakerNetworkIsolation: true` なので同じに足す（gh の TLS に要る。`msu.js:789`）。P2 で足した物は理由と一緒に表で残す。
  - `CASE_ROOM_READ_NAMED`: 読み取りで名前を挙げて開ける物（下の表）。【事実】段階 P で git が `~/.gitconfig`・`~/.config/git/config`・`~/.config/git/ignore`・`~/.config/git/attributes` を読めないと動かなかった（131-stageP/P-summary.txt）。【事実】この4つは今の `CASE_ALLOW_READ` に既にある（agent-console `server/case-sandbox.ts:122-125`）。`CASE_ROOM_READ_NAMED` には足さず、今の `CASE_ALLOW_READ` のまま規則の順 2 の開け直しに入る（同じ道を2か所に載せない）。開け直しは今の Bash の囲いと同じなので守りは弱まらない。【事実】今の `~/.gitconfig` のキーは `credential.<github>.helper` 2つ・`user.email`・`user.name` だけで、秘密らしい文字は0件（審査役がキー名と件数だけを見た。134-review-room6/review-out.txt の LOW-1）。`credential.helper` があっても、Keychain を開けないので読み出せない。
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
| claude | `claude_bin`（`ccdiscord.zsh:5`。既定は `claude`）。【事実】`~/.local/bin/claude` は `~/.local/share/claude/versions/2.1.311` へのリンク（129 の記録） | リンクは metadata だけ、先のファイルは読み取りと実行を許す（ファイル1つずつ。サーバーが件を開くたび（作成・再開・起こし直し）に絶対の道を realpath で解き、その同じ文字列を room.sb の literal と `AC_CLAUDE_BIN` の両方に書く。起動関数は `AC_CLAUDE_BIN`（実体の道）を exec する。PATH で探させない） | 拒否（`versions/` の中も） | 本体を動かすのに要る。【事実】段階 P の途中で本体が 2.1.311 から 2.1.312 に自動で入れ替わった（リンクの先が変わった）。room.sb は 2.1.311 だけを開けていたが、読み取りの拒否が12回出ただけで起動・実行できた（133-stageP2/P-summary.txt の P2）。この事実から、実行には読み取りの許可が要らない（部屋の中で動くので逃げ道ではない）。開くたびに realpath を解き直すので、入れ替わったあとも次に開くときに新しい道で書かれる。起動の確かめ ⑫（§4-5）は「`AC_CLAUDE_BIN` が room.sb の claude の literal と同じ文字列で、そのファイルがある」。古い版の置き場が消えたときは exec が失敗して開かない側に倒れる。ホーム丸ごと・`~/.claude` は止める条件 |
| 件の鍵 | 親 `:242` の `dataDir/case-token`（【事実】実装はまだ無い） | この便では開けない。【事実】今の Bash の囲いでも読めない（H を塞ぎ、D から開け直すのは GH だけ。`case-sandbox.ts:95`・:121）。便3 で開けると今より広がる（親 `:356` の予定の弱さ）ので、便3 の審査で決める | 拒否 | ac-case の名乗りに使う。活動の受け口は使わない（§4-6） |

- 部屋の外で読む物は表に入れない: `ccdiscordcase` が起動の前に読む指示のファイル（`ccdiscord.zsh:7-8`・:43-44）と gh の鍵（:29-33）は、`sandbox-exec` に入る前に読み終わる。
- ボードの見張りの扱い: 【事実】今の件のセッションは、ボードの見張りに1回止められても、Bash から `D/boards/` に書けない（§2-1。書ける場所に D が無い）。見張りは1回だけ止めて2回目は通す（`board-guard.mjs` の印）。つまり今も、件のセッションでは知らせを受けても応えられない。部屋の中では `D/open-sessions.json` を読めないので、黙って素通りになる。そこで件の設定（`buildCaseSettings`）だけ、`HOOK_SPECS` から board-guard を除いて入れる（ほかの役割は今のまま）。これは安全の見張りではなく書き忘れの知らせだが、見張りを1つ外す変更なので、親 `:385` のとおり PO に1件確かめる（§7）。外さない答えなら、件用に `D/open-sessions.json` を開ける形は採らず、止めて PO に戻す。
- 見張りが部屋の中で黙って効かなくなることへの対処: case-guard は読めなければ止める（`onFailure: "block"`）。ac-routine-guard と server-kill-guard は読めないと通す作りなので、G5 で「部屋の中で各見張りが拒むべき命令を拒む」を1回ずつ確かめ、落ちたら件を開かない（P2 の止める条件）。vitest で、件の設定のフックの一覧が `HOOK_SPECS` から board-guard を除いた物と一致し、各見張りの道が `CASE_ROOM_READ_NAMED` に入っていることを確かめる。

- 規則の順（【事実】Seatbelt は同じ細かさなら後ろの規則が勝つ。`msu.js:648-649`。ただし個別の操作の拒否は後ろの `file-write*` の許可で上書きされない。:675-676。どちらが勝つかの最後の判定は G3・G4 の実測で決める）:
  1. `(version 1)` `(deny default)` と `CASE_ROOM_BASE`・`CASE_ROOM_MACH`。srt の `allowAppleEvents` の塊（:795-807）と利用者が足す mach-lookup（:808-815）は写さない（AppleEvents は切る・mach の名前は `CASE_ROOM_MACH` に完全な名前で書く）。
  2. 読み取り（srt の :639-690・:1009-1020 の形を写す）: 全体を許し、`CASE_DENY_READ_SANDBOX` と `CASE_DENY_READ` を拒否、`CASE_ALLOW_READ` と `CASE_ROOM_READ_NAMED`（ファイルは `(literal …)`、件の置き場だけ `(subpath …)`）を開け直しの塊にまとめ、そのあと `lateReadDenyFilters` と同じ形で、開け直しの道の中にある拒否だけを再び拒否する。【事実】srt の REVIEW INVARIANT（:628-632）は、開け直しの塊のあとに `(allow file-read* …)` を足すなと書く。この形はそれに沿う（開け直しの塊の後ろは拒否だけ）。【事実】`lateReadDenyFilters` は literal の拒否を、literal の許可の道の真下にあるときだけ再拒否する（`msu.js:294`。glob の拒否は全部再拒否 :299-305）。`D/cases`（`case-sandbox.ts:88`）の祖先になる開け直しの道は無い（`CASE_ALLOW_READ` の D の下は GH = `D/case-gh/<id>` だけ。:62・:121）ので、`D/cases/<id>/settings.json` などの literal の開け直しは後勝ちで効く。vitest で「どの拒否の道についても、開け直しの道がその祖先でない（または再拒否に出る）」と「`CASE_ROOM_READ_NAMED` のどの道も再拒否の道に入らない」を確かめる。端末の読み書きの許可（srt では最後の pty の塊。:1030-1033）は、読み取りの分を開け直しの塊に入れ、書き込みの分は規則の順 3 に置く（開け直しの塊の後ろに `(allow file-read*` を置かない）。そのあとディレクトリの `file-read-metadata` の許可（:666-667）、移動の塞ぎ（:670）、書ける場所（W・R・T と case-home の中の本体が書く物。§4-2 の (A) と (C) の `.claude.json` の literal だけ。(A) の置き場は `(subpath "<CH>/<名>")`、`.last-cleanup` と `.claude.json` は `(literal …)`。case-home の根そのものは開け直さない）への `file-write-unlink`・`file-write-create` の開け直し（:671-690。移動の塞ぎは H の下全体に両方を拒否する :586・:670。これが無いと case-home に新しいファイルを作れず、 W の中で `rm`・`mv`・git の lock の改名が拒まれ G5 が落ちる）を写す。書ける場所の中の読み取りの拒否の道の移動の塞ぎ（:1009-1020）を最後に置く。
  3. 書き込み: `CASE_ALLOW_WRITE`（W・R・T）・case-home の中の本体が書く物（§4-2 の (A) の名前と (C) の `<case-home>/.claude.json` の literal だけ。許可の一覧の形。(A) の置き場6つは `(subpath "<CH>/<名>")`、`.last-cleanup` と `.claude.json` は `(literal …)`）・`/dev/null` と端末（下の端末の扱い）を許し、そのあと `(deny file-write* …)` の1つの塊で `CASE_DENY_WRITE` と `CASE_PROTECTED_WRITE` を拒否する。case-home を丸ごと書ける形（試しの形）は採らない（名前に無い物と大文字小文字を変えた名前が既定で拒否になり、今の Bash の囲いが CLAUDE_CONFIG_DIR の中身の多くを塞ぐのと同じ向きになる。写し 81-recon2b3/doc-sandboxing.md:543）。拒否の正規表現の形は段階 P で試して通った物（試しの台本 /private/tmp/CC報告ファイル/discord-pdca-bin2/133-stageP2/tools/mkroom.py:109-131。131-stageP も同じ形）に、(B) の名前と公式資料の `.claude/workflows`・`.claude/scheduled_tasks.json` を足した物。【未確認】試しは case-home を丸ごと `(subpath …)` で書ける形（mkroom.py:98-106）で行い、(A)＋(C) の許可の一覧の形は試していない。確かめ方は §4-2 の「受入の最初の確かめ」:
     - `CASE_PROTECTED_WRITE` は、X＝W・R・case-home の realpath のそれぞれについて、次の正規表現を作る（`<X>` は realpath を正規表現の記号を逃がして書いた物。`<名>` は1文字ずつ大小を問わない形 `[gG][iI][tT]` に開いた物）:
       - 危ないファイル（`.gitconfig`・`.gitmodules`・`.bashrc`・`.bash_profile`・`.zshrc`・`.zprofile`・`.profile`・`.ripgreprc`・`.mcp.json`。`su.js:12-22`）と、名前そのままのファイル（`.claude/settings.json`・`.claude/settings.local.json`・`.claude/scheduled_tasks.json`（写し 81-recon2b3/doc-sandboxing.md:540）・`.git/config`）: `^<X>/(.+/)?<名>$`。
       - 危ない置き場（`.vscode`・`.idea`・`.claude/commands`・`.claude/agents`。`su.js:27`・:33-39。公式資料の保護の道のうち srt に無い `.claude/skills`・`.claude/hooks`・`.claude/workflows`。写し 81-recon2b3/doc-sandboxing.md:537-547。`.claude/workflows` は :540）と `.git/hooks`: `^<X>/(.+/)?<名>(/.*)?$`。
       - 裸のリポジトリに変える名前（`HEAD`・`objects`・`refs`・`config`。同 doc-sandboxing.md）: 一番上だけ `^<X>/<名>(/.*)?$`。
     - `CASE_DENY_WRITE` に足す物: ホームの `~/.claude`・`~/.claude.json`・`~/.zshrc`、`D/cases`・`D/activity`・`D/hooks`（`(subpath …)`）。case-home の本体が読む設定の名前（§4-2 の (B) と `settings.json`・`agents`・`hooks`・`commands`・`skills`・`CLAUDE.md`）を `^<case-home>/<名>(/.*)?$` の形で（`policy-limits*.json` は §4-2 の正規表現。大文字小文字を変えた名前は、拒否の正規表現ではなく、許可の一覧に当たらないことで拒否になる）。これらは書き込みの許可の一覧に無いので既定でも拒否になり、名前を挙げた拒否は2重の守り。§4-2 の分岐で (B) の5つを「書ける」に替えたときは、その5つを許可の一覧に足し、名前を挙げた拒否から外す形にする。
     - 【事実】大文字小文字の違う名前（`W/.Claude/agents/x`・`W/.GIT/hooks/x`・`W/.CLAUDE/Settings.JSON`・`W/sub/.cLaUdE/settings.json`）への書き込みは拒否された（133-stageP2/P5-g7-room.txt:36-53）。G3 で毎回確かめる。
  4. 作成・削除・移動の塞ぎ（`msu.js:585-609` の写しに、段階 P の直しを足した物。試しの台本 mkroom.py:133-145）: `(deny file-write-unlink file-write-create …)` の1つの塊に、次の全部を入れる:
     - 3 の `CASE_PROTECTED_WRITE` の正規表現の全部（W・R・case-home）。
     - case-home の本体が読む設定の名前（3 の `CASE_DENY_WRITE` の case-home の分と同じ正規表現）。
     - X＝W・R・case-home のそれぞれの根・`<X>/.claude`・`<X>/.git` の `(literal …)`。
     - 入れ子の `.git` と `.claude` そのもの: `^<X>/(.+/)?\.git$` と `^<X>/(.+/)?\.claude$`（末尾は `$`。`.git` と `.claude` の中身（`index.lock`・`objects`・`refs` など）には掛けない。先頭は X の realpath なので T には掛けない。中身に掛けると git の commit・stash・rebase と、T で git init する `npm test` が落ちる）。
     - 【事実】`file-write*` の拒否だけでは新しく作ることを止められなかった（131-stageP で case-home の `settings.json`・`CLAUDE.md` が作れた）。そのため W・R の保護の道（新しい `W/sub/.mcp.json`・`W/sub/.claude/settings.json` など）にも、この塊で作成の拒否を掛ける。【事実】入れ子の `W/sub/.git` の移動は、名前を挙げた literal の塞ぎには当たらず、上の入れ子の正規表現を足して塞いだ（131-stageP/P-summary.txt の「見つけた穴と直し」1)・2)）。
  5. 通信: 全部拒否のあと、外への接続は `(remote ip "localhost:<受付>")` と `(remote ip "localhost:<agent-console>")` だけを許す。Unix ソケットへの接続は許さない。localhost での待ち受け（bind・inbound）は、P2 で `npm test` に要ると分かったときだけ許す。【事実】今の `allowLocalBinding: true` は、srt では bind と inbound が `*:*`、外への接続が `localhost:*` になる（`msu.js:951-954`）。部屋はこのうち外への `localhost:*` を写さず、上の2つの番号だけにする（今より狭い）。外への `localhost:*` は §7 の止める条件。
- 端末: room.sb は件を開くたびにサーバーが書くが、端末の名前は tmux の中で起動したあとに決まる。そこで規則は `(param "TTY")` を使い、`ccdiscordcase` が `sandbox-exec -D TTY="$(tty)"` で渡す。`tty` の答えが `/dev/ttys<数字>` の形（`^/dev/ttys[0-9]+$`）でなければ起動しない（tmux の外から呼ばれると "not a tty" が渡るため）。【事実】`sandbox-exec` は `-D key=value` を持つ（`man sandbox-exec`。/private/tmp/CC報告ファイル/discord-pdca-bin2/127-verify/out.txt）。【事実】`(param "TTY")` を渡した部屋で、対話の形の本体が画面を描き、本体の `/dev/ttys*` の拒否は出なかった（133-stageP2/P-summary.txt の P2）。この形で決める。【未確認】渡さないときに拒否が出るかの対照は行っていない（守りの向きには影響しない）。
- 道はすべて realpath（`/tmp` ではなく `/private/tmp`）で書く。【事実】realpath で書いた拒否は効いた（123 の 03-nested.txt:1-3）。【事実】リンクの側の道で書いた拒否は、実体の道への書き込みを止めなかった。実体の側で書いた拒否は両方を止めた（133-stageP2/P2-realpath.txt）。realpath で書く。【事実】通信の先は `*` か `localhost` に番号の形しか書けない（123 の 05-net.txt）。空白を含む道（`Application Support`）は文字列の引用で書く。
- テスト（vitest）: 5つの今の一覧と5つの新しい定数（`CASE_PROTECTED_WRITE` を含む）の全部の道が規則に入る・書き込みの拒否が許可より後ろ・読み取りの開け直しの塊の後ろに `(allow file-read*` が無い（REVIEW INVARIANT）・`CASE_ROOM_READ_NAMED` が件の置き場のほかはファイル1つずつで、どれも再拒否の道に入らない・書ける場所の unlink と create の開け直しが入る・移動の塞ぎが拒否の道ごとに入る・作成と削除の塞ぎ（規則の順 4）の入れ子の正規表現が、どれも W・R・case-home のどれかの realpath で始まり、`\.git$` か `\.claude$` で終わる（中身と T に掛からない）・case-home の (B) の名前が書き込みの拒否と作成の塞ぎの両方に入り、(A) の名前と (C) の `.claude.json` の literal だけが書き込みの許可に入る（case-home の根そのものの `(subpath "<CH>")` の書き込みの許可と unlink・create の開け直しが無い）・`CH/Remote-Settings.json` のような大文字小文字を変えた (B) の名前が許可の一覧のどれにも当たらない・W・R の保護の道に `.claude/workflows` と `.claude/scheduled_tasks.json` が入る・`AC_CLAUDE_BIN` と room.sb の claude の literal が同じ文字列・起動関数が §4-5 の消し方で環境変数を消し、そのあとで足す物を入れる・mach-lookup に `*` が無い・AppleEvents と lsopen の許可が無い・受付の一覧が上の式と一致する・件の設定のフックに board-guard が無く、ほかの見張りの道が開け直しに入る、を1件ずつ確かめる。

### 4-2 claude 自身の状態の置き場（case-home）

- 部屋が1つなので、本体に書かせる場所は Bash の子からも書ける。ホームの `~/.claude/` と `~/.claude.json` を書けるようにすると、件のセッションがほかのセッションの設定（フック・担当・MCP の設定）を書き換えられる。これは今より弱くなるので採らない。
- 採る形（§7 の P1 の升が「置き場を替えられる」のとき）: 件ごとの置き場 `CLAUDE_CONFIG_DIR=<dataDir>/case-home/<id>/` を起動関数で渡す。【事実】段階 P で本体が case-home に書いた物は `.claude.json`・`backups/`・`plugins/`・`policy-limits*.json`・`remote-settings.json`（と synced-at）・`projects/`・`session-env/`・`sessions/`・`shell-snapshots/`・`tasks/`・`teams/`・`.last-cleanup`（133-stageP2/P2-casehome-written.txt:2-36）。`settings.json`・`agents/`・`hooks/`・`commands/`・`skills/`・`CLAUDE.md` は作られず、作成の拒否のままで本体は動いた。本体が書いた物を、本体が次に設定として読み戻すかで3つに分ける:
  - (A) 記録だけの物。書ける: `projects/`・`sessions/`・`session-env/`・`shell-snapshots/`・`tasks/`・`teams/`・`.last-cleanup`。
  - (B) 設定として読み戻す物。書き込みの拒否と作成・削除の塞ぎに入れる（§4-1 の規則の順 3・4）: `remote-settings.json`・`remote-settings.json.synced-at`・`policy-limits*.json`（正規表現 `^<case-home>/policy-limits[^/]*\.json$`）・`plugins/`・`backups/`。加えて、本体が読む設定 `settings.json`・`agents/`・`hooks/`・`commands/`・`skills/`・`CLAUDE.md`。【事実】公式資料 server-managed-settings（写し /private/tmp/CC報告ファイル/discord-pdca-bin2/134-review-room6/doc-server-managed.md:360・:205）: 手で書き換えた管理者の設定の写し（`remote-settings.json`）は起動のときに効き、`env` に足した変数は起動し直すまで残る。CLAUDE_CONFIG_DIR を case-home にしたので、この写しは case-home の中に置かれる。Bash の子が書けると、次の起動（`--resume` を含む）で一番強い設定として見張りを弱められる（ADR-1034 R4 に当たる）。今の Bash の囲いも CLAUDE_CONFIG_DIR の中身の多くを Bash から書かせない（写し 81-recon2b3/doc-sandboxing.md:543）ので、拒否にして今と同じ強さにそろえる。
    - 分岐: 実装の受入の最初の確かめで、(B) を拒否にした部屋で本体が起動して入力待ちまで行き、1回の応答と `--resume` が通るかを見る。通れば拒否のまま。通らなければ、本体が書いた (B) の5つ（`remote-settings.json`・synced-at・`policy-limits*.json`・`plugins/`・`backups/`）だけを「書ける」に替え（`settings.json`・`agents/`・`hooks/`・`commands/`・`skills/`・`CLAUDE.md` は拒否のまま）、サーバーが件を開く前に毎回、部屋の外でその5つを全部消す（`.claude.json` の書き直しと同じ時に）。替えた場合、セッションの途中で本体が (B) を読み直すかは【未確認】として §5 に残し、G3 の remote-settings.json の確かめで見る。
  - (C) `.claude.json`。本体が書くので書ける（Bash の子からも書ける）。書き込みの許可に `<case-home>/.claude.json` の literal で入れ、拒否には入れず、下の書き直しに一本化する。【事実】今の Bash の囲いは `~/.claude.json` を Bash から書かせない（写し 81-recon2b3/doc-sandboxing.md:543）ので、この点は今より弱い。次の起動への持ち越しは書き直しで閉じ、途中の読み直しは G3 で見る。
- 受入の最初の確かめ（(B) の分岐と同じ回）: `log stream` の Sandbox の行で case-home の下の拒否を名前ごとに数え、`.claude.json` の書き込みが通ったこと（起動のあとファイルの更新時刻が変わる）を見る。拒否された名前があれば、§7 の止める条件の手順で1つずつ (A)／(B) に分けて足す（丸ごとにはしない）。本体が `.claude.json` を書き直すときに一時のファイルの名前（例 `.claude.json.<数字>.tmp` の形）が要るなら、その名前の形を literal か `^<case-home>/\.claude\.json\.[^/]+$` の正規表現で足し、足した形を記録に残す。足すときは規則の順 2（unlink・create の開け直し）と 3（書き込みの許可）の両方に同じ形で足す。正規表現は記録で実際に見た名前の形（数字・`tmp` など）に合わせて最も狭く書く。`backup` を含む名前は (B) と同じ扱いで足さない。
- `.claude.json` の書き直し: 子が書き足した物（MCP の設定など）は次の起動の本体に効くおそれがある。そこでサーバーは件を開く前に毎回、部屋の外で `.claude.json` を「残すキーの許可の一覧」だけの形に書き直す（拒否の一覧で消す形は採らない）。残すキー: 印の `hasCompletedOnboarding: true` と `projects: {"<W の realpath>": {"hasTrustDialogAccepted": true}}`（§4-5。この2つはサーバーが値を決めて書く）、本体の名乗りと移行の印 `userID`・`machineID`・`firstStartTime`・`firstStartVersion`・`migrationVersion`・`opusProMigrationComplete`・`sonnet1m45MigrationComplete`（前の `.claude.json` にあり、値が文字列・数・真偽のどれかのときだけ写す。初回の案内や移行の問いが毎回出ないように）。ほかのキー（`cachedGrowthBookFeatures` などの機能の印の写し・`pluginUsage`・`seenNotifications`・`mcpServers` ほか）は全部落とす。【事実】段階 P の起動前の `.claude.json` のキーは16個で、上のほかは `cachedExperimentData`・`cachedExperimentFeatures`・`cachedExtraUsageDisabledReason`・`cachedGrowthBookFeatures`・`cachedGrowthBookFeaturesAt`・`hasResetAutoModeOptInForDefaultOffer`・`pluginUsage`・`seenNotifications` だった（133-stageP2/P3b-before.json。キー名だけを見た）。
  - 【未確認】この形に書き直しても (1) 対話の形の本体が入力待ちまで行くか（初回の案内・移行の問いが出ないか）、(2) `--resume` が会話を見つけるか（会話は `projects/` の記録に入るので見つかると見込むが、確かめていない）。実装の受入で1回ずつ確かめ、落ちたら止めて PO に戻す（キーを足すときは、そのキーが見張りに関わらないことを書いて審査に出す）。
- `projects/<W>/memory/`（自動の覚え書き。133-stageP2/P2-casehome-written.txt:18）は (A) の中にあり、次の起動の本体の文脈に入る。Bash の子が書ける。件ごとの置き場なのでほかの件には効かない（§5）。
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

- 【事実】段階 P の結果は升3（決定）: 置き場を替えると「Not logged in」（131-stageP/P-summary.txt の P1(a)）。Keychain を開けた部屋では shingo-ops の項目が読めたので升2 は採らない（同 P1(d)）。PO は 2026-10-28 に専用のログイン鍵を作ることを選んだ（「1」）。鍵は Keychain の項目 `-s agent-console-case-claude -a case` に入っている（2026-10-29。長さ109バイト・形の書き出しが一致。値は見ていない。132-token-check）。鍵ありで、部屋の外1回・部屋の中2回とも「Not logged in」は出ず、`--resume` で会話が見つかった（133-stageP2/P-summary.txt の P1(b)・P1(c)）。部屋では Keychain の読み取りと `com.apple.SecurityServer`・`com.apple.securityd.xpc` を塞いだままでよい。
- 【事実】公式資料（https://code.claude.com/docs/en/authentication 「Generate a long-lived token」。Context7 は月の上限で使えなかった）: `claude setup-token` は1年使える鍵を画面に出し、どこにも保存しない。`CLAUDE_CODE_OAUTH_TOKEN` で使う。モデルの呼び出しだけができる。bare mode では読まれない。
- 鍵の環境変数の弱さ（升1・升3）: 鍵は Bash の子から `env` で見える（GH_TOKEN と同じ）。受付は github.com を通すので、公開のリポジトリの PR・issue に鍵を書ける。鍵の発行は PO の手の操作（ログイン）なので、作るか・どこに置くか・この弱さを受けるかを PO に1件聞く。K11（親 `:608`）の「秘密の値で検索して一致0件」の対象にこの鍵を足す。
- PO はこの弱さを受けて鍵を作った（2026-10-28「1」）。鍵の期限は1年なので、期限の1か月前に知らせる仕組みを §9 に足す。
- 鍵は `ccdiscordcase` の中で取る（GH_TOKEN と同じ。`ccdiscord.zsh:29-33` の形。項目は上の `agent-console-case-claude`／`case`。取れなければ起動しない）。サーバーの環境・tmux の引数（`server/terminal-host/tmux-runner.ts:84` の `-e K=V`）には載せない。
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
  - 本体の pid の出どころ: `ccdiscordcase` の最後を `exec` にし（§4-5）、`sandbox-exec` も claude を exec する。【事実】対話の形で tmux の `#{pane_pid}` は本体 claude の pid と一致し、受付が lsof で引いた pid とも一致した（133-stageP2/P6-panepid.txt・P-proxy-log.txt）。作成のときは、サーバーが `newSession` のあとに pane の pid を引いて記録する。起こし直し・つなぎ直しのときは、その場で `#{pane_pid}` を引き直す（`sessions.ts:587-592` の probe の pid が 0 のときは「分からない」）。サーバーが起き直ったときは記録が消えるので、件ごとに引き直す。
  - 分からないとき（pid が 0・引けない・記録が無い）は、`api.anthropic.com` を断る（安全側）。
  - lsof の答えの扱い（受付の `api.anthropic.com`）: 接続の両端が出るので、受付（サーバー）自身の pid を除く。残りがちょうど1つで、その pid とプロセスの開始時刻が、記録した件の本体と同じときだけ通す。親はたどらない（親をたどると Bash の子や子が起動した `claude -p` も本体と見なされ、(a) が成り立たない）。残りが0件・2つ以上・本体と違うときは断る。親をたどるのは §4-6 の活動の受け口だけ。
  - 【事実】段階 P で `api.anthropic.com` の通した75件のうち73件は残りの pid が1つで本体だった。2件は pid が2つで親の連鎖が空だった（原因は【未確認】。133-stageP2/P6-proxy-analysis.txt・P-proxy-log.txt:79-81）。この2件は試しでは通しており、この決まりなら断る側になる。npm test の子からの `registry.npmjs.org` は本体と違う pid で見分けられた。
  - 【未確認】断ったときに本体が再試行して会話が続くか。実装の受入で、受付の記録から断った件数と率を数え、対話の形の1回で会話が続くことを確かめる。続かなければ止めて PO に戻す（親をたどる形には替えない）。
  - tmux が使えず node-pty で開いた件（`sessions.ts:600-609`）: 【未確認】node-pty の子の pid と本体の pid が一致するか（段階 P は tmux だけ）。確かめていないので、件の役割では node-pty で開かない（tmux が無ければ 503）と決める。
  - pid の使い回し: セッションが終わったら記録を消す。照らすときに pid と一緒にプロセスの開始時刻（`ps -o lstart= -p <pid>`）を記録と比べ、違えば断る。
  - 【事実】本体の API の通信は本体の pid から出ていた（上の73件）。(a) で決める。(b) は採らない。
- 記録: 1回ごとに `{時刻, セッション id, host, 本体か, 通した/断った}` を今の監査記録に1行（新しい置き場を作らない）。
- 【事実】試しの受付（124 の proxy.py）で、`api.anthropic.com` だけを通して `claude -p` が動いた。断った CONNECT は `mcp-proxy.anthropic.com` 68・datadoghq 7・github.com 2・`downloads.claude.ai` 2・api.mobbin.com 1。`localhost:8931/mcp` の15件は、受付が CONNECT でない要求として断った（124 の T1-proxy-summary.txt）。断っても `claude -p` は動いた。
- 本体の余計な通信を減らす `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を起動関数で渡す。【事実】名前は公式資料 https://code.claude.com/docs/en/env-vars で確かめた（Context7 は月の上限で使えなかった）。同じ `-p` を1回ずつ比べ、受付で断った件数は 1 から 0、通した件数は 10 から 3 になった（133-stageP2/P4-compare.txt。各1回の小さな標本）。効かなくても受付で断られるので、守りは変わらない。【事実】この変数なしで起動した P3b では本体の自動更新が走って失敗し（133-stageP2/P3b-screen.txt:35「Auto-update failed」）、受付は `downloads.claude.ai` を4回断った（P3b-proxy-log.txt）。【事実】公式資料 env-vars では、この変数は空でない値で自動更新・テレメトリ・エラー報告・リリースノート・機能の印の取りに行きを止める（133-stageP2/P-summary.txt の P4 に写した記述）。受入の対話の1回で、`downloads.claude.ai` の断りが0件であることを確かめる。

### 4-5 起動の形と確かめ

- `ccdiscordcase`（`ops/shell/ccdiscord.zsh`）:
  - 最後の起動（:51 の `command "$claude_bin" …`）を `exec "$sandbox_exec" -f "$AC_CASE_ROOM" -D TTY="$(tty)" "$AC_CLAUDE_BIN" …` に替える（`sandbox_exec` は :6 で既定 `/usr/bin/sandbox-exec`。件の役割では `claude_bin` と PATH を使わない）。`AC_CLAUDE_BIN` と room.sb の claude の道が違うときは、サーバーの起動の確かめ ⑫ で開かない（§4-1 の表）。`AC_CASE_ROOM`・`AC_CLAUDE_BIN` が無い・読めないとき、`tty` が `/dev/ttys<数字>` でないときは起動しない（今の `AC_CASE_SETTINGS` と同じ扱い）。
  - 足す環境変数: `CLAUDE_CONFIG_DIR="$AC_CASE_HOME"`（§4-2。サーバーは case-home の realpath を `AC_CASE_HOME` で渡す（`server/sessions.ts:403-407` の `AC_CASE_*` の並びに足す）。起動関数は `ccdiscord.zsh:10-13` と同じ形で `-d` を確かめ、unset のあとで export する。サーバーが `CLAUDE_CONFIG_DIR` をそのまま渡すと一番初めの unset で消えるので、その形にしない）・`TMPDIR="$AC_CASE_TMP"`（Bash の囲いを切ると Claude Code が子の一時の置き場を替えなくなる。写し doc-sandboxing.md:529）・`CLAUDE_CODE_TMPDIR="$AC_CASE_TMP"`（今の `ccdiscord.zsh:41` にすでにある。【事実】TMPDIR だけでは本体が `/tmp/claude-501` を開こうとして EPERM で落ちた。公式資料 env-vars の `CLAUDE_CODE_TMPDIR` を T に向けると通った。133-stageP2/P-summary.txt の P2）・`CLAUDE_CODE_OAUTH_TOKEN`（§4-3）・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（§4-4）・`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`（今の `ccdiscord.zsh:39` にある物を残す）・`HTTPS_PROXY`・`HTTP_PROXY`・`https_proxy`・`http_proxy`（受付）・`NO_PROXY=127.0.0.1,localhost`。
  - 消す環境変数（消す物の一覧ではなく、前方一致で消す形に決める）: 起動関数の一番初め（`ccdiscord.zsh:10` からの入力の確かめより前）で1回だけ、`SSH_AUTH_SOCK`・`TMUX`・`TMUX_PANE` と、名前が `CLAUDE_CODE_`・`CLAUDE_`・`ANTHROPIC_` で始まる物と `CLAUDECODE` を全部 `unset` し、そのあとに今の `:32-41` の export と上の足す物が続く順にする（`CLAUDE_CONFIG_DIR`・`CLAUDE_CODE_TMPDIR`・`CLAUDE_CODE_OAUTH_TOKEN`・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`・`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` は消したあとに入れ直す。`AC_CASE_*` と `AC_CLAUDE_BIN` は前方一致に当たらないので残る）。`env -i` の許可の一覧の形は、今の `ccdiscordcase` が PATH・HOME・LANG など多くを受け継いで動いている形を全部書き出す必要があり、漏れで起動が落ちる側の失敗が読みにくいので採らない。【未確認】サーバーの環境に `CLAUDECODE`・`CLAUDE_CODE_ENTRYPOINT`・`ANTHROPIC_API_KEY`・`ANTHROPIC_BASE_URL` などがあるか（`ANTHROPIC_API_KEY` は鍵の環境変数より先に使われる）。前方一致で消すので、あってもなくても部屋には入らない。vitest で、起動関数に上の名前を入れた環境を渡したとき、`sandbox-exec` に渡る環境に前方一致の名前が足す物のほかに残らないことと、`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` と `CLAUDE_CODE_TMPDIR` が入っていることと、`CLAUDE_CONFIG_DIR` が `AC_CASE_HOME` と同じ値であることを確かめる。【事実】試しを Claude のセッションの中から起動したとき、部屋の本体が「Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker」と出した（133-stageP2/P3b-screen.txt）。受け継いだ印で会話の記録が止まると `--resume` が使えないので消す。【事実】G7 の直接の実行では `TMUX` が部屋の中に残った（P5-g7-room.txt）。unset は起動関数で必ず行う。
  - 道だけを渡し、秘密は引数に載せない（今と同じ）。
- 件の `settings.json`: `sandbox.enabled: false` にし、`sandbox.*` の一覧は書かない（部屋が受け持つ）。`permissions`・フック・`--restricted` は今のまま。
- `spawnSession` の確かめ（親 `:384` の①〜⑦）に足す: ⑧ `room.sb` がある ⑨ 受付が待ち受けている（サーバーの中の受付の状態を同期で見る） ⑩ `case-home/<id>/` がある ⑪ macOS の版が記録と同じ（§9） ⑫ `AC_CLAUDE_BIN` が room.sb の claude の literal と同じ文字列で、そのファイルがある（どちらも開くたびに同じ realpath から書く。§4-1 の表） ⑬ tmux で開く（node-pty では開かない。§4-4）。1つでも落ちたら 503。
- 初回の案内と信頼の問い: 【事実】case-home の `.claude.json` に `hasCompletedOnboarding: true` が無いと、対話の形の本体は初回の案内で `platform.claude.com` へつなごうとして受付に断られ止まった（133-stageP2/P3-screen1.txt）。入れると次に信頼の問いが出た（P3-screen2.txt）。【事実】今の `~/.claude.json` では、信頼済みのフォルダは `projects["<道>"].hasTrustDialogAccepted: true` の形だった（133-stageP2/O-trust-key.txt。キーの名前と値だけを見た）。この印を case-home の `.claude.json` に部屋の外から書いて起動すると、信頼の問いは出ず入力待ちの画面になった（P3b-screen.txt。"trust" の文字0件）。サーバーは §4-2 の書き直し（残すキーの許可の一覧）で、毎回この2つの印を書いてから起動する。

### 4-6 活動の受け口

- 件のセッションの活動のフックは、`D/activity/` に書かず、agent-console の番号の新しい入口（例 `POST /api/agent/case-activity`）へ、フックが受けた標準入力をそのまま送る。フックが件の形かどうかは、件の設定でフックに渡す引数で決める（ほかの役割のフックは今のまま）。
- 記録の置き場は1つ: サーバーは `hooks/activity-hook.mjs` の `buildRecord`（:131-182）と `appendRecord`（:193-223）を読み込んで使い、今の `D/activity/events-YYYYMMDD.jsonl` に今と同じ形の1行を書く。別の置き場・別の形を作らない。共用できる形にするための関数の切り出しは便2b-3c で行い、今のフックの出力が変わらないことを vitest で確かめる。
- どの件か、はサーバーが決める（部屋から送られた値は使わない）。決め方は受付の (a) と pid の引き方だけ同じで、本体かの判定は違う（受付は親をたどらない。§4-4）: 受けた接続の送り元の番号から `lsof` で pid を引き、`ps -o ppid=` で親をたどって、サーバーが記録した件の本体の pid（開始時刻も一致）に行き着いたら、その件の出来事とする。行き着かない・引けない・記録が無いときは受けない（401。出来事は落ちるが、ほかのセッションの分に混ざらない）。件の鍵は使わない（親の case-token は全部の件で1つの共有の合言葉なので、どの件かを決められない。親第24版 `:242`）。
- 本文の中の会話の番号（`session_id`）: サーバーが決めた件の会話の番号と違えば受けない。【未確認】サーバーが件の会話の番号をいつ知るか（`D/open-sessions.json` の `claudeSessionId` が最初の出来事より前に入るか）。P6 で確かめ、前に入らなければ「その件で最初に受けた番号に固定し、違う番号は受けない」にし、固定した番号は件の `case.json` と同じ置き場（`D/cases/<id>/`）に書いて、サーバーが起き直っても消えないようにする。【推測】部屋の中からほかのセッションの会話の番号は読めない（H を塞ぎ、`D/open-sessions.json` も塞ぐ）ので、固定の前に偽の番号を出される穴は小さい。G4 でその読めないことを確かめる。
- 入口の作りは今の `/api/agent/*` の形にそろえる（Origin があれば 403。`server/http.ts:388-415`）。
- 弱さ: Bash の子は自分の件の偽の出来事を送れる（本体の子孫なので見分けない）。ほかのセッションの分には書けない（親をたどって別の件の本体に行き着かない限り）。部屋の外へ抜けたプロセス（親が launchd に替わった物）は、たどれないので受けない。§5 に書く。
- 【事実】`-p` の4回で、活動のフックの送り元の pid から親をたどると本体 claude の pid に行き着いた（例: 28466 → 28258。133-stageP2/P-console-log.txt）。この入口を作る。【未確認】対話の形からの送り（段階 P ではプロンプトを送れなかった）と、会話の番号を固定する時期。実装の受入（G5）で確かめる。

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
| Bash の子が case-home の `.claude.json` に MCP の設定などを書き足す | 起動の前に毎回、部屋の外で残すキーの許可の一覧の形に書き直す（§4-2）。【未確認】セッションの途中で本体が読み直すか。G3 の途中の読み直しの確かめで見て、効いたら止めて PO へ戻す（§1 の G3）。効くとしても部屋の中に留まり、受付と部屋の規則は変わらない |
| Bash の子が case-home の管理者の設定の写し（`remote-settings.json` など (B)）を書き換え、次の起動で見張りを弱める | (B) を書き込みの拒否と作成・削除の塞ぎに入れる（§4-2・§4-1 の規則の順 3・4）。本体が動かなければ「起動前に部屋の外で消す」に替え、そのときはセッションの途中の読み直しを【未確認】として G3 で見る |
| Bash の子が (A) の記録（`projects/<W>/memory/` の自動の覚え書き・`projects/` の会話の記録（`--resume` で読み直される）・`session-env/`・`teams/`）を書き、次の起動や再開の本体の文脈に入る | 本体が書く記録の置き場なので塞がない（§4-2 の (A)）。件ごとの置き場で、ほかの件には効かない。【事実】今の Bash の囲いは CLAUDE_CONFIG_DIR の中身の多くを Bash から書かせない（写し 81-recon2b3/doc-sandboxing.md:543）ので、この点は今より弱い。効くのはその件の中だけで、W の外への書き込みと通信は部屋が塞ぐ（G3・G4） |
| ログインの鍵の期限（1年）が切れて件が動かなくなる | 期限の1か月前に知らせる（§9）。切れたら起動の確かめで落ちる側になる |
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
- 段階 P の結果（2026-10-28〜29。記録 /private/tmp/CC報告ファイル/discord-pdca-bin2/131-stageP/ と 133-stageP2/。費用 0.647＋0.118＝約0.77 ドル（約120円。1ドル156.40円・2026-10-23）で上限 1.5 ドルの内）:
  - P0: Bash の囲いの規則は取り出せなかった（131 の P0）。比較はしない。
  - P1: 升3 に決めた（§4-3）。
  - P2: 本体ごと部屋に入れた形で git・npm・rm・mv・見張り・活動のフックが動いた。止める条件に当たる物は要らなかった。足す物は §4-1（git の設定のファイル4つ・作成の拒否・入れ子の .git の移動の塞ぎ）と §4-5（`CLAUDE_CODE_TMPDIR`）。害の無い拒否（dtracehelper・diagnosticd・`~/.claude` の下の覗き・`~/.npmrc`・`T/cc-socks/<pid>.sock` の bind・setuid の実行など）は足さない。`T/cc-socks` の bind が要る機能は【未確認】で、拒否のままで動いた。
  - P3: 2つの印で問いが消えた（§4-5）。
  - P4: §4-4 のとおり。
  - P5: G7 の道のうち、`osascript`・`open`・`launchctl submit` と `list`・部屋の外への `kill`・`ps eww`・`pbpaste` は失敗した（133-stageP2/P5-g7-room.txt）。`SSH_AUTH_SOCK` は unset で渡しただけで、つなぐ試しは無い。【未確認】`tmux -L agent-console` への接続・`SSH_AUTH_SOCK` のソケットへの接続・`launchctl bootstrap`。G7 の受入で試す（`TMUX` を残した対照も G7 に入れた）。ハードリンクで部屋の外の物を引き込むことはできなかった。【未確認】Bash から出て一瞬で終わる git 自身の測り（親の zsh は部屋の中と確かめた）。G1 は実装のあと、本物のセッションで `git` を長く待たせる形（例 `git commit` の編集の待ち）を1回入れて測る。
  - P6: (a) で決めた（§4-4）。活動の入口も作る（§4-6）。
  - 守れなかった点: 対話の形の起動はカードの上限2回に対して4回（2回は起動の失敗、1回は追加の指示）。追加の費用は0。
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
- ログインの鍵の期限: 鍵を作った日（2026-10-28）を `<dataDir>` の記録に書き、作ってから11か月を過ぎたら、毎週の点検で PO に作り直しを知らせる（作り直しは PO の手の操作。§4-3）。
- claude の自動の入れ替え: 件を開くたびに realpath を解き直して room.sb と `AC_CLAUDE_BIN` に同じ値を書くので、入れ替わっても次に開くときに新しい道になる。起動の確かめ ⑫ は書いた2つが同じ文字列で、ファイルがあることを見る。開いている間に古い版の置き場が消えたら、起こし直しの exec が失敗して開かない側に倒れる。`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` で部屋の中の本体は自動更新を止める（公式資料の記述。受入で `downloads.claude.ai` の断り0件を確かめる。§4-4）ので、入れ替えは部屋の外の普段のセッションで起きる。
- 守り手: agent-console の設計の担当（Opus）。

## 10. 審査の履歴

- 第1版（2026-10-27）: 新しい Opus の審査役（Architect）が REQUEST_CHANGES（/private/tmp/CC報告ファイル/discord-pdca-bin2/125-review-room/review-out.txt）。HIGH 6・MEDIUM 6・LOW 12。第2版で全部を反映した。
- 第2版（2026-10-28）: 新しい Opus の審査役が REQUEST_CHANGES（/private/tmp/CC報告ファイル/discord-pdca-bin2/126-review-room2/review-out.txt）。前回分は H-5・L-4・L-9 が一部だけで、ほかは直った。新しく HIGH 2・MEDIUM 7・LOW 9。根拠の照合は /private/tmp/CC報告ファイル/discord-pdca-bin2/127-verify/out.txt。第3版で反映した: H-A（部屋の中で動く本体以外の物）は §2-1・§4-1 の表と規則の順 2・§4-6・§7 の止める条件・G3/G4/G5、H-B（Keychain の5つの道）は §4-3・G4、M-A は §4-1 の `CASE_ROOM_BASE`・`CASE_ROOM_MACH`、M-B は規則の順の前提と 2、M-C は 3 の入れ子の形と G3、M-D は §4-4 の (a) の見分け方、M-E は §3 の A、M-F は §2-1 の Keychain の記録、M-G は 5 と P2・§7。L-1 は親の第25版の行、L-2 は §4-1 の端末、L-3 は新しい定数5つ、L-4 は升3、L-5 は `sessions.ts:598`、L-6 は 4、L-7 は G3・P5、L-8 は G1、L-9 は §7。
- 第3版（2026-10-28）: 新しい Opus の審査役が REQUEST_CHANGES（/private/tmp/CC報告ファイル/discord-pdca-bin2/128-review-room3/review-out.txt）。前回分は H-A・M-B が一部だけで、ほかは直った。新しく HIGH 2・MEDIUM 5・LOW 7。根拠の調べは /private/tmp/CC報告ファイル/discord-pdca-bin2/129-recon-guards/out.txt。第4版で反映した: HIGH-1 は §2-1 の見張り3種の事実・§4-1 の表（見張り・ボードの見張りの物・件の置き場・件の命令・claude のリンク）・ボードの見張りの扱い・見張りの対処・§5・§7 の止める条件（D の例外を §4-2 とそろえた）・G4/G5。HIGH-2 は §4-6 を接続元の pid で件を決める形に替え（件の鍵に頼らない）、§5・§7 を直した。MEDIUM-1 は規則の順 2 に :671-690、MEDIUM-2 は §2-1 と規則の順の行番号、MEDIUM-3 は規則の順 2 の並び（開け直しの塊にまとめる）と vitest、MEDIUM-4 は §4-6 の記録の置き場、MEDIUM-5 は §2-1・規則の順 3・G3。LOW-1 は §6、LOW-2 は表、LOW-3 は §4-6、LOW-4 は §2-1・規則の順 3、LOW-5 は表と §4-5、LOW-6 は規則の順 1、LOW-7 は規則の順 5。
- 第4版（2026-10-28）: 新しい Opus の審査役が APPROVE（/private/tmp/CC報告ファイル/discord-pdca-bin2/130-review-room4/review-out.txt）。128 の14件は全部直った。条件として、カードの前に MEDIUM 1・LOW 6 を直す。第5版で反映した: MEDIUM-1 は表の件の命令・件の鍵の行と G5（ac-case と case-token は便3 の物）、LOW-1 は規則の順 2 の理由（msu.js:294）、LOW-2 は unlink・create の開け直しに case-home、LOW-3 は端末の許可の置き場、LOW-4 は trustd と指示のファイルの行、LOW-5 は §4-4 の lsof の答え・node-pty と §4-6 の固定の置き場、LOW-6 は表の claude の道を `AC_CLAUDE_BIN` で渡す。
- 第6版（2026-10-29）: 段階 P の結果で分岐を決めた（§7 の段階 P の結果）。升3・(a)・`(param "TTY")`・realpath・case-home の書く物の一覧・`.claude.json` の書き直し・初回の案内と信頼の2つの印・`CLAUDE_CODE_TMPDIR`・`CLAUDE_CODE_CHILD_SESSION` の unset・node-pty で開かない・起動の確かめ ⑫ ⑬・鍵の期限の知らせ。新しい Opus の審査役が REQUEST_CHANGES（/private/tmp/CC報告ファイル/discord-pdca-bin2/134-review-room6/review-out.txt）。HIGH 2・MEDIUM 5・LOW 7。追加の試しは要らないとの判断。
- 第7版（2026-10-29）: 134 の14件を反映した。HIGH-1 は §4-1 の規則の順 3・4 を試しの台本 mkroom.py:109-145 の形に書き直し（作成・削除の塞ぎを W・R・case-home の保護の正規表現の全部に掛ける・入れ子は `^<X>/(.+/)?\.git$`／`\.claude$` で中身と T に掛けない）、G3 に入れ子の `.claude` の回り道と保護の名前の新しい作成、vitest に入れ子の正規表現の形。HIGH-2 は §4-2 で case-home の書いた物を (A) 記録だけ・(B) 設定として読み戻す・(C) `.claude.json` に分け、(B) を拒否（動かなければ起動前に消す）、G3・§5。MEDIUM-1 は §4-2 の残すキーの許可の一覧と【未確認】2つ、`.claude.json` を拒否から外して書き直しに一本化。MEDIUM-2 は §4-4 で受付は親をたどらず pid と開始時刻の一致だけ、記録と食い違った文を消して【未確認】へ。MEDIUM-3 は §7 の P5 と G7（未確認3つと `TMUX` を残した対照）。MEDIUM-4 は §4-1 の表・§4-5・⑫・§9 を「開くたびに書く」に一本化。MEDIUM-5 は §4-5 の前方一致で消す形と vitest。LOW-1 は §4-1 の git の設定、LOW-2 は §4-5、LOW-3 は §4-6、LOW-4 は §4-1 の端末と §4-5、LOW-5 は §4-2 と §5、LOW-6 は §4-4 と §9、LOW-7 は G5。新しい Opus の審査役が REQUEST_CHANGES（/private/tmp/CC報告ファイル/discord-pdca-bin2/135-review-room7/review-out.txt）。134 の14件は全部直った。新しく HIGH 1・MEDIUM 2・LOW 4。追加の試しは要らないとの判断。
- 第8版（2026-10-29）: 135 の7件を反映した。HIGH-1 は §4-1 の規則の順 2・3 と vitest を「(A) と (C) の `.claude.json` の literal だけ・case-home の丸ごとの書き込みは採らない」に、試しの形との違いを【未確認】で明記し、§4-2 に受入の最初の確かめ（拒否を名前ごとに数える・`.claude.json` の書き込みを見る・一時のファイルの名前の足し方）、(B) は既定でも拒否で名前の拒否は2重の守り。MEDIUM-1 は保護の道に `.claude/workflows`・`.claude/scheduled_tasks.json`（doc-sandboxing.md:540）と G3。MEDIUM-2 は §4-5 で unset を起動関数の一番初めに1回・`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` を入れ直す物に・`CLAUDE_CODE_TMPDIR` は今の :41 にある・vitest。LOW-1 は G3 に同じセッションの途中の読み直し。LOW-2 は §5 の (A) の記録の行。LOW-3 は room.sb を一時の名前に書いて付け替える。LOW-4 は規則の順 3 の形の書き方と大文字小文字を変えた (B) の名前の vitest。新しい Opus の審査役が APPROVE（条件付き・再審査は不要。/private/tmp/CC報告ファイル/discord-pdca-bin2/136-review-room8/review-out.txt）。135 の7件は全部直った。条件は MEDIUM 2・LOW 3。
- 第8.1版（2026-10-29）: 136 の条件5件を反映した。MEDIUM-1 は §4-5 で case-home の道を `AC_CASE_HOME` で渡し、unset のあとで `CLAUDE_CONFIG_DIR` に入れる形と vitest。MEDIUM-2 は規則の順 2・3 に (A) の置き場は subpath・ファイルは literal、vitest は「case-home の根の subpath が無い」。LOW-1 は §4-2 の受入の最初の確かめに一時の名前の足し方。LOW-2 は §5 の `.claude.json` の行に G3。LOW-3 は §4-1 の room.sb の書き込みの失敗は 503 と G6。
