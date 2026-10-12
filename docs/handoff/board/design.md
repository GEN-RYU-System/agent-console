# 設計: 右の欄を「作戦ボード」にする（動いている担当・KGI・KPI・ロードマップと進み具合・最近の入力）

- 状態: 設計者（Opus）が作成。Fable の設計審査で、第1回 REVISE、第2回 APPROVE（LOW-A〜C の文言の直しを反映済み）。v0.11.0 のマージ後に着手する。
- 版の番号: 実装の時点の main の次（チャット v0.11.0 の後なら 0.12.0）。着手は v0.11.0 が main に入ってから（activity.ts と hook の同じ箇所を変えるため。recon A）。
- PO 承認（2026-10-13）:
  - 「右側はtodoリストのように現在稼働しているエージェントと内容をリアルタイムで確認できるボード、このセッションで計画したKGI、KPI、ロードマップと進捗状況が見える化」→「y,作戦ボードも進めて」
  - 不具合: 「動いているsonnetがいても表示がされない」「終わった担当は表示しなくて良い」「最近の入力は良い機能」
  - KGI などは、各セッションの Claude が決まった命令で書き込み、そのための決まりを1項目足す（提案に y）。
- 調査: docs/handoff/board/recon.md（Sonnet）
- 対象ADR: ADR-067、ADR-144

## 0. 事実（recon より）
- 再開した担当が「終わった」に出る原因:
  - 「動いている」の判定（server/activity.ts:350-372）は、始まりを Agent の呼び出しの1件だけで数える。終わりは agent_id ごとの最後の stop と handback で決める。
  - 再開を表す event は記録していない（SubagentStart も SendMessage も、記録の対象に無い：activity.ts:23、activity-hooks.ts:20-27）。
  - 本番の記録では、再開された担当4つとも「Post → 報告と終わり → 報告と終わり」で、再開の印は0件だった。
  - 公式: SubagentStart は担当を再開したときにも起き、agent_id と agent_type が付く（hooks.md:2484-2501）。
- Claude のセッションの中から、自分の会話の番号を知る方法:
  - 公式の環境変数 CLAUDE_CODE_SESSION_ID がある。Bash の子プロセスと hook に自動で入り、hook の session_id と同じ値（code.claude.com/docs/en/env-vars）。
  - 調査のセッションの Bash で、その変数があることを確かめた。
- アプリの鍵: 再起動・更新をまたいで変わらないのは、claudeSessionId（Claude の会話の番号）だけ（recon E）。
- アプリへ書き込む既存の CLI は無い。サーバー秘密はキーチェーンにある（recon B）。
- 画面:
  - 右の欄は RightPane（タブ: このセッション・台帳）と ActivityPane（今の状態、動いている担当、終わった担当、やること、最近の入力）。
  - SA の金型に ProgressBar（value 0-100）、Badge、Card、DataTable がある。ProgressBar は label を渡して 100% のときに 'Done' を直書きで出す（i18n できない）。Stepper や Checklist の金型は無い。
- 決まりの置き場所:
  - Opus 設計役の起動指示は ~/.claude/prompts/salesanchor-designer.md（ccopusgo.zsh:70-79 が読ませる）。
  - salesanchor の CLAUDE.md は 120 行の上限に達している。
- 保存の作法: 一時ファイル→rename、600/700、version 付き、壊れたファイルは上書きしない（session-store.ts:87-98）。

