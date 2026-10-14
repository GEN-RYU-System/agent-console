# 画像以外のファイルを端末に添付する（attach-files）設計 第1版

- 状態: 設計案 第1版（Opus 2026-10-14）。Fable 審査前。実装未着手。
- 根拠: 同じフォルダの recon.md（A1〜A5）。生出力 /tmp/CC報告ファイル/attach-files/r1/。

## 0. PO の言葉と目的
- PO（2026-10-14）「CSVがセッションに添付できないのだがそれもアップデートできる？スクショは添付できたが他のデータは添付することが出来ない」
- Opus の問い「CSV だけでなく PDF・Excel・テキストなども含めて、どの種類のファイルでも添付できるようにしてよいですか？（y なら種類を問わず、5MB まで）」に対し、PO「直し方を添えて『作り始めてよいか』→ y」。Opus はこれを「種類を問わず添付できるように、設計・審査を経て作ってよい」と受け取った（解釈であることを PO 報告に明記する）。
- 目的: 端末にどんなファイルをドロップしても、画像と同じく保存されてその場所が入力欄に入り、Claude に読ませられる。

## 1. 方針（一言）
画像（PNG・JPEG）は今のまま。それ以外は新しい口で「元の名前（安全に直した物）のまま」保存し、その絶対パスを端末に貼る。

## 2. 成功条件（○×で判定）
| # | 基準 | 検証方法 |
|---|---|---|
| K1 | 端末に CSV をドロップすると、dataDir/uploads/files/<UUID>/<名前>.csv に中身がそのまま（バイト一致）保存され、そのパスが入力欄に入る（Enter は押さない） | e2e（tests/e2e/console.spec.ts の pdf ドロップの試験を書き換え: csv と pdf の 2 通り） |
| K2 | PNG・JPEG の添付は今と同じ（同じ口・同じ保存先・同じ貼り方） | 既存の画像の試験（tests/unit/uploads*.test.ts・TerminalPane.ux.test.tsx の画像の部分）が変えずに緑 |
| K3 | 名前の直し方が表のとおり（§3-2） | 単体試験（tests/unit/uploadName.test.ts 新規）: 表の全行 |
| K4 | 5 MiB を超えるファイルは保存せず「大きすぎます」を出す | 画面の単体試験＋統合試験（413） |
| K5 | 画像以外の保存は 100 個までで、超えたら古い順に消える。消すのはこのアプリが作った UUID のフォルダとその中の 1 ファイルだけ | 単体試験: 101 個目で最古が消え、UUID でない名前の物は残る |
| K6 | フォルダ・読めないファイルをドロップしたら、何も貼らずに「保存できませんでした」を出す | 画面の単体試験（FileReader 失敗） |
| K7 | フォルダは 700、ファイルは 600 | 単体試験（stat の mode） |
| K8 | 文言はすべて t()、新しいハードコード 0 | npm run lint・design-governance 試験 |
| K9 | CI が ubuntu・macos とも緑 | CI |
| K10 | PO の目視: CSV を端末にドロップし、Claude に「このファイルを読んで」と送ると中身を答える | PO が画面で確認（手順は PR に書く） |

## 3. 仕組み
### 3-1 画面
- src/components/TerminalPane/imageTransfer.ts: classifyTransfer の返り値を `{ images, others, text }` にする（others = PNG・JPEG 以外の全部。hasOtherFiles は消す）。images の判定（:3,:17）は今のまま。
- TerminalPane.tsx:
  - attachOne（:150-161）を、画像なら今の uploadImage、それ以外なら新しい uploadFile(file) を呼ぶ形にする。大きさの事前検査（:151-152）・切り替わり検査（:156）・貼り方 `term.paste(\` ${path} \`)`（:157）・1 つずつ順に（:162-165）は同じ。
  - onDrop（:179-184）: images と others を、ドロップされた順のまま attach する（notImage は出さない）。
  - onPaste（:166-173）: 条件を「ファイルが 1 つ以上で、text/plain が空」にする（文字があれば今どおり xterm に任せる）。Finder でコピーしたファイルが clipboardData.files に入るかは【未確認】（入らなければ今と同じく何も起きないだけ）。
  - UploadNotice（:39）から "notImage" を消す。
