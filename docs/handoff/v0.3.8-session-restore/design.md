# 設計: v0.3.8 再起動の後にセッションを開き直す仕組みと、動いているセッションを手動で閉じる操作

- 状態: 設計者（Opus）が作成。
- PO 承認（2026-10-12）:
  - 「再起動や更新のあと、前回開いていたセッションを自動で開き直す仕組み」に「y」。
  - 「手動でセッションを閉じたりすることも出来るようにしたい」。
- 調査: docs/handoff/v0.3.8-session-restore/recon.md（実装担当の Sonnet が作成）
- 対象ADR: ADR-067（デザイントークン）、ADR-144（UI ガバナンス・金型を優先する）
- 前提の設計:
  - docs/handoff/v0.3.3-resume-picker/design.md（再開は公式の選択リスト。作業場所は本店と worktree の一覧で照合する）
  - docs/handoff/stage2/design.md（保存の作法は quick-prompts と同じ）

## 0. 事実（recon より）
- `claude agents --json` の各行に `sessionId` がある。公式文書の agent-view には「Full session UUID, usable with `claude --resume`」とある。server/agents.ts:46 はすでにこれを読み込んでいるが、どこにも使っていない。
- `claude --resume <session-id>` は、どの場所から実行しても会話を再開できる（公式の sessions）。
- 一言も入力していないセッションは `claude agents --json` に出てこないため、sessionId を取れない（2026-10-12 に3回実測）。
- サーバーを止めるとき（SIGINT・SIGTERM）は、すべての端末を kill する（server/index.ts:77-83）。起動するときに元へ戻す処理は無い。
- 動いているセッションを終わらせる API は無い。DELETE は止まったセッションだけを受け付け、動いているものは 409 になる（server/sessions.ts:204）。
- 1セッションあたりのメモリは RSS で約 50〜500MB、平均およそ 260MB。物理メモリは 8GiB（recon §3）。

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 動いているセッション（Claude・シェルとも）の行に「閉じる」ボタンがある。押すと確認画面が出て、「閉じる」を選ぶと端末のプロセスが終わり、そのまま一覧からも消える。「やめる」を選ぶと何も起きない|単体試験＋e2e（プロセスが終わる、行が消える）|
|K2 復元リスト（dataDir/open-sessions.json、権限 600）には、今開いている（止まっていない）セッションだけが入る。各項目は、役割、名前、作業場所（cwd）、ブランチ、Claude の sessionId（取れたときだけ）|統合試験（作成・閉じる・止まる・sessionId を知るたびに中身を確かめる）|
|K3 サーバーの停止（SIGTERM・SIGINT）でセッションが終わっても、復元リストは消さない。セッションが自分で終わったとき（/exit など）と、手動で閉じたときは、リストから外す|統合試験（停止の経路では、ファイルが変わらないこと）|
|K4 サーバーを起動すると、復元リストの各項目を、作業場所を確かめたうえで順番に開き直す。sessionId があるものは、役割の `restoreCommand` を、環境変数 AC_RESUME_ID=<UUID> を付けて起動する。無いものは、役割の通常の `command` で起動する。名前は保存した名前を使う|統合試験（偽 claude で、起動した命令・環境変数・作業場所・名前を確かめる）|
|K5 作業場所が本店でも、その時点の worktree でもない項目は、開き直さずにリストから外す。画面には「開き直せなかったセッション：<名前>（作業場所がありません）」を1回だけ出す|統合試験＋単体試験|
|K6 一度に起動しないように、`restoreStaggerMs` の間隔をあけて1件ずつ起動する（既定 3000、config だけに置く）。上限 maxSessions を超える分は開かない|統合試験（起動の時刻の差）|
|K7 sessionId は UUID の形（`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`）のものだけ保存し、使う。コマンドの文字列にはつなげず、環境変数で渡す|統合試験（不正な値は保存しない）|
|K8 リストが壊れていても上書きしない。サーバーは起動し、画面に「復元リストを読めませんでした」を出す|統合試験|
|K9 文言は i18n。見た目は SA の金型とトークンだけ。lint と既存の試験・CI（両 OS）が通る|CI|
|K10（導入後に実測）v0.3.8 → v0.3.8 の再導入、または launchctl の kickstart で再起動した後、開いていた Claude のセッションが同じ会話の続きで開き直る|PO の目視と、設計者による claude agents --json の sessionId の照合|

