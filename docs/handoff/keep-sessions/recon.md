# recon: 更新してもセッション（端末の中の claude）を切らずにサーバーだけ入れ替えられるか

- 調査日: 2026-10-13 / 基準: `origin/main` = 4b86c9b（v0.12.0）/ worktree: `/Users/tanizawashingo/agent-console-wt/keep-sessions`（ブランチ `release/keep-sessions`）
- 範囲: 事実と選択肢の材料だけ。設計提案はしない。製品コード・設定・本番には変更なし（読み取りと、/tmp・scratchpad での使い捨て実験のみ）。
- ラベル: 【事実】= 実測・ソース・公式文書で確認 / 【推測】= 根拠からの推論 / 【未確認】= 確かめていない

---

## A. 今の作り

### A-1 サーバーが端末を持つ仕組み
- 【事実】node-pty の spawn はここ 1 か所だけ: `server/sessions.ts:268`（`spawn(command[0], command.slice(1), {name:"xterm-256color", cols, rows, cwd, env})`）。node-pty は `package.json` で `"node-pty": "1.1.0"`。
- 【事実】端末はサーバーのメモリ上の `Session` が所有（`server/sessions.ts:46` `term: IPty`）。出力は `term.onData`（:289-294）で `ring`（リングバッファ）に溜め、接続中の WebSocket 全員へ送る。`term.onExit`（:295-298）で `exited = true`。
- 【事実】書き込み・サイズ変更は `write`（:315-317）・`resize`（:319-322）。閉じるのは `close`（:328-357。`term.kill()`＝SIGHUP、猶予後に子孫へ SIGKILL）。
- 【事実】サーバー停止時の処理 `server/index.ts:98-109`:
  ```
  const shutdown = (): void => {
    hub.stop(); activity.stop(); routines.stop();
    // 停止で端末が終わっても、復元リストは書き換えない（再起動のあとに開き直すため）
    sessions.beginShutdown();
    sessions.killAll();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);  process.on("SIGTERM", shutdown);
  ```
  （`shutdown` は :98、`process.on` は :108-109。`sessions.beginShutdown()` は :103、`sessions.killAll()` は :104）。`killAll`（`server/sessions.ts:360-364`）は全 pty に `term.kill()`＝SIGHUP を送る。`beginShutdown`（:242-244）は復元リストを書き換えない印。
- 【事実】つまり今のコードは、サーバーが SIGTERM/SIGINT を受けると**自分から全 pty に SIGHUP を送る**。launchd 任せではない。

### A-2 更新の流れ（file:line）
- 【事実】`scripts/ac-update.sh:14-26`: ロック取得 → `ac_install_version`（自己診断つきで版を導入）→ `ac_switch_current "$tag"`（:20）→ `ac_restart_and_wait "$tag"`（:21）→ 失敗なら `ac_switch_current "$prev"` と再起動で戻す。
- 【事実】`scripts/lib/ac-common.sh:185-188` `ac_switch_current` は `ln -sfn "versions/$tag" "$AC_HOME/current"`（シンボリックリンク切替だけ。プロセスは止めない）。
- 【事実】`scripts/lib/ac-common.sh:403-408` `ac_restart_and_wait` は `"$AC_LAUNCHCTL" kickstart -k "gui/$AC_UID/$AC_LABEL"`（:406）のあと `/healthz` が新しい版・コミットで返るまで待つ。
- 【事実】`man launchctl`（この Mac）: `kickstart [-kp] service-target ... -k If the service is already running, kill the running instance before restarting the service.`
- 【事実】`scripts/ac-rollback.sh:23-27` も同じく `ac_switch_current` → `ac_restart_and_wait`。
- 【事実】サーバーの入れ替え＝プロセスの再起動で、新プロセスは古い current（symlink）の先を読み直す。サーバーのコード・フロント（dist）・hooks はすべて current 配下（`ops/launchd/local.agent-console.server.plist.template` の `__CURRENT__/dist-server/server/index.js`、WorkingDirectory も current）。

