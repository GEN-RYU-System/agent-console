# agent-console 段階1.5 設計書（起動・版管理・セキュリティ）

- 状態: 設計案（Opus 作成・Opus 自己審査）。PO 承認: 「段階1.5を先に」y（2026-10-11）、「確立したなら進める」。KGI の数値は Opus 設定。
- 調査: docs/handoff/stage1-5/recon.md／前段: docs/handoff/stage1/design.md

> 改訂 2026-10-11（修正ラウンド1・設計者 Opus）: 相互認証（秘密を 4319 の相手に送らない）、Cookie 廃止（sessionStorage ＋ Bearer / WebSocket サブプロトコル）、タグの検証（origin/main 到達性・`--ignore-scripts`・SHA 表示）、スクリプトからの `rm` 全廃、ロックの原子化、`/healthz` の版・コミット照合、キーチェーン記述の事実への修正。根拠: review-stage1-5.md（M1〜M3, L1〜L5）。

## 1. 目的（PO の言葉）

普通のアプリのようにこの Mac で起動でき、この Mac の中で版を管理でき、外部からの攻撃に備えたい。段階2（スマホ）で接続の入口が増える前に、起動・認証・版の土台と守りを固める。

## 2. KGI（○×で判定）

| # | 基準 | 検証方法 |
|---|---|---|
| K1 | Dock（~/Applications/Agent Console.app）を 1 回クリックすると、URL を貼らずにログイン済みの画面がアプリ窓で開く | PO 実機 1 回＋自動テスト（チャレンジ→コード→/pair?code→引換→画面表示を Playwright で） |
| K2 | 長期の秘密（サーバー秘密）が URL・起動ログ・ブラウザ履歴に出ず、**4319 で応答した相手にも送らない**（相互認証）。URL に出るのは 1 回限り・30 秒で失効するコードだけで、再使用・失効後は 401 | 単体・統合テスト（再使用 401、31 秒後 401、ログ全文に秘密が 0 件） |
| K3 | ログイン時に自動でサーバーが起動し、`/healthz` が 200 を返す | PO 実行のインストール出力（`launchctl print` の state と curl 結果）。plist は `plutil -lint` OK をテストで |
| K4 | 版の切替: 新しい版の導入・1 つ前への切戻しが 1 コマンドででき、画面下部の版表示が切り替わる。導入前の自己診断に失敗した版には切り替わらない | スクリプトの統合テスト（一時ディレクトリ・launchctl/security/git をスタブ化）＋PO 実機 1 回 |
| K5 | セッショントークンはタブの sessionStorage にだけ置く（Cookie は出さない＝Set-Cookie が全応答で 0 件）。API は Bearer、WebSocket は `Sec-WebSocket-Protocol: ac.<token>`。セッション認証の状態変更要求（POST/DELETE）と WS は Origin が自分以外なら 403。セッション最長 12 時間・画面からログアウト（サーバー側で失効） | 統合テスト・e2e |
| K6 | CI で `npm audit --audit-level=moderate` と `npm audit signatures` が成功。専任セキュリティ点検で CRITICAL/HIGH が 0 件 | CI・点検報告 |
| K7 | 段階1の K1〜K8 が引き続き合格（デザイン検査含む） | 既存テスト |

## 3. 対象と対象外

対象: ログイン時自動起動、Dock の起動アプリ、ペアリング方式の認証（URL から長期秘密を除く）、この Mac での版管理（導入・更新・切戻し・撤去）、依存の自動検査、専任点検。

対象外: スマホ（段階2）。Chrome の「アプリとしてインストール（PWA）」は使わない（通常タブとの Cookie 共有が文書で確認できないため: recon §B）。Dependabot は使わない（private での利用条件が未確認: recon §E）。

## 4. 仕組み

### 4-1. 置き場所（この Mac）

