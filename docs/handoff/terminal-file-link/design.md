# 設計: 端末に出たファイル名をクリックすると「ファイル」タブで開く（agent-console v0.40.0）

- 状態: 設計案 第1版（Opus、2026-10-16）。PO 承認: 10/16「y」（設計→審査→実装→マージ→入れ替えまで）。
- 基準: origin/main 36169b6（v0.39.0）。作業場所 ~/agent-console-wt/terminal-file-link（release/terminal-file-link）。
- 調べた記録（生出力）: /tmp/CC報告ファイル/ac-file-link/（files-routes.txt ほか）と recon2/（TerminalPane.tsx.txt・FilesPane.tsx.txt・ConsolePage-excerpts.txt・xterm.d.ts.txt・xterm-link-excerpt.txt）、xterm-src/WebLinkProvider.ts（xterm.js 公式 6.0.0 タグの addon-web-links 0.12.0 の元コード）。
- Context7 は月の上限で使えなかった（"Monthly quota exceeded"）。代わりに、手元の @xterm/xterm 6.0.0 の型定義（typings/xterm.d.ts）と、公式リポジトリの元コードで確かめた。

## 1. 目的と受入条件
PO の依頼（10/16）: Claude が作ったファイル（例: `Write(/tmp/CC報告ファイル/…/candidates.md)`）を、端末タブでクリックしたら、ファイルタブに切り替わって中身が見られるようにする。

- 変える前: 端末の文字はクリックできない。ファイルタブで一覧から手で選ぶ必要がある。
- 変えた後: 端末に出たパスのうち、そのセッションのファイル一覧に載っている物だけが、マウスを乗せると下線付きになる。クリックすると「ファイル」タブに切り替わり、そのファイルの中身が出る。
- 変えないこと: 読めるファイルの範囲（既存どおり「そのセッションが Write・Edit などで書いたと記録されたパスとの完全一致」だけ。file-viewer design §5・K3）。サーバー（server/）と hook（hooks/）には触らない。

| 基準 | 検証方法 |
|---|---|
| K1 パスの見つけ方と当て方（§4-2）が、表の全例で期待どおり（絶対パス・`../../../tmp/…`・`~/…`・全角を含む名前・末尾の `)` `.` `、` `。`・候補が2つ以上ある時はリンクにしない・`/` を含まない語はリンクにしない） | 単体試験 src/components/TerminalPane/fileLinks.test.ts |
| K2 全角文字（例「報告」）を含む行でも、下線の範囲（列）がパスの文字と一致する。折り返し（isWrapped）にまたがるパスも1つのリンクになる | 同上（偽のバッファで getCell・getWidth を再現） |
| K3 端末1つにつき登録は1回、端末を作り直す・閉じる時に外す（dispose） | TerminalPane.test.tsx（モックに registerLinkProvider を足す） |
| K4 リンクをクリックすると onOpenFile がそのパス（一覧の path そのもの）で呼ばれる | TerminalPane.test.tsx |
| K5 FilesPane に開く依頼（openRequest）が来ると、そのパスで fetchFileContent が呼ばれ、選択状態になる。別セッション宛の依頼は無視する | FilesPane.test.tsx |
| K6 server/・hooks/ の差分が 0 行（読める範囲が広がらない） | `git diff --stat origin/main...HEAD -- server hooks` が空 |
| K7 lint・typecheck・CI（ubuntu・macOS）が緑 | CI |
| K8 導入後 healthz が 0.40.0 | Opus が確認 |
| K9 実機: Claude が Write したファイルのパスが端末で下線付きになり、クリックでファイルタブにその中身が出る | PO 目視（§7 の想定分岐あり） |

## 2. 触る箇所と触らない箇所
触る:
1. 新規 src/components/TerminalPane/fileLinks.ts（画面を持たない関数だけ。§4-2・§4-3）と fileLinks.test.ts。
2. src/components/TerminalPane/TerminalPane.tsx
   - props（:50-59）に `onOpenFile?: (path: string) => void` と `filesRev?: number` を足す。
   - :70-71 の `latest` に両方を足す（端末を作り直さずに読み直す既存の作法）。
   - :117 の `term.open(host)` の後で `term.registerLinkProvider(...)` を1回呼び、戻り値を変数に持つ。
   - 後始末（:314-331）の `dataSub.dispose()` の並びに、その戻り値の `dispose()` を足す。