### A-3 更新後の開き直し（restore）
- 【事実】`server/restore.ts:105-152` `restoreOnStartup`: 保存リスト（`OpenSessionStore`）の各項目を、作業場所を確かめてから `restoreStaggerMs` 間隔で 1 件ずつ `sessions.restore(...)`（:140）で開き直す。
- 【事実】`server/sessions.ts:206-213` `restore`: Claude の sessionId（UUID）があり役割に `restoreCommand` があれば、環境変数 `AC_RESUME_ID` を渡して `restoreCommand` を起動、なければ通常の `command`。実機の ps（下記 A-5）では `/bin/zsh -ic ccopusgo --resume "$AC_RESUME_ID"` が 8 件、`ccopusgo --resume`（id なし）が 2 件、`ccopusgo`（新規）が 1 件。
- 【事実】保存リストは `OpenSessionRecorder.sync`（`server/restore.ts:65-88`）が作成・閉じる・名前変更・sessionId 判明のたびに書く。`canWrite`（:60-62）は `!sessions.isShuttingDown()` を条件にしているので、停止中は書き換えない。
- 【事実】Claude 公式: `claude --resume` / `--continue` は同じセッション ID で会話を開き直し新しい発言を追記する（https://code.claude.com/docs/en/how-claude-code-works の "Resume or fork sessions"）。トラブルシュート頁にも「Restarting doesn't lose your conversation. Run `claude --resume` ...」（https://code.claude.com/docs/en/troubleshooting）。
- 【推測】「その場の作業が切れる」の中身（実行中のツール呼び出し・承認待ちダイアログ・ストリーム中の応答・バックグラウンドのシェル）は、claude プロセスが終わることで失われる。公式文書で「--resume で何が戻らないか」を列挙した箇所は今回読んだ範囲では見つからなかった → 【未確認】。

### A-4 LaunchAgent plist（実機、読み取りのみ。`plutil -p ~/Library/LaunchAgents/local.agent-console.server.plist`）
```
"KeepAlive" => false
"Label" => "local.agent-console.server"
"ProgramArguments" => [ "/usr/local/bin/node", ".../agent-console/current/dist-server/server/index.js" ]
"RunAtLoad" => true
"WorkingDirectory" => ".../agent-console/current"
"EnvironmentVariables" => { AGENT_CONSOLE_AUTH=keychain, PATH=... }
StandardOutPath / StandardErrorPath
```
- 【事実】`AbandonProcessGroup`・`ProcessType`・`ExitTimeOut` は plist に**無い**（既定値）。雛形 `ops/launchd/local.agent-console.server.plist.template` も同じ項目構成。
- 【事実】`launchctl print gui/501/local.agent-console.server`: `exit timeout = 5`、`minimum runtime = 10`、`runs = 19`、`pid = 29605`。
- 【事実】`man launchd.plist`（この Mac）: `AbandonProcessGroup <boolean> When a job dies, launchd kills any remaining processes with the same process group ID as the job. Setting this key to true disables that behavior.`

### A-5 「サーバーが終わると子の pty と claude はなぜ終わるのか」（実測）
- 【事実】実機の ps（`ps -axo pid,ppid,pgid,sess,tty,stat,command`、本番サーバー pid 29605）:
  ```
  29605     1 29605 ??      S    /usr/local/bin/node .../current/dist-server/server/index.js
  70054 29605 29605 ??      R    claude agents --json            <- サーバーが poll で起こす子（サーバーと同じ pgid）
  29715 29605 29715 ttys003 Ss   /bin/zsh -ic ccopusgo --resume "$AC_RESUME_ID"
  32987 29605 32987 ttys005 Ss   /bin/zsh -ic ccopusgo --resume "$AC_RESUME_ID"
  44069 29605 44069 ttys008 Ss   /bin/zsh -ic ccopusgo --resume
  ... （同様に ttys009/011/013/015/017/019/021/044 の計 11 行。pty 付き 11 件＋ agents --json）
  ```
  pty の子はそれぞれ**自分の pid = 自分の pgid**（pty の新しいセッションのリーダー）で、サーバーの pgid(29605) とは別。
- 【事実】したがって launchd の「同じ process group の残りを kill する」既定は、**pty の子（zsh/claude）には当たらない**（pgid が違う）。当たるのは `claude agents --json` のような pty でない子だけ。
- 【事実】pty の子が終わる経路は 2 つ:
  1. サーバー自身の `killAll`（`server/index.ts:104` → `server/sessions.ts:362`、SIGHUP）。
  2. サーバーが落ちて pty の master fd が閉じたときの端末ハングアップ（カーネルが子へ SIGHUP）。