- src/api.ts: `uploadFile(file: File): Promise<{path}>` を足す（`POST /api/uploads/files`、本文 `{name: file.name, data: base64}`）。readBytes・toBase64 は今の物を使う。
- 文言（src/locales/ja.json:197-203 の upload）:
  - title「画像を貼れませんでした」→「ファイルを貼れませんでした」
  - tooLarge「画像が大きすぎます（1枚 {{max}} まで）」→「ファイルが大きすぎます（1つ {{max}} まで）」
  - notImage を消す
  - failed「画像を保存できませんでした」→「ファイルを保存できませんでした（フォルダは貼れません）」
  - switched はそのまま

### 3-2 server
- 新しい口 `POST /api/uploads/files`（server/uploads-routes.ts に足す。handleUploads と同じ認証・Origin の内側、同じ本文の上限 uploadBodyLimit + 名前の分）。本文 `{name: string, data: base64}`。name が文字列でなければ 400。data の検査は decodeBase64（:16-21）を使う。成功は 201 `{path}`。大きすぎは 413 `{error:"file too large"}`。
- server/uploads.ts に `saveFile(name, data)` を足す（UploadStore の中、serial で 1 本ずつ）:
  - 大きさ > uploadMaxBytes なら UploadTooLargeError。
  - 中身は検査しない（種類を問わない、PO の y）。
  - 保存先 `dataDir/uploads/files/<randomUUID>/<安全な名前>`。files と <UUID> のフォルダは 700、ファイルは 600、一時ファイル→rename（今の save と同じ作法）。
  - 名前の直し方（新規 server/uploadName.ts の safeUploadName、K3）:
    | 入力 | 結果 | 理由 |
    |---|---|---|
    | `../../etc/x.csv`、`a\\b.csv` | `x.csv`、`b.csv` | 最後の `/`・`\` の後だけ使う |
    | `売上 10月.csv` | `売上_10月.csv` | 空白は `_`（端末に貼ったとき 1 語にする） |
    | `a"b'c$d;e&f|g<h>i(j)k*l?m!n#o~p.csv` | 記号はそれぞれ `_` | シェル・入力欄で意味を持つ記号を消す |
    | `.bashrc`、`-rf.csv` | `bashrc`、`rf.csv` | 先頭の `.`・`-` を落とす |
    | 制御文字入り | 制御文字を消す | |
    | 濁点が分かれた（NFD）日本語名 | NFC に直す | macOS の名前の揺れ |
    | 拡張子込みで 120 文字を超える | 本体を切って拡張子を残す | 長すぎるパスを避ける |
    | 直した結果が空・`.`・`..` | `file` | |
  - 消す（prune）: `dataDir/uploads/files` の中の UUID 名のフォルダを mtime の新しい順に並べ、uploadMaxKeep（既定 100）を超えた分を消す。消し方は「フォルダの中のファイルを 1 つずつ unlink → rmdir」。rm -r・rm -rf 相当（fs.rm の recursive）は使わない。UUID 名でない物には触らない。画像の prune（:67-88）とは数を別に数える。
- 画像の口・保存・prune（server/uploads.ts:20-89、uploads-routes.ts:24-38）は変えない（K2）。

### 3-3 Claude の読み方
- 貼るのはパスの文字だけ。Claude は Read ツールでそのパスを読む（CSV・テキスト・PDF は読める）。Excel（.xlsx）などは Read では中身を読めず、Claude が別の手段（python 等）で開くことになる。これは PO に伝える。

## 4. SSOT
- 添付したファイルの正は dataDir/uploads/files/<UUID>/ の 1 か所。台帳・記録は作らない（画像と同じ）。

