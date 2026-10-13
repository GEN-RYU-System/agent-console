# 設計: スマホのホーム画面から agent-console を使う（mobile-pwa）第2版

- 状態: 設計案 第2版＋§14（Opus、2026-10-14）。第1版は Fable 審査で REVISE（/tmp/CC報告ファイル/mobile-pwa/review-design1/review.md）。第2版は Fable 再審査で条件付き APPROVE（Medium 4・Low 5、/tmp/CC報告ファイル/mobile-pwa/review-design2/review.md）。条件の Medium 4 件と Low 5 件は §14 で取り込み済み。工程0の結果で §5 の分岐を確定した第3版を作ってから実装カードを出す。実装未着手。第1版の控え: /tmp/CC報告ファイル/mobile-pwa/design-v1.md
- 依頼（PO 原文、2026-10-14）: 「スマホのアプリ→webアプリでホームアイコンに固定して使用したい、個人利用なので」「まずwifi環境だけで作り、段階的に外出先からも使えるように設計」「配線とDBのSSOTは遵守してデータを分散させることは禁止。フロントエンドのパーツもデザイントークンとデザインシステム を遵守して、金型登録のないハードコードを禁止する」
- PO 決定（2026-10-14）: つなぎ方は Tailscale（Serve）。プランは無料 Personal（PO 原文「私が個人利用するので無料プランで進める」）。
- 根拠（生出力・引用）:
  - 現状の概要: /tmp/CC報告ファイル/mobile-pwa/recon/recon.md
  - 認証・画面の詳細: /tmp/CC報告ファイル/mobile-pwa/recon2/recon.md
  - 外部事例: /tmp/CC報告ファイル/mobile-pwa/external/cases.md
  - 公式資料: /tmp/CC報告ファイル/mobile-pwa/external2/facts.md
  - Tailscale の信頼性と規約: /tmp/CC報告ファイル/mobile-pwa/tailscale/trust.md、plan-terms.md
  - つなぎ方の比較（PO に示した物）: /tmp/CC報告ファイル/mobile-pwa/options.md
  - 第1版の審査: /tmp/CC報告ファイル/mobile-pwa/review-design1/review.md
- 基準: origin/main f255892（v0.19.0）。

## 1. 目的と成功条件（PO が○×で判定できる形）
目的: iPhone のホーム画面のアイコンから agent-console を開き、Mac の前にいなくても会話の確認・送信・端末の操作ができる。データは Mac の1か所だけに置く。

| # | 基準（○×） | 検証方法 |
|---|---|---|
| K1 | ホーム画面のアイコンから開くと、Safari の枠（アドレス欄）なしで agent-console が出る | PO が iPhone で目視 |
| K2 | Mac の画面に出たコードを、出てから2分以内に iPhone のアプリに打てばつながる。2分を過ぎたコード・一度使ったコードは断られる | 自動試験（期限・使い捨て）＋ PO 実機 |
| K3 | 一度つないだ iPhone は、アプリを閉じて開き直しても、Mac のサーバーが更新・再起動しても、30日間はつなぎ直し不要 | 自動試験（devices.json を読み直したサーバーで端末トークンが通る）＋ PO 実機 |
| K4 | 幅 390px の画面で、会話一覧→会話を選ぶ→チャットで送信→返事が見える | e2e（viewport 390×844）＋ PO 実機 |
| K5 | 端末タブの入力ボタンが §5-6 の表どおりのバイト列を送る | 自動試験（WebSocket に届くバイト列を表と照合）＋ PO 実機 |
| K6 | 画面が表に戻った（visibilitychange）時から3秒以内に端末の WebSocket がつながり直し、同じ文字が二重に出ない | 自動試験（visibilitychange 発火→onopen までの時間、再接続後の画面の文字列が1回だけ）＋ PO 実機（1分裏に回して戻す） |
| K7 | Mac の画面の「つないだ端末」一覧で iPhone を外すと、その iPhone は直ちに使えなくなり、アプリはコード入力画面に戻る | 自動試験（取り消し後の HTTP 401・WebSocket 切断・画面がコード入力へ） |
| K8 | 許可していない Host・Origin（大文字・末尾の `.`・別ポート・別名を含む）からの要求は全部断られる | 自動試験（拒否例の表） |
| K9 | Mac で今までどおり使える（起動用アイコンからのペアリング /pair、Chrome 拡張の部品指定、既存の全試験） | 既存の自動試験・e2e 全件合格＋ PO 目視 |
| K10 | 画面の文言は全部 t() 経由、色・寸法は全部トークン、部品は金型。manifest の色も手書きの値を置かない | lint（check-design-governance.mjs）＋ 生成スクリプトの試験 |
| K11（段階2） | Wi-Fi を切ってモバイル回線だけでも K4 が動く | PO 実機 |
| K12 | Tailscale の管理画面で承認していない端末からは届かない | PO が管理画面で確認（手順を渡す） |
| K13 | 端末トークン（スマホ）では、コードの発行と端末の一覧・削除ができない（403） | 自動試験（Origin を 127.0.0.1 に偽っても 403） |

