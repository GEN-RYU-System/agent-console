# 画像以外のファイルを端末に添付する（attach-files）設計 第2版

- 状態: 設計審査済み（第2版、Fable APPROVE 条件付き 2026-10-14。条件 N1 と任意 N2〜N5 を反映済み、§11）。実装未着手。
- 表の中の `\|` は Markdown の表の区切りと区別するための書き方で、実際の文字は `|`。
- 根拠: 同じフォルダの recon.md（A1〜A5）。生出力 /tmp/CC報告ファイル/attach-files/r1/。第2版で Opus が読み直した行: server/uploads.ts:1-89、server/uploads-routes.ts:1-38、server/http.ts:427-439、server/config.ts:107-110、README.md:184、src/components/TerminalPane/imageTransfer.ts:1-19・imageTransfer.test.ts:1-35、TerminalPane.ux.test.tsx:29-32、tests/e2e/console.spec.ts:1272-1274、src/api.test.ts:3,135-160。

## 0. PO の言葉と目的
- PO（2026-10-14）「CSVがセッションに添付できないのだがそれもアップデートできる？スクショは添付できたが他のデータは添付することが出来ない」
- Opus の問い「CSV だけでなく PDF・Excel・テキストなども含めて、どの種類のファイルでも添付できるようにしてよいですか？（y なら種類を問わず、5MB まで）」に対し、PO「直し方を添えて『作り始めてよいか』→ y」。Opus はこれを「種類を問わず添付できるように、設計・審査を経て作ってよい」と受け取った（解釈であることを PO 報告に明記する）。
- 目的: 端末にどんなファイルをドロップしても、画像と同じく保存されてその場所が入力欄に入り、Claude に読ませられる。

## 1. 方針（一言）
画像（PNG・JPEG）は今のまま。それ以外は新しい口で「元の名前（安全に直した物）のまま」保存し、その絶対パスを端末に貼る。

## 2. 成功条件（○×で判定）
| # | 基準 | 検証方法 |
|---|---|---|
| K1 | 端末に CSV（中身に UTF-8 の日本語を含む）をドロップすると、dataDir/uploads/files/<UUID>/<名前>.csv に中身がバイト一致で保存され、そのパスが入力欄に入る（Enter は押さない）。PDF も同じ | e2e（tests/e2e/console.spec.ts の pdf ドロップの試験を書き換え、csv を足す） |
| K2 | PNG・JPEG の添付は今と同じ（同じ口・同じ保存先・同じ貼り方） | 画像の既存試験（tests/unit/uploads.test.ts・uploads.integration.test.ts・src/api.test.ts:135-160・TerminalPane.ux.test.tsx の画像の部分・e2e の png の部分）が中身を変えずに緑 |
| K3 | 名前の直し方が §3-3 の手順どおり。表の全行が期待どおり | 単体試験（tests/unit/uploadName.test.ts 新規）: §3-3 の表の全行 |
| K4 | uploadMaxBytes（既定 5 MiB）を超えるファイルは保存せず「大きすぎます」を出す。ちょうど uploadMaxBytes は 201、1 byte 超えは 413（統合試験は harness の uploadMaxBytes が境界） | 画面の単体試験（事前の大きさ検査）＋統合試験（境界の 201/413） |
| K5 | 画像以外の保存は uploadMaxKeep 個までで、超えたら古い順に消える。消すのはこのアプリが作った UUID 名のフォルダ（中が普通のファイルだけの物）だけ | 単体試験（maxKeep=3 で、既存の uploads.test.ts と同じ作り）: 4 個目で最古が消える／UUID でない名前のフォルダ・ファイルは残る／中にサブフォルダがある UUID フォルダは残る／画像の数とは別に数える |
| K6 | 読めないファイル（フォルダなど）は何も貼らずに「保存できませんでした」を出す | 2 段: src/api.test.ts で「FileReader が失敗 → uploadFile が reject」、TerminalPane.ux.test.tsx で「uploadFile が reject → failed の通知・何も貼らない」 |
| K7 | files・<UUID> のフォルダは 700、ファイルは 600 | 単体試験（stat の mode） |
| K8 | 空（0 byte）のファイルも保存できる | 単体試験＋統合試験（data "" → 201、0 byte のファイル） |
| K9 | 新しい口の拒否: name が文字列でない・空・1024 文字超 → 400、data が base64 でない → 400、トークン無し → 401、セッション認証で Origin 無し → 403 | 統合試験（tests/unit/uploads.integration.test.ts の既存の表と同じ形） |
| K10 | 文言はすべて t()、新しいハードコード 0 | npm run lint・design-governance 試験 |
| K11 | CI が ubuntu・macos とも緑 | CI |
| K12 | PO の目視: CSV を端末にドロップし、Claude に「このファイルを読んで」と送ると中身を答える | PO が画面で確認（手順は PR に書く。CSV で確かめる） |

