# CHANGELOG

版を出すたびに 1 行追記する（版の正本は git タグ `vX.Y.Z`）。

- 0.3.0 段階2（毎日の使い勝手）: 作業の区切り（busy→waiting/idle）の通知（一覧の未読の印・窓タイトルの未読数・macOS 通知、設定 `notify.macos`）、名前の変更（Claude 起動中は `/rename`、それ以外はアプリの名前）、よく使う指示（`quick-prompts.json` 1 ファイル・権限 600）、過去のセッションの再開（`claude agents --all --json`、Sonnet 実装役のみ・`resumeCommand` と環境変数 `AC_RESUME_ID`）、台帳ボードの絞り込み（既定は作業中・レビュー・WIP かつ直近 30 日・隠れた件数と日付不明を別に表示）、メモリ画面（セッションごと・サーバー・Mac 全体、10 秒更新）。
- 0.2.1: 画面下部にライト/ダーク切替（SA と同じキー `theme`・クラス `force-dark`、保存は localStorage で次回起動も保持）、CSP に `base-uri 'self'; form-action 'self'` を追加。
- 0.2.0 段階1.5: Dock の起動アプリ（Chrome アプリ窓）、ログイン時の自動起動（LaunchAgent）、ペアリング認証（相互認証の HMAC チャレンジ＋1 回限りコード＋sessionStorage のセッショントークン、サーバー秘密はキーチェーンでネットワークに送らない）、ログアウト、`/healthz` の版・コミット、この Mac での版管理（導入・更新・切戻し・撤去）、CI に `npm audit` と署名検査。
- 0.1.0 段階1: セッション一覧・端末・台帳ボード（ローカル Web アプリ、127.0.0.1 のみ）。
