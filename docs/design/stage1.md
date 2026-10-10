# agent-console 段階1 設計書

- 状態: 設計案（Opus 作成・Opus 自己審査）。KGI/閾値は PO 委任下で Opus が設定したもので、PO の個別承認は未取得（PO 2026-10-11「確立したなら進める」に基づく）。
- 作成: 2026-10-11 / 設計: Claude Opus / 調査・実装: Claude Sonnet
- 調査記録: `docs/design/recon.md`

## 1. 目的（PO の言葉）

Orca（stablyai/orca, MIT）の UI/UX は魅力的だが、メモリ消費が大きく、`~/.claude/settings.json` を書き換える。Orca を手本に、**必要な部分だけ**を軽いローカル Web アプリとして作る。保守は Opus＋Sonnet。

## 2. KGI（段階1の完成判定。すべて ○× で判定）

| # | 基準 | 検証方法 |
|---|---|---|
| K1 | 左の一覧に、アプリから起動したセッションが「名前・役割・状態（作業中/待ち/停止）」で並び、状態が 5 秒以内に `claude agents --json` の `status` と一致する | e2e: ダミー役割で起動→一覧の表示と `claude agents --json` 相当の取得値を比較（単体: 解析関数のテスト） |
| K2 | 「新しいセッション」から、名前・役割・（必要なら）ブランチ名を入れると、ワークツリー作成（`scripts/new-worktree.sh`）→その場所で役割コマンドが端末内で起動し、中央に表示・入力できる | e2e（ダミー役割コマンド）＋手動 1 回（実 Claude） |
| K3 | ブラウザのタブを閉じて開き直しても、セッションは動き続け、一覧と端末の直近出力が戻る | e2e: ページ再読込後に同じセッションの出力を確認 |
| K4 | 右の台帳ボードに、台帳（active-work.d）の状態ごとの件数が表示され、公式窓口 `scripts/ledger-lookup.sh` で同じ枝を引いた値と一致する | 単体（解析）＋e2e（件数一致） |
| K5 | アプリは `~/.claude/settings.json` と `~/.claude.json` に書き込まない | e2e 前後でハッシュ比較（settings.json）／コード検査で書込経路 0 件 |
| K6 | 画面の色・余白・文字サイズはすべて Sales Anchor のトークン（origin/main）由来で、部品は Sales Anchor の金型を使う。直値 0 件・生 `<button>/<input>/<select>/<textarea>` は金型外で 0 件・UI 文字列は辞書経由 | CI の検査スクリプト（§7） |
| K7 | メモリ: アプリのサーバープロセス RSS が、ダミーセッション 3 本起動時に 150MB 以下。ブラウザ側 JS ヒープ使用量が 80MB 以下 | e2e 内で `ps -o rss=` と CDP `Performance.getMetrics`（JSHeapUsedSize）を記録 |
| K8 | 127.0.0.1 以外から接続できず、起動時トークンと Origin が一致しない WebSocket/HTTP 要求は拒否される | 単体＋e2e（不正トークン/不正 Origin で 401/403） |

閾値 K7 の根拠: node-pty で zsh を 1 本動かした node プロセスの実測 RSS 46.5MB（recon §B-2）。Orca の公開実測は待機時 1.07GB（Discussion #16993）。

## 3. 対象と対象外

対象（段階1）: 左一覧＋中央端末＋右の台帳ボード＋役割ボタン（新規セッション）。

対象外（段階2以降）: スマホ操作と取り戻し、変更箇所の画面と行コメント、画面プレビューと部品コメント、メモリ数値画面、PR/CI 一覧、定期タスク表示。内蔵ブラウザ・エミュレーター・Jira・コンピューターユース・タイマーで Claude を動かす機能は作らない（規約: Consumer Terms 第3条7項。定期実行は Claude Desktop のローカル定期タスクを使う＝PO 2026-10-11）。

## 4. 全体構成