## 2. 対象と対象外
- 対象: サーバーの許可ホスト・CSP、スマホ用ペアリング、端末トークン（30日・取り消し可）、狭い画面の配置、端末の入力ボタン、端末の再接続、ホーム画面用の manifest とアイコン、README。
- 対象外: Android（PO は iPhone）、通知（プッシュ）、オフライン動作、Service Worker、Mac の待ち受けを 127.0.0.1 以外に広げること、Tailscale Funnel（世界公開）、Chrome 拡張の変更。
- 触らない: ops/launcher/launch.sh の流れ、/api/pair* と launcher 用コードの Map（server/auth.ts:101 の `codes`）、server/picker-extension.ts、extension/、Keychain のサーバー秘密、tmux 保持（PR #35）の範囲。

## 3. 現状（事実の要約。詳細は recon2・審査 §1）
- 待ち受けは 127.0.0.1:4319 固定（server/index.ts:26,82）。接続元 IP で信用する箇所は 0 件（recon2 項目1）。守りは Host・Origin の文字列一致と Bearer 認証。
- Host は `127.0.0.1:<port>` と完全一致のみ（server/auth.ts:159-161、呼び出し server/http.ts:372、server/ws.ts:80）。Origin は `http://127.0.0.1:<port>` のみ（server/auth.ts:155-157、server/http.ts:310,340,395、server/ws.ts:88）。Origin は要求側が付けるヘッダで、ブラウザ以外（curl など）は自由に付けられる。今の Origin 検査は CSRF 対策で、「誰か」の判定ではない。
- CSP は `contentSecurityPolicy(port)`（server/http.ts:362-363）で connect-src が `ws://127.0.0.1:<port>` 固定。呼び出しは server/http.ts:406（HTML のみ、:127）。
- 静的配信の MIME 表（server/http.ts:33-41）に `.webmanifest` が無い（既定は application/octet-stream、:125）。
- 認証の種類は `"bearer" | "session"`（server/auth.ts:44）。ペアリングはサーバー秘密（Keychain）を持つ Mac の launcher だけがコードを作れる（server/auth.ts:162-198、ops/launcher/launch.sh:44-76）。試行回数の制限は無い（256bit に依存）。
- セッショントークンは 12時間・メモリの `sessions` Map のみで、サーバー再起動で全部消える（server/auth.ts:17,102,196）。認証は authenticate（:134-146）、WebSocket は sessionFromProtocols（:147-154）と handleProtocols（server/ws.ts:76）、失効の追跡は sessionTokenOf・isSessionValid・onSessionRevoked（server/auth.ts:206-223）と定期点検（server/ws.ts:109-114）。全部が `sessions` Map だけを見る。
- ブラウザは sessionStorage だけを読む getSessionToken（src/api.ts:16-22）。openSocket も同じ（src/api.ts:183-186）。/ws/events の再接続はトークンがある時だけ（src/pages/ConsolePage.tsx:75）。
- 画面の分岐は `/pair` かそれ以外かだけ（src/App.tsx:6）。トークンが無いと ConsolePage は「未認証」の表示だけ（src/pages/ConsolePage.tsx:66,291-298）。
- 画面は3列固定 `20% 1fr 22%`・`height:100vh`、@media 0 件（src/pages/ConsolePage.css:1-12）。金型は Sales Anchor の frontend/src を @sa で取り込む（scripts/sa-sync.mjs:35、vite.config.ts:5-9）。SA のスマホ幅の上限は `--breakpoint-mobile-max: 767px`（SA frontend/src/tokens.css:113）。SA の Drawer.css:104 も `@media (max-width: 767px) { /* = --breakpoint-mobile-max */` と書く。
- check-design-governance.mjs は src/ と extension/ だけを見る（:57-65）。public/ は見ない。@media の行は除外し、中の宣言は通常どおり検査（:97,119-120）。pages/ の生の button・input などは落ちる（:165-166）。
- 端末の WebSocket は切れても再接続しない（src/components/TerminalPane/TerminalPane.tsx:106-109）。端末の画面は会話を選び直した時だけ作り直す（cleanup の ws.close :197・term.dispose :199、依存 [sessionId] :201）。サーバーは接続ごとにリングの全量を先に送る（server/ws.ts:23-25）。
- SA のトークンから値を解決して写しを作る作法が既にある（scripts/build-picker-tokens.mjs:3,80-103。ビルドの最初に実行、package.json:11）。
- 設定は `AGENT_CONSOLE_CONFIG` か作業場所の agent-console.config.json（server/config.ts:287-289）。本番の作業場所は更新のたびに入れ替わる `~/Library/Application Support/agent-console/current`（~/Library/LaunchAgents/local.agent-console.server.plist の WorkingDirectory）で、そこの config.json は公開リポジトリ（GEN-RYU-System/agent-console は PUBLIC）の追跡ファイル。
- 過去の方針: v0.7.0 の設計（docs/handoff/v0.7.0-terminal-ux/design.md:83）は「スマホは公式 Remote Control、本アプリは 127.0.0.1 のみ」。今回の PO 依頼で置き換える（待ち受けは 127.0.0.1 のままで、Tailscale Serve が中継する）。

