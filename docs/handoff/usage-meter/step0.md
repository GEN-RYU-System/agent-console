# 工程0(a) 実測結果（rate_limits が statusLine の入力に来るか）

- 日時: 2026-10-13 17:57〜18:04 JST
- claude --version: 2.1.296 (Claude Code)
- 判定: ○（rate_limits が来た）。ただし最初の1回目の呼び出しには無く、返事のあとの2回目に入った。

## 手順
1. 作業場所: /tmp/CC報告ファイル/usage-meter/step0a/（work/ を cwd に使用。ASCII の別名 /tmp/step0a-ascii を symlink で用意。expect が日本語パスを壊したため）
2. 捨て設定 settings.json（~/.claude/settings.json 等は未変更）:
   {"statusLine":{"type":"command","command":"/tmp/step0a-ascii/capture.sh"}}
3. capture.sh: 標準入力を stdin-log.jsonl に追記し、標準出力に `step0` を出す。
4. `claude -p --settings .../settings.json --model sonnet`（1問）→ 返事は来たが statusLine は動かず（stdin-log.jsonl 無し）。
5. 対話（python pty の drive.py。CLAUDE*・AC_* の環境変数を子から除去、窓 40x120）:
   `cd /tmp/step0a-ascii/work && python3 -I ../drive.py`
   - 1回目・2回目: trust 画面で Enter が既定の「No, exit」を選び終了（質問は未送信）。
   - 3回目: Down → Enter で「Yes, I trust」を選び、「1+1は？一言で」を送信 → 返事「2です。」→ /exit。
   - 質問の消費: -p で1回、対話で1回（計2回）。

## 観測値
- statusLine が動いた回数: 2回（stdin-log.jsonl に2件）
- 最上位の鍵（1件目）: session_id, transcript_path, cwd, scratchpad_dir, effort, model, workspace, version, output_style, cost, context_window, exceeds_200k_tokens, fast_mode, thinking
  - rate_limits: 無い
- 最上位の鍵（2件目）: session_id, transcript_path, cwd, scratchpad_dir, prompt_id, effort, model, workspace, version, output_style, cost, context_window, exceeds_200k_tokens, prompt_cache, fast_mode, thinking, rate_limits
  - rate_limits の生の値:
    {"five_hour": {"used_percentage": 1, "resets_at": 1791887400}, "seven_day": {"used_percentage": 100, "resets_at": 1792141200}}
- 注: 画面に "You're now using usage credits ... weekly limit resets Oct 16" が出ていた。seven_day=100 はこの状態の値。
- resets_at は Unix 秒（数値）。

## 生ログ
- /tmp/CC報告ファイル/usage-meter/step0a/stdin-log.jsonl（値入り。transcript_path 等を含むため repo には置かない）
- /tmp/CC報告ファイル/usage-meter/step0a/pty-early.log, pty-posttrust.log, pty-answer.log, pty-raw.log

## 工程0 (d): footer の幅で 2 本のバーが読めるか（実装後の確認）
- 方法: e2e（tests/e2e/console.spec.ts「利用量」）が実物の dataDir/bin/ac-statusline.mjs を動かして usage.json を作り、footer を撮る（AC_USAGE_SHOT_DIR 指定）。
- 画像: /tmp/CC報告ファイル/usage-meter/footer-{normal,warning,full}-{1400,1280,1024,800}.png
- 結果: 読める。
  - 当初案（footer の 1 行に並べる）は 2 本のバーの幅が 0 になり読めなかったため、footer に flex-wrap を足し、利用量を 1 行まるごと（flex-basis 100%）の自分の行に置いた。footer は 2 行（1024px 以下は 3 行）になる。
  - 1400px: 週・5時間ともバー・N%・Badge・リセット・「N分前」が 1 行で読める。
  - 800px: バーは短くなる（約 6〜8 文字分）が N%・Badge・リセットは読める。
  - 100%（full）: バーを出さず「上限」の danger Badge だけが出る（§10-1）。
- 設計との差: ConsolePage.css の footer に flex-wrap を足した（§10-2 の一覧の外・footer だけの CSS）。
