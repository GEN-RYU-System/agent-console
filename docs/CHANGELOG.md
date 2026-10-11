# CHANGELOG

版を出すたびに 1 行追記する（版の正本は git タグ `vX.Y.Z`）。

- 0.3.4 よく使う指示の並び替え: 「指示を編集」の各行に「↑」「↓」を追加し、1つずつ上下に動かせる（先頭の「↑」・末尾の「↓」は無効）。並び順は `quick-prompts.json` の `items` の順番だけで表し、上部のボタン列にそのまま反映。API は `POST /api/quick-prompts/:id/move {direction: "up"|"down"}`（範囲外・不正な向きは 400、存在しない id は 404）。
- 0.3.3 再開の入口を Claude 公式の会話選択リストに切り替え: 「過去のセッション」（`claude agents --all --json` 依存で、ターミナルで終えた会話が出ず、出た行は全部「再開不可」だった）を「過去の会話を再開」に置き換え。本店（Opus 設計役）と本店の worktree（Sonnet 実装役、名前で絞り込み）の行を押すと、その場所で id なしの `--resume` を起動して公式の選択リストを開く（会話の一覧・選択は Claude に任せる）。API は `GET /api/resume-targets` と `POST /api/sessions/resume {kind, path}`（本店と `git worktree list` に照合、範囲外は 400）。`AC_RESUME_ID`・過去セッション一覧の API/画面/i18n/試験は削除。`ccopusgo --resume`（id なし）を追加（PO の設定ファイル側の変更）。案内文で Ctrl+W／Ctrl+A と「今動いている会話は選ばない」を表示。
- 0.3.2 Opus 設計役の再開: 過去のセッションのうち作業場所が本店そのものの行を Opus 設計役で再開できる（設定 `resumeScope`: main=Opus 設計役 / worktree=Sonnet 実装役、「resumeCommand を持つ最初の役割」の選び方をやめた）。一覧の各行に再開する役割を表示。`ccopusgo --resume <UUID>` を追加（PO の設定ファイル側の変更）。
- 0.3.1 アプリアイコン: Dock・Finder の Agent Console を専用の絵にした（正本は `ops/launcher/icon/agent-console-icon.svg`、`build-icns.sh` で icns を作る）。起動アプリは導入・更新・切戻しのたびに切替先の版の icns で作り直し（ad-hoc で再署名）、icns の無い版（v0.3.0 以前）へ戻すと標準の絵になりその旨を表示。
- 0.3.0 段階2（毎日の使い勝手）: 作業の区切り（busy→waiting/idle）の通知（一覧の未読の印・窓タイトルの未読数・macOS 通知、設定 `notify.macos`）、名前の変更（Claude 起動中は `/rename`、それ以外はアプリの名前）、よく使う指示（`quick-prompts.json` 1 ファイル・権限 600）、過去のセッションの再開（`claude agents --all --json`、Sonnet 実装役のみ・`resumeCommand` と環境変数 `AC_RESUME_ID`）、台帳ボードの絞り込み（既定は作業中・レビュー・WIP かつ直近 30 日・隠れた件数と日付不明を別に表示）、メモリ画面（セッションごと・サーバー・Mac 全体、10 秒更新）。
- 0.2.1: 画面下部にライト/ダーク切替（SA と同じキー `theme`・クラス `force-dark`、保存は localStorage で次回起動も保持）、CSP に `base-uri 'self'; form-action 'self'` を追加。
- 0.2.0 段階1.5: Dock の起動アプリ（Chrome アプリ窓）、ログイン時の自動起動（LaunchAgent）、ペアリング認証（相互認証の HMAC チャレンジ＋1 回限りコード＋sessionStorage のセッショントークン、サーバー秘密はキーチェーンでネットワークに送らない）、ログアウト、`/healthz` の版・コミット、この Mac での版管理（導入・更新・切戻し・撤去）、CI に `npm audit` と署名検査。
- 0.1.0 段階1: セッション一覧・端末・台帳ボード（ローカル Web アプリ、127.0.0.1 のみ）。
