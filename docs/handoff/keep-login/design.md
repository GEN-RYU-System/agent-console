# アプリを更新しても画面が止まらない（keep-login）設計 第1版

- 状態: 設計案 第1版（Opus 2026-10-14）。Fable 審査前。PO 実装承認前。実装未着手。
- 根拠（recon）: /tmp/CC報告ファイル/update-blank/r1/（白画面の調査）、/tmp/CC報告ファイル/keep-login/r1/（認証・再接続の調査、01〜12）。Opus が読み直した行: server/auth.ts:100-107、src/pages/ConsolePage.tsx:60-80、src/components/TerminalPane/TerminalPane.tsx:100-120、server/ws.ts:22-24。

## 0. PO の言葉と目的
- PO（2026-10-14）「アップデートが入るとアプリが何も表示されなくなり作業できなくなる、アプリを閉じて再度開くと解消される」
- 目的: 更新（サーバーの再起動）の後も、開いている画面がそのまま使える。開き直しが要らない。

## 1. 現在地（事実、recon）
- R1 ログインの記録はメモリだけ: server/auth.ts:104-106 の codes・sessions・challenges は Map。sessions は {sha256(token), expiresAt}（12 時間固定、:17）。再起動で全部消える。秘密（secret）はキーチェーンで再起動しても同じ（server/secret.ts:24-35、keychain.ts:7-8）。
- R2 画面はトークンを sessionStorage "ac.session" に持つ（src/api.ts:14-34）。401 でトークンを消す処理は無い（clearSessionToken を呼ぶのは logout だけ、api.ts:173）。
- R3 /ws/events は切れると 1 秒ごとに再接続する（ConsolePage.tsx:74-77）。401 でも同じで、永久に失敗し続ける。つながり直しても一覧を取り直さない。401 の案内は最初の fetchState の時だけ（:67、:293-301）。
- R4 端末の WebSocket（TerminalPane.tsx:106）は onclose が無く、再接続しない。切れたら端末は固まる。つながった時は server が ring の内容を先に送る（server/ws.ts:22-24 attachTerminal の backlog）。
- R5 更新（scripts/ac-update.sh → scripts/lib/ac-common.sh:499 `launchctl kickstart -k`）はサーバーだけを再起動する。Chrome のアプリ窓は開いたまま（recon r1 07）。
- R6 画面の描画で例外が出ると受け止める部品（ErrorBoundary）が無い（src を grep して 0 件）。`if (!state) return null`（ConsolePage.tsx:303）で、最初の取得が終わらない間も白い。
- 【未確認】PO の「何も表示されない」がどの経路か（実機で再現していない）。下の直しは R1〜R6 の全部を塞ぐ。

## 2. 成功条件（○×で判定）
| # | 基準 | 検証方法 |
|---|---|---|
| K1 | サーバーを再起動しても、再起動前に発行したトークンで API が 200 を返す（12 時間の期限は今と同じ） | 統合試験（tests/unit/pairing.integration.test.ts に追加）: 同じ dataDir・同じ secret で 2 つ目の server を起動し、1 つ目で得たトークンで GET /api/state |
| K2 | 期限切れ・logout 済みのトークンは再起動後も 401 | 同上 |
| K3 | 保存ファイルにトークンそのものは無い（ハッシュと期限だけ）。権限 600、フォルダ 700 | 単体試験（tests/unit/auth.test.ts）: ファイルの中身にトークン文字列が含まれない・mode |
| K4 | 保存ファイルが壊れていたら、空として起動し（全員ログインし直し）、壊れたファイルは auth-sessions.json.broken-<時刻> に名前を変えて残す | 単体試験 |
| K5 | /ws/events がつながり直したら、一覧（fetchState）を取り直す | 画面の単体試験（ConsolePage.test.tsx） |
| K6 | 端末の WebSocket が切れたら 1 秒後からつなぎ直し、つながったら画面を描き直す（今の term を reset してから backlog を受ける） | 画面の単体試験（TerminalPane.ux.test.tsx）＋ e2e: サーバーを再起動して端末に文字が出る |
| K7 | 本当にログインが無効（401）になったら、白い画面や固まった画面ではなく「もう一度アプリを開いてください」の案内が出る | 画面の単体試験: API が 401 → 案内。WebSocket の再接続が 3 回続けて失敗したら fetchState を呼んで 401 か確かめる |
| K8 | 描画の例外で白くならず、「表示に失敗しました」と「再読み込み」ボタンが出る | 画面の単体試験（例外を投げる子） |
| K9 | 新しい版が入ったら、画面の上に「新しい版が入りました」と「再読み込み」ボタンが出る（勝手には読み込み直さない） | 画面の単体試験: /healthz の commit が読み込み時と違う |
| K10 | 文言は t()、色・大きさは SA 部品とトークンだけ（新しいハードコード 0） | npm run lint・design-governance 試験 |
| K11 | CI が ubuntu・macos とも緑 | CI |
| K12 | PO の目視: 画面を開いたまま更新が入っても、開き直さずに一覧・チャット・端末が動く | PO が次の更新の後に確認 |