3. src/components/TerminalPane/TerminalPane.test.tsx・TerminalPane.ux.test.tsx: xterm のモック（test.tsx:23-46、ux.test.tsx:45-48）に `registerLinkProvider`（戻り値 `{ dispose }`）を足す。K3・K4 の試験を足す。
4. src/components/FilesPane/FilesPane.tsx: Props（:28-34）に `openRequest?: { sessionId: string; path: string; seq: number }` を足し、§4-5 の effect を1つ足す。FilesPane.test.tsx に K5 の試験。
5. src/pages/ConsolePage.tsx: §4-6 の state を1つと、TerminalPane（:562）・FilesPane（:576）への受け渡し。
6. 版 0.40.0: package.json・package-lock.json（版の2行、:3 と :9）・extension/manifest.json・docs/CHANGELOG.md に1行・README.md に1行（v0.39.0 の PR#58 と同じ場所）。
7. 本書。

触らない: server/、hooks/、src/api.ts（既存の fetchFiles・fetchFileContent をそのまま使う）、src/locales/ja.json（新しい文言なし）、MarkdownView、その他すべて。新しい依存パッケージも足さない。

## 3. 調べた事実（根拠）
- 【事実】ファイルを読める範囲は「そのセッションの記録 path と完全一致」だけ（server/files-routes.ts:91、無ければ 404 notListed）。記録される path は絶対パスで normalize 済み（hooks/activity-hook.mjs:88-94、server/activity.ts:37-43）。
- 【事実】端末にリンクの仕組みは無い（@xterm/addon-web-links は未導入、registerLinkProvider の使用 0 件）。
- 【事実】xterm 6.0.0: `registerLinkProvider(linkProvider: ILinkProvider): IDisposable`（xterm.d.ts:1102）。`ILink { range, text, decorations?, activate(event, text), hover?, leave?, dispose? }`（:1407-1453）。range の x・y は 1 始まり（:1490・:1494）。
- 【事実】provideLinks の y は 1 始まりで、行は `buffer.active.getLine(y - 1)` で取る。range の end.x は「その文字を含む」1 始まり。全角は getCell の getWidth で数え直す（公式 addon-web-links 0.12.0 の WebLinkProvider.ts:62・:86-93・:159-199）。
- 【事実】全角文字は2セルで、2セル目は幅0（xterm.d.ts:1640-1644）。文字列の添字と列はずれるため、列は getCell で数え直す。
- 【事実】既存の @xterm/addon-web-links は URL しか扱わない（WebLinkProvider.ts:72 で isUrl に合わない物は捨てる）ので使えない。同じ数え方を自前の小さな関数で持つ。
- 【事実】TerminalPane と FilesPane は、タブを切り替えても hidden にするだけで消えない（ConsolePage.tsx:561、FilesPane の `hidden={!active}`）。タブの状態は ConsolePage.tsx:181 の centerTab。
- 【事実】FilesPane の選択は内部 state（FilesPane.tsx:43）だけで、外から選ばせる口は無い。openFile（:65-78）は path を受けて fetchFileContent を呼ぶ。

## 4. 作り
### 4-1 流れ
1. 端末の行にマウスが乗ると、xterm が provideLinks(y) を呼ぶ。
2. その行（折り返しでつながる前後の行を含む）の文字列から、パスらしい語を拾う（§4-2）。
3. 拾った語を、そのセッションのファイル一覧（fetchFiles の結果）に当てる（§4-2）。当たった物だけ ILink にする。
4. クリック（activate）で `onOpenFile(一覧の path)` を呼ぶ。
5. ConsolePage が「ファイル」タブに切り替え、FilesPane に開く依頼を渡す。FilesPane が既存の openFile で中身を取る（サーバーがもう一度、一覧との完全一致を確かめる）。