## 3. 仕組み
### 3-1 画面
- src/components/TerminalPane/imageTransfer.ts: classifyTransfer の返り値を `{ files: { file: File; kind: "image" | "file" }[]; text: string }` にする。files はドロップ・貼り付けされた元の順のまま。kind は今の判定（ATTACHABLE_IMAGE_TYPES、:3）で image、それ以外（種類が空を含む）は file。hasOtherFiles・images は消す。
- TerminalPane.tsx:
  - attachOne（:150-161）に kind を渡し、image なら今の uploadImage、file なら新しい uploadFile を呼ぶ。大きさの事前検査（:151-152）・切り替わり検査（:156）・貼り方 `term.paste(\` ${path} \`)`（:157）・1 つずつ順に（:162-165）は同じ。
  - onDrop（:179-184）: files を元の順に attach する（notImage は出さない）。files が 0 なら今どおり何もしない。
  - onPaste（:166-173）: 条件を「files が 1 つ以上で、text/plain が空」にする（文字があれば今どおり xterm に任せる）。Finder でコピーしたファイルが clipboardData.files に入るかは【未確認】（入らなければ今と同じく何も起きないだけ）。
  - UploadNotice（:39）から "notImage" を消す。表示は ConsolePage.tsx:424-426 の動的キー `ac.upload.${uploadNotice}` で、残りの 3 種のまま。
- src/api.ts: `uploadFile(file: File): Promise<{ path: string }>` を足す（`POST /api/uploads/files`、本文 `{ name: file.name, data: base64 }`）。readBytes・toBase64（:200-213）は今の物を使う。
- 文言（src/locales/ja.json:197-203 の upload）:
  - title「画像を貼れませんでした」→「ファイルを貼れませんでした」
  - tooLarge「画像が大きすぎます（1枚 {{max}} まで）」→「ファイルが大きすぎます（1つ {{max}} まで）」
  - notImage を消す
  - failed「画像を保存できませんでした」→「ファイルを保存できませんでした（フォルダは貼れません）」
  - switched はそのまま

### 3-2 server: 受け口（server/uploads-routes.ts）
- 新しい口 `POST /api/uploads/files`（UPLOAD_FILES_PATH、新しい関数 handleUploadFiles。http.ts:197 の handleUploads の隣で呼ぶ）。今の handleUploads と同じく handleApi の中で呼ぶので、認証（http.ts:429-433）と、セッション認証の POST に必須の Origin 検査（http.ts:434-438）の内側に入る。
- 本文の上限: `uploadBodyLimit(uploadMaxBytes) + NAME_MARGIN_BYTES`。NAME_MARGIN_BYTES = 8192（name は最大 1024 文字。JSON で 1 文字最大 6 byte の \uXXXX にされても 6144 byte に収まる）。
- name: 文字列で、長さ 1〜1024（UTF-16 の数）。違えば 400 `{error:"name must be a string of 1-1024 characters"}`（SessionInputError）。
- data: 新しい decodeFileBase64（空の "" は 0 byte として受ける。それ以外は今の decodeBase64 と同じ検査、:16-21）。
- 成功は 201 `{path}`。大きすぎ（本文の上限超え・中身が uploadMaxBytes 超え）は 413 `{error:"file too large"}`。
- 画像の口 handleUploads（:24-38）は変えない（K2）。