## 3. 仕組み
### 3-1 server: ログインの記録を残す（server/auth.ts）
- createAuth の options に `sessionsFile?: string` を足す。本番（server/index.ts:65）は `path.join(dataDir, "auth-sessions.json")` を渡す。試験の既定は無し（今と同じメモリだけ）。
- 形: `{version:1, items:[{digest:"<hex>", expiresAt:<ms>}]}`。トークンそのものは書かない（今もメモリにはハッシュしか持たない、auth.ts:104-106）。
- 読む: 起動時に 1 回。期限切れは捨てる。MAX_SESSIONS（64、:7）を超えたら新しい方を残す。無ければ空。壊れている（JSON でない・version 違い・形が違う）なら空として起動し、ファイルを `auth-sessions.json.broken-<YYYYMMDDTHHMMSS>` に rename（上書きしない、json-store の考え方と同じ）。
- 書く: セッションの発行（:198-200）・logout/revoke（:202-208）・古い物の追い出し（:125,:197）の後に、server/json-store.ts の writeJsonAtomic（600・tmp→rename）と createSerial で直列に書く。書けなかった時はログに出して続ける（ログインは今と同じくメモリで効く）。
- codes・challenges は残さない（30 秒の物で、再起動をまたぐ必要が無い）。
- 期限・延長の決まりは変えない（12 時間固定）。

### 3-2 画面: つながり直したら取り直す（src/pages/ConsolePage.tsx:62-80）
- /ws/events: 一度切れた後に onopen が来たら fetchState() を呼び、state を置き換える。
- 再接続が 3 回続けて失敗したら fetchState() を呼ぶ。401 なら loadFailed("unauthorized") にして（今の :293-301 の案内）、トークンを消し、再接続をやめる。案内の文言を「ログインが切れました。Dock の Agent Console からアプリを開き直してください」に直す（ja.json の該当キー）。
- src/api.ts の request で 401 を受けたら clearSessionToken() は呼ばない（上の判定に任せる。一時的な 401 で消すと戻れないため）。

### 3-3 画面: 端末のつなぎ直し（src/components/TerminalPane/TerminalPane.tsx:106-120）
- ws の onclose（コンポーネントを閉じた時以外）で、1 秒・2 秒・4 秒…最大 10 秒の間隔でつなぎ直す。つながったら term.reset() してから、server が送る backlog（server/ws.ts:22-24）をそのまま書く。入力（onData）と大きさの送信は新しい ws へ向ける。
- つなぎ直し中は端末の上に小さく「つなぎ直しています…」（SA の部品、文言 ja.json）。
- 【未確認】再起動後の ring の中身（tmux 保持の v0.20.0 で、再起動後の backlog に今の画面が入るか）。K6 の e2e で確かめ、入らなければ「つないだ直後に大きさを送り直して Claude に描き直させる」を足す（syncSize を onopen で呼ぶのは今もある、:118）。