## 1. 成功条件
|基準|検証方法|
|---|---|
|K1 右の欄のタブ「このセッション」を「作戦ボード」に改める。上から、今の状態、動いている担当、KGI、KPI、ロードマップと進み具合、最近の入力、を出す。「終わった担当」と「やること」の欄は出さない|単体試験＋e2e|
|K2 担当を再開すると（SubagentStart）、その担当は「動いている担当」に戻る。次に終わり（stop か報告）が来たら消える。動いている担当には、呼び名・頼んだ仕事の説明・動き始めてからの時間を出す。SubagentStart だけで、Agent の呼び出しと結べない担当（Claude の内部の担当、孫の担当）は出さない|統合試験（偽の hook の入力: 呼ぶ→終わる→再開→終わる、と、SubagentStart 単独）|
|K3 各セッションの Claude は、決まった命令で、自分のボード（テーマ・KGI・KPI・ロードマップ）を書き込める。画面はボードを5秒ごとに取り直すので、書き込んだ内容は 5秒以内に出る|統合試験＋e2e（write → 5秒待つ → 文言が出る）|
|K4 ボードの記録は dataDir/boards/<Claude の会話の番号>.json の1か所（ディレクトリ 700、ファイル 600）。アプリを再起動・更新しても残る。命令は、ボードを丸ごと書き換える（一部だけの書き換えはしない）|単体試験＋統合試験|
|K5 命令の入力は検査する。形が違う・長すぎる・制御文字があるときは、書き込まずに理由を出して、終了コード 1 で終わる|単体試験|
|K6 進み具合は「完了の数 / ロードマップの数」で出す（ProgressBar、label は渡さない）。KPI は、名前・目標・今の値・単位を表で出す|単体試験|
|K7 ボードに「最後に更新した時刻」を出す。ボードがまだ無いセッション（Sonnet の役割のセッションや、/clear のあと）には、「まだ計画が書き込まれていません」と出す|単体試験|
|K8 Opus の設計役の起動指示（~/.claude/prompts/salesanchor-designer.md）に、§3-4 の1項目を足す。命令の使い方は README に書く|設計者が控えを取って足し、足した差分を step0.md と CHANGELOG に残す|
|K9 文言は i18n。見た目は SA の金型とトークンだけ。lint と既存の試験・CI（両 OS）が通る|CI|
|K10（導入後）PO が見て、セッションを選ぶと、動いている担当と、計画（KGI・KPI・ロードマップ）と進み具合が分かる|PO の目視|

## 2. 対象と対象外
- 対象:
  - hook:
    - hooks/activity-hook.mjs に SubagentStart を足す（agent_id、agent_type）。
    - server/activity-hooks.ts の HOOK_SPECS と、server/activity.ts の EVENTS にも SubagentStart を足す。
  - server/activity.ts: 「動いている」の判定を直す（§3-1）。
  - ボードの命令:
    - hooks/ac-board.mjs（新設。node の標準の部品だけを使う）。1つのファイルに、検査の関数 `validateBoard`、読み出しの関数 `readBoard`、命令として動くときの処理（isMain のときだけ）を持たせる。型は ac-board.d.mts を添える（hooks/activity-hook.mjs と activity-hook.d.mts の前例と同じ）。
    - 本番のサーバーが起動するときに、dataDir/bin/ac-board.mjs に写す（v0.9.0 の hook を写す関数と同じ関数を使う）。
  - server/boards.ts（新設。下の hooks/ac-board.mjs を import して、ボードの読み出しをする）、server/board-routes.ts（GET /api/sessions/:id/board）、http.ts。
  - 画面:
    - src/components/ActivityPane/ を作戦ボードの形に変える。終わった担当とやることの表示、その試験（ActivityPane.test.tsx の該当）は外す。
    - 名前の変更は、ja.json の文言（タブ名「作戦ボード」）だけにする。部品の名前は変えない。
  - ja.json、試験、版、CHANGELOG、README（命令の使い方）。
  - アプリの外: ~/.claude/prompts/salesanchor-designer.md に1項目を足す（K8）。設計者が、控えを取ってから足す。
- 対象外:
  - 設計書から KGI などを自動で読み取ること（書き方がテーマごとに違い、推測になる）
  - 画面からボードを書き換えること（正本の書き手は、そのセッションの Claude だけ）
  - /clear で会話の番号が変わったときに、前のボードを引き継ぐこと（新しい番号には新しいボードになる。README に書く）

## 3. 仕組み
### 3-1 動いている担当
- 担当ごとに「最後の始まり」と「最後の終わり」を持つ。
  - 始まり: Agent の呼び出しの ts、または SubagentStart の ts の、新しい方。
  - 終わり: stop か handback の、新しい方。