## 4. 仕組み（変更後）
iPhone（Tailscale 接続中）→ https://<mac名>.<tailnet>.ts.net（Tailscale が証明書を自動発行）→ Mac の Tailscale Serve → http://127.0.0.1:4319（今のサーバー）。
- Mac の待ち受けは変えない。家の LAN にも世界にも口を開かない。届くのは Tailscale で PO が承認した端末だけ。
- データの正本は今のまま Mac の ~/Library/Application Support/agent-console/ と Keychain だけ。iPhone に置くのは端末トークン1つだけ。
- Mac の名前（*.ts.net）の正本は Tailscale 自身。アプリは起動時に Tailscale から読むだけで、リポジトリにもファイルにも書かない（§5-1）。

## 5. 変更の中身（段階1）
### 5-1 Mac の名前の取り方（審査 M-4・L-5）
- 公開リポジトリの config.json に Mac の名前を書かない。設定に足すのは `remoteAccess: "off" | "tailscale"`（既定 "off"）と `tailscalePath`（既定は工程0で実在を確かめた CLI のパス）だけ。
- "tailscale" のとき、サーバーは起動時と5分ごとに `tailscale status --json` を実行し、`Self.DNSName` の末尾の `.` を除いた名前（例 `mac.tail1234.ts.net`）を「外の名前」としてメモリに持つ。取れない（Tailscale が止まっている・CLI が無い・形が違う）ときは外の名前を空にしてログに出し、Mac の 127.0.0.1 だけで動く（黙って広げない）。
- 名前の形の検査: 英小文字・数字・`-`・`.` のみ、`.ts.net` で終わる。違えば空にしてログ。
- 工程0 (k) で、`tailscale status --json` の `Self.DNSName` の実物と CLI のパスを確かめる。取れなければ設計を止めて改版する。
- "off" なら今と全く同じ動き（K9 の担保）。

### 5-2 許可ホストと CSP（server/auth.ts、server/http.ts、server/ws.ts）
- Host の許可: `127.0.0.1:<port>` と、外の名前から作る形。形は工程0 (a) の実測で次のどちらかに決める。
  - (i) Serve が Host を `<外の名前>` のまま届ける → `<外の名前>` と `<外の名前>:443` を許可。
  - (ii) Serve が Host を `127.0.0.1:4319` に書き換える → Host は今のまま。この時 Host 検査は外に対して効かないので、守りは Origin と認証になる（ブラウザ以外の要求は Tailscale の承認済み端末からしか届かない）。§9 にこの前提を書いている。
- Origin の許可: `http://127.0.0.1:<port>` と `https://<外の名前>`。比較は今と同じ完全一致（大文字・末尾 `.`・別ポートは不一致）。
- CSP: `contentSecurityPolicy(port)` の引数に外の名前を足し（server/http.ts:362）、呼び出し（server/http.ts:406）を直す。connect-src に `wss://<外の名前>` を足す。工程0 (g) で `'self'` だけで https のページから同じ名前の wss が通ると確かめられたら、`'self'` を足す形にしてもよい（どちらにしたかを step0.md に記録）。
- 許可リストは createAuth に「外の名前を返す関数」として渡す（server/auth.ts:95、呼び出し server/index.ts:62）。5分ごとの読み直しで変わっても、比較は毎回その時点の値で行う。