- 【事実】実験（`/private/tmp/claude-501/.../scratchpad/ptyexit.cjs`、本番の node-pty 1.1.0 を読み込み、`kill` を呼ばずに親の node を `process.exit(0)`）:
  - `sh -c 'exec sleep 77'`: 親の終了 2 秒後に子は**いない**（master を閉じると SIGHUP で死ぬ）。
  - `sh -c "trap '' HUP; exec sleep 78"`: 親の終了後も子は**生きている**（ppid=1、pgid=自分、`Ss+`、tty `ttys025`）。ただし master を握る者が居ない孤児。（実験後に kill 済み）
  → 【事実】SIGHUP を無視する子は、master が閉じても死なない。claude が SIGHUP をどう扱うかは【未確認】（公式文書に SIGHUP/ハングアップの記述は見つからなかった。troubleshooting・cli-reference・how-claude-code-works・agent-view・env-vars を grep）。
- 【事実】node-pty のソース（`/Users/tanizawashingo/agent-console/node_modules/node-pty/src/unixTerminal.ts:236-253`）: `destroy()` は socket を閉じてから `kill('SIGHUP')`、`kill(signal)` は `process.kill(this.pid, signal || 'SIGHUP')`。`src/unix/pty.cc:399` は `forkpty(...)`。
- 【事実】node-pty には「プロセス再起動をまたいで pty を引き継ぐ」API は見つからない（src/index.ts・interfaces.ts を確認した範囲。fd の受け取り口は無い）→ サーバーの再起動で master fd を引き継ぐ手は、node-pty だけでは取れない【推測を含む：fd を別プロセスへ渡す方法は未調査】。

### A-6 今の運用で起きていること
- 【事実】ps の実測で pty 付きセッションは 11 件（上記）。更新＝全 pty の SIGHUP＋再起動後の `--resume` 開き直し、という構造。

---

## B. 選択肢の材料

### B-1 端末の番人（別プロセス）／tmux

**既存の道具（この Mac）**
- 【事実】`which tmux dtach abduco screen`: `tmux`=/opt/homebrew/bin/tmux（`tmux -V`=3.8）、`screen`=/usr/bin/screen、`dtach`・`abduco` は**無い**。
- 【事実】使い捨て実験（`tmux -L kspr -f /dev/null new-session -d -s t1 'sleep 120'`、実験後 `kill-server` 済み）:
  ```
  70305     1 70305 ??     tmux -L kspr -f /dev/null new-session -d -s t1 sleep 120
  70318 70305 70318 ttys022 sleep 120
  ```
  tmux サーバーは ppid=1・自分の pgid・端末なしで自走（呼び出し元の pgid 70242 とは別）。pane の子はさらに別の pgid。→ 【事実】呼び出したプロセスが終わっても tmux サーバーは同じ pgid の kill に巻き込まれない形になっている。launchd 配下から起動した場合に launchd の掃除から逃れるか（`launchctl` 経由の実測）は【未確認】（本番 LaunchAgent に触れないため試していない）。
- 【事実】`man tmux`（3.8）の該当説明:
  - 制御モード `-C`: 「tmux offers a textual interface called control mode ... a client sends tmux commands ... on standard input. Each command will produce one block of output ... %begin ... %end/%error」。通知 `%output pane-id value`（「A window pane produced output. value escapes non-printable characters and backslash as octal \xxx」）、`%exit`、`%sessions-changed`、`%window-close` など。`refresh-client -C` で制御モードのクライアントの大きさを決める。
  - `capture-pane -p -e -J -S -E`: 「-e ... the output includes escape sequences for text and background attributes」「-C also escapes non-printable characters as octal」。画面の途中状態をまとめて取れる。
  - `pipe-pane -O`: 「any output in the pane is piped to shell-command」。`-I` は逆に shell-command の出力を pane に入力として入れる。「A pane may only be connected to one command at a time」。
  - `exit-empty`（既定 on）: 「the server will exit when there are no active sessions」。`exit-unattached`（既定 off）。
- 【事実】xterm.js 6.0.0 を使用中（`package.json`）。ブラウザ側 `src/components/TerminalPane/TerminalPane.tsx:105` は `/ws/term` に WebSocket で繋ぎ、サーバーの生バイト列（`ring.snapshot()` を最初に送る、`server/ws.ts:24-26`）をそのまま xterm に書く。
- 【推測】tmux の制御モードの `%output` は octal エスケープ済みなので、xterm.js へ流す前に戻す変換が要る。tmux の再描画（画面全体を tmux が持つ）の都合で、スクロールバックや選択・マウス・Kitty/画像系のエスケープがそのまま通るかは別途確認が要る。【未確認】（試していない）。
- 【事実】サーバー側で pty の pid に依存する箇所: `server/hub.ts:194,210,232,341`、`server/memory.ts:62,121`、`server/sessions.ts:344-352`（`descendantPids(session.term.pid, ps の一覧)` で子孫を辿り、作業中判定・メモリ・close の SIGKILL を行う）。番人／tmux に置くと、`session.term.pid` に相当する pid（tmux では `#{pane_pid}`）の取り方が変わる。pid の木は同じ Mac の ps で引けるので辿り方自体は使い回せるが、起点 pid の取得が必要【推測】。