## 5. 安全
- 保存先のパスは server が作る。画面からは名前の文字だけを受け取り、§3-2 の表で最後の 1 段だけにする。UUID のフォルダの中に置くので、他の場所には書けない（K3）。
- 中身は実行しない。保存は 600 で、実行の権限は付けない。
- 口は既存の /api/ の認証（Bearer）と、POST に必須の Origin 検査（server/http.ts:394-397）の内側にある。
- 秘密を含むファイルを添付すれば、それも Claude に読まれる（PO が自分で落とした物だけ）。

## 6. 決めたこと（Opus）
- D1 画像以外は種類を問わず受ける（PO の y の解釈）。上限は画像と同じ 5 MiB（PO への問いに書いた値）。
- D2 画像の口は変えず、新しい口を足す。理由: 画像は今のまま Claude の [Image #n] に入る動きを壊さない（K2）。
- D3 元の名前を（直して）残す。理由: Claude が拡張子と名前で何のファイルか分かる。名前が重なっても UUID のフォルダで分かれる。
- D4 GIF・WebP なども「画像以外」の側に入る（ファイルとして保存しパスを貼る）。
- D5 版はマージ時点の次の空き番号（マージ直前に origin/main の package.json を見て決める）。

## 7. 代替案
- A 画像の口を広げて全部受ける: 画像の検査（先頭バイト）と拡張子の決め方が崩れ、K2 の保証が弱くなる。不採用。
- B 名前を捨てて UUID.拡張子にする: Claude にも PO にも何のファイルか分からない。不採用。
- C チャット欄にも添付ボタンを付ける: 今回の依頼（端末への添付）の外。不採用（必要なら別件）。

## 8. リスクと対処
- Finder からのコピー＆貼り付けで files が来ない環境 →【未確認】。ドロップは確実に使える、と PR に書く。
- 大きな CSV（5 MiB 超）→ 貼れない。案内が出る。上限を上げるかは PO が使ってから決める。
- .xlsx は Claude が直接は読めない → §3-3、PO に伝える。

## 9. 外部・過去事例
- 外部事例は使わない。理由: アプリの中の受け口の話で、判断は手元の事実（recon）で足りる。
- 過去事例: v0.7.0 の画像の添付（同じ保存の作法・順番・切り替わり検査）をそのまま使う。

## 10. 工程（1 回で Sonnet に渡す）
1. server: uploadName.ts・saveFile・prune・新しい口・試験（K3・K4・K5・K7）
2. 画面: imageTransfer・TerminalPane・api・ja.json・試験（K1・K4・K6・K8）。既存試験で変わる物: imageTransfer.test.ts:17-25（others に入ることへ）、TerminalPane.ux.test.tsx:166-176（pdf のドロップで uploadFile が呼ばれ、パスが貼られることへ）、tests/e2e/console.spec.ts:1278-1344（pdf のドロップ → 保存と貼り付けへ。csv も足す）。画像の試験は変えない（K2）。
3. 版の 4 か所（package.json:3、package-lock.json:3,9、extension/manifest.json:4）・docs/CHANGELOG.md・README.md（添付の説明）
4. 審査（Fable）→ CI（K9）→ マージ・タグ・update-when-idle → PO 目視（K10）

## 触るファイル・触らないファイル
- 触る: src/components/TerminalPane/imageTransfer.ts・imageTransfer.test.ts・TerminalPane.tsx・TerminalPane.ux.test.tsx、src/api.ts、src/locales/ja.json、server/uploads.ts、server/uploads-routes.ts、server/uploadName.ts（新規）、tests/unit/uploadName.test.ts（新規）・uploads.test.ts（足すだけ）・uploads.integration.test.ts（足すだけ）、tests/e2e/console.spec.ts、版の 4 か所・CHANGELOG・README。
- 触らない: 画像の検査と保存（detectImage・save・画像の prune）、チャット欄、認証、server/config.ts の値。

## 維持の仕組み
- K3・K5 の試験が CI に入り、名前の直しや消す範囲を緩める変更は赤になる。画像の既存試験が K2 を見張る。
