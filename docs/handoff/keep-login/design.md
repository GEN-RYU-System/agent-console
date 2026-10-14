# アプリを更新しても画面が止まらない（keep-login）設計 第2版

- 状態: 設計案 第3版（Opus 2026-10-14）。第1版・第2版は Fable 審査で REVISE（§11）。第3版の審査前。PO 実装承認前。実装未着手。
- 根拠: 同じフォルダの recon.md（R1〜R8）。

## 0. PO の言葉と目的
- PO（2026-10-14）「アップデートが入るとアプリが何も表示されなくなり作業できなくなる、アプリを閉じて再度開くと解消される」
- 目的: 更新（サーバーの再起動）の後も、開いている画面がそのまま使える。開き直しが要らない。

## 1. 方針（一言）
ログインの記録をファイルにも残して再起動をまたがせ、画面はつながり直したら取り直し、端末もつなぎ直す。それでも駄目な時は白くせず案内を出す。

## 2. 成功条件（○×で判定）
| # | 基準 | 検証方法 |
|---|---|---|
| K1 | サーバーを再起動しても、再起動前に発行したトークンで API が 200（12 時間の期限は今と同じ） | 統合試験（tests/unit/pairing.integration.test.ts）: harness に sessionsFile を渡せるようにし、同じ dataDir・同じ secret で 2 つ目の server を起動、1 つ目で得たトークンで GET /api/state |
| K2 | 期限切れ・logout 済みのトークンは再起動後も 401。secret が変わったら、前のトークンは全部 401 | 同上（secret を変えた 2 つ目の server も試す） |
| K3 | 保存ファイルにトークンそのものは無い（ハッシュ・期限・secret の印だけ）。ファイル 600、フォルダは新しく作るとき 700 | 単体試験（tests/unit/auth.test.ts）: 中身にトークン文字列が含まれない・mode |
| K4 | 保存ファイルが壊れていたら、空として起動し（全員ログインし直し）、壊れたファイルは auth-sessions.json.broken-<時刻> に名前を変えて残す | 単体試験 |
| K5 | AGENT_CONSOLE_PORT を指定して起動したサーバーは、保存ファイルを読みも書きもしない | 単体試験（判定関数）＋統合試験 |
| K6 | /ws/events が切れた後につながり直したら、fetchState で一覧を取り直す（版・commit も新しくなる） | 画面の単体試験（ConsolePage.test.tsx） |
| K7 | /ws/events が 3 回続けてつながらない（onopen の無いまま onclose）と fetchState を呼ぶ。401 なら今の案内（ja.json:103-104）を出してつなぎ直しをやめる。401 以外の失敗（再起動中など）なら画面はそのまま、つなぎ直しを続ける | 画面の単体試験: 3 通り（401・500・接続できない） |
| K8 | 端末の WebSocket が切れたら 1 秒・2 秒・4 秒…最大 10 秒でつなぎ直し、つながったら今の画面を描き直す（term.reset → server が送る内容を書く）。つなぎ直している間の入力は送られない（今と同じく捨てる）ことを「つなぎ直しています…」の表示で示す | 画面の単体試験（TerminalPane.ux.test.tsx）: 作り物の WebSocket で「切れる → つなぎ直す → onopen で reset → 中身が書かれる」、replay の中身が onopen の直後に来る場合と 1 秒後に来る場合の 2 通り。実際のサーバーの再起動は e2e では見ない（今の e2e は Playwright がサーバーを管理していて試験の中から再起動できないため）。実機では K13 と、Opus がこの版の更新の直後に画面を見て確かめる |
| K9 | 描画の例外で白くならず、「表示に失敗しました」と「再読み込み」ボタンが出る。最初の読み込み中は「読み込み中」が出る（白くない） | 画面の単体試験（例外を投げる子・fetchState が終わらない） |
| K10 | 新しい版が入ったら、画面の上に「新しい版が入りました」と「再読み込み」ボタンが出る（勝手には読み込み直さない） | 画面の単体試験: 取り直した /api/state の commit が最初と違う |
| K11 | 文言は t()、色・大きさは SA 部品とトークンだけ（新しいハードコード 0） | npm run lint・design-governance 試験 |
| K12 | CI が ubuntu・macos とも緑 | CI |
| K13 | PO の目視: 画面を開いたまま更新が入っても、開き直さずに一覧・チャット・端末が動く | この版を入れる更新では、まだ古い画面なので PO が 1 回開き直す。その次の更新で確かめる |