**必要な変更（材料）**
- 【事実】pty に直接触る箇所は少ない（E 参照）。`Session.term`（`IPty`）の型を介して 5 メソッド（`onData`・`onExit`・`write`・`resize`・`kill`）と `pid` 参照だけ。
- 【推測】番人を別プロセスにすると、その更新・落下・再接続・認証（UNIX ソケットのアクセス権）・ring の持ち主（今はサーバーのメモリ）が新しい論点になる。tmux を使う場合は ring の代わりに `capture-pane` を使えるが、同じ見た目になるかは【未確認】。
- 【事実】Claude 公式にも似た仕組みがある（B-5 参照）。

### B-2 launchd の AbandonProcessGroup 等で子を残す
- 【事実】`man launchd.plist`: `AbandonProcessGroup`（A-4 に引用）。
- 【事実】A-5 のとおり、pty の子は**もともとサーバーと別 pgid**なので、`AbandonProcessGroup` を足しても pty の子の運命は変わらない見込み（この設定が効くのはサーバーと同じ pgid の残り＝`claude agents --json` 等のみ）【推測：根拠は A-5 の ps の pgid の実測】。
- 【事実】今のコードが自分で `killAll`（SIGHUP）する（`server/index.ts:104`）。子を残すには、これを止める変更が要る。
- 【事実】サーバーが消えると pty の master fd も消える（node-pty はそれを `tty.ReadStream(term.fd)` で保持、unixTerminal.ts:106）。子は master を失った孤児の端末になる。A-5 の実験で、SIGHUP を無視しない子は死に、無視する子は孤児として生き残るが、**誰も master を握らないので出力も入力も届かない**（新サーバーが同じ端末に再接続する手段は node-pty に無い）。
- 【結論材料】AbandonProcessGroup だけでは「生き残ったセッションを新サーバーが再び操作する」ことはできない。再接続するには master fd を握る別プロセスが要る（B-1）。

### B-3 コードだけを止めずに入れ替える（ホットリロード）
- 【事実】サーバーは単一の Node プロセスで、`createServer`・`attachWebSockets`・`SessionManager`（Map とリング）を `main()`（`server/index.ts` の 60 行目台〜）で組み立て、全部ひとつのプロセスのメモリ上にある。
- 【事実】Node の ESM／CJS に標準のホットリロードは無い（Node 24.12.0、実機）。モジュールの差し替えをするなら、状態（`SessionManager` と pty）を差し替え対象から切り離す設計が必要。
- 【推測】`SessionManager`／pty を「差し替えない層」、HTTP ハンドラ・hub・ledger 等を「差し替える層」に分ける設計なら可能性はあるが、同一プロセス内の差し替えは `require` キャッシュ／動的 import の管理・古いタイマー（`hub`・`activity`・`routines` の setInterval）や WebSocket の後始末が増える。B-1 の番人プロセスを作る方が境界は明確【推測】。【未確認】実装コストの見積もりはしていない。

### B-4 `--resume` の開き直しを短くする（更新前に手空きを待つ）
- 【事実】今の更新前の運用（「全セッションの手が空くまで待つ」）は、サーバー再起動で in-flight の作業が切れるのを避けるため。
- 【事実】`server/hub.ts:194,210,232` は各セッションの子孫プロセスから「作業中／手空き／入力待ち」を判定している（`inputVerdict`・`agentForSession`）。全セッションの状態は hub が持つ。
- 【推測】更新の前に「新しい依頼を止めて、手空きのセッションから順に再起動」する案は、現状のサーバーが全セッション一括で落ちる構造のままでは作れない（サーバー再起動＝全 pty 終了）。個別に手空きを待つ運用を短縮できるのは、(a) 手空きを待たずに 1 セッションずつ入れ替える、または (b) 再起動は一括だが復元後に会話を速やかに続ける（`restoreStaggerMs` の短縮など）くらい。(b) は A-3 の `--resume` が前提で、その場の作業は切れる。
- 【未確認】`restoreStaggerMs` の現在値（本番 config は読んでいない）、10 セッション復元に実際何秒かかるか。

