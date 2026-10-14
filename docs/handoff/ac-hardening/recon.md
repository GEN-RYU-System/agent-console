# recon: ac-routine 強化（ac-hardening）

基準: origin/main c67cb0e10407b2131a65938ac7ee5f8490d3a52d（v0.29.0）。行番号はこの時点のもの。
生の調査出力は `/tmp/CC報告ファイル/ac-routine-cli/hardening-recon/`（A1 認証の分岐・A4 claude agents・B5 guard・B6 bin・B7 hook 文書・B8 hook の消費・B9 ほか）にある。

## 事実（実物で確かめたもの）

- guard は Bash の command に `/bin/ac-routine.mjs` を含み、入力に `agent_id` があるときだけ拒否する。それ以外は完全に無出力で通す。`hooks/ac-routine-guard.mjs:8`（GUARDED_FRAGMENT）、`:13`（judge）。B5-guard.txt。
- Bash 以外の道具（Read・Grep・Glob）は guard の対象外。reserve-token（dataDir にあるファイル）は担当が直接読める。B5-guard.txt、B6-bin-listing.txt。
- 担当（サブエージェント）が動いているかは、PreToolUse(Agent) から始まり PostToolUse・SubagentStop で終わる記録から `ActivitySource.view().running` が判定する。24 時間で打ち切る。`server/activity.ts` の view（RUNNING_MAX_AGE_MS）。
- セッションを新規に開いて指示を送る共通部は `launchAndSend`。戻り値は outcome と sessionName だけ（sessionId は無い）。`server/launch.ts:84-102`。
- `claude agents --json` は `Hub.pollAgents()` が `agentsPollMs` ごとに取る。取得失敗は null（状態不明）。`server/hub.ts:153`。状態への写しは `server/agents.ts` の `stateForSession`。
- 認証は「bearer（サーバーの秘密）」「session（画面のペアリング後）」「reserve-token（AI 用）」の 3 種。A1-auth-split.txt、A1-callers.txt。AI 用の受け口は `/api/agent/routines` だけで、画面用の `/api/routines` とは別。
- hook の `if` は Bash と Read で効き、Grep と Glob では効かない（第0段 U5。`/tmp/CC報告ファイル/ac-hardening/step0/`）。
- 中断（SIGINT）や親の終了（SIGTERM）では SubagentStop も Stop も来ず、running が 24 時間まで残る（第0段 U2）。

## 推測しないこと

- 担当が guard の対象外の道具や間接的な呼び出しで書き込む経路は、この強化では防げない（設計 §1 の表の (d2)(e)(h)）。README の限界の節に書いた。

## 既存 ADR の検索結果

このリポジトリ（agent-console）に ADR ディレクトリは無い。設計の正本は `docs/handoff/<topic>/design.md`。関連する既存の設計は `docs/handoff/ac-routine/design.md`（§4 が ac-routine の受け口と guard）。