```
~/Library/Application Support/agent-console/
  versions/<tag>/        各版の中身（git clone --branch <tag> --depth 1＋npm ci＋sa-sync＋build 済み）
  current -> versions/<tag>   いま使う版（シンボリックリンク。これが「どの版か」の唯一の正本）
  logs/server.out.log, server.err.log
  lock/                  導入・更新・切戻しの排他（mkdir ロック）
~/Library/LaunchAgents/local.agent-console.server.plist
~/Applications/Agent Console.app   起動アプリ（osacompile で生成）
キーチェーン: サービス agent-console / アカウント server   サーバー秘密（32 バイト乱数の 16 進）
```

- 版の正本は git タグ（`vX.Y.Z`）。導入済みの版の一覧は versions/ の中身、使用中の版は current の指す先。別の記録ファイルは作らない。
- Sales Anchor のデザイン（.sa-cache）は版ごとの導入時に展開して固定する（起動のたびには取得しない）。展開元 SHA は従来どおり画面下部に表示。

### 4-2. 自動起動（LaunchAgent）

- Label `local.agent-console.server`、ProgramArguments `[/usr/local/bin/node（導入時に `command -v node` で解決した絶対パス）, <current>/dist-server/server/index.js]`、WorkingDirectory `<current>`、RunAtLoad=true、KeepAlive=false（落ちたら起動アプリが起こし直す）、StandardOutPath/StandardErrorPath は logs/、EnvironmentVariables に `AGENT_CONSOLE_AUTH=keychain`。
- 雛形は `ops/launchd/local.agent-console.server.plist.template`（リポジトリ内）。導入スクリプトがパスを埋めて書き出し、`plutil -lint` で検査してから `launchctl bootstrap gui/<uid>`。

### 4-3. 認証（相互認証つきペアリング＋セッショントークン）

1. 導入時に `security -i`（標準入力から `add-generic-password -U -s agent-console -a server -w <乱数>` を渡す。値を引数に出さない）で秘密を保存。値は画面に出さない。
2. サーバー起動時（`AGENT_CONSOLE_AUTH=keychain`）、`security find-generic-password -s agent-console -a server -w` で秘密を読む。読めなければ起動中止。開発時（`npm start`）は従来どおり起動ごとの乱数（`AGENT_CONSOLE_AUTH` 未設定）。本番（keychain）では `AC_*` の差し替え環境変数を無視する（テストモード `AC_STUB_LOG` が無い限り既定値）。
3. **相互認証（長期秘密をネットワーク相手に送らない）**。起動アプリ（Dock）は、`/healthz` が 200 を返しただけの相手を信用しない。
   1. launcher が乱数 `cnonce`（16 バイト hex）を付けて `POST /api/pair/challenge`。サーバーは `snonce`（32 バイト乱数・30 秒・1 回限り・cnonce に束縛）と `proof_s = HMAC-SHA256(secret, "server|" + cnonce + "|" + snonce)` を返す。
   2. launcher が秘密から同じ値を計算して `proof_s` を検証する。**不一致なら中止し、何も送らない**（秘密も `proof_c` も送らない）。HMAC は現行版の node スクリプト（`ops/launcher/pair-proof.mjs`）を呼び、**秘密は標準入力で渡す**（argv に出さない）。
   3. launcher が `proof_c = HMAC-SHA256(secret, "client|" + snonce + "|" + cnonce)` を `POST /api/pair {cnonce, snonce, proof}` に送り、サーバーが検証して 1 回限りのペアリングコード（32 バイト乱数・30 秒失効）を返す。snonce は検証の成否にかかわらずここで消費される。
   サーバーが応答しなければ `launchctl kickstart gui/<uid>/local.agent-console.server` して最大 10 秒 `/healthz` を待つ。`Bearer`（秘密）による `/api/pair` は廃止（開発・テストの Bearer は他の API にだけ使える）。