### B-5 追加で見つかった材料: Claude Code 自身のバックグラウンドセッション（supervisor）
- 【事実】`claude --version` = 2.1.296（実機）。https://code.claude.com/docs/en/agent-view.md（取得 200）の記述:
  - 「A session started by running `claude` directly is tied to that terminal and ends when it closes, unless you send it to the background.」
  - 「The supervisor is a background service that runs your background sessions so they keep working after you close agent view or your terminal.」各セッションは supervisor 配下の独立した Claude Code プロセス。
  - 「After an auto-update: the supervisor restarts itself onto the new version and moves idle sessions over in the background. Sessions that are working, waiting on you, or attached aren't interrupted.」
  - `claude attach <id|name>`（端末で接続）、`←` / `Ctrl+Z` で detach、`claude --bg "<prompt>"`、`claude respawn <id>` / `claude respawn --all`（更新後のバイナリへ移す）、`claude daemon status|logs|stop --any [--keep-workers]`。
  - 「Shutting down or restarting your machine stops running background sessions ... Within 48 hours, the session shows as failed. Attach or reply to it and it restarts from its saved conversation.」
  - 状態は ~/.claude/daemon/roster.json、~/.claude/jobs/<id>/state.json、~/.claude/daemon.log。
  - 「If you set CLAUDE_CONFIG_DIR, the supervisor ... runs as a separate instance with its own sessions.」
- 【事実】agent-console はすでに `claude agents --json` を poll している（`server/agents.ts:104`）。実機の ps でも `claude agents --json` が見えた。
- 【未確認】`claude attach` を agent-console の pty の中で動かし、その pty だけが消えた（サーバー再起動）とき、背後のセッションが supervisor 配下で動き続けるか。公式文書は detach 操作（`←`/`Ctrl+Z`）の挙動を書くが、attach 側の端末がいきなり消えた場合は書いていない。実セッションを作る実験が要る（トークンを使うため今回は未実施）。
- 【未確認】agent-console 側の hooks（`server/activity-hooks.ts`）・作戦ボード（`CLAUDE_CODE_SESSION_ID`）・チャット送信（端末への貼り付け）が、background session 配下でも今と同じに動くか。
- 【未確認】現在の起動コマンド `ccopusgo`（zsh のエイリアス／関数。ps では `/bin/zsh -ic ccopusgo ...`）の中身。本番 config は読んでいない。

---

## D. 外部の事例

### D-1 Orca（stablyai/orca、clone: `/private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad/orca-src/orca`、HEAD `eaf5dbed9e5fec6046eb8b4835303c40125b8012` = 既存 recon-orca.md と同一）
（本リポジトリ外。パスは clone ルート相対）
- 【事実】Orca は **端末を持つ専用の常駐プロセス（"daemon"）を別に分けている**。src/main/daemon/ にソース 243 ファイル（テスト除く）・合計約 87,000 行（`ls | grep -v test | wc -l` / `cat *.ts | wc -l`）。
- 【事実】src/main/daemon/daemon-launched-child-spawn.ts:60-95: 「detached+unref outlives Electron」。`detached: true`、`stdio: ['ignore','ignore','pipe','ipc']`、`ELECTRON_RUN_AS_NODE=1`（「run as plain Node so Electron's GPU/display init can't interfere with node-pty's posix_spawn」）、cwd は userData（「detached daemons outlive dev worktrees」）。
- 【事実】src/main/daemon/daemon-protocol-version.ts:1: 「// Why: daemons survive app updates, so wire behavior must be version-gated.」`PROTOCOL_VERSION = 44`。古い daemon にも接続できるよう、機能ごとに版番号の境目の定数を持つ（"older owners stay attachable"）。
- 【事実】src/main/daemon/AGENTS.md: ソケットパスの所有（`link`→`rename`、「Never collapse "can't tell" into "dead."」「Do not add a sweeper」）と、その規則を決めた経緯（「Seven review rounds ... produced twenty-three defects」）。ソケットの二重起動・取り違えは「terminals that accept keystrokes and never run them」という事故につながった。
- 【事実】src/main/daemon/daemon-cgroup-scope.ts:1-15（Linux）: 「`detached: true` buys the daemon its own POSIX process group, not its own cgroup ... `systemctl stop/restart` SIGKILLs whatever is left there ... every live terminal dies」→ `systemd-run --user --scope` で別 cgroup へ逃がす。
- 【事実】macOS 用に macos-login-session-death-watch.ts がある（ログインセッションの終了を見る。中身は未読）。daemon-entry の終了処理は `SHUTDOWN_TIMEOUT_MS = 5000`（daemon-entry.ts:181-）。
- 【事実】`docs/audits/daemon-late-exit/`・`daemon-shutdown-descendants`・`daemon-stream-retention` などの監査記録が複数ある（実運用で出た不具合の記録）。
- 【推測】Orca の規模（約 8.7 万行）は、本格的な番人プロセスを自作した場合の上限側の目安。agent-console に要る範囲（ローカル 1 台・1 ユーザー）はそれよりずっと小さい見込みだが、見積もりはしていない。