## 3. 仕組み
### 3-1 server: ログインの記録を残す（server/auth.ts）
- sessions の Map のキーを、生のトークンから sha256 の hex（digest の 16 進）に変える（consumePairingCode :199 で `sessions.set(digestHex, { digest, expiresAt })`。値の digest（Buffer）は今どおり残し、照合は今どおり値の digest で行う）。findByDigest・dropOldest・revokeSession（:116-129、:202-208）はキーをそのまま使っているので形は変わらない。revokedListeners には今どおり呼び出し元のトークンを渡す。これでメモリにも生のトークンを持たなくなる。
- createAuth の options に `sessionsFile?: string` を足す。createAuth は同期のままで、sessionsFile があれば中で readFileSync で 1 回読む。
- 本番だけ有効: server/index.ts:65 は「AGENT_CONSOLE_PORT が未設定（空文字も未設定扱い）」のときだけ `path.join(config.dataDir, "auth-sessions.json")` を渡す。判定は新しい isAuthPersistEnabled(env) を server/auth.ts に export で置く（式は server/picker-extension.ts:37-39 の isPickerSetupEnabled と同じ「AGENT_CONSOLE_PORT が undefined か空」。AGENT_CONSOLE_RESTORE は見ない）。試験の harness（tests/unit/helpers/harness.ts:29,210）は options で sessionsFile と secret を渡せるようにする（既定は無し・今の TOKEN＝今と同じ）。
- ファイルの形: `{ version: 1, secretTag: "<hex>", items: [{ digest: "<hex>", expiresAt: <ms> }] }`。secretTag = HMAC-SHA256(secret, "agent-console auth-sessions v1") の hex。トークンそのもの・secret そのものは書かない。
- 読む（起動時に 1 回）:
  - 無い → 空。
  - 読めて形が正しく、secretTag が今の secret の物と一致 → 期限切れを捨て、expiresAt の古い順に Map へ入れる（dropOldest が今どおり一番古い物を消せるように）。64 を超えたら新しい方の 64 を残す。
  - secretTag が違う → 空（secret が変わったので前のログインは全部無効。ファイルは次の書き込みで上書きされる）。
  - 壊れている（JSON でない・version 違い・形が違う）→ 空として起動し、ファイルを `auth-sessions.json.broken-<YYYYMMDDTHHMMSS>` に rename する（json-store の readJsonFile とは違う方式。ログインの記録は失っても「ログインし直し」で済むため、止めずに続ける）。rename に失敗したらログに出して続ける（次の書き込みで上書きされる）。
- 書く: セッションの発行・logout/revoke・古い物の追い出しの後に、server/json-store.ts の writeJsonAtomic を createSerial で直列にして書く（中身は「その時のメモリの Map の全部」）。purge（:108-113）で消えた期限切れは書き直さないのでファイルに残るが、読むときに捨てる。書けなかったらログに出して続ける（ログインはメモリで効く）。
- codes・challenges は残さない（30 秒の物）。期限・延長の決まりは変えない（12 時間固定）。expiresAt は絶対時刻なので、Mac の時計を戻すと延びる。これは許す（今のメモリでも同じ）。

### 3-2 画面: つながり直したら取り直す（src/pages/ConsolePage.tsx:62-80）
- /ws/events に onopen を足す。数え方: failures = 「onopen が来ないまま onclose した回数」。onopen で 0 に戻す。
- 一度でも切れた後の onopen では fetchState() を呼び、成功したら state を丸ごと置き換える（state が null でも入る）。
- failures が 3 になったら fetchState() を呼ぶ:
  - 成功 → state を置き換え、つなぎ直しを続ける。
  - 401 → loadFailed("unauthorized")（今の :293-301 の案内、文言は今の ja.json:103-104 のまま）、トークンを消し、つなぎ直しをやめる（待っている timer を clearTimeout し、それ以後 onclose が来ても connect しない）。
  - それ以外の失敗（再起動中で接続できない・500）→ state も loadFailed も変えない（一覧・チャット・端末を消さない）。failures を 0 に戻して、つなぎ直しを続ける（また 3 回で確かめる）。
- src/api.ts の request は 401 を受けてもトークンを消さない（今と同じ）。消すのは上の 401 の時だけ。
- 最初の fetchState（:67）の扱いは今のまま（失敗したら "error"／"unauthorized"）。