4. `open -na "Google Chrome" --args --app=http://127.0.0.1:4319/pair?code=<コード>`。`/pair` は SPA を返し、画面が `POST /api/pair/redeem {code}` でコードを引換える（1 回限り）。サーバーはセッショントークン（32 バイト乱数、サーバーのメモリ上、**最長 12 時間**・サーバー再起動で失効）を返す。画面はそれを **sessionStorage**（オリジン＝ポート単位でタブごとに分離）に保存し、`history.replaceState` で URL を `/` にする。無効・失効・再使用のコードは 401 で、画面は SA の Callout で案内。**Set-Cookie は一切出さない**（Cookie はポートで分離されず、同じ 127.0.0.1 の別ポートへ送られてしまうため: review M2）。
5. API は `Authorization: Bearer <セッショントークン>`、WebSocket は `Sec-WebSocket-Protocol: ac.<セッショントークン>`（サーバーは受理したサブプロトコルをそのまま応答に返す）で認証。URL クエリ `?t=` は廃止。Host 完全一致・Origin 検査は維持（セッション認証の POST/DELETE と WS は Origin 必須: 自分以外・欠落は 403）。
6. 画面にログアウト（SA Button）。`POST /api/logout` でサーバー側のセッションを失効させ、sessionStorage を消去する。
7. ログに出すのは開発時のペアリング URL（1 回限りコード、開発時のみ有効期限 5 分）だけ。秘密・セッションは出さない。
8. `/healthz`: 認証不要、Host 検査あり、本文は `{"ok":true,"version":"<package.json の version>","commit":"<git rev-parse HEAD>"}`。更新・切戻し・自己診断の成功判定はこの本文が期待の版・コミットと一致することで行う（旧プロセスや別プロセスの 200 では成功にしない）。

### 4-4. 版管理（scripts/ に置く。すべて mkdir ロック＋trap）

| コマンド | 動作 |
|---|---|
| `scripts/ac-install.sh <tag>` | 初回導入。秘密が無ければ作成→版を導入（下の install-version）→plist 書出し・lint・bootstrap→起動アプリ生成→`/healthz` 確認 |
| `scripts/ac-update.sh <tag>` | install-version → current を切替（`ln -sfn`）→ `launchctl kickstart -k` → `/healthz` の本文が期待の版・コミットと一致するか確認。失敗したら元の版に戻す |
| `scripts/ac-rollback.sh` | versions/ のうち current より 1 つ前（semver 順）へ切替 → kickstart → `/healthz` の本文が期待の版・コミットと一致するか確認 |
| `scripts/ac-uninstall.sh` | bootout → plist と起動アプリを **Trash へ移動**（削除しない）。versions/ とキーチェーンの秘密は残す（`--purge` 指定時のみ、versions/・current・logs を Trash へ移動し、キーチェーンの秘密を削除） |
| install-version（内部） | ①`gh repo clone shingo-cc/agent-console <一時> -- --branch <tag> --depth 1` ②タグのコミット SHA を取得し、**origin/main から到達可能**であることを確認（`gh api repos/<repo>/compare/main...<SHA>` の status が `identical` か `behind`。`ahead`・`diverged` は中止）③**`npm ci --ignore-scripts`**（依存のライフサイクルスクリプトを実行しない）→ リポジトリ内の自前スクリプト（`scripts/postinstall.mjs`: node-pty の spawn-helper の実行権）を明示実行 → sa-sync → build ④別ポート（4320）で自己診断（起動→`/healthz` が期待の版・コミットと一致→停止）。失敗した版は Trash へ移し current にしない。導入・更新の出力にタグの**コミット SHA を表示**し、画面下部にも表示 |