### 4-2 パスの拾い方と当て方（fileLinks.ts、画面を持たない関数）
- 拾う語: 空白（全角の空白「　」を含む）と `()[]{}<>"'\`` と `,` で区切った語のうち、`/` を含む物。空白を含むパス（例 `/Volumes/HIGHLIFEJPN HDD/…`）と、Claude が途中を `…` で縮めたパスは当たらない（リンクにならないだけで、誤って開くことは無い）。語の末尾の `.` `,` `:` `;` `)` `」` `、` `。` は外す（繰り返し）。語の先頭の `(` は区切りで落ちる。
- 当て方（一覧の path は絶対パス）:
  1. 語が `/` で始まる → 一覧の path と完全一致した時だけ当たり。
  2. それ以外 → 先頭の `~/`、`./`、`../` を繰り返し外した残り（rest）を作る。rest が空、または `/` を含まない時は当てない。一覧のうち path が `"/" + rest` で終わる物がちょうど1つなら当たり。0 個・2 個以上なら当てない（取り違えを防ぐ）。
- 当たった時、リンクが開くのは「一覧の path」（端末の文字ではない）。
- 一覧はセッションの物だけ。別セッションの一覧は使わない。

### 4-3 列の数え方（fileLinks.ts）
- 公式 addon-web-links 0.12.0 と同じ方法（WebLinkProvider.ts:112-199）を、自前の関数として書く: 対象行が isWrapped なら上へ、次の行が isWrapped なら下へつなげて1本の文字列にする（上限 2048 文字、空白を含む行で止める）。文字列の添字から (行, 列) へは、getCell の getWidth・getChars で1セルずつ数えて戻す（全角の早い折り返しの補正も同じ）。range は 1 始まり、end.x は含む。
- MIT ライセンスの元コードを参考にした旨を、関数の上のコメントに1行書く（出典 URL とタグ 6.0.0）。

### 4-4 一覧の持ち方（TerminalPane の中、同じセッションだけ）
- 新しい保存先は作らない。一覧の正本はサーバーの /api/sessions/:id/files のまま。
- TerminalPane は「一覧の写し」と「その写しを取った時の filesRev」を ref に持つ。provideLinks が呼ばれた時、写しが無いか filesRev が進んでいれば fetchFiles を1回だけ呼び（同時に来た分は同じ Promise を待つ）、取れたら callback を呼ぶ。失敗・noSession の時は `callback(undefined)`（リンクなし）。
- 端末を作り直す（sessionId が変わる）と写しは捨てる（effect の中の変数に持つ）。
- 取るのはマウスが乗った時だけ。端末が表示されていない時や、何もしていない時には取らない。

### 4-5 FilesPane の受け口
```ts
// openRequest の seq が進んだら、そのパスを開く（sessionId が違う依頼は無視）
useEffect(() => {
  if (openRequest && openRequest.sessionId === sessionId) void openFile(openRequest.path);
  // eslint 無しの作法に合わせ、依存は seq だけを見る
}, [openRequest?.seq]);
```
- 一覧の取得は既存どおり（active になった時、K1 の effect :81-83）。開く処理は一覧の取得を待たない（サーバーが一致を確かめる。一覧に無ければ既存の notListed の表示）。
- sessionId が変わった時に選択を外す既存の effect（:49-53）より後に書く（同じ描画で両方動く時、開く方が後に勝つ）。

### 4-6 ConsolePage
```ts
const [fileOpenRequest, setFileOpenRequest] = useState<{ sessionId: string; path: string; seq: number } | null>(null);
const openFileFromTerminal = useCallback((path: string) => {
  if (!activeId) return;
  setCenterTab("files");
  setFileOpenRequest((prev) => ({ sessionId: activeId, path, seq: (prev?.seq ?? 0) + 1 }));
}, [activeId]);
```
- TerminalPane に `onOpenFile={openFileFromTerminal}` と `filesRev={state.activityRev}`、FilesPane に `openRequest={fileOpenRequest}` を渡す。
- 新しい文言・新しい部品は無い（下線とポインタは xterm の既定の飾り。ILinkDecorations は未設定＝両方有効、xterm.d.ts:1421-1422）。

## 5. 代替案と選択理由
- @xterm/addon-web-links を入れる: URL しか扱わない（isUrl）。不採用。
- 端末の文字列から任意のパスを開ける API を足す: 読める範囲が広がる（file-viewer §5・§7 C で不採用にした考え）。不採用。一覧に当たる物だけをリンクにする。
- Cmd を押しながらのクリックだけで開く: PO の依頼は「クリックしたら」。普通のクリックにする。ドラッグでの選択は xterm がクリックと区別する（ドラッグ後は activate されない）。【未確認】→ K9 で確かめる。
- 一覧を ConsolePage で取って両方に配る: FilesPane の取り方（開いている時だけ）を変えることになり、触る範囲が広い。不採用。TerminalPane はマウスが乗った時だけ取る。
- 相対パスを「セッション起動時の cwd（SessionView.cwd）」で解決する: Claude が途中で cd すると合わない（cwd は起動時の値、server/sessions.ts:64）。末尾一致で一覧に当てる方が確実。不採用。