### 3-3 画面: 端末のつなぎ直し（src/components/TerminalPane/TerminalPane.tsx:106-120）
- ws を `let` にし、つなぐ処理を connect() にまとめる。send と syncSize は「今の ws」を見る形にする（閉包で古い ws を持たない）。
- onclose（コンポーネントを閉じた時以外）で、1 秒・2 秒・4 秒…最大 10 秒の間隔で connect() する。新しい ws を作る前に、古い ws の onopen・onmessage・onclose を外す。
- onopen で term.reset() してから syncSize()（今の :117 と同じ）。その後 server が送る ring の中身・replay をそのまま書く。
- 【推測】再起動の直後は ring が空で、tmux につなぎ直した時の replay が後から来る（recon R5）。replay が「今の画面」を描き直す内容かは確かめていない → K8 の単体試験で先・後の 2 通りの画面側の動きを固め、実機は K13 で見る。崩れていたら「onopen の 1 秒後にもう一度 syncSize を送り、Claude に描き直させる」を次の版で足す。
- つなぎ直し中は端末の上に小さく「つなぎ直しています…」（SA の Callout か既存の部品、文言 ja.json）。
- 閉じた時（unmount）は今どおり ws を閉じ、つなぎ直しの timer を止める（TerminalPane.test.tsx:60 の試験と両立）。

### 3-4 画面: 白くしない（新規 src/components/ErrorBoundary/）
- React の class の部品 ErrorBoundary を新しく作り、src/App.tsx の中身を包む。例外の時は SA Callout「表示に失敗しました」＋ SA Button「再読み込み」（location.reload()。トークンは sessionStorage に残り、3-1 でサーバーにも残るので、そのまま戻れる）。
- ConsolePage.tsx:303 の `return null` を、SA の EmptyState「読み込み中」にする（EmptyState は :302 で使っている物）。

### 3-5 画面: 新しい版のお知らせ
- 最初の fetchState の commit（/api/state が返す、server/http.ts:148）を覚える。3-2 で取り直した state の commit が違えば、上部に SA Callout「新しい版が入りました」＋「再読み込み」ボタン。勝手には読み込み直さない（チャットの書きかけを消さないため）。/healthz は使わない。

## 4. SSOT
- ログイン中のトークンの正は、メモリの Map と、それを写した auth-sessions.json の 1 組だけ。書くのは auth.ts だけ。本番のサーバーだけが読み書きする（K5）。

## 5. 安全
- 残すのはトークンのハッシュ（sha256、元は 32 byte の乱数）と期限と secret の印（HMAC）だけ。ファイルを読めてもトークンも secret も作れない。ファイルは 600。
- 試験・自己診断のサーバー（ポート指定）は読み書きしないので、そちらで発行したトークンが本番で効くことはない（K5）。secret が変わった時は前のログインが全部切れる（K2）。
- 期限（12 時間）・logout の失効・Host/Origin の検査は今のまま。
- 401 の時にトークンを消すのは「3 回続けてつながらず、fetchState も 401」の時だけ。

## 6. 決めたこと（Opus）
- D1 直し方は「ログインを再起動後も残す」。代替の「401 なら開き直しを案内する」だけでは、PO の「開き直さずに作業を続けたい」を満たさない。
- D2 新しい版は勝手に読み込み直さず、ボタンで知らせる。理由: チャット欄の書きかけを消さない。
- D3 壊れた保存ファイルは止めずに名前を変えて空で始める（ログインのし直しで済むため）。
- D4 案内の文言は今の物（ja.json:103-104）をそのまま使う（既に「Dock から開き直して」と書いてある）。
- D5 版はマージ時点の次の空き番号。

## 7. 代替案
- A 更新の時に Chrome のアプリ窓も開き直す: ac-update が Chrome を操作することになり、PO の他の Chrome の窓を巻き込むおそれ。不採用。
- B トークンを cookie にする: 認証の作り（Bearer、CSRF の考え方）が変わる。範囲が大きすぎる。不採用。
- C ファイルにトークンをそのまま書く: ファイルを読まれたらログインできてしまう。不採用。