## 2. 対象と対象外
- 対象:
  - server/session-store.ts を新設する（復元リストの読み書き。quick-prompts.ts と同じ作法）。
  - server/sessions.ts（close・終了の理由・sessionId の記録）
  - server/hub.ts（定期取得で sessionId を知ったときの記録）
  - server/index.ts（起動時の復元と、停止時の印）
  - server/http.ts（POST /api/sessions/:id/close）
  - server/config.ts と agent-console.config.json（各役割の `restoreCommand`、`restoreStaggerMs`）
  - 画面（閉じるボタン、確認の Modal、開き直せなかった案内）
  - ja.json、試験、版 0.3.8、CHANGELOG、README
- 対象外:
  - 端末の画面の中身（スクロールの履歴）の復元
  - 作業の途中だった指示の再実行
  - 一言も入力していない Claude セッションの会話の再開（通常起動で開き直す）
  - 名前の予約（v0.3.7。メモリだけで、再起動すると消える）

## 3. 仕組み
### 3-1 復元リスト（正本）
- 場所は config.dataDir 配下の open-sessions.json。
- 形は `{version:1, items:[{roleId, name, cwd, branch?, claudeSessionId?}]}`。
- 書き込みは quick-prompts.ts と同じにする: serial、一時ファイル（600）、chmod、rename。
- 読み込みのとき、version が違う、または壊れている場合は例外にして、上書きしない（K8）。
- 正本の向き: 動いているセッションが正本で、リストはその写しにする。次のどれかが起きたら、そのたびに作り直して保存する（停止中を除く）。
  - SessionManager のセッションの作成・閉じる・自然終了・名前の変更
  - hub で sessionId が変わったこと
- 停止中の印: index.ts の shutdown で、killAll の前に `sessions.beginShutdown()` を呼ぶ。この後の onExit ではリストを書き換えない（K3）。

### 3-2 sessionId の記録
- hub.pollAgents で、各セッションに対応する agent の行（agentForSession）の sessionId が UUID の形で、前の値と違うときだけ、`sessions.setClaudeSessionId(id, sid)` を呼んで保存させる。
- 名前は、表示用の名前（Claude 側の名前を優先する）を保存する。hub.snapshot の lastNames を使う。

### 3-3 起動時の復元
- index.ts で listen した後、`restoreSessions()` を呼ぶ。
- 各項目について、resume-targets.ts の照合を使う。cwd が本店（kind main）か、その時点の worktree かを、realpath で確かめる（K5）。
- roleId が config に無い項目は外して案内する。
- sessionId があり、役割に `restoreCommand` がある場合は、`sessions.restore(role, cwd, name, branch, {AC_RESUME_ID: sid})` で起動する。
- sessionId が無い場合は、通常の command で起動する。
- 起動の間は restoreStaggerMs あける。起動する前に毎回 maxSessions を確かめる。
- 外した項目と失敗した項目は、hub が snapshot に `restoreNotices: string[]` として載せる。画面の Callout（info）に1回出し、閉じたら消す（メモリだけ）。
- 復元を終えたら、その時点の写しで open-sessions.json を保存し直す。

### 3-4 config
- opus-designer: `"restoreCommand": ["/bin/zsh","-ic","ccopusgo --resume \"$AC_RESUME_ID\""]`
- sonnet-impl: `"restoreCommand": ["/bin/zsh","-ic","claude --model sonnet --resume \"$AC_RESUME_ID\""]`
- shell: restoreCommand は無し（通常の command で開き直す）。
- `"restoreStaggerMs": 3000`
- これは v0.3.2 の config（767d9af）と同じ渡し方。ccopusgo は UUID を検証してから受け付ける（~/.claude/shell/ccopusgo.zsh:43-53）。