### 5-3 スマホのペアリング（新設。launcher のペアリングとは完全に別）
- 新しいエンドポイント:

| エンドポイント | 用途 | 認証 | Origin |
|---|---|---|---|
| POST /api/devices/code | スマホ用コードを発行 | session か bearer のみ（device は 403） | 許可リスト必須 |
| POST /api/devices/redeem | コードを端末トークンに換える | なし | 許可リスト必須 |
| GET /api/devices | つないだ端末の一覧 | session か bearer のみ（device は 403） | 許可リスト必須 |
| DELETE /api/devices/:id | 端末を外す | session か bearer のみ（device は 403） | 許可リスト必須 |

- 権限の根拠はトークンの種類（審査 H-1）。Origin は今までどおり CSRF 対策として見るが、「Mac かどうか」の判定には使わない。
- コード: 8文字、紛らわしい文字を除いた32種（約40bit）。有効2分・使い捨て。同時に有効なのは1つ（新しく出すと前のは無効）。保持は launcher 用の `codes` Map とは別の場所（ハッシュで保持、定数時間で比較、今の作法と同じ）。
- 総当たり対策: 中継経由では接続元がすべて同じに見えるので、サーバー全体で数える。redeem の失敗が5回で、スマホ用の有効なコードを無効にしてログに残す。失敗の数は新しいコードを出した時に0に戻す。launcher 用のコードと /api/pair* には影響しない（K9）。
- 画面の入口（審査 M-1）: トークンが sessionStorage にも localStorage にも無い時は、どの名前で開いても、`/pair` 以外はコード入力画面を出す（src/App.tsx:6 の分岐に足す）。Mac で直接開いた時もコード入力が出るが、Mac は launcher からつながるので害は無い。`/pair` は今のまま。
- Mac 側: 右の欄（またはヘッダー）に「スマホをつなぐ」ボタン → コードと残り時間を表示。「つないだ端末」一覧（名前・最終使用日時・外すボタン）。部品は @sa の Button・Drawer・TextField、文言は t()。

### 5-4 端末トークン（K3・K7・K13）
- 認証の種類に `"device"` を足す（server/auth.ts:44 を `"bearer" | "session" | "device"` に）。
- 保存（正本）: dataDir の devices.json（mode 600、書き込みは一時ファイル→rename）。中身は id、名前、トークンの SHA-256、作成日時、最終使用日時、期限（30日）。トークンそのものは置かない。起動時に読み、メモリにも持つ。
- 最終使用日時の書き込みは1端末につき1分に1回まで。
- 触る関数（審査 M-3。全部で device を扱う）: authenticate（:134-146）、sessionFromProtocols（:147-154）、sessionTokenOf・isSessionValid（:206-223）、端末の取り消し（新設。onSessionRevoked の通知を使い、その端末の WebSocket を直ちに閉じる。server/ws.ts:67-70 と同じ仕組み）、定期点検（server/ws.ts:109-114。期限切れの device も閉じる）。
- 端末トークンでできることは Mac のセッションと同じ（端末操作を含む）。違いは §5-3 の表の3つ（コード発行・一覧・削除）ができないことだけ。
- ブラウザ側（審査 M-2）: getSessionToken（src/api.ts:16-22）は sessionStorage → localStorage の順に読む。redeem で得た端末トークンは localStorage に置く（launcher の12時間セッションは今のまま sessionStorage）。どの API でも 401 を受けたら両方を消してコード入力画面へ戻す。openSocket（src/api.ts:183-186）と /ws/events の再接続条件（src/pages/ConsolePage.tsx:75）は同じ関数を使うので、読み順の変更が自動で効く。

### 5-5 狭い画面の配置（≤767px）
- 1列にする: 一覧画面（左列の会話一覧）→ 会話を選ぶと全幅のタブ（チャット・ターミナル）と「一覧へ戻る」ボタン。右列（作戦ボード・台帳）は Drawer（SA 金型）で開く。PR・部品・変更・定期実行のタブはスマホでも出す（中身は今と同じ）。
- @media は `@media (max-width: 767px) { /* = --breakpoint-mobile-max（SA frontend/src/tokens.css:113） */` と書く（SA の Drawer.css:104 と同じ作法。CSS の @media の条件にはトークンが使えないため）。中の宣言は全部トークン。
- `height: 100vh` はスマホでアドレス欄・キーボードとずれるので、狭い画面では `100dvh` を使う（工程0 (l) で iOS の standalone 表示での高さを実測）。
- 部品は @sa の Button・Tabs・Drawer・TextField。生の要素は作らない。文言は src/locales/ja.json に足して t()。