- **片付けは削除せず Trash へ移す**（設計者（Opus）判断 2026-10-11：削除系コマンドをスクリプトに書かない。安全フックの方針に合わせ、元に戻せる移動にする）。移動先は `~/.Trash/agent-console-<種類>-<YYYYmmdd-HHMMSS>`（テストでは `AC_TRASH` で差し替え）。対象は撤去する plist・起動アプリ、失敗した版の一時ディレクトリ、置き換える旧 plist・旧起動アプリ、`--purge` の versions/・current・logs。移動元はマーカーのある AC_HOME 配下か LaunchAgents・Applications 配下に限る。キーチェーンの秘密の削除（`--purge`）だけは元に戻せない。
- **スクリプトに `rm`（`-f` を含む全形）と `unlink` を書かない**。単一ファイルも Trash へ移す。pid・ロック・一時ファイルは、ファイルを作らない（診断プロセスの pid はシェル変数、起動アプリは osacompile へ標準入力で渡す）か、空ディレクトリ（`rmdir` で消せる）で表す。
- **ロックの原子化**: `mkdir lock` が成功した直後に、保持者を空ディレクトリ `lock/pid-<pid>` で記録する。回収は「`pid-<n>` があり、そのプロセスが不在」または「`pid-<n>` が無く、ロックの作成から 10 分超」の場合だけ。回収の各段（`rmdir lock/pid-<n>`、`rmdir lock`、`mkdir lock`）のどれかが失敗した側は「別の操作が実行中」として中止する（同時回収で両方が取得しない）。
- 本番実行では `AC_*` の差し替え環境変数を無視する（テストモード `AC_STUB_LOG` が設定されているときだけ有効。取得元・security・curl・launchctl が汚染された環境変数で差し替わらない）。
- 導入・更新は PO が実行するものの、取得したタグのコードを実行する点に変わりはない（node の起動確認と build）。リポジトリ（アカウント）が侵害されたときの被害を、`origin/main` 到達性の確認と `--ignore-scripts`、SHA の表示で小さくする。タグの署名検証・SHA の事前固定（PO の y/n）は段階2以降の課題。
- テストでは対象ディレクトリ（`AC_HOME`）・`launchctl`・`security`・`git/gh`・`open` を環境変数で差し替え、一時ディレクトリ内で導入→更新→切戻し→撤去を通す。
- 版を出す手順: package.json の version を上げる PR → マージ → `vX.Y.Z` タグを付けて push（タグは Opus/Sonnet が付ける）。

### 4-5. 依存と点検
- CI に `npm audit --audit-level=moderate` と `npm audit signatures` を追加（失敗で赤）。
- CI の `permissions: contents: read` は維持。
- マージ前に専任セキュリティ点検（Sonnet、読み取りのみ）を行い、CRITICAL/HIGH 0 件を確認。

## 5. データの正本（SSOT）

| データ | 正本 | 複製しない理由・方法 |
|---|---|---|
| 版 | git タグ | 導入済み一覧は versions/、使用中は current の指す先。記録ファイルを作らない |
| サーバー秘密 | キーチェーン | ファイルに書かない。サーバー・起動アプリとも都度キーチェーンから読む |
| セッション | サーバーのメモリ | 保存しない（再起動で失効し、起動アプリが自動で再ペアリング） |
| plist・起動アプリ | リポジトリ内の雛形 | 導入時に雛形から生成（手で編集しない） |
| 段階1の各データ | 段階1設計 §5 のとおり | 変更なし |

## 6. 安全（脅威と対策）

| 脅威 | 対策 |
|---|---|
| ネットワーク外部からの接続 | 127.0.0.1 のみ待受（変更なし） |
| 悪意あるサイトからの操作（CSRF・WebSocket 乗っ取り・DNS リバインディング） | 認証情報は Cookie ではなく sessionStorage（ブラウザが自動送信しない）。状態変更と WS は Origin 必須、Host 完全一致 |
| 同じ 127.0.0.1 の別ポートのサーバーへのセッション漏えい | Cookie を使わない（Cookie はポートで分離されない）。sessionStorage はオリジン（ポート）単位。セッションは最長 12 時間・ログアウトでサーバー側失効 |
| 4319 を先に待ち受けた偽サーバーへの秘密の送出 | 相互認証（HMAC チャレンジ）。launcher は偽サーバーの proof を検証できなければ中止し、秘密も proof も送らない |
| 秘密の漏えい（URL・履歴・ログ・プロセス引数） | 長期秘密は URL に出さない。ネットワークに送らない（HMAC のみ）。HMAC 計算へは標準入力で渡す。ログに出さない（テストで検証） |
| ペアリングコードの横取り | 1 回限り・30 秒失効・定数時間比較 |
| 同じ Mac の別ユーザー | キーチェーンはユーザーごと。待受は 127.0.0.1 なので別ユーザーからも接続はできるが、秘密・セッショントークンが無いと 401 |
| 同じユーザーのマルウェア・端末内のプロセス | **対象外**。`-T` 無しで `/usr/bin/security` が作成した項目は、同じユーザーの任意のプロセスが `security find-generic-password -w` で読み出せ得る（未検証。実機で別ターミナルから読めるか確認が必要）。キーチェーンの保護は、別ユーザー・ファイルの直読みに対するもの |
| 依存部品の汚染 | lockfile 固定＋`npm audit`＋署名検査を CI で必須化 |
| 更新で壊れる | 自己診断（期待の版・コミットが `/healthz` の本文で一致）に通った版だけ切替。1 コマンドで切戻し |
| 取得するタグのコード（可変なタグ・リポジトリ侵害） | タグのコミットが origin/main から到達可能であることを確認、`npm ci --ignore-scripts`、コミット SHA を導入出力と画面に表示 |