### 3-5 閉じる
- API: `POST /api/sessions/:id/close`。認証と Origin の検査は既存の内側で行う。
  - 止まっているセッションは、今と同じく除外として扱う。
  - 動いているセッションは、`term.kill()`（SIGHUP。node-pty の既定）を送る。終了（onExit）を待ってから remove し、リストから外す。
  - 5秒たっても終わらない場合は、SIGKILL を送る。送る先は、端末のプロセスと、その子孫のプロセス（process-tree.ts の descendantPids）の両方。
  - 閉じた後に子孫のプロセス（claude）が残っていないことを、統合試験で確かめる。
- 画面:
  - 動いている行の右端に、鉛筆と並べて「閉じる」（iconOnly sm Button、lucide X、aria-label と title は i18n）を置く。止まった行は今の「一覧から外す」のまま。
  - 押すと SA の Modal（size sm）で「<名前> を閉じますか？ 動いている作業は止まります。会話は『過去の会話を再開』から戻せます。」と出し、「閉じる」と「やめる」を選ばせる。

## 4. SSOT
- 動いているセッションの正本は SessionManager（メモリ）。
- 復元リストは、その写しを1ファイルに置くだけ。サーバーが止まっている間だけ正本になる。
- 会話の中身の正本は Claude（~/.claude）。アプリは sessionId だけを持つ。
- 起動の命令と待つ時間は config だけに置く。コードには書かない。

## 5. 安全
- 再開する id は UUID の形のものだけ。環境変数で渡し、シェルの文字列にはつながない。
- 作業場所は、起動のたびにその時点の正本（本店と worktree 一覧）と照合する。消えた worktree では開かない。
- 閉じる操作は、確認を挟んでから行う。送るのは SIGHUP で、5秒たって終わらなければ SIGKILL。
- 停止の経路ではリストを書き換えない。更新や再起動の途中で、リストが空になることを防ぐ。

## 6. 代替案
- 起動時に自動で開かず、「前回のセッションを開く」ボタンを出すだけにする: PO は「自動で開き直す」に y を選んだので不採用。メモリは、PO が閉じる操作で減らせる（K1）。
- tmux などで端末をサーバーの外に持つ: アプリの再起動では生き残るが、Mac の再起動では消える。仕組みも大きく変わるので不採用。
- ~/.claude の会話記録ファイルを直接読む: 非公開の形式なので不採用（v0.3.3 と同じ判断）。

## 7. リスクと対処
- 同じ会話を2か所で開いてしまう（復元と手動の再開）: 同じ sessionId を2プロセスで開いている状態は、今も実在する（recon §1-1）。Claude の扱いは公式に書かれていない。そこで、復元で開いた会話を「過去の会話を再開」で選ばないよう、案内文（v0.3.3 の K6）の中で示す。
- たくさん開き直すと Mac が重くなる: 間隔をあけて1件ずつ開き、上限を守る。閉じる操作で減らせる。
- 一言も入力していないセッションは、会話の続きにならない: 通常起動で開き、対象外に明記する。

## 外部・過去事例の参照と我々への応用
- Claude Code 公式 agent-view（https://code.claude.com/docs/en/agent-view）と sessions（https://code.claude.com/docs/en/sessions）、Context7 /websites/code_claude、2026-10-12 取得:
  - sessionId を `claude --resume` で使えること。
  - どこから実行しても再開できること。
  - これを根拠に、id だけを持って復元する。
- 過去事例 v0.3.2（767d9af）: AC_RESUME_ID を環境変数で渡して、id 付きで再開していた。この渡し方を使い回す。
- 過去事例 v0.3.5・v0.3.6 の更新: 更新でアプリ内のセッションが切れた（2026-10-11、salesanchor-2a）。K10 は、それを防げたかを測るもの。
- 適用限界: Orca の復元の仕組みは観察していない。この設計の成否の根拠にはしない。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K3（停止ではリストを消さない）と K7（UUID のみ）の統合試験で固定する。
- Claude の版が上がったら、agent-view の sessionId の記述を確かめる。