### D-2 VS Code
- 【事実】https://code.visualstudio.com/docs/terminal/advanced（取得 200）の "Persistent sessions": 「The terminal supports two different types of persistent sessions: **Process reconnection**: When reloading a window ..., reconnect to the previous process and restore its content. **Process revive**: When restarting VS Code, a terminal's content is restored and the process is relaunched using its original environment.」設定 `terminal.integrated.enablePersistentSessions`。
- 【事実】つまり VS Code も「窓の再読込み（プロセスが生き残る）」と「アプリの再起動（内容を復元して再起動＝今の agent-console の restore と同じ型）」を区別している。この頁には pty host プロセスの記述は見つからなかった → pty host の仕組みは【未確認】（今回の取得範囲では出典なし）。

---

## E. 規模の見積もりに要る事実

### E-1 pty に直接触る箇所（`git grep` の全件、テスト除く）
- 【事実】`node-pty` の import は `server/sessions.ts:2` の 1 か所。その `spawn`（:268）が唯一の生成。
- 【事実】`IPty` を持つ `Session.term`（`server/sessions.ts:46`）への触り方:
  - 生成と購読: `server/sessions.ts:268`（spawn）、:289（`term.onData`）、:295（`term.onExit`）
  - 入出力: :316（`term.write`）、:321（`term.resize`）
  - 終了: :346（`term.kill()`）、:362（`killAll` の `term.kill()`）
  - pid 参照: `server/sessions.ts:344,350,352`、`server/hub.ts:194,210,232,341`、`server/memory.ts:62,121`、`server/http.ts:205`（`term: s.term` を memory へ渡す）
  - 起動前の確認: `server/index.ts:30-35`（spawn-helper の実行権）
- 【事実】`term.` を外から触るメソッドは onData・onExit・write・resize・kill と `pid` のみ（`git grep` 結果）。`session.ring`・`session.clients` は `server/sessions.ts:290-291,309` と `server/ws.ts:24,26,39`。

### E-2 流れ（hub・ws・TerminalPane）
- 【事実】ブラウザ `src/components/TerminalPane/TerminalPane.tsx:105` `openSocket("/ws/term", {session})` → `server/ws.ts:97-103` が `/ws/term` を `attachTerminal`（:24-39）に渡す → 接続時に `session.ring.snapshot()`（バックログ）を送り `session.clients.add(ws)`、以降は `sessions.write`（`{type:"input"}`）・`sessions.resize`（`{type:"resize"}`）。
- 【事実】出力は `server/sessions.ts:289-294` の `onData` が `ring.push` ＋ clients へ `ws.send(data)`（生バイト列）。
- 【事実】`/ws/events` は hub（`server/hub.ts:386` 行）が購読者へ送る。hub は端末の出力そのものは見ず、`ps` の子孫（`readProcessTable`、`server/process-tree.ts:52-55`）と `claude agents --json`（`server/agents.ts:104`）、hooks の記録で状態を決める。
- 【事実】`server/` は約 5,950 行（`wc -l server/*.ts`、うち `server/sessions.ts` 367 行・`server/hub.ts` 386 行・`server/ws.ts` 116 行・`server/restore.ts` 168 行・`server/index.ts` 115 行）。

---

## 未確認の一覧（実測が要るもの）
1. claude が SIGHUP を受けたときの挙動（公式文書に記述なし）。`ccopusgo` の中身。
2. `claude attach` を pty 内で動かして pty が消えたとき、背後のバックグラウンドセッションが生き続けるか（B-5）。
3. launchd 配下のサーバーから tmux サーバーを起動した場合に、`launchctl kickstart -k` の後も生き残るか。
4. tmux の制御モード／capture-pane と xterm.js の見た目・スクロール・マウスの相性。
5. 本番 `restoreStaggerMs` の値と、10 セッション復元の実秒数。
6. VS Code の pty host の仕組み（出典が取れていない）。
7. Orca の macOS 側 daemon の終了時の挙動（macos-login-session-death-watch.ts 未読）。

