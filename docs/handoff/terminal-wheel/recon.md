# 端末ホイール（terminal-wheel）recon

- 調べた担当: Sonnet（R1〜R3）。行番号は origin/main 078c9e4。下の3節は /tmp/CC報告ファイル/terminal-scroll-history/recon*/facts.md を写したもの（生出力の原本は同じフォルダ）。
- 既存 ADR の検索: agent-console に専用 ADR は無い。UI 文字列は ADR-027 に従う（今回は追加なし）。

## R1（recon/facts.md）

# terminal-scroll-history recon facts (読むだけ)
worktree: /Users/tanizawashingo/agent-console-wt/terminal-scroll-history  HEAD=078c9e4483d1d1bd81481262e0ca23cc2c71fe9c (origin/main, v0.28.0)
生出力: grep1.txt tmux-grep.txt tmux-live.txt（同ディレクトリ）

## A 端末スクロール
- 【事実】xterm 版: package.json:22 "@xterm/xterm": "6.0.0"、:21 addon-fit 0.11.0、:41 @xterm/headless 6.0.0。node_modules 実物も 6.0.0 / 0.11.0（借りたリンク経由）。addon-search は package.json に無い（node_modules/@xterm は addon-fit,headless,xterm のみ）。
- 【事実】Terminal 生成: src/components/TerminalPane/TerminalPane.tsx:102-107。渡す物は scrollback: 2000（:14,:103）、smoothScrollDuration: 0（:105）、...readTerminalAppearance()（:106、theme/fontFamily/fontSize）。scrollSensitivity・fastScrollSensitivity・fastScrollModifier の指定は無い（既定のまま。既定 smoothScroll 0 / sensitivity 1 / fastScrollSensitivity 5: docs/handoff/v0.7.0-terminal-ux/recon.md:123）。
- 【事実】自前 wheel 処理: TerminalPane.tsx:175-184。host に capture/passive の wheel リスナーを付け、src/components/TerminalPane/wheelClassifier.ts（VS Code 方式）で「物理ホイールか」を判定。物理ホイールと判定された時だけ term.options.smoothScrollDuration = smoothScrollMs（:182）、トラックパッド等は 0。preventDefault や scrollLines は呼ばない。attachCustomWheelEventHandler は未使用。
- 【事実】smoothScrollMs の出所: agent-console.config.json:25 terminalSmoothScrollMs=125 → server/config.ts:193-196,296 → server/http.ts:151 (/api/state) → src/pages/ConsolePage.tsx:527 → TerminalPane :49,:56,:72。
- 【事実】tmux 設定: ops/tmux/agent-console.tmux.conf:14 `set -g mouse off`、:32 history-limit 2000。起動: server/terminal-host/tmux-protocol.ts:21 `-u -L <socket> -f <conf>`（既定ソケット名 "agent-console": server/sessions.ts:207、conf=sessions.ts:195）。new-session -d: tmux-runner.ts:82。表示は control client `tmux -C attach-session`（tmux-terminal.ts:98）。起動時 source-file で設定読み直し（tmux-runner.ts:97）。
- 【事実】実測（読むコマンドのみ、tmux 3.8、`tmux -L agent-console`）: show -g mouse = off、history-limit = 2000。list-panes（tmux-live.txt）: Claude が動く 11 pane は全て alternate_on=1 / mouse_any_flag=1 / mouse_sgr_flag=1 / history_size=0。bash の 1 pane は alt=0 mouse=0 hist=0。
- 【事実】経路（既存記録）: docs/handoff/keep-sessions/step0.md:53 「claude 実行中の xterm.js は mouseTrackingMode:any。ホイールは \e[<64;23;12M として claude へ送られ、xterm.js のスクロールバックは動かない（viewportY 0, baseY 0）」。同:104,175 mouse off でも追跡中のホイールは中へ届き copy-mode に入らない。つまり Claude 実行中は wheel → xterm がマウス信号化 → WebSocket → tmux → Claude（Claude 自身の TUI が行単位でスクロール）。xterm のバッファ・smoothScrollDuration は効かない（alt 画面にスクロールバック無し）。※この xterm の挙動は step0.md の実測の引用。今回の再測定はしていない【未確認】。
- 【事実】再接続時の先入れ: tmux-protocol.ts:233-252 buildReplay（capture-pane の履歴＋通常画面→alt なら ?1049h→モード復元）。TerminalPane.tsx:142 で term.reset() してから描き直す。
- 【事実】xterm 6.0.0 typings（node_modules/@xterm/xterm/typings/xterm.d.ts）: smoothScrollDuration :271-275「origin から target まで滑らかにスクロールする ms。0 で即時」、scrollSensitivity :267-269「通常スクロール速度の倍率」、fastScrollSensitivity :111-113「Alt 押下時の倍率」、scrollback :246-251 既定 1000、attachCustomWheelEventHandler :1075-1099。fastScrollModifier は 6.0.0 の typings に grep で見つからず。
- 【事実】Context7: resolve-library-id が "Monthly quota exceeded" で使えなかった。上は typings 直読み。

## B 最近の入力履歴
- 【事実】描画: src/components/ActivityPane/ActivityPane.tsx:285-299（Section id=activity-inputs、ac.activity.inputsTitle=src/locales/ja.json:536 「最近の入力」）。li は text と ago(now-ts) のみ。onClick 無し。型 ActivityInput={ts,text}: src/types.ts:223-226。右欄の入れ物: src/components/RightPane/RightPane.tsx:33。
- 【事実】出どころ: hooks/activity-hook.mjs:155-162 が UserPromptSubmit で {ts,event,session_id,prompt} を dataDir/activity/events-YYYYMMDD.jsonl（UTC日付）に追記（server/activity.ts:2,190）。実ファイル ~/Library/Application Support/agent-console/activity/events-20261014.jsonl の UserPromptSubmit 行のキーは ts(int)/event/session_id/prompt のみ。server/activity.ts:444-454 applyPrompt が previewOf（空白整形・先頭80字 :25,:107-110）にして inputs（保存 20 件 :19、表示 3 件 :12,:501）に入れる。担当の戻り（source=agent）は除外 :446。
- 【事実】「場所」情報: 持つのは ts（ミリ秒）と Claude の session_id（hook の値）と本文のみ。行番号・バイト位置・tmux/xterm の行・端末出力側の時刻印は記録されない。session_id は Claude の会話ID で、tmux セッション名(ac-…)とは別。
- 【事実】端末出力側: 画面の出力は ws で流すだけ（TerminalPane.tsx:146 term.write）。出力に時刻・行番号の印は付かない。Claude 実行中の xterm は alt 画面でスクロールバック 0 行（上記）、tmux history_size=0（tmux-live.txt）。Claude の過去画面は Claude 自身の TUI の中にある。
- 【事実】使える API（xterm 6.0.0 typings）: scrollToLine(line) :1233、scrollLines :1211、scrollPages :1217、scrollToTop/Bottom :1222/:1227、registerMarker(cursorYOffset) :1147（normal buffer 用と記載）、IMarker.line :483-495、onScroll :990、onLineFeed :957。search アドオンは package.json に無い（追加が要る。版・API 名は【未確認】）。
- 【事実】作るとしたら要る物（事実として分かる範囲）: ①入力が端末のどこに出たかの記録（現状なし）。②Claude 実行中は xterm のバッファに履歴が無いので scrollToLine の対象が無い（Claude の TUI 側の位置は外から取れる情報が今は無い）。通常画面(alt=0)のシェル pane では registerMarker / scrollToLine が理屈上使える【推測】。③再接続で term.reset()（:142）されるとバッファ内の位置は作り直しになる。

## R2（recon2/facts.md）

# recon2 facts (読むだけ。claude 版 2.1.299)
生出力: measure.txt cap-*.txt claude-help.txt（同ディレクトリ）

## 1 Claude Code の alt screen / マウス設定
- 【事実】Context7 resolve-library-id は "Monthly quota exceeded" で使えず。公式を WebFetch で直読み。
- 【事実】https://code.claude.com/docs/en/fullscreen : fullscreen rendering は alternate screen を使い、マウスを捕捉する。切替は `/tui fullscreen|default`（settings の `tui` に保存）、env `CLAUDE_CODE_NO_FLICKER=1`（fullscreen、tui 設定より優先）。
- 【事実】https://code.claude.com/docs/en/env-vars : `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` = classic（native scrollback、tui 設定・NO_FLICKER より優先）／`CLAUDE_CODE_DISABLE_MOUSE=1` = fullscreen のままマウス追跡だけ切る（ホイール不可、PgUp/PgDn 可）／`CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` = ホイールは残しクリック・ドラッグ・hover を切る（v2.1.195+、DISABLE_MOUSE が優先）。
- 【事実】fullscreen 頁「Mouse wheel scrolling」: ホイールは端末が notch ごと1イベントを送るだけだと遅く感じうる。`CLAUDE_CODE_SCROLL_SPEED`（正の値〜20、小数可、3 が vim 相当）で倍率、`/scroll-speed` で対話調整（~/.claude/settings.json に保存）。ホイール加速は既定で有効、`wheelScrollAccelerationEnabled=false`（settings.json、v2.1.174+）で切れる。`autoScrollEnabled` は /config で追従切替。
- 【事実】fullscreen 頁「Fullscreen by default」: 設定が無くても、2026-05-06 以降の初回利用者などは fullscreen が既定。保存した `tui` 設定はその行より優先される。
- 【事実】fullscreen 頁「Use with tmux」: tmux 内でホイールを Claude に届けるには tmux `mouse on` が必要（無いと tmux に行く）。
- 【事実】`claude --help`（claude-help.txt）に alt screen/mouse/tui/fullscreen を決める引数は無し（grep で `--ax-screen-reader` と render の説明文のみ該当）。
- 【未確認】CLAUDE_CODE_SCROLL_SPEED の env-vars 頁の行そのもの（頁の後半71,040字は未読。fullscreen 頁の記述のみ確認）。settings-reference の tui/wheelScrollAccelerationEnabled 詳細項（頁が長く後半未読。索引行のみ確認）。

## 2 agent-console の Claude 起動
- 【事実】agent-console.config.json:42 sonnet-impl command=["/bin/zsh","-ic","claude --model sonnet"]、:45-46 resume/restore も同形。opus-designer は `/bin/zsh -ic ccopusgo`（config 内 role 定義、restore は `ccopusgo --resume "$AC_RESUME_ID"`）。shell 役は `/bin/zsh -i`。agent-console.config.json:7 claudeBin="claude"（メタ取得用 --version/auth/agents のみ）。
- 【事実】環境: server/sessions.ts:94-107 buildChildEnv = 親 env から BLOCKLIST(AGENT_CONSOLE_TOKEN 等 server/config.ts:221)を除き、terminalEnv(agent-console.config.json:12 は LANG=ja_JP.UTF-8 のみ)を重ね、`TERM=xterm-256color` を固定(:104)。tmux new-session に `-e K=V` で渡す(server/terminal-host/tmux-runner.ts:82-83、sessions.ts:449-450)。CLAUDE_CODE_* を設定するコードは agent-console 側に無し(grep: server/ の CLAUDE_ ヒットは無関係)。
- 【事実】agent-console 側の追加設定は ops/tmux mouse off（前回 facts.md）。ただし Claude が mouse any を要求している間は、前回 step0.md の記録どおり信号が中へ届く。

## 3 PO の普段の起動との差
- 【事実】~/.zshrc: alias cc="cd ~/salesanchor && git checkout develop ... && claude"(:8)、sa() { cd ~/salesanchor && claude --permission-mode auto }(:143)、他 ti/crm/bay は `claude` 素。ccopusgo は ~/.claude/shell/ccopusgo.zsh 内で `command claude --model opus --effort <medium|high> --permission-mode auto --append-system-prompt <役割文> [--resume ..]`。どれも CLAUDE_CODE_* env・表示/マウス引数は付けない（.zshrc/.zshenv/.zprofile/.claude/shell を grep: SCROLL/DISABLE_MOUSE/NO_FLICKER/ALTERNATE_SCREEN ヒット0）。
- 【事実】~/.claude/settings.json:321 `"tui": "fullscreen"`。wheelScrollAccelerationEnabled / autoScrollEnabled / CLAUDE_CODE_SCROLL_SPEED の指定は無い（grep ヒット0）。~/.claude/settings.local.json は無い。
- 【事実】違い: (a) 起動コマンド・引数・effort は実質同じ形で、display/mouse に関わる差は無い。(b) どちらも tui=fullscreen（同じ settings.json を読む）ので、PO の普段のターミナルでも Claude は alt screen+マウス追跡で動く。(c) 差が出るのは Claude の外側: 端末エミュレータ（PO が普段使う物は【未確認】）対 agent-console の xterm.js 6.0.0（TERM=xterm-256color 固定、間に tmux -C control mode）。ホイールのイベント量・倍率は fullscreen 頁の記述どおり端末側が決める。
- 【未確認】PO が普段使う端末エミュレータの種類と、その wheel 倍率設定。

## 4 実機比較（専用ソケット relay-recon-scroll、-f /dev/null、200x50、cwd=/Users/tanizawashingo/salesanchor、指示は送らず）
- 【事実】信頼確認が未信頼 cwd で出た(capA-1.txt: "Quick safety check: Is this a project you created or one you trust?" / "No, exit" / "Yes, I trust this folder")。この時点は alt=0。記録して kill、信頼済み cwd に変更。
- 【事実】測定値（measure.txt）alternate_on / mouse_any_flag / mouse_sgr_flag:
  - `claude`（settings の tui=fullscreen そのまま）: 1 / 1 / 1（14秒後・28秒後とも）
  - `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude`: 0 / 0 / 0（classic UI が表示: cap-tB.txt）
  - `CLAUDE_CODE_NO_FLICKER=0 claude`: 0 / 0 / 0（classic UI: cap-tD.txt）
  - `CLAUDE_CODE_DISABLE_MOUSE=1 claude`: 1 / 0 / 0（28秒後。14秒時点は alt=0 で描画前: cap-tC.txt 空）
- 【事実】後始末: `tmux -L relay-recon-scroll kill-server` 済み、"no server running" を確認。agent-console ソケット・127.0.0.1:4319 は操作せず。
- 【事実】副作用: salesanchor を cwd に claude を起動したため、起動時 hook(SessionStart 等)が走った可能性あり【未確認】。プロンプトは送っていない。

## R3（recon3/facts.md）

# recon3 facts (読むだけ/測るだけ)
生出力: terminal-app.txt tmux-clients.txt xterm-src-wheel.txt measure-wheel-dpr1.json measure-wheel-dpr2.json probe-trackpad.txt harness/(index.html run.mjs probe.mjs)

## 1 PO の端末
- 【事実】実行中の端末アプリは検出できず（ps に Terminal/iTerm/ghostty/Warp/wezterm/kitty/alacritty 無し: tmux-clients.txt）。/Applications に iTerm/Ghostty/WezTerm/kitty/Alacritty/Warp 無し（Claude Code URL Handler.app のみ該当語）。/System/Applications/Utilities/Terminal.app は 2.15 が存在。com.apple.Terminal: Default/Startup プロファイル Basic / "Clear Light"、スクロール・マウス系キー無し（terminal-app.txt）。
- 【事実】本セッションの env: TERM=tmux-256color / TERM_PROGRAM=tmux 3.8。default サーバの tmux client は全て termname xterm-256color。
- 【事実】トラックパッド: com.apple.AppleMultitouchTrackpad Clicking=1, ActuateDetents=1。-g com.apple.scrollwheel.scaling=1 の出力あり。
- 【未確認】PO が普段使う端末アプリは特定できず（Terminal.app が唯一の候補だが使用の証拠は無い）。
## 2 xterm.js 6.0.0 のマウス追跡時 wheel (node_modules/@xterm/xterm/src, xterm-src-wheel.txt)
- 【事実】src/browser/CoreBrowserTerminal.ts:641-657: wheel→customWheelEventHandler→deltaY==0なら無視→coreMouseService.consumeWheelEvent。戻り lines==0 なら送らない。lines は 0/非0 の判定にしか使われず（:666-682 triggerMouseEvent は1回、UP/DOWN 1つ）。つまり wheel 1イベント→最大1信号（lines が 5 でも1つ）。
- 【事実】src/common/services/CoreMouseService.ts:241-269 consumeWheelEvent: amount=deltaY*scrollSensitivity（Alt/Ctrl/Shift で*fastScrollSensitivity）(:271-276)。DOM_DELTA_PIXEL: amount/=cellHeight/dpr; |deltaY|<50 は「トラックパッド」とみなし *0.3 (:257-259); _wheelPartialScroll に蓄積し整数部のみ放出 (:262-264)。DOM_DELTA_PAGE: *rows。DOM_DELTA_LINE は倍率なしでそのまま amount。
- 【事実】smoothScrollDuration は Viewport.ts:45-50（バッファのスクロール）だけが参照。マウス信号の数には効かない（実測も不変）。
- 【事実】wheel リスナ: マウス追跡有効時 passive:false で登録 (:755)。
## 4 実測 (Chromium/Playwright, xterm 6.0.0, DOM renderer, 100x24, cell h=17px, dpr=1, mouse mode vt200(1000h)+SGR1006; measure-wheel-dpr1.json)
| 条件 | smooth 125 sens1 | smooth 125 sens3 | smooth 0 sens1 | smooth 0 sens3 |
|---|---|---|---|---|
| (a) deltaY=100 x5 @50ms | 5信号 | 5 | 5 | 5 |
| (b) deltaY=4 x25 @16ms | 1 | 5 | 1 | 5 |
- 【事実】(a) は 1 wheel→1信号 `\e[<65;34;12M`（5イベント→5信号）。sens3 でも信号数は同じ（1イベント1信号の上限）。(b) は sens1 で 25イベント→1信号（4/17*0.3=0.07/イベントを蓄積）、sens3 で5信号。smoothScrollDuration の違いで数は変わらない。
- 【事実】dpr=2 では Playwright の mouse.wheel(0,4) がブラウザに deltaY=2 で届く（probe-trackpad.txt）。dpr2 の結果は measure-wheel-dpr2.json（(b) sens1:0 信号, sens3:2 信号, (a) 5信号）。
- 【未確認】実機 Mac のトラックパッド/マウスが出す実際の deltaY・間隔・deltaMode。Claude 側で mouse any(1003) のときの挙動（今回は 1000h で測定、wheel 処理は同じコード）。
## 3 agent-console の入力経路（信号1つ=1コマンド、間引き無し）
- src/components/TerminalPane/TerminalPane.tsx:157-158 term.onData → 16KiB(:16)で分割し send({type:"input"}) (:120 ws.send)。throttle/debounce 無し。
- server/ws.ts:36 type=input → sessions.write → server/sessions.ts:488-489 session.term.write。
- server/terminal-host/tmux-terminal.ts:221-234 write: ready 前/replay 中は pendingWrites に積み(上限64KiB :27)、通常は writeNow。:217-219 writeNow→sendKeysCommands→各コマンドを sendNow(:212-215) で control client stdin に `line\n` を即 write。
- server/terminal-host/tmux-protocol.ts:41-49 sendKeysCommands: 1000 バイト(:4)ごとに `send-keys -t <pane> -H <hex...>` を1コマンド。SGR 信号は約10バイト=1 wheel→1 send-keys コマンド。まとめ・間引き・遅延は無し。各コマンドは CommandQueue(:131-151)に積まれ、%begin/%end 応答を待ち受ける（送信自体は応答待ちで止まらず即 write）。
- 【未確認】tmux 側 send-keys 1コマンドの処理時間、WS 往復遅延の実測。
## 5 Claude 公式 https://code.claude.com/docs/en/fullscreen (Context7 は "Monthly quota exceeded" で不可、WebFetch で取得)
- "If mouse wheel scrolling feels slow, your terminal may be sending one scroll event per physical notch with no multiplier. Some terminals, like Ghostty and iTerm2 with faster scrolling enabled, already amplify wheel events. Others, including the VS Code integrated terminal, send exactly one event per notch. Claude Code can't detect which."
- "Set `CLAUDE_CODE_SCROLL_SPEED` to multiply the base scroll distance ... A value of `3` matches the default in `vim` and similar applications. The setting accepts any positive value up to 20, including fractional values below 1 such as `0.25` to slow accelerated trackpad and wheel scrolling in terminals that already amplify wheel events."
- "To adjust scroll speed interactively, run `/scroll-speed`. ... The command writes the same value the `CLAUDE_CODE_SCROLL_SPEED` environment variable sets, persisted to `~/.claude/settings.json`."
- "Separately from the base speed, Claude Code accelerates the scroll rate when you spin the wheel quickly, so a fast spin covers more distance than the same number of slow notches. To turn acceleration off and keep a constant rate per notch, set `wheelScrollAccelerationEnabled` to `false` in settings.json ... v2.1.174 or later."
- "Mouse wheel | Scroll a few lines at a time" (Scroll the conversation の表)。
- tmux: "Mouse wheel scrolling requires tmux's mouse mode ... `set -g mouse on` ... Without mouse mode, wheel events go to tmux instead of Claude Code."
- 後始末: node_modules リンクは rm 済み。agent-console ソケット・4319 は未操作。
