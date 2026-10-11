# 設計: v0.3.3 再開の入口を Claude 公式の会話選択リストに切り替える

- 状態: 設計者（Opus）作成。PO 承認: 2026-10-11「y」（再開の入口を公式の選択リストに切り替える）。
- 調査: docs/handoff/v0.3.3-resume-picker/recon.md（実装担当 Sonnet が作成）
- 対象ADR: ADR-067, ADR-144
- 前版: docs/handoff/v0.3.2-opus-resume/design.md

## 0. 切り替える理由（事実）
- v0.3.2 の一覧は `claude agents --all --json` に依存する。`claude agents --help`（2.1.296）は `--all  With --json: also include completed background sessions` と記す。2026-10-11 の実測では、`--all` の 9 行が `--json` の 9 行と一致し、9 行すべての pid が生存していた。このため、ターミナルで終えた会話は一覧に出ず、出た行はすべて「再開不可（今動いています）」になる（PO のスクリーンショット 21:17）。
- 公式文書（https://code.claude.com/docs/en/sessions 「Where the session picker looks」「Use the session picker」、Context7 /websites/code_claude、2026-10-11 取得）による選択リストの仕様:
  - `claude --resume` を引数なしで実行すると選択リストが開く。
  - 既定では、そのときの作業場所（worktree）の会話を表示する。`Ctrl+W` で同じリポジトリの全 worktree、`Ctrl+A` でこの Mac の全プロジェクトに広がる。
  - 別の worktree の会話を選ぶと、その会話は元の場所で再開される。
  - バックグラウンドで実行中の会話は `bg` の印付きで表示され、選ぶと attach になる。

## 1. 目的
アプリから、終えた会話も含めて選んで再開できる。会話の一覧と選択は Claude 公式の画面に任せる。

## 2. 成功条件
|基準|検証方法|
|---|---|
|K1 「過去の会話を再開」画面に「Opus 設計役（本店）」1行と、本店の worktree ごとに「Sonnet 実装役（<ブランチ名>）」の行が出る。worktree は名前で絞り込める|vitest（API と画面）|
|K2 Opus の行を押すと、本店で `ccopusgo --resume`（id なし）を起動した端末が開く|統合試験で、起動した命令と作業場所を確認|
|K3 Sonnet の行を押すと、その worktree で `claude --model sonnet --resume`（id なし）を起動した端末が開く|統合試験|
|K4 本店でもなく、`git worktree list` の一覧にもない場所を API に渡すと拒否される（画面からの文字列をそのまま使わない）|統合試験（範囲外・存在しない・相対パス・シンボリックリンク）|
|K5 `ccopusgo --resume`（id なし）は `claude ... --append-system-prompt <指示> --resume` を起動する。id を付けた場合と、引数なし・依頼文あり・--high の場合は、v0.3.2 と完全に一致する|偽 claude で diff 0（控えは「~/.claude/shell/ccopusgo.zsh.bak-20261011b」）|
|K6 画面に案内文が出る（Ctrl+W／Ctrl+A の意味、今動いている会話は選ばないこと）|画面試験（i18n キー）|
|K7 既存の試験と CI が通る|CI 両 OS|

## 3. 対象と対象外
- 対象:
  - 再開 API と再開画面の置き換え
  - config の resumeCommand（id なし）
  - 「~/.claude/shell/ccopusgo.zsh」に、id なしの `--resume` を追加
  - 版 0.3.3、CHANGELOG、README
- 対象外:
  - 会話記録ファイル（~/.claude/projects 配下）を直接読むこと（非公開の形式のため）
  - 台帳の「+」エラー（別件）
  - Codex と Grok の追加（別件）

## 4. 仕組み
- API `GET /api/resume-targets`: 本店（resumeScope "main" の役割）と、`git worktree list --porcelain` の各 worktree（本店を除く。resumeScope "worktree" の役割）を返す。各行は {kind, path, branch, roleId}。
- API `POST /api/sessions/resume` {kind, path}:
  - サーバーは path を realpath し、本店そのもの（kind main）か、その時点の worktree 一覧の実パス（kind worktree）と一致する場合だけ受け付ける。
  - 受け付けたら、その scope の役割の resumeCommand を、その作業場所で起動する。
  - sessionId と AC_RESUME_ID は使わない。
- config:
  - opus-designer: `resumeCommand: ["/bin/zsh","-ic","ccopusgo --resume"]`
  - sonnet-impl: `resumeCommand: ["/bin/zsh","-ic","claude --model sonnet --resume"]`
  - resumeScope は v0.3.2 のまま。
- `claude agents --all` による過去セッション一覧は削除する。使わなくなったコード・試験・i18n キーも削除する。classifyCwd・roleForScope は再利用する。
- ccopusgo:
  - `--resume` の直後が無い、または `--` の場合は、id なしで claude に `--resume` を渡す。
  - id がある場合は、従来どおり UUID だけを受け付ける。
  - 依頼文との併用は従来どおり拒否する。
- 画面:
  - SA の Modal、行、ボタンの金型と、既存の絞り込み入力の金型を使う。
  - 案内文（K6）は i18n で表示する。

## 5. SSOT
- 会話の一覧と再開の実体は Claude（公式の選択リスト）だけに持たせる。アプリは会話の一覧を持たない。
- 作業場所の一覧は `git worktree list` だけから取る。役割と scope の対応は config だけに書く。

## 6. 安全
- 作業場所は、サーバー側でその時点の正本（本店と worktree 一覧）に照合する。
- シェルへ渡すのは、config に固定した命令だけにする。画面の文字列は命令に入れない。
- 【未確認】ターミナルで今動いている（バックグラウンドでない）会話を選択リストで選んだときの挙動は、公式文書に記載がない。二重書き込みのおそれがあるため、K6 の案内文で「今動いている会話は選ばない」と示す。
- アプリが自動で選択や入力を行うことはない。選ぶのは人。

## 7. 代替案
- 会話記録ファイルを直接読んで一覧を作る: 非公開の形式に依存するため、不採用。
- 本店で開いて Ctrl+W だけに頼る: Sonnet の会話を Opus の命令で再開してしまうおそれがあるため、不採用。役割ごとに作業場所を分けて開く。

## 8. リスクと対処
- 選択リストで Ctrl+A を押して別の役割の会話を選ぶ: その会話は今の役割の命令（モデル）で再開される。案内文で示す。
- worktree の数が多い: 名前で絞り込めるようにする。

## 外部・過去事例の参照と我々への応用
- Claude Code 公式文書 sessions（2026-10-11 取得）: 選択リストの表示範囲と、元の場所で再開する仕様。作業場所ごとに開けば、その場所の会話が既定で出る。この性質を役割の分離に使う。
- Orca: 過去セッションを独自の一覧で持つ（段階0の recon）。我々は SSOT の方針から、一覧を Claude に任せる。
- 適用限界: 選択リストの見た目と操作は Claude の版で変わりうる。案内文は操作キーの名前だけにとどめる。

## 維持の仕組み
- 守り手: 設計者（Opus）。Claude の版が上がったら、公式文書 sessions の Ctrl+W／Ctrl+A の記載を確認する。
- 試験 K2〜K4 で、役割と作業場所の対応と、範囲外の拒否を固定する。