### 5-6 端末の入力ボタン（K5）
端末タブの下に1列。押すと今の input と同じ経路で次のバイト列を送る。部品は Button 金型、ボタン名は t()。

| ボタン | 送るバイト列 |
|---|---|
| Esc | `\x1b` |
| Tab | `\t` |
| Ctrl+C | `\x03` |
| ↑ | `\x1b[A` |
| ↓ | `\x1b[B` |
| → | `\x1b[C` |
| ← | `\x1b[D` |
| Enter | `\r` |

矢印のバイト列は xterm の通常カーソルモードの値。工程1で、今の xterm.js が矢印キーで送る実物と同じかを試験で確かめる。違えば実物に合わせ、設計書に追記する。

### 5-7 再接続（K6。審査 M-7）
- 方式は「端末の画面を作り直す」に1本化する。今の cleanup（TerminalPane.tsx:199 の dispose）と同じ道を通るので、サーバーが先に送るリングの全量で画面がまっさらから描かれ、二重表示が起きない。reset 方式は使わない。
- /ws/term が閉じたら（onclose）、1秒・2秒・4秒（上限8秒）の間隔でつなぎ直す。画面が表に戻った時（visibilitychange で visible）は待ち時間を捨てて直ちにつなぎ直す。
- 切れている間の入力は送らず、「つなぎ直しています」を表示（t()）。
- 401 で閉じた時（取り消し・期限切れ）はつなぎ直さず、§5-4 のとおりコード入力画面へ。

### 5-8 ホーム画面用（審査 M-5）
- manifest.webmanifest はビルド時に生成する（scripts/build-picker-tokens.mjs と同じ作法の新しいスクリプト、または同スクリプトの拡張）。theme_color・background_color は SA のトークンから解決した値、name・short_name は src/locales/ja.json のキーから取る。手書きの値を置かない。生成物は .gitignore に入れ、ビルドの最初に作る（package.json:11）。
- 静的配信の MIME 表（server/http.ts:33-41）に `.webmanifest: application/manifest+json` を足す。
- apple-touch-icon（180×180 PNG）は既存のアイコンの元画像から作る（元が無ければ工程1で止めて報告）。index.html に manifest とアイコンの link を足す。
- Service Worker は入れない（WebKit 公式「Safari から作るホーム画面アプリは Service Worker 不要」、external2/facts.md 項目1。工程0 (b) で実測）。

### 5-9 README
- Tailscale の入れ方と守りの設定（新しい端末の承認、Tailnet Lock、ログインアカウントの2段階認証、Mac の名前に個人情報を入れない）、`tailscale serve` の設定、`remoteAccess` の書き方、iPhone のつなぎ方、端末の外し方。

## 6. 工程
- 工程0（実機の事実確認。製品コードは触らない）: 使い捨ての確認用サーバー（scratchpad の小さな node スクリプト、127.0.0.1 の別ポート）を Tailscale Serve の別ポートで出し、iPhone で測る。各項目に「否のとき」を書く。

| 項目 | 確かめること | 否のとき |
|---|---|---|
| (a) | 届いた全ヘッダをそのままファイルに保存（Host・Origin・X-Forwarded-*・Tailscale が付ける識別ヘッダの有無） | §5-2 の (i)/(ii) を選ぶ。識別ヘッダがあれば追加の守りにできるか改版で検討（主の守りにはしない） |
| (b) | ホーム画面から standalone で開けるか（manifest・アイコン） | `apple-mobile-web-app-capable` の meta を足して再測。だめなら止めて PO に報告 |
| (c) | wss がつながるか | 止めて改版（Serve の設定・CSP を見直す） |
| (d) | localStorage がアプリを閉じて開き直しても残るか | 毎回コード入力になる（K3 は×）。PO に報告して方針を決める |
| (e) | Safari とホーム画面アプリで保存場所が別か | 同じなら変更なし（コード入力はどちらでも動く） |
| (f) | 1分裏に回して戻ると WebSocket が閉じているか（onclose が来るか） | 来ないなら、visibilitychange 時に readyState を見て、閉じていなくても作り直す |
| (g) | CSP connect-src 'self' で wss が通るか | 通らなければ明示列挙（§5-2 の既定） |
| (h) | `.webmanifest` の MIME が standalone 判定に要るか | どちらでも MIME は足す（記録のみ） |
| (j) | iOS の版と、ホーム画面のサイトが既定でアプリとして開くか（facts.md 項目5） | 開かなければ (b) と同じ対処 |
| (k) | `tailscale status --json` の `Self.DNSName` と CLI のパス | 取れなければ §5-1 を改版 |
| (l) | standalone 表示で 100dvh が画面の高さと合うか、キーボードを出した時の高さ | 合わなければ visualViewport で高さを合わせる案に改版 |

