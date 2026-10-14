# アプリを更新しても画面が止まらない（keep-login）現在地の調査

- 基準: origin/main 0a8266c（v0.21.0）。作業場所 ~/agent-console-wt/keep-login（release/keep-login）。
- 調査: Sonnet（生出力 /tmp/CC報告ファイル/update-blank/r1/、/tmp/CC報告ファイル/keep-login/r1/ 01〜12）と Fable の第1版の審査（/tmp/CC報告ファイル/keep-login/review-design1/review.md）。下の行は Opus が読み直して照合した。

## R1 ログインの記録
- server/auth.ts:98 `createAuth(secret, port, options)` は同期の関数。server/index.ts:65 `createAuth(token, config.port)`、試験は tests/unit/helpers/harness.ts:210 `createAuth(TOKEN, port, { now })`。
- server/auth.ts:104-106 codes・sessions・challenges は Map で、メモリだけ。再起動で全部消える。
- sessions の Map のキーは「生のトークン」、値が {digest: sha256(token), expiresAt}（server/auth.ts:199-200）。照合は findByDigest（:116-123）で全件を定数時間比較し、見つかったキーを返す。revokeSession（:202-208）はそのキーで消し、revokedListeners にトークンを渡す。dropOldest（:125-129）は Map の最初（一番古く入れた物）を消す。
- 期限 SESSION_MAX_MS = 12 時間（:17）、上限 MAX_SESSIONS = 64（:7）、トークンは 32 byte の乱数（:4）。
- セッションの有効性は secret に結び付いていない（:131-134 の authenticate は Map に有るかだけを見る）。
- 秘密（secret）はキーチェーンにあり、再起動しても同じ（server/secret.ts:24-35）。

## R2 本番と試験・自己診断のサーバーの区別
- server/restore.ts:165-169 isRestoreEnabled: AGENT_CONSOLE_PORT が未設定（空文字も未設定扱い）のときだけ復元と記録をする。ポートを上書きして起動したサーバー（自己診断・試験・検証用）は、同じ dataDir を読んでも書かない。
- e2e は AGENT_CONSOLE_PORT="" で起動する（playwright.config.ts:47,60）。
- tests/e2e/console.spec.ts:664-666 は dataDir の中身を 7 つの名前に固定して確かめている。

## R3 保存の部品
- server/json-store.ts: readJsonFile（:19-27、壊れていれば例外を投げ、呼び出し側は上書きしない方式）、writeJsonAtomic（:30-35、tmp→rename、ファイル 600、フォルダは新しく作るときだけ 700）。

## R4 画面: 一覧の取得
- src/pages/ConsolePage.tsx:67 最初に fetchState。失敗は 401 なら loadFailed("unauthorized")、それ以外は "error"。
- :68-78 /ws/events。onmessage で snapshot を今の state に重ねる（state が null の間は捨てる、:72）。onclose でトークンがあれば RECONNECT_MS（1 秒）後につなぎ直す（:74-77）。onopen は無い。
- server/hub.ts:574-582 は接続のたびに snapshot（sessions など）を送る。つまり一覧は戻るが、/api/state にしか無い項目（版・commit など、server/http.ts:145-150）と、state が null のときは戻らない。
- :293-301 loadFailed="unauthorized" のとき ja.json:103-104 の案内（「ログインが必要です」「Dock の Agent Console アプリから開き直してください。」）。:302 "error" のとき EmptyState（一覧・チャット・端末が全部消える）。:303 state が null の間は何も描かない（白）。
- ブラウザの WebSocket は、つなげなかった理由（401 など）を画面に渡さない。

## R5 画面: 端末
- src/components/TerminalPane/TerminalPane.tsx:106 `const ws = openSocket("/ws/term", …)`。send（:107-109）と syncSize（:110-115）がこの ws を閉包で持つ。onopen = syncSize（:117）。onclose は無く、切れたらつなぎ直さない。開いていない ws への入力は :108 で黙って捨てる。
- server: 再起動の直後、セッションの ring は空（server/sessions.ts:392）。tmux につなぎ直すと onReplay で ring を今の画面に置き換え、つながっている画面へも送る（server/sessions.ts:404-409）。ws がつながったとき、server は ring の中身を先に送る（server/ws.ts:22-24）。

## R6 白くしない部品
- src に ErrorBoundary は 0 件。SA の部品にあるかは .sa-cache が無く【未確認】。

## R7 更新
- scripts/ac-update.sh → scripts/lib/ac-common.sh:499 `launchctl kickstart -k` でサーバーだけ再起動。Chrome のアプリ窓は開いたまま。起動を待つのは最大 20 秒（scripts/ac-update.sh:38）。

## R8 未確認
- PO の「何も表示されない」がどの経路か（実機で再現していない）。recon r1 10 の EBADF/SIGTERM のログが直接の原因かは判定できない。

## 既存の設計・決まり
- このリポジトリに ADR は無い。設計の正本は docs/handoff/<仕事>/design.md。関係: keep-sessions（v0.20.0、tmux でセッションを保つ）、pairing（ログインの手順）。
