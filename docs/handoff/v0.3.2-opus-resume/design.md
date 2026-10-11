# 設計: v0.3.2 Opus 設計役（ccopusgo）の再開

- 状態: 設計者（Opus）作成。PO 承認: 2026-10-11「y」（ccopusgo に再開の指定を足す・案A）。
- 調査: docs/handoff/v0.3.2-opus-resume/recon.md（実装担当 Sonnet が作成）
- 対象ADR: ADR-067, ADR-144（画面の文言・部品）

## 1. 目的
過去セッション一覧から、本店で動いていた Opus 設計役の会話も「再開」できる。ターミナルからも `ccopusgo --resume <id>` で再開できる。

## 2. 成功条件
|基準|検証方法|
|---|---|
|K1 `ccopusgo --resume <UUID>` が `claude --model opus --effort medium --permission-mode auto --append-system-prompt <指示> --resume <UUID>` を起動（本店で）|偽の claude（引数を出力するだけ）を PATH 先頭に置き、引数を比較|
|K2 引数なし・依頼文あり・--high の起動引数が変更前と完全一致|同じ偽 claude で変更前（控え）と変更後の出力を diff。差分 0|
|K3 不正な id（UUID 形式でない・空）や、--resume と依頼文の同時指定は起動せず終了コード 2|偽 claude が呼ばれないこと|
|K4 アプリの過去セッション一覧で、cwd が本店のものが再開可能になり Opus 設計役として再開、worktree のものは従来どおり Sonnet 実装役|vitest（http 統合試験）で役割 id と起動コマンドを確認|
|K5 一覧の各行に「どの役割で再開するか」が表示される|画面試験（i18n キー経由）|
|K6 既存の試験・CI がすべて通る|CI 両 OS|

## 3. 対象と対象外
- 対象: 「~/.claude/shell/ccopusgo.zsh」（PO の設定。変更前に同じ場所へ日付付きの控えを作る）、agent-console の設定・再開処理・画面・版 0.3.2。
- 対象外: ccopusgo の起動指示文（prompts）・GO 委任の文言・--status の文言。本店以外・worktree 以外の再開（従来どおり不可）。

## 4. 仕組み
- ccopusgo: `--high` の後に `--resume <id>` を受け付ける。id は `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`。依頼文との併用は拒否（終了コード 2）。claude の引数は配列で組み、既存の2分岐の引数順を変えない。`claude --help`（2.1.296）で `-r, --resume [value]` と `--append-system-prompt` の併用が可能なことを確認済み。なお同ヘルプの `--system-prompt-snapshot`（既定 on）により、再開時は会話に記録済みの起動指示がそのまま使われる。
- agent-console: 役割の設定に `resumeScope: "main" | "worktree"` を追加（設定が正本）。opus-designer に `resumeScope: "main"` と `resumeCommand: ["/bin/zsh","-ic","ccopusgo --resume \"$AC_RESUME_ID\""]`、sonnet-impl に `resumeScope: "worktree"`。再開時は cwd の判定（classifyCwd の main / worktree）から、その scope を持つ役割を選ぶ（「resumeCommand を持つ最初の役割」をやめる＝段階2レビュー L8 の解消）。該当役割が無ければ従来どおり不可。
- scope に対応する役割が設定に無い行は不可理由 noRole（設計者承認 2026-10-11）。
- 判定 `main` は「不可」ではなく「本店（Opus 設計役で再開）」に意味を変える。running・outside・missing は従来どおり不可。
- 一覧 API は各行に再開する役割 id（無ければ null）を返し、画面は役割のラベルを表示する。

## 5. SSOT
- 役割と再開先の対応は agent-console.config.json のみ。セッションの所在は `claude agents --all --json` のみ。

## 6. 安全
- id は API（既存の検証＋一覧に存在するもののみ）と ccopusgo の両方で検証。シェルへは環境変数で渡し、文字列連結しない（既存方式）。
- 本店で別の起動方法（素の claude など）で始めた会話も Opus 設計役として再開される。一覧にどの役割で再開するかを表示し、PO が押す前に分かるようにする（K5）。

## 7. 代替案
- 画面で役割を毎回選ばせる: 操作が増える → 不採用。cwd で決まる（アプリの起動規則と同じ: Opus=本店、Sonnet=worktree）。
- ccopusgo を使わず claude を直接起動: 起動指示の正本が二重になる → 不採用。

## 8. リスクと対処
- ccopusgo の変更で普段の起動が壊れる: K2 の差分 0 で確認、控えから戻せる（戻し方: 控えを元の名前に複製）。
- 本店の非 Opus 会話を Opus で再開: §6 の表示で事前に分かる。

## 外部・過去事例の参照と我々への応用
- Claude Code CLI 2.1.296 `claude --help` の `--resume`・`--system-prompt-snapshot` の記載（実物で確認、2026-10-11）。
- 過去事例: 段階2で Sonnet 実装役の再開を環境変数 AC_RESUME_ID 方式で実装済み（docs/handoff/stage2/design.md）。同方式を Opus に広げる。
- 適用限界: 該当する外部の導入事例は不要（個人の起動スクリプトの拡張のため）。

## 維持の仕組み
- 守り手: 設計者（Opus）。役割を増やすときは config の resumeScope を必ず決める。試験（K4）が役割と scope の対応を固定する。