- 前提として PO の手作業が要る: Mac と iPhone に Tailscale を入れる、新しい端末の承認・Tailnet Lock・HTTPS（MagicDNS）を管理画面でオンにする、ログインアカウントの2段階認証。手順書は工程0の前に渡す。
- 工程0の結果を docs/handoff/mobile-pwa/step0.md に書き、§5 の分岐を確定してから実装カードを出す。
- 工程1（実装、Sonnet）: 試験を先に書く。§5-1〜5-9。版は次の minor。
- 工程2（審査・反映）: Fable のコード審査 → CI → マージ → タグ → 更新ジョブ。
- 工程3（PO 確認）: 家の Wi-Fi で K1〜K7・K12、その後モバイル回線で K11。

## 7. 触る箇所の一覧（実装役向け）
- server/config.ts（remoteAccess・tailscalePath）、新規 server/tailscale-name.ts（名前の取得と検査）
- server/auth.ts（:44 の種類、:95 の createAuth、:134-154、:155-161、:206-223、スマホ用コードと redeem・失敗の数、devices.json の読み書き）
- server/http.ts（:33-41 MIME、:310,340,395 の Origin、:362-363 と :406 の CSP、§5-3 の4エンドポイント）
- server/ws.ts（:76,80,88 の検査、:67-70 の切断、:109-114 の定期点検）
- server/index.ts（:62 の createAuth への受け渡し、5分ごとの名前の読み直し）
- src/App.tsx（:6 の分岐）、src/api.ts（:16-22 の読み順、401 の扱い、新エンドポイント）、src/pages/ConsolePage.tsx・ConsolePage.css（狭い画面）、src/components/TerminalPane/TerminalPane.tsx（再接続・入力ボタン）、新規のコード入力画面・端末一覧の部品、src/locales/ja.json
- scripts/（manifest の生成）、index.html、public/（アイコン）、.gitignore
- 試験: tests/unit/auth.test.ts・pairing.integration.test.ts・design-governance.test.ts に追加、新規の devices・tailscale-name・再接続の試験、tests/e2e に 390px の1本
- README.md、docs/CHANGELOG.md、版の4か所
- 触らない: §2 の「触らない」

## 8. 代替案と選択理由
- 家の Wi-Fi に直接開く（mkcert）: 端末を操作できる入口を家の LAN に開く。iPhone に自前の証明書を入れる手間がある。外出先対応で作り直しになる。PO に比較を示し、Tailscale に決定（options.md）。
- 公式 Remote Control: Claude Code の会話の操作に限られる。作戦ボード・送信予約・定期実行など agent-console の画面は出せない（external2/facts.md 項目6）。
- QR を読んで Safari で開く: ホーム画面アプリと保存場所が別なら、トークンがアプリに渡らない。アプリ内でのコード入力を採用。
- 端末トークンを 12時間・メモリのままにする: 更新のたびにつなぎ直しになり K3 を満たせない。
- IP で試行回数を制限する: 中継経由では接続元がすべて同じに見えるため効かない（recon2 安全面の結論3）。サーバー全体で数える。
- 「Mac 限定」を Origin で判定する（第1版）: Origin はブラウザ以外なら偽れるので、盗まれたトークンで端末を増やせる（審査 H-1）。トークンの種類で判定する。
- Mac の名前を config.json に書く（第1版）: 公開リポジトリに載る（審査 M-4）。作業場所の config.json は更新のたびに入れ替わるので、手で書き足す運用も消える。Tailscale から読む形にした。