```
ブラウザのタブ（React + Vite, Sales Anchor 金型）
   │  HTTP（静的配信・API）／WebSocket（端末の入出力・状態通知）  127.0.0.1 のみ・起動時トークン必須
ローカルサーバー（Node 24 + TypeScript）
   ├─ 端末管理: node-pty で役割コマンドを起動。出力はセッションごとに上限付きリングバッファ（1MB）で保持し再接続時に再送
   ├─ 状態取得: `claude agents --json` を 3 秒ごとに実行し、端末の子孫プロセスの pid と照合
   ├─ ワークツリー: `bash ~/salesanchor/scripts/new-worktree.sh <branch>` を実行し、`git worktree list --porcelain` で場所を確定
   ├─ 台帳: 本店 `.claude-pipeline/active-work.d/*.md` の `branch:` 行を列挙し、各枝を `scripts/ledger-lookup.sh` で引く（60 秒ごと＋手動更新）
   └─ デザイン: 起動時に Sales Anchor の origin/main から `frontend/src` を `.sa-cache/` へ展開（git archive。コミットしない）
```

### 4-1. Orca との対応（メモリ要因の採否。根拠 recon §M）

| Orca の要因 | 段階1での扱い |
|---|---|
| Electron 本体・内蔵ブラウザ（1タブ=1 webview） | 使わない。既存のブラウザのタブで表示 |
| 端末の二重保持（画面側＋daemon 側 headless xterm、既定 5,000 行） | 画面側は表示中の 1 本だけ xterm を生成（scrollback 2,000 行）。サーバー側は生バイトのリングバッファ 1MB のみ |
| 非表示端末を 4 つ・15 分保持 | 非表示は即破棄し、表示時にリングバッファから再描画 |
| ファイル監視の子プロセス最大 8 | 使わない |
| managed hooks を `~/.claude/settings.json` に書込 | 書かない。状態は `claude agents --json`（TTY 不要）で取得 |
| renderer ヒープ上限 4GB 引上げ | しない |

## 5. データの正本（SSOT）— アプリは複製を持たない

| データ | 正本 | アプリの扱い |
|---|---|---|
| セッション状態・名前・sessionId | Claude Code（`claude agents --json`） | 読むだけ。保存しない |
| 端末プロセスとセッションの対応 | サーバーのメモリ上（実行時状態） | 保存しない（サーバー再起動で消える。セッション自体は `claude --resume` で再開可能＝段階2で UI 化） |
| ワークツリーの場所 | git（`git worktree list --porcelain`） | 読むだけ |
| ワークツリー作成の手順・台帳登録 | `scripts/new-worktree.sh` | 呼び出すだけ（ロジックを再実装しない） |
| 台帳の状態 | 本店 `.claude-pipeline/active-work.d/`（窓口 `scripts/ledger-lookup.sh`） | 窓口スクリプトを呼ぶ。書き込まない |
| 役割の指示文 | `~/.claude/prompts/*.md` と `~/.claude/shell/ccopusgo.zsh` | 起動コマンドとして呼ぶ。内容を複製しない |
| デザイントークン・金型・共通の翻訳文 | Sales Anchor origin/main `frontend/src` | 起動・ビルド時に `.sa-cache/` へ展開（.gitignore）。展開元コミット SHA を画面下部に表示 |
| アプリ固有の設定（役割一覧・ポート） | `agent-console.config.json`（このリポジトリ） | 設定のみ。上記データを持たない |

役割一覧（初期値）:

| 役割 | 起動コマンド | 作業場所 |
|---|---|---|
| Opus 設計（ccopusgo） | `/bin/zsh -ic ccopusgo` | ccopusgo が本店に移動する（`ccopusgo.zsh:63-76`） |
| Sonnet 実装 | `/bin/zsh -ic 'claude --model sonnet'` | 新規ワークツリー（`release/<topic>`） |
| シェル | `/bin/zsh -i` | 指定なし＝本店 |

## 6. 安全

- 端末＝シェル操作そのもの。サーバーは 127.0.0.1 にのみ待受。起動ごとにランダムトークン（32 バイト）を発行し、URL に付けて開く。HTTP/WS はトークン必須、WS は Origin が自分自身のときのみ許可（他サイトからの WebSocket 乗っ取り対策）。
- ブランチ名は `^release/[a-z0-9][a-z0-9-]{1,60}$` のみ受け付け、シェルに渡すときは引数配列で渡す（文字列連結しない）。
- アプリはブランチ・ワークツリーを削除しない（回収は reaper の責務: `scripts/reaper-worktree.sh:4-8`）。
- マージ・push・PR 作成ボタンは作らない。
- 秘密情報を読まない（`~/.claude.json`、OAuth、キーチェーンに触れない）。
- タイマーで Claude に指示を送る機能は作らない。

## 7. デザインシステム遵守（Sales Anchor ADR-067 / ADR-144 / docs/CC_UI_GOVERNANCE.md）

- トークン: `.sa-cache/frontend/src/index.css`（`tokens.css` を @import）を読み込む。アプリの CSS は `var(--…)` のみ。
- 部品: `.sa-cache/frontend/src/components/` の金型（Button, Card, Tabs, Badge, Stack, EmptyState, TextField, Select, Tooltip, Drawer, Modal, loading/Spinner, loading/Toast）を import して使う（実験で vite build 成功: recon §V-4）。
- 金型に無い部品（端末ペイン、ボードの列、一覧の行）はアプリの `src/components/` に「金型」として登録し（`Xxx.tsx`＋`Xxx.css`（var() のみ）＋単体テスト）、画面（`src/pages/`）はそれと SA 金型だけを使う。端末の配色は `getComputedStyle` でトークン値を読んで xterm に渡す（直値を書かない）。
- 文字列: react-i18next。共通文言は SA の翻訳資源（.sa-cache）、アプリ固有はアプリの `src/locales/ja.json`。
- CI 検査 `scripts/check-design-governance.mjs`: ①`src/` の CSS/TSX に色直値（#hex, rgb(, hsl(）0 件 ②`src/pages/` に生 `<button|<input|<select|<textarea|<a ` 0 件 ③JSX 内の日本語直書き 0 件 ④`.sa-cache/` がコミットされていない。

## 8. 代替案と選択理由

| 案 | 不採用理由 |
|---|---|
| Orca をそのまま使う | settings.json へ既定で書込（#20691 未マージ）、ブランチ削除（#20875）、待機 1.07GB |
| Orca を fork | 同じ Electron 構成でメモリが減らない。上流がほぼ毎日更新 |
| Claude Desktop | ccopusgo の `--append-system-prompt` を渡せない。台帳ボードが無い |
| tmux で常駐 | 未導入。node-pty＋サーバー常駐で段階1の要件（K3）は満たせる |
| `claude --bg`＋`attach` | 新規ディレクトリで「Workspace not trusted」で起動不可（recon §V-1）。信頼付与には `~/.claude.json` 書込が必要 |

## 9. リスクと対処

| リスク | 対処 |
|---|---|
| Claude Code 更新で `claude agents --json` の形が変わる | 解析は未知キーを無視・必須キー欠落時は「状態不明」表示。CI で実出力のサンプル（キー名のみ）に対する単体テスト。`claude --version` を画面下部に表示 |
| node-pty の prebuild の `spawn-helper` に実行権が無い（recon §V-2） | `postinstall` で `chmod +x` を付与し、起動時に権限を検査して無ければ停止・案内 |
| Sales Anchor 側の金型の変更で壊れる | 展開元 SHA を表示。CI は SA の main を毎回取得してビルド（public リポジトリ） |
| サーバー停止で端末が消える | 段階1の制約として明記。段階2で `claude --resume` 一覧を UI 化 |
| アカウント停止リスク（自動実行） | タイマーで Claude を動かす機能を作らない（§6） |

## 10. 維持の仕組み

- 担当: 保守は Opus（設計・審査）＋Sonnet（実装）。PO は画面の ○× 判定。
- CI（GitHub Actions）: 型検査・単体テスト・ビルド・§7 の検査・e2e（Playwright、ダミー役割）。
- 引き継ぎ: `docs/design/` と `docs/handoff/` に残す。

## 11. 外部事例

- Orca（stablyai/orca）: 公開実測 待機 1.07GB（Discussion #16993, 2026-08-28, OS 不明）、端末 daemon 3 本で private 計 1.08GB（#12728, Windows 14.8GB 機）。採用しない要因の根拠として使用。成功の証明には使わない。
- 本アプリと同構成（ブラウザ＋ローカル Node＋node-pty）の公開実測値は未調査。K7 は本アプリ自身の実測で判定する。

## 12. 未決（PO 判断）

- リポジトリの所有者: shingo-ops 配下への作成は権限判定で拒否されたため `shingo-cc/agent-console`（private）に作成。移管するかは PO 判断。
- main の保護ルール（Ruleset）: Sales Anchor の CLAUDE.md で Ruleset 変更は PO 確認対象のため未設定。設定するかは PO 判断。
- Orca の部品別メモリ実測: 起動が権限判定で拒否。PO が自分で実行する計測スクリプトを用意済み（recon §M-3）。