### 3-3 server: 名前の直し方（新規 server/uploadName.ts の safeUploadName）
手順（この順。結果は必ず空でない 1 段の名前）:
1. `String.prototype.toWellFormed()` で不正なサロゲートを U+FFFD にする（Node 24。U+FFFD は手順 4 で `_` になる）。
2. NFC に直す（macOS の濁点が分かれた名前をまとめる）。
3. 最後の `/` または `\` より後だけを使う。
4. 1 文字ずつ見て、使ってよい文字（Unicode の文字 `\p{L}`・結合記号 `\p{M}`・数字 `\p{N}`・`.`・`_`・`-`）以外はすべて `_` にする（空白・制御文字・記号・バッククォート・括弧・`%` などは全部ここで消える。許す側を決める方式）。
5. 続いた `_` は 1 つにまとめる。
6. 先頭の `.` と `-` を、続く限り全部落とす（`..foo.csv` → `foo.csv`）。
7. 120 文字（コードポイント）を超えたら切る。拡張子 = 最後の `.` より後で、1〜10 文字・`\p{L}\p{N}` だけで、その前に 1 文字以上ある物。拡張子があれば本体を頭から「120 −（拡張子の文字数 + 1）」文字に切って `.拡張子` を付ける、無ければ頭から 120 文字。
8. 結果が空・`.`・`..`・`_` だけ なら `file`。

| 入力 | 結果 |
|---|---|
| `../../etc/x.csv` | `x.csv` |
| `a\b.csv` | `b.csv` |
| `売上 10月.csv` | `売上_10月.csv` |
| `` a"b'c$d;e&f\|g<h>i(j)k*l?m!n#o~p`q[r]s{t}u^v%w=x,y.csv `` | `a_b_c_d_e_f_g_h_i_j_k_l_m_n_o_p_q_r_s_t_u_v_w_x_y.csv` |
| `a  b.csv`（空白 2 つ） | `a_b.csv` |
| `.bashrc` | `bashrc` |
| `-rf.csv` | `rf.csv` |
| `..foo.csv` | `foo.csv` |
| `a\u0007b.txt`（制御文字入り） | `a_b.txt` |
| NFD の `ダ.csv`（タ + U+3099） | NFC の `ダ.csv` |
| 本体 200 文字 + `.csv` | 本体 116 文字 + `.csv`（計 120） |
| 拡張子なしの 200 文字 | 頭から 120 文字 |
| `...`、`///`、`"` | `file` |
| 不正サロゲート入り `a\uD800b.csv` | `a_b.csv` |

### 3-4 server: 保存と消す処理（server/uploads.ts の UploadStore に足す）
- `saveFile(name: string, data: Buffer): Promise<{ path: string }>`。今の save（:48-62）と同じ serial の中で 1 本ずつ。
  - data.length > maxBytes なら UploadTooLargeError。中身は検査しない（種類を問わない）。
  - `files = dataDir/uploads/files`、`dir = files/<randomUUID()>`。files と dir を mkdir（700）＋ chmod（700）。
  - `final = path.join(dir, safeUploadName(name))`。`path.dirname(final) === dir` でなければ例外（名前の規則が将来緩んでも外へ書かない保険）。
  - 書き方は今の save と同じ: dir の中に一時ファイル（`.<UUID>.tmp`、600）→ chmod 600 → rename で final。
  - 最後に pruneFiles(このフォルダの UUID)。
- pruneFiles(justSaved):
  - files の中で、名前が小文字 UUID（新しい定数 UPLOAD_DIR_PATTERN = UUID だけの形。画像の UPLOAD_FILE_PATTERN :12 とは別）で、lstat がフォルダ（シンボリックリンクでない）の物だけを候補にする。
  - 並べる時刻は「フォルダの mtime」（rename で中にファイルが入った時刻）。新しい順に並べ、maxKeep を超えた物を消す。justSaved は飛ばす（今の :82 と同じ）。
  - 1 つのフォルダの消し方: 中身を readdir し、全部が lstat で普通のファイルなら 1 つずつ unlink してから rmdir。中にサブフォルダ・シンボリックリンクなど普通のファイル以外があれば、そのフォルダは触らずに残す（このアプリはそういう物を作らないので通常は起きない。起きた時は残る分だけ数の枠を占めるが、消しすぎない側に倒す）。フォルダを丸ごと消す関数（fs.rm の recursive）は使わない。
  - 失敗の扱いは画像の prune（:83-86）と同じ: ENOENT は無視、それ以外は例外（その保存は 500 になるが、保存した物は残る。画像と同じ動き）。
  - 画像の prune（:67-88）とは数を別に数える（画像の UPLOAD_FILE_PATTERN は uploads 直下のファイルだけを見るので、files フォルダは対象外のまま）。