---

## F. 実験（2026-10-13、使い捨て。本番 4319・本番 dataDir・今動いているセッションには触れていない）

スクリプトはすべて scratchpad（`/private/tmp/claude-501/-Users-tanizawashingo-salesanchor/f16867bb-0f82-4b6a-8e6f-be39adca12b1/scratchpad/`）: `bgstart.cjs`・`bgattach.cjs`・`tmuxatt.cjs`。node-pty は agent-console の 1.1.0 を読み込み。

### F-1 Claude 公式のバックグラウンドセッション
(a) 公式の記述（https://code.claude.com/docs/en/agent-view.md、B-5 に引用済み）: 「A session started by running `claude` directly is tied to that terminal and ends when it closes, unless you send it to the background」「The supervisor is a background service that runs your background sessions so they keep working after you close agent view or your terminal」。`claude --bg "<prompt>"`・`claude attach <id|name>`・`claude logs <id>`・`claude stop <id>`・`claude daemon status|stop --any [--keep-workers]`。

(b) 準備: 捨てディレクトリ `.../scratchpad/bgexp`（.claude/settings.local.json に Bash(sleep 30) 等の許可だけ）。起動は `claude --model sonnet --setting-sources project,local --bg "<prompt>"` を node-pty で。
- 初回は workspace trust ダイアログが出た（既定は「No, exit」で、Enter だけだと終了コード 1 で終わる。↓＋Enter で「Yes, I trust」）。この信頼の記録は claude 側が書くもの（この捨てディレクトリ分だけ）。
- 10:25:26 実行 → 出力:
```
Starting background service…
backgrounded · 8de92f57
  claude agents / claude attach 8de92f57 / claude logs 8de92f57 / claude stop 8de92f57
EXIT {"exitCode":0,"signal":0}
```
- 依頼: 「Bash で `sleep 30 && echo DONE` を実行して DONE と答える」。10:26:09 の `claude agents --json --cwd bgexp`: `"pid": 31917, "id": "8de92f57", "kind": "background", "status": "busy", "state": "working"`。

(b続き) 別の node-pty で `claude attach 8de92f57` を実行し、直後に attach している node を SIGKILL:
```
10:26:21  node 32907 attach-client 32917      （node の ppid 32665、attach の tty ttys027）
ps（kill 前）:
 31516 31336 31516 ??     .../ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc-daemon-501/4...
 31917 31516 31917 ttys025 .../versions/2.1.296 --session-id 8de92f57-49d6-4ee2-b4dc-8f3e5562b16a --mo...
 32917 32907 32917 ttys027 claude attach 8de92f57
10:26:23  kill -9 32907
ps（kill 2 秒後）: attach 32917 と node 32907 は消え、31516（--bg-pty-host）と 31917（セッション本体）は残った
```
【事実】背後のセッションは、Claude 自身の **pty ホスト（`--bg-pty-host`、ppid は supervisor 31336）が端末を持っていて**、attach 側の pty とは別プロセス。attach 側の node を SIGKILL しても、セッション本体は同じ pid(31917)・同じ tty(ttys025)で生き続けた。

(c) 結果:
- 10:27:22 `claude agents --json --all`: `"id": "8de92f57", "status": "busy", "state": "working"`（pid 31917 のまま）。
- `claude logs 8de92f57`: attach 側を kill したあとの画面に、`Running 1 shell command ⎿ $ sleep 30 && echo DONE`、「Cooked for 1m 27s · done 10:27」、`Background command "Sleep 30 seconds then print DONE" completed (exit code 0)`、`⏺DONE`（Claude の返事）が出ていた（途中でハーネスが前景の sleep を止めたため、Claude が背景実行に切り替えた）。
- 10:28:15 `claude agents --json --all`: `"status": "idle", "state": "done"`、pid 31917 のまま。
- 再 attach（10:28、新しい node-pty で `claude attach 8de92f57`、10 秒後に SIGKILL）の出力:
```
...ntDONE"completed(exitcode0)⏺DONE✻Cogitated for 11s · done 10:27──── sleep-echo-done-check ─❯ ...⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
```
  → 【事実】結果（DONE）が再 attach で見えた。attach の node を殺しても会話は壊れず、最後の画面が復元されて出た。
- 【事実】attach 側の pty を SIGKILL しても、背後のセッションは作業を続けて完了した。