### 3-4 画面: 白くしない（新規 src/components/ErrorBoundary/）
- src/App.tsx の中身を ErrorBoundary で包む。例外の時は SA Callout「表示に失敗しました」＋ SA Button「再読み込み」（location.reload()。トークンは sessionStorage に残り、3-1 でサーバーにも残るので、そのまま戻れる）。
- ConsolePage.tsx:303 の `return null` を、SA の読み込み中の表示（既存の部品を使う。無ければ EmptyState「読み込み中」）にする。

### 3-5 画面: 新しい版のお知らせ
- 読み込み時に GET /healthz の commit を覚える。/ws/events がつながり直した時に /healthz を見て、commit が違えば上部に SA Callout「新しい版が入りました」＋「再読み込み」ボタン。勝手には読み込み直さない（チャットの書きかけを消さないため）。
- /healthz は今も認証の外で version と commit を返す（server/http.ts:412）。

## 4. SSOT
- ログイン中のトークンの正は、メモリの Map と、それを写した auth-sessions.json の 1 組だけ。書くのは auth.ts だけ。

## 5. 安全
- 残すのはトークンのハッシュ（sha256、元は 32 byte の乱数）と期限だけ。ファイルを読めてもトークンは作れない。ファイルは 600 で、読めるのは同じ OS ユーザーだけ（その人はもともとキーチェーンの secret でログインできる）。
- 期限（12 時間）・logout の失効・Host/Origin の検査は今のまま。
- 401 の時にトークンを消すのは「3 回失敗して fetchState も 401」の時だけ。

## 6. 決めたこと（Opus）
- D1 直し方は「ログインを再起動後も残す」。代替の「401 なら開き直しを案内する」だけでは、PO の「開き直さずに作業を続けたい」を満たさない。
- D2 新しい版は勝手に読み込み直さず、ボタンで知らせる。理由: チャット欄の書きかけを消さない。
- D3 版はマージ時点の次の空き番号。

## 7. 代替案
- A 更新の時に Chrome のアプリ窓も開き直す: ac-update が Chrome を操作することになり、PO の他の Chrome の窓を巻き込むおそれ。不採用。
- B トークンを cookie にする: 認証の作り（Bearer、CSRF の考え方）が変わる。範囲が大きすぎる。不採用。

## 8. リスクと対処
- 保存ファイルの書き込みが失敗 → ログに出してメモリで続ける（今と同じ動き）。
- 端末のつなぎ直しで画面が崩れる → K6 の e2e。崩れたら 3-3 の【未確認】の手当て。
- 12 時間を過ぎた画面 → 今と同じく 401。3-2 で案内が出る（今は固まる）。

## 9. 外部・過去事例
- 外部事例は使わない。理由: 手元のアプリの再起動の作りの話で、recon の事実で判断できる。
- 過去事例: v0.20.0（keep-sessions、更新しても tmux でセッションを保つ）の続き。あの版で「中の Claude は切れない」が、画面側は切れたままだった。

## 10. 工程
1. server（3-1）＋ K1〜K4 の試験
2. 画面（3-2〜3-5）＋ K5〜K10 の試験、ja.json
3. 版の 4 か所・CHANGELOG・README
4. Fable 審査 → CI → マージ・タグ・update-when-idle（この更新の時はまだ古い画面なので、PO は一度だけ開き直しが要る。次の更新から K12 を確かめる）

## 触るファイル・触らないファイル
- 触る: server/auth.ts、server/index.ts（:65 の引数）、src/api.ts（必要なら）、src/pages/ConsolePage.tsx、src/components/TerminalPane/TerminalPane.tsx、src/components/ErrorBoundary/*（新規）、src/App.tsx、src/locales/ja.json、tests/unit/auth.test.ts・pairing.integration.test.ts、src の該当試験、tests/e2e（再起動の試験）、版の 4 か所・CHANGELOG・README。
- 触らない: ペアリングの手順（launch.sh・challenge・code）、secret、期限の長さ、Host/Origin の検査、ac-update.sh。