- 「動いている」は、最後の始まりが最後の終わりより新しいとき（または終わりが無いとき）。24時間を過ぎたものは外す（今の決まりのまま）。
- SubagentStart は `restarts: Map<agent_id, ts>` に最新の ts を持つだけにする。
- 「動いている」の判定に使うのは、Agent の呼び出しの PostToolUse の agentId で結べている担当だけ。始まり = max(呼び出しの ts, restarts の ts)、終わり = max(stop の ts, 報告の ts, PostToolUse が completed のときの Post の ts)。K2 の統合試験に「前景の担当で completed だけが来る場合」を1本足す。
- SubagentStart だけの担当（Claude の内部の担当、孫の担当。結べないもの）は出さない（Fable の審査 HIGH-1）。
- 呼び名と仕事の説明は、Agent の呼び出しのときの記録を使う。
- 「終わった担当」の一覧は、画面に出さない。サーバーは、終わりを判定に使うだけにする。

### 3-2 ボードの命令（dataDir/bin/ac-board.mjs）
- 使い方: node "<dataDir>/bin/ac-board.mjs" write < board.json（標準入力の JSON で丸ごと書き換える）。show の副命令は作らない（YAGNI。中身はファイルを読めば分かる）。
- 自分の会話の番号は、環境変数 CLAUDE_CODE_SESSION_ID から取る。引数では受け取らない。
- UUID の正規表現（hooks/activity-hook.mjs と同じ）に通らなければ、パスを組み立てずに終了コード 1 にする。通ったときだけ、ボードのフォルダに「会話の番号 + .json」のパスを組み立てる（パスの走査を防ぐ）。
- 形（version 1）:
  - `{version:1, theme, kgi:[{text}], kpis:[{name, target, current, unit}], roadmap:[{title, status}], updatedAt}`
  - status は todo・doing・done のどれか。
  - updatedAt は命令が付ける。
- 長さの上限:
  - theme は 200 字。
  - kgi は 10 件で、各 500 字。
  - kpis は 20 件で、各項目 200 字。
  - roadmap は 50 件で、各 200 字。
  - 改行とタブ以外の制御文字は、拒否する。
- 書き込み: dataDir/boards/<番号>.json。一時ファイル→600→rename。ディレクトリは 700。
- 検査の関数は hooks/ac-board.mjs の1か所。サーバーはそれを import し、命令は dataDir/bin に写した同じファイルが動く。

### 3-3 サーバーと画面
- 動いている担当などの activity は、今の作り（5秒ごと＋合図）のまま取り直す。ボードは5秒ごとに取り直す（activity の合図ではボードは変わらないため）。
- GET /api/sessions/:id/board: その app のセッションの claudeSessionId のボードを返す。無ければ `{status:"none"}`。壊れていれば `{status:"invalid"}` を返し、画面に案内を出す（ファイルは書き換えない）。
- 表示:
  - 今の状態: 今のまま。
  - 動いている担当: Card の中に、呼び名の Badge・説明・時間の一覧。
  - KGI: 箇条書き。
  - KPI: DataTable（名前・目標・今・単位）。工程0 (d) で、右の欄の幅で4列が読めないと分かったら、「名前 ／ 今の値 → 目標 単位」の1行ずつの一覧にする。
  - ロードマップ: 各行に状態の Badge（未着手 neutral・進行中 info・完了 success）と題名。上に ProgressBar（label なし）と「完了 N / M」の文（i18n）。
  - 最近の入力: 今のまま。
  - 最後に更新した時刻（「3分前」）。
- 色・余白は SA のトークンだけを使う。

### 3-4 決まり（K8）
- ~/.claude/prompts/salesanchor-designer.md の末尾に、次の1項目を足す。
  - 「作戦ボード: テーマ・KGI・KPI・ロードマップを決めたとき、段階の状態が変わったとき、KPI の今の値が変わったときに、node "$HOME/Library/Application Support/agent-console/bin/ac-board.mjs" write へ JSON を標準入力で渡し、ボードを丸ごと書き直す（一部だけの書き換えはしない）。形と上限は agent-console の README。書き込みは自分で Bash から行う（担当に任せる場合も、同じセッションの中で）。」