## 9. リスクと対処
| リスク | 対処 |
|---|---|
| 「localhost なら信用」で外から素通り（外部事例: AI エージェントの管理画面 900超が露出、cases.md C6） | 接続元 IP を判定に使う箇所は 0 件（recon2 項目1）。今後も使わない。K8 で外の Host・Origin を拒否する試験 |
| スマホの紛失・盗難 | 端末トークンを Mac から外せる（K7）。Tailscale 側でも端末を外せる（README）。スマホのトークンでは端末を増やせない（K13、トークンの種類で判定） |
| Tailscale のアカウント乗っ取り | ログインアカウントの2段階認証、新しい端末の承認、Tailnet Lock（trust.md 項目5）。アプリ側の端末トークンが別に要る |
| Serve が Host を 127.0.0.1 に書き換える場合、Host 検査が外に効かない | 工程0 (a) で確定。その時の守りは Origin（ブラウザ）と認証、届くのは承認済み端末だけ（§5-2 (ii)） |
| Mac の名前が公開の証明書記録に載る（Tailscale 公式） | 名前に個人情報を入れない（README・手順書）。リポジトリには書かない（§5-1） |
| 短いコードの総当たり | 有効2分・1つだけ・5回失敗で無効（約40bit に対し最大5回）。launcher 用とは別 |
| iOS が裏で WebSocket を切る（cases.md の報告） | 再接続と画面の作り直し（§5-7、K6） |
| ホーム画面アプリの保存が消える（WebKit Bugzilla の報告、cases.md A3） | 消えてもコードを打ち直せばつながる。データは Mac にあるので失われない |
| Tailscale が止まる | Mac では今までどおり使える（K9）。外の名前は空になり、外からの要求は断られる |
| challenge の連打による Mac 側ペアリングの妨害（recon2 項目3） | 今回は変えない（Tailscale の承認済み端末しか届かないため）。記録だけ残す |

## 10. 維持する担当・仕組み
- 許可ホスト・CSP・端末トークン・コードの試験は vitest に入れ、CI（既存）で毎回走る。
- 狭い画面の e2e を1本足し、CI で走る。
- 文言・トークン・金型は check-design-governance.mjs（lint、CI）。manifest は生成スクリプトで作り、手書きしない。
- Tailscale 側の設定（承認・Tailnet Lock）は PO の管理画面。README に確認手順を書く。

## 11. 外部事例（要約。詳細と出典は cases.md・facts.md・trust.md）
- 失敗: Docker API の認証なし公開 1,400超（Unit 42、2020-01）。Ollama の DNS rebinding は最短3秒（CVE-2024-28224）。AI エージェントの管理画面 900超が露出（2026-01、「localhost なら自動承認」＋リバースプロキシ、cases.md C6）。共通要因は「認証なし」または「接続元で信用」。本設計は両方を持たない。
- 成功・制約: code-server 公式は、IP 直指定の自己署名証明書では Safari が WebSocket を止めると記載 → 正規の証明書と名前を Tailscale が用意する。WebKit 公式は、ホーム画面アプリは Service Worker 不要で、保存は Safari と別の数え方と記載。
- 数値の限界: PWA の効果の数値（Twitter Lite など）は数億人規模のサービスで、個人用の本件の成功の根拠には使わない。本件の成功は K1〜K13 の実測で判定する。

## 12. 設計判断の記録（ADR の Why に残す案）
- 外の名前（Tailscale）を Host・Origin の許可に加える。名前は Tailscale から読み、リポジトリに書かない。接続元 IP は信用に使わない。管理の操作（コード発行・端末の一覧・削除）はトークンの種類で判定し、Origin は CSRF 対策に限る。
- agent-console の作法（docs/handoff/<テーマ>/design.md を正とし、README に要約）に合わせ、本設計書の §5-1〜5-4 を正とする。

## 13. 第1版の審査への対応
| 指摘 | 対応 |
|---|---|
| H-1 Origin で Mac 限定を判定 | §5-3 表・§5-4：トークンの種類で判定。K13 追加 |
| M-1 コード入力画面の入口 | §5-3「画面の入口」 |
| M-2 トークンの読み順・401 | §5-4「ブラウザ側」、K7 に画面の戻りを追加 |
| M-3 触る関数の列挙 | §5-4「触る関数」、§7 |
| M-4 公開リポジトリに名前 | §5-1：Tailscale から読む。名前をどこにも書かないため、PO の判断は要らなくなった |
| M-5 MIME・theme_color | §5-8 |
| M-6 launcher 用コードとの分離 | §5-3「コード」「総当たり対策」 |
| M-7 K6 と再接続方式 | K6 を visibilitychange→onopen に限定、§5-7 を作り直し方式に1本化 |
| L-1 tokens.css の行 | §3・§5-5 で :113 |
| L-2 事例番号 | §9・§11 で C6 |
| L-3 CSP の署名 | §5-2 |
| L-4 工程0 (a) の範囲 | §6 (a) を全ヘッダに |
| L-5 名前の形と :443 | §5-1 の検査、§5-2 (i)/(ii) |
| 工程0 の漏れ (h)(i)(j) と否の分岐 | §6 の表（(i) は (a) に統合）、(k)(l) も追加 |
| K2・K4・K5・K8 の表現 | §1 で修正 |

