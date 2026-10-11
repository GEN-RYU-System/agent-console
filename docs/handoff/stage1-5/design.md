# agent-console 段階1.5 設計書（起動・版管理・セキュリティ）

- 状態: 設計案（Opus 作成・Opus 自己審査）。PO 承認: 「段階1.5を先に」y（2026-10-11）、「確立したなら進める」。KGI の数値は Opus 設定。
- 調査: docs/handoff/stage1-5/recon.md／前段: docs/handoff/stage1/design.md

## 1. 目的（PO の言葉）

普通のアプリのようにこの Mac で起動でき、この Mac の中で版を管理でき、外部からの攻撃に備えたい。段階2（スマホ）で接続の入口が増える前に、起動・認証・版の土台と守りを固める。

## 2. KGI（○×で判定）

| # | 基準 | 検証方法 |
|---|---|---|
| K1 | Dock（~/Applications/Agent Console.app）を 1 回クリックすると、URL を貼らずにログイン済みの画面がアプリ窓で開く | PO 実機 1 回＋自動テスト（ペアリング API → /pair?code → 画面表示を Playwright で） |
| K2 | 長期の秘密（サーバー秘密）が URL・起動ログ・ブラウザ履歴に出ない。URL に出るのは 1 回限り・30 秒で失効するコードだけで、再使用・失効後は 401 | 単体・統合テスト（再使用 401、31 秒後 401、ログ全文に秘密が 0 件） |
| K3 | ログイン時に自動でサーバーが起動し、`/healthz` が 200 を返す | PO 実行のインストール出力（`launchctl print` の state と curl 結果）。plist は `plutil -lint` OK をテストで |
| K4 | 版の切替: 新しい版の導入・1 つ前への切戻しが 1 コマンドででき、画面下部の版表示が切り替わる。導入前の自己診断に失敗した版には切り替わらない | スクリプトの統合テスト（一時ディレクトリ・launchctl/security/git をスタブ化）＋PO 実機 1 回 |
| K5 | Cookie は HttpOnly・SameSite=Strict・Path=/。Cookie 認証の状態変更要求（POST/DELETE）は Origin が自分以外なら 403 | 統合テスト |
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

### 4-3. 認証（ペアリング）

1. 導入時に `security add-generic-password -U -s agent-console -a server -w <乱数>` で秘密を保存（値は画面に出さない）。
2. サーバー起動時（`AGENT_CONSOLE_AUTH=keychain`）、`security find-generic-password -s agent-console -a server -w` で秘密を読む。読めなければ起動中止。開発時（`npm start`）は従来どおり起動ごとの乱数（`AGENT_CONSOLE_AUTH` 未設定）。
3. 起動アプリ（Dock）: `security … -w` で秘密を読み、`curl -s -X POST -H @- http://127.0.0.1:4319/api/pair`（Authorization ヘッダを標準入力から渡す＝引数に秘密を書かない: recon §C）で 1 回限りのコード（32 バイト乱数・30 秒失効）を受け取る。サーバーが応答しなければ `launchctl kickstart gui/<uid>/local.agent-console.server` して最大 10 秒 `/healthz` を待つ。
4. `open -na "Google Chrome" --args --app=http://127.0.0.1:4319/pair?code=<コード>`。サーバーはコードを消費してセッション（32 バイト乱数、サーバーのメモリ上、最長 24 時間・サーバー再起動で失効）を作り、`Set-Cookie: ac_session=…; HttpOnly; SameSite=Strict; Path=/` を付けて `/` へ 303。無効・失効・再使用のコードは 401 で、画面は SA の Callout で案内。
5. API・WS はセッション Cookie または Bearer（秘密/開発トークン）で認証。URL クエリ `?t=` は廃止。Host・Origin 検査は従来どおり。Cookie 認証の POST/DELETE は Origin 必須（自分以外・欠落は 403）。
6. ログに出すのは開発時のペアリング URL（1 回限りコード、開発時のみ有効期限 5 分）だけ。秘密・セッションは出さない。
7. `/healthz`: 認証不要、Host 検査あり、本文は `ok` のみ。

### 4-4. 版管理（scripts/ に置く。すべて mkdir ロック＋trap）

| コマンド | 動作 |
|---|---|
| `scripts/ac-install.sh <tag>` | 初回導入。秘密が無ければ作成→版を導入（下の install-version）→plist 書出し・lint・bootstrap→起動アプリ生成→`/healthz` 確認 |
| `scripts/ac-update.sh <tag>` | install-version → current を切替（`ln -sfn`）→ `launchctl kickstart -k` → `/healthz` 確認。失敗したら元の版に戻す |
| `scripts/ac-rollback.sh` | versions/ のうち current より 1 つ前（semver 順）へ切替 → kickstart → `/healthz` 確認 |
| `scripts/ac-uninstall.sh` | bootout → plist と起動アプリを撤去。versions/ とキーチェーンの秘密は残す（`--purge` 指定時のみ撤去） |
| install-version（内部） | `gh repo clone shingo-cc/agent-console versions/<tag> -- --branch <tag> --depth 1` → `npm ci` → sa-sync → build → 別ポート（4320）で自己診断（起動→`/healthz` 200→停止）。失敗した版は current にしない |

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
| 悪意あるサイトからの操作（CSRF・WebSocket 乗っ取り・DNS リバインディング） | Cookie は SameSite=Strict、状態変更と WS は Origin 必須、Host 完全一致 |
| 秘密の漏えい（URL・履歴・ログ・プロセス引数） | 長期秘密は URL に出さない。curl へは標準入力で渡す。ログに出さない（テストで検証） |
| ペアリングコードの横取り | 1 回限り・30 秒失効・定数時間比較 |
| 同じ Mac の別ユーザー | キーチェーンはユーザーごと。待受は 127.0.0.1 なので別ユーザーからも接続はできるが、秘密・Cookie が無いと 401 |
| 依存部品の汚染 | lockfile 固定＋`npm audit`＋署名検査を CI で必須化 |
| 更新で壊れる | 自己診断に通った版だけ切替。1 コマンドで切戻し |

## 7. デザインシステム遵守
画面の追加はペアリング失敗の案内のみ。SA 金型（Callout, Button）と i18n 辞書を使用。段階1のデザイン検査をそのまま適用。

## 8. 代替案と選択理由

| 案 | 不採用理由 |
|---|---|
| PWA（アプリとしてインストール） | 通常タブとの Cookie 共有が文書で確認できない（recon §B） |
| 秘密をファイル（権限 600）に保存 | PO が求める守りに対しキーチェーンの方がユーザー単位で保護され、作成アプリ以外の読み出しは確認が出る（man security） |
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