(d) 後始末: `claude stop 8de92f57` → `stopped 8de92f57`。ps に 8de92f57 の行なし。その後 `claude daemon status` は `not running`（`control.sock: unreachable`、`bg workers: 0 in roster.json`）。【事実】最後のバックグラウンドセッションが止まると supervisor も止まった。今動いている PO のセッションは pty 直起動で、バックグラウンドセッションではない（実験の起動時に "Starting background service…" と出たので、supervisor は実験前は動いていなかった）ため影響なし。

注意（【事実】）: 実験中に以下が起きた。(1) `~/.claude` 配下の supervisor 状態（`~/.claude/daemon/`、`jobs/`）に実験セッション分が作られた（`claude rm 8de92f57` はまだ実行していない＝一覧に done として残る）。(2) trust ダイアログで、捨てディレクトリを信頼した記録が claude の管理ファイルに残った。いずれも捨てディレクトリ分だけ。

### F-2 tmux と launchd
(a) `launchctl submit -l local.acexp.job -- /bin/sh -c "/opt/homebrew/bin/tmux -L acexp -f /dev/null new-session -d -s t1 'sleep 600'; echo submitted-done"`（10:22:52）:
```
launchctl list | grep acexp   →   -  0  local.acexp.job      （job は終了、終了コード 0）
ps（job 終了後 3 秒）:
 8224     1  8224 ??     Ss   /opt/homebrew/bin/tmux -L acexp -f /dev/null new-session -d -s t1 sleep 600
 8229  8224  8229 ttys022 Ss+  sleep 600
tmux -L acexp ls  →  t1: 1 windows (created Tue Oct 13 10:22:52 2026)
```
【事実】launchd の job が終わったあとも、tmux サーバー(8224、ppid=1)と pane の sleep(8229)は生き残った。`launchctl remove local.acexp.job` 済み。
【注意】この job は一回きりで、job の親(sh)は tmux を起動してすぐ終了した（"job が終わる" 時に launchd が同じ pgid を kill する掃除に tmux が巻き込まれないことの確認）。本番の LaunchAgent（`kickstart -k` で node を kill する形）と全く同じ条件ではない。node(サーバー)が tmux を子として起動した場合は未実験【未確認】。

(b) node-pty で `tmux -L acexp attach -t t1`（node 11519、attach-client 11666）→ `tmux list-clients`: `/dev/ttys026: t1 [80x24 xterm-256color] (attached,focused,UTF-8)`。node を SIGKILL した 2 秒後:
```
tmux ls → t1: 1 windows (created Tue Oct 13 10:22:52 2026)
 8224 1 tmux -L acexp ... / 8229 8224 sleep 600      （残った）
list-clients → （空。attach クライアントだけ消えた）
```
再 attach（別 session で再実験。tmux サーバー 19935、sleep 19958）: 1 回目の node(19967)を SIGKILL → 2 回目の node(20106、attach-client 20135)で `list-clients`: `/dev/ttys026: t1 [80x24 xterm-256color] (attached,focused,UTF-8)`、sleep 600 は同じ pid(19958)のまま。
【事実】attach している pty の node を殺しても tmux のセッションと中の sleep は残り、再 attach できた。

(c) `tmux -L acexp kill-server` 済み。`ps | grep -E "tmux -L acexp|sleep 600"` は空。

### F の要点
| 項目 | 結果 |
|---|---|
| Claude 公式バックグラウンドセッション: attach 側の pty の node を SIGKILL | セッション本体は継続（pid 31917 不変、`--bg-pty-host` が端末を保持）。作業完了。再 attach で DONE が見えた |
| 公式の止め方 | `claude stop <id>` で止まった。最後の1件が止まると supervisor も止まる（`daemon status: not running`） |
| tmux: launchd job 終了後 | tmux サーバー・pane の子は生存 |
| tmux: attach 側 node を SIGKILL | セッション生存、再 attach 可 |

【未確認】(1) agent-console の今の起動形（`/bin/zsh -ic ccopusgo`）を `claude --bg` + `claude attach` に置き換えたとき、hooks・作戦ボード（`CLAUDE_CODE_SESSION_ID`）・チャット送信（端末への貼り付け）・`restoreCommand` 周りが今と同じに動くか。(2) 本番の `kickstart -k`（node を SIGTERM）の条件で子 tmux／supervisor が残るか。(3) attach クライアント(claude attach)の大きさ変更（resize）や、スクロール・マウスが xterm.js 越しに正しく動くか。(4) `claude attach` の画面の復元内容（上の再 attach 出力は「最後の画面」。全履歴ではない）。