## 6. リスクと対処
| リスク | 対処 |
|---|---|
| 似た名前のファイルを取り違える | 相対・`~/` の語は末尾一致がちょうど1つの時だけリンクにする（K1） |
| 全角入りの行で下線がずれる | 公式と同じ getCell による数え直し（K2） |
| マウスを動かすたびに一覧を取りにいく | 写しを持ち、filesRev が進んだ時だけ取り直す。同時の呼び出しは1回にまとめる |
| 端末の出力を他人が細工する | 開けるのは一覧に載った（このセッションが書いた）ファイルだけ。画面の中のタブ切り替えだけで、外への移動はしない |
| 既存試験のモックに registerLinkProvider が無く落ちる | 2つの試験ファイルのモックに足す（§2-3） |

## 7. 想定分岐（実装役・審査役向け）
- 手元で src/ の画面試験が React の二重読込で全滅する（既知、v0.38.3 カード §4）→ 手元は判定に使わず CI を正とする。worktree の試験には .sa-cache が要る（vitest.config.ts:5,9）。
- CI macOS の既知の揺れ（tmux の計時・pc-meter の CPU 比較）→ 失敗したジョブを1回だけ再実行する。2回落ちたら報告する。
- K9 で「長いパスが Claude の画面の都合で改行され（isWrapped でない本当の改行）、途中までしか下線が出ない」場合 → その時は当たらない（一部だけの語は末尾一致しないか、/ を含まない）。誤って開くことは無い。記録して次の改版で扱う。今回の合否には含めない（K9 は「改行されないパス」で判定）。
- K9 で、Claude の画面がマウスを使う設定の時にクリックが Claude 側に取られてリンクが反応しない場合 → 事実を記録して PO に報告する（xterm の既定では、マウスを使う設定の時は Shift を押しながらのクリックで端末側に渡る。【未確認】、その時に確かめる）。

## 8. 戻し方・測り方
- 戻し方: `bash scripts/ac-update.sh v0.39.0`
- 測り方: K1〜K7 は試験と CI、K8 は healthz、K9 は PO 目視。

## 9. 維持する仕組み
- K1〜K5 は vitest で CI が毎回走らせる。lint（check-design-governance.mjs）は文言の直書き・色の直値を毎回検査する。

## 10. 外部事例
不要。理由: 端末のリンクは xterm.js 公式の仕組み（registerLinkProvider と公式アドオンの数え方）をそのまま使い、新しい技術判断は「一覧に当たる物だけリンクにする」だけ。根拠は §3 の公式元コードと既存設計（file-viewer §5）。

## 11. 設計判断の記録（Why）
- 端末の文字からは「すでに読めるファイル」にだけ飛べるようにする。読める範囲の判定はサーバーの既存の完全一致に任せ、画面側では増やさない。

---
## 自己審査（Opus／同一AI。独立した第二者審査ではない）2026-10-16 判定: APPROVE
- 整合: 読める範囲は file-viewer §5・K3 のまま（サーバーと hook に触らない、K6 で機械的に確かめる）。新しい保存先なし（一覧の正本はサーバー）。文言の追加なし（i18n・lint に影響なし）。
- 根拠: xterm の座標の約束（1 始まり・end を含む・全角の数え直し）は型定義と公式元コード（タグ 6.0.0）で確かめた。Context7 は使えなかった事実を冒頭に記した。
- 検証可能性: K1〜K7 は機械判定、K8 は healthz、K9 は PO 目視。K9 の不確かな2点（本当の改行・マウスを使う設定）は §7 に分岐を書き、誤って開く方向の失敗は起きない作り（当たらなければリンクにしない）。
- 審査で直した点: 全角の空白を区切りに足した。空白入りのパスと `…` で縮めたパスは当たらないことを明記した。package-lock の版の行を明記した。
- 未解決: なし（K9 の2点は実機でしか確かめられず、合否の条件と分岐を決めてある）。