- 足すのは設計者。足す前に控え（同じフォルダに .bak-<日時>）を取る。
- PO は 2026-10-13 に、この決まりを1項目足すことを含む提案に「y」と答えている。そのうえで、足すのは導入の直前に行う。
- 範囲は Opus の設計役だけ。sonnet-impl の役割は素の claude で起動指示の差し込み口が無く、今アプリで開いているのは全部 Opus（recon E-2）。

## 4. SSOT
- ボードの正本は dataDir/boards/ の1か所（会話の番号ごと）。書き手は、そのセッションの Claude だけ。
- 動いている担当の正本は、今の記録（dataDir/activity/）。
- 状態の正本は agents --json。

## 5. 安全
- 命令は、手元のファイルに書くだけ。サーバー秘密は使わない（キーチェーンを読まない）。
- 入力は検査して、形の違うものは書かない。
- 鍵は環境変数から取り、引数では受け取らない。これは誤って別のボードに書くことを防ぐためで、同じ利用者の中での権限の分離ではない（環境変数は書き換えられる。dataDir は 700 で、その利用者だけが読み書きできる）。

## 6. 代替案
- サーバーの API に Bearer で書き込む: Claude の Bash にサーバー秘密を読ませることになる。不採用。
- 公式のやることリスト（TaskCreate）を使う: 今のモデルでは既定で外されていて、KGI・KPI を表せない（recon、tools-reference）。不採用。
- 設計書を読み取る: 推測になるので不採用。

## 7. リスクと対処
- Claude が書き込みを忘れて、ボードが古くなる: 最後に更新した時刻を出す（K7）。決まりに明記する（K8）。
- /clear で番号が変わる: 画面も新しい番号を指すので、新しい（空の）ボードになる。README に書く。
- 番号を付けずに過去の会話を再開したとき（選ぶ一覧からの再開）、環境変数の番号が起動のときの番号のままになりうる（公式 env-vars）。工程0 (b) で確かめ、食い違うなら README に書く。アプリの復元（番号を付けた再開）は対象外。
- v0.11.0 との衝突: v0.11.0 のマージ後に着手する。

## 8. 外部・過去事例の参照と我々への応用
- 公式 hooks（SubagentStart）と env-vars（CLAUDE_CODE_SESSION_ID）。
- 過去事例: v0.9.0 の hook の本体を dataDir に写す形、v0.6.0 の拡張のフォルダの形を、命令の置き場所に使い回す。
- 適用限界: ボードの正しさは、Claude が決まりを守ることに依存する。

## 9. 工程0（実装の最初）
- (a) 本物の claude（捨てディレクトリ、--settings で hook）で担当を呼び、終わらせ、SendMessage で再開する。step0.md に次の3つを書く。
  - ① 再開のときに SubagentStart が来るか（来る／来ない）
  - ② SubagentStart の agent_id と、PostToolUse の tool_response.agentId が完全に一致するか（両方の生の値も書く）
  - ③ 同じ再開の PreToolUse（SendMessage）の tool_input の項目の名前
  - ① が「来ない」か、② が「一致しない」なら、§3-1 は成り立たない。止まって設計者に戻す。
- (b) 本物の claude の Bash で `printenv CLAUDE_CODE_SESSION_ID` が、hook の session_id と同じかを確かめる。同じことを、Agent（sonnet）の中の Bash と、番号を付けずに選ぶ一覧から再開した会話でも確かめる。親の Bash で食い違えば、止まって戻す。
- (c) SA の ProgressBar.tsx:46-56 を読み、label を渡さなければ文字が出ないことを、読んだ行として書く（実機は要らない）。
- (d) 右の欄の既定の幅で、KPI の4列の DataTable が読めるか（画面の写真）。

## 10. 設計審査
- 第1回（Fable、2026-10-13）: REVISE。HIGH-1（SubagentStart 単独は出さない）、HIGH-2（工程0 の分岐）、MEDIUM-3（安全の説明とパスの検査）、MEDIUM-4（1ファイルにまとめる）、MEDIUM-5（/clear と番号なしの再開）、MEDIUM-6（決まりの範囲と文）、MEDIUM-7（部品）、K3 の取り直しの周期、LOW-8・9 を反映した。

## 維持の仕組み
- 守り手: 設計者（Opus）。
- K2（再開した担当が動いているに戻る）と K5（入力の検査）を試験で固定する。