## 7. デザインシステム遵守
画面の追加はペアリング失敗の案内のみ。SA 金型（Callout, Button）と i18n 辞書を使用。段階1のデザイン検査をそのまま適用。

## 8. 代替案と選択理由

| 案 | 不採用理由 |
|---|---|
| PWA（アプリとしてインストール） | 通常タブとの storage 共有が文書で確認できない（recon §B） |
| Cookie によるセッション | Cookie は同じホストの別ポートへ送られる（RFC 6265）。sessionStorage ならオリジン（ポート）単位で分離される |
| 秘密をファイル（権限 600）に保存 | キーチェーンはユーザー単位で保護され、ファイルの直読み・バックアップ流出に強い。ただし `-T` 無しで `/usr/bin/security` が作成した項目は、同じユーザーの任意のプロセスが `security` コマンドで読み出せ得る（未検証）ため、同一ユーザーのマルウェアは防げない（どちらの方式でも対象外） |
| Electron でアプリ化 | メモリ（段階1の目的に反する） |
| 起動のたびに Sales Anchor のデザインを取得 | 回線が無いと起動できない。版ごとに固定する方が再現性がある |

## 9. リスクと対処

| リスク | 対処 |
|---|---|
| `open -na … --args --app=` が既存 Chrome 起動中にアプリ窓にならない（未確認: recon §B） | 実装の最初に実機確認。ならなければ NEEDS_DECISION で PO に報告（勝手に別方式にしない） |
| 自動起動・キーチェーン書込を Claude 側の権限判定が止める | 導入・更新スクリプトは PO が `!` で実行する前提で作る。Claude はスタブを使ったテストまで |
| launchd の PATH | node を絶対パスで指定 |

## 10. 維持の仕組み
- 守り手: Claude Opus（設計・審査）＋Claude Sonnet（実装・点検）。CI が audit・署名・テスト・デザイン検査を毎 PR で実行。
- 版を出すたびに CHANGELOG（docs/CHANGELOG.md）へ 1 行追記。

## 11. 外部・過去事例の参照と我々への応用
- Sales Anchor の reaper 自動起動（ops/launchd、RunAtLoad=true・KeepAlive=false・WorkingDirectory 必須）を雛形の作法として流用（recon §A）。
- Jupyter 等のローカル Web ツールが採る「起動時トークン＋ブラウザ Cookie」方式と同系統だが、公開実測や事故事例の調査は未実施。成功の証明には使わない。

## 12. 未決（PO 判断）
- なし（段階1.5 の範囲）。§9 の実機確認で問題が出た場合のみ報告する。

## 13. 設計審査（Architect・同一 AI による自己審査）
判定: **APPROVE（条件付き）**
- 条件 1: §9 の `--app` 実機確認を実装の最初に行う。
- 条件 2: 導入・更新・切戻し・撤去は Claude 側で実環境に対して実行しない（スタブのテストまで）。実環境は PO が実行。
- 条件 3: 秘密がログ・引数・URL に出ないことをテストで示す（プロセス一覧に秘密が出ないことを含む）。