## 14. 再審査（第2版）を受けた決め
- 再審査: /tmp/CC報告ファイル/mobile-pwa/review-design2/review.md（条件付き APPROVE、High 0・Medium 4・Low 5）。以下で全件を取り込む。§5 と食い違う所は本節が正。

| 指摘 | 決め |
|---|---|
| M-1 握手の 401 はブラウザから見えない | 端末の WebSocket が閉じた時: close code 1008（接続中の取り消し、server/ws.ts:43,68）なら再接続せずコード入力画面へ。それ以外（握手の拒否は 1006 で届く）なら、再接続の前に認証付きの GET（今の fetchState）を1回打ち、401 なら両方のトークンを消してコード入力画面へ、200 ならつなぎ直す。K7 の自動試験に「握手で 401 → 画面がコード入力」を足す |
| M-2 http.ts:395 の Origin 検査 | 条件を `method === "session"` から `method !== "bearer"` に変え、device にも Origin 検査をかける。試験「device トークンで Origin が違う POST → 403」を足す |
| M-3 名前の読み直し | 実行は execFile ＋ タイムアウト5秒（server/pr-status.ts:53-55 と同じ作法、タイムアウトは killed で見分ける :36）。起動を待たせない（listen の後に非同期で取得し、取れるまで外の名前は空）。結果の分け方: JSON が返り DNSName が空・形が違う → 空にする。タイムアウト・0以外で終わる・CLI が無い → 前回の値を保ち、失敗の回数をログに出す（許可を広げることはない）。間隔は定数 `TAILSCALE_NAME_REFRESH_MS = 5 * 60 * 1000`、setInterval は `.unref()`（server/index.ts:80 と同じ）。試験: CLI をスタブに替えて3通りを確かめる |
| M-4 devices.json と端末名 | 端末は最大8台。超える時はコードの発行を 409 で断り、Mac の画面に「端末が上限です。どれかを外してください」を出す（黙って古いのを消さない）。端末名は redeem の時に iPhone から送り、1〜32文字、制御文字は不可（server/config.ts:209 の ENV_CONTROL_CHARS と同じ正規表現）、違えば 400。devices.json が壊れていたら、devices.json.bad-<日時> に退避して空として起動し、ログに出す。試験3件（上限・名前・壊れたファイル） |
| L-1 行番号 | §3・§5-7 を TerminalPane.tsx:197,199,201 に直した |
| L-2 Mac 側の置き場所 | 画面下の AccountBadge の隣に「スマホ」ボタンを1つ置き、押すと Drawer（SA 金型）で「コードを出す」と「つないだ端末」一覧を出す。ボタンは端末トークン（スマホ）で開いている時は出さない |
| L-3 コードの文字 | `0123456789ABCDEFGHJKMNPQRSTVWXYZ`（32文字、I・L・O・U を除く）。8文字。redeem 側は、空白と `-` を除き、英字を大文字にし、O→0、I と L→1 に直してから比べる。画面は4文字ずつ `-` で区切って出す |
| L-4 名前が変わった時の遅れ | README の「Mac の名前」の節に、Tailscale で名前を変えると反映まで最大5分かかることを書く |
| L-5 tailscalePath の既定 | 工程0 (k) で、入れた配布形（App Store 版か Standalone 版か）と CLI のパスを記録し、既定を1つに決める。ほかは config の tailscalePath で上書きする |

- 実装を始める条件（再審査 §7）: PO が工程0の前提（Tailscale の導入・管理画面の設定）を済ませ、工程0の結果 step0.md と、§5 の分岐を確定した第3版が揃うこと。
- 【事実】この Mac には今 Tailscale の CLI が無い（再審査の ls・which が not found）。工程0 (k) は PO が入れた後にだけ確かめられる。