- 上限は画像と同じ値を使う（uploadMaxBytes 5 MiB、uploadMaxKeep 100）。値は変えず、server/config.ts:107-110 のコメントを「端末に貼る画像・ファイル 1 つの上限」「貼った画像・ファイルを残す数（画像とファイルは別に数える）」に直す。

### 3-5 Claude の読み方
- 貼るのはパスの文字だけ。Claude は Read ツールでそのパスを読む（CSV・テキスト・PDF は読める）。Excel（.xlsx）などは Read では中身を読めず、Claude が別の手段（python 等）で開くことになる。これは PO に伝える。
- 既定の dataDir は `~/Library/Application Support/agent-console`（空白を含む）なので、貼られるパスにはいつも空白がある。画像も同じで、今も Claude Code の入力欄では問題なく扱えている（`[Image #n]` になる）。画像以外のパスを Claude Code がどう扱うか（ただの文字として残るか）は【未確認】。K12 の PO の目視で確かめる。名前の空白を `_` にするのは、名前の中に区切りを増やさず読みやすくするため（パス全体を 1 語にするためではない）。

## 4. SSOT
- 添付したファイルの正は dataDir/uploads/files/<UUID>/ の 1 か所。台帳・記録は作らない（画像と同じ）。

## 5. 安全
- 保存先のパスは server が作る。画面からは名前の文字だけを受け取り、§3-3 で「許す文字だけの 1 段の名前」にする。`/`・`\`・`..` は残らない。最後に dirname の一致を確かめる。
- 中身は実行しない。保存は 600 で、実行の権限は付けない。
- 消すのは UUID 名のフォルダで、中が普通のファイルだけの物に限る。1 つずつ unlink してから rmdir する。
- 口は既存の /api/ の認証（Bearer）と、セッション認証の POST に必須の Origin 検査（server/http.ts:434-438）の内側にある。
- 秘密を含むファイルを添付すれば、それも Claude に読まれる（PO が自分で落とした物だけ）。

## 6. 決めたこと（Opus）
- D1 画像以外は種類を問わず受ける（PO の y の解釈）。上限は画像と同じ 5 MiB（PO への問いに書いた値）。
- D2 画像の口は変えず、新しい口を足す。理由: 画像は今のまま Claude の [Image #n] に入る動きを壊さない（K2）。
- D3 元の名前を（直して）残す。理由: Claude が拡張子と名前で何のファイルか分かる。名前が重なっても UUID のフォルダで分かれる。
- D4 GIF・WebP なども「画像以外」の側に入る（ファイルとして保存しパスを貼る）。
- D5 名前は「許す文字だけ残す」方式（審査 H1）。
- D6 空のファイルも受ける（「種類を問わず」に合わせる。審査 M7）。
- D7 版はマージ時点の次の空き番号（マージ直前に origin/main の package.json を見て決める。第2版を書いた時点は 0.21.0）。

## 7. 代替案
- A 画像の口を広げて全部受ける: 画像の検査（先頭バイト）と拡張子の決め方が崩れ、K2 の保証が弱くなる。不採用。
- B 名前を捨てて UUID.拡張子にする: Claude にも PO にも何のファイルか分からない。不採用。
- C チャット欄にも添付ボタンを付ける: 今回の依頼（端末への添付）の外。不採用（必要なら別件）。
- D 名前の直し方を「消す記号を並べる」方式: 並べ漏れが残る（第1版の審査 H1）。不採用。

## 8. リスクと対処
- Finder からのコピー＆貼り付けで files が来ない環境 →【未確認】。ドロップは確実に使える、と PR に書く。
- 大きな CSV（5 MiB 超）→ 貼れない。案内が出る。上限を上げるかは PO が使ってから決める。
- .xlsx は Claude が直接は読めない → §3-5、PO に伝える。
- 画像以外のパスの Claude Code での扱い →【未確認】、K12 で確認。うまく読まない時は直し方を別に設計する。

## 9. 外部・過去事例
- 外部事例は使わない。理由: アプリの中の受け口の話で、判断は手元の事実（recon）で足りる。
- 過去事例: v0.7.0 の画像の添付（同じ保存の作法・順番・切り替わり検査）をそのまま使う。

## 10. 工程（1 回で Sonnet に渡す）
1. server: uploadName.ts・saveFile・pruneFiles・新しい口・config.ts のコメント・試験（K3・K4・K5・K7・K8・K9）
2. 画面: imageTransfer・TerminalPane・api・ja.json・試験（K1・K4・K6・K10）。
   既存試験で変える物（全部）:
   - src/components/TerminalPane/imageTransfer.test.ts: hasOtherFiles・images を見ている :15,:17-25,:32 を、files（元の順・kind）を見る形に。
   - src/components/TerminalPane/TerminalPane.ux.test.tsx: :29-32 の api の mock に uploadFile を足す。:166-176（pdf のドロップ → notImage）を「pdf のドロップ → uploadFile が呼ばれ、パスが貼られる」に。
   - tests/e2e/console.spec.ts: :1273-1274 の uploadedFiles() が uploads 直下の files フォルダも 1 件と数えるので、画像の数は「UUID.png|jpg の名前だけ」を数える形に直す（:1320・:1329・:1340 の before+n が合うように）。:1278-1344 の pdf のドロップ → 保存と貼り付けへ。csv を足す。
   - src/api.test.ts: uploadFile の試験を足す（成功・413・FileReader 失敗で reject）。uploadImage の試験（:135-160）は変えない。
   画像の試験の中身は変えない（K2。e2e の数え方の直しは数え方だけ）。
3. 版の 4 か所（package.json:3、package-lock.json:3,9、extension/manifest.json:4）・docs/CHANGELOG.md（1 版 1 行）・README.md:184（「PNG と JPEG 以外のファイルを落としても何も貼らず、案内だけ出ます」を、画像以外は uploads/files/<UUID>/<名前> に保存してパスを貼る、の説明に書き換え）
4. 審査（Fable）→ CI（K11）→ マージ・タグ・update-when-idle → PO 目視（K12）

## 触るファイル・触らないファイル
- 触る: src/components/TerminalPane/imageTransfer.ts・imageTransfer.test.ts・TerminalPane.tsx・TerminalPane.ux.test.tsx、src/api.ts・src/api.test.ts、src/locales/ja.json、server/uploads.ts、server/uploads-routes.ts、server/http.ts（handleApi の :197 の handleUploads の隣に handleUploadFiles の呼び出しを 1 行足す）、server/config.ts（コメントだけ）、server/uploadName.ts（新規）、tests/unit/uploadName.test.ts（新規）・uploads.test.ts（足すだけ）・uploads.integration.test.ts（足すだけ）、tests/e2e/console.spec.ts、版の 4 か所・CHANGELOG・README。
- 触らない: 画像の検査と保存（detectImage・save・画像の prune）、画像の口、チャット欄、認証・Origin の検査、server/config.ts の値。

## 維持の仕組み
- K3・K5 の試験が CI に入り、名前の直しや消す範囲を緩める変更は赤になる。画像の既存試験が K2 を見張る。

## 11. 審査の記録
- 第1版（2026-10-14、Fable）: REVISE。高 H1（名前の直し方が並べ漏れのある方式）→ §3-3 を許す文字の方式に。中 M1（元の順が失われる）→ §3-1 files[]。M2（壊れる既存試験の漏れ）→ §10-2 に全部。M3（本文の上限が数でない）→ §3-2。M4（消す処理の例外）→ §3-4。M5（空白の理由が誤り・非画像パスの扱いが未確認）→ §3-5・§8。M6（FileReader 失敗の試験の場所）→ K6 を 2 段に。M7（空ファイル）→ D6・K8。M8（順序・範囲・切り方）→ §3-3。低 L1〜L8・推奨（dirname の確認）→ 該当箇所に反映。審査本文は Fable の報告（Opus の会話記録）にある。
- 第2版（2026-10-14、Fable、/tmp/CC報告ファイル/attach-files/review-design2/review.md）: APPROVE（条件付き）。表 16 行を手順どおりのスクリプトで検算し 15 行一致。N1（`"` → `file` が手順 8 と矛盾）→ 手順 8 に「`_` だけ」を足した。N2（UPLOAD_DIR_PATTERN は新しい定数）・N3（http.ts の足す場所）・N4（表示の行）・N5（切る文字数・境界）→ 反映。