## 8. リスクと対処
- 保存ファイルの書き込みが失敗 → ログに出してメモリで続ける（今と同じ動き）。
- 端末のつなぎ直しで画面が崩れる → K8 の e2e。崩れたら 3-3 の手当て。
- 12 時間を過ぎた画面 → 今と同じく 401。3-2 で案内が出る（今は固まる）。
- PO の白画面の経路は未確認（recon R8）。この設計は R1〜R6 の経路を全部塞ぐ。直らなければ K13 の時に画面の Console の記録をもらって調べる。

## 9. 外部・過去事例
- 外部事例は使わない。理由: 手元のアプリの再起動の作りの話で、recon の事実で判断できる。
- 過去事例: v0.20.0（keep-sessions、更新しても tmux でセッションを保つ）の続き。あの版で中の Claude は切れなくなったが、画面側は切れたままだった。

## 10. 工程
1. server（3-1）＋ K1〜K5 の試験。harness.ts に sessionsFile と secret の options を足す。
2. 画面（3-2〜3-5）＋ K6〜K11 の試験、ja.json。
   既存試験で変える物: tests/e2e/console.spec.ts:664-666（dataDir の中身の一覧に auth-sessions.json を足して 8 つに。コメントも直す）、src/pages/ConsolePage.test.tsx:121-130 の FakeWebSocket に onopen を足す、src/components/TerminalPane/TerminalPane.test.tsx:34-42 と TerminalPane.ux.test.tsx:34-40 の Fake に onclose を足す、src/App.test.tsx:6-7 の mock と ErrorBoundary の両立。案内の文言は変えないので ConsolePage.test.tsx:286-291・:305-310 は変えない。
3. 版の 4 か所（package.json:3、package-lock.json:3,9、extension/manifest.json:4）・docs/CHANGELOG.md（1 版 1 行）・README.md（ログインが再起動後も残ること・auth-sessions.json の説明）
4. Fable 審査 → CI → マージ・タグ・update-when-idle（この更新では PO が 1 回開き直す。次の更新で K13）

## 触るファイル・触らないファイル
- 触る: server/auth.ts、server/index.ts（:65 の引数）、（isAuthPersistEnabled は auth.ts に置く）、src/pages/ConsolePage.tsx、src/components/TerminalPane/TerminalPane.tsx、src/components/ErrorBoundary/*（新規）、src/App.tsx、src/locales/ja.json、tests/unit/auth.test.ts・pairing.integration.test.ts・helpers/harness.ts、src の該当試験、tests/e2e/console.spec.ts（dataDir の一覧だけ）、版の 4 か所・CHANGELOG・README。
- 触らない: ペアリングの手順（launch.sh・challenge・code）、secret の扱い、期限の長さ、Host/Origin の検査、ac-update.sh、json-store.ts。

## 維持の仕組み
- K1〜K5 の試験が CI にあり、ログインの記録を残さない・試験のサーバーが本番のファイルに書く、といった後戻りは赤になる。K7・K8 の試験がつなぎ直しを見張る。

## 11. 審査の記録
- 第1版（2026-10-14、Fable、/tmp/CC報告ファイル/keep-login/review-design1/review.md）: REVISE。
  - 高 H1（Map のキーは生トークン）→ 3-1 でキーを digest hex に。H2（試験のサーバーが同じファイルを読み書き）→ isAuthPersistEnabled・K5。H3（e2e の dataDir 一覧）→ §10-2。H4（再起動中の失敗で画面が消える）→ 3-2・K7。
  - 中 M1（R3 の不正確）→ recon R4 を直した。M2（json-store と方式が違う）→ D3・3-1 に明記。M3（同期）→ readFileSync。M4（3 回の数え方）→ 3-2。M5（古い ws の閉包）→ 3-3。M6（ring と replay）→ recon R5・3-3。M7（文言 3 通り）→ D4。M8（secret に結び付かない）→ secretTag・K2。M9（700）→ K3。M10（/healthz 不要）→ 3-5。
  - 低 L1〜L7 → 該当箇所に反映（L6 は §10-3、L7 は K13）。
- 第2版（2026-10-14、Fable、/tmp/CC報告ファイル/keep-login/review-design2/review.md）: REVISE。第1版の指摘 21 件は全部解消。新規 R1（K8 の e2e は今の作りでは再起動できず、replay の先・後は競走で○×にならない）→ K8 を単体試験の 2 通り＋K13 に。R2（harness の secret 指定）・R3（ux.test の Fake）・低（判定の置き場・401 後の余分な接続・digest を残す・recon R7 の行）→ 反映。
