# 便2b-4c 件の窓の自動起動の小さな直し6つ（v0.55.1）作る係への指示書

- 前の便: `bin2b4b-card.md`（v0.55.0）。設計: `docs/handoff/discord-pdca/design.md` §4-2・§4-6
- 出どころ: v0.55.0 のマージ前審査で出た「合流は止めない小さな指摘」6つ（2026-11-07）。PO の決定（2026-11-07）: この6つを1枚にまとめて直す
- 目的: 動きの見た目は変えずに、(1) 件の数え方と作り方の食い違い、(2)(3) 試験の抜け、(4) 開いた直後に止めたときの残り物、(5) 1回の見回りでの二重書き、(6) 依頼の写しを消すときのリンクの扱い、を直す
- この便に入れないもの: 判断待ちの60分の知らせ・障害記録・画面のボタン・誤り報告のチャンネル・`launchAndSend`・定期実行（routine-closer）の動き
- 入れる順番: 作る係は PR を作るところまで（Draft にしない。題は `fix: discord-case launch follow-ups (v0.55.1)` の形）。審査・マージ・タグ・入れるのは設計者
- 迷ったら止まる: 下の「決めたこと」に無い分岐・行番号が合わない・既存の試験が通らなくなる、のどれかに当たったら、推測で埋めず止めて「何が・どこで（file:line）・何を試したか」を報告する

## 調べた実物（行番号は origin/main 421cc50 = v0.55.0）

- `server/config.ts`: `caseSandbox` の形の確かめ :163-165・`caseRoleIds` :323・それを使う確かめ :324-329。**`caseSandbox: true` の役割の数は確かめていない**
- `server/index.ts:141`: `liveCaseIds` は `s.roleId === "discord-case"` で探す
- `server/sessions.ts`: `openVersionProbe` の役割探し :468・`createDiscordCase` :485-497（役割探し :488 は `caseSandbox === true`）・`removeCaseRequest` :500-507（`unlink(path.join(R, "request.md"))`。R の上の階層のリンクはたどる）・`caseTmpRoot` :251（既定 `"/tmp"`。macOS では `/tmp` は `/private/tmp` へのリンク）・`restore` :707-
- `git grep -c -E "caseSandbox\"?: true" origin/main -- tests agent-console.config.json` の結果: どのファイルも1つ（`agent-console.config.json`・`tests/unit/case-agents.test.ts`・`case-say.test.ts`・`config.test.ts`・`launch-name.test.ts`・`sessions.case.test.ts`）。2つ以上の役割を持つ設定は今は無い
- `server/discord-intake.ts`: `advance` :519-607（`launcher.open` :589・`if (this.stopped) return;` :590・開いたあとの commit に失敗したときの後始末 :601-606）・`watchSlot` :660-706（kept の commit :690・長くかかっているの commit :702）・`closeSlot` :709-・`freeSlot` :725-
- `tests/unit/discord-intake-launch.test.ts`: 14 :426-444（状態ファイルは `h.stateFile` だけを読む）・28 :659-683（close も discard も例外の場合だけ）
- `tests/unit/sessions.case.test.ts`: request.md の試験はあるが、`restore` で request.md が作られない試験は無い

## 決めたこと

### 1. 件の役割は1つに限り、数え方と作り方を同じ探し方にする

- `server/config.ts` の :323 の直後に、`caseRoleIds.size > 1` なら `throw new Error("config: only one role can have caseSandbox")` を足す
- `server/index.ts:141` の `liveCaseIds` は、`s.roleId === "discord-case"` をやめ、`config.roles.find((r) => r.caseSandbox === true)?.id` で得た id（無ければ空の一覧を返す）と比べる。`!s.exited` と `s.versionProbe !== true` の条件はそのまま
- 試験: `tests/unit/config.test.ts` に「caseSandbox の役割が2つで読み込むと上の文で失敗する」を1つ足す

### 2. restore では request.md を書かない試験を足す

- `tests/unit/sessions.case.test.ts` に、件の役割を `restore` で開いたとき、報告の置き場 R に `request.md` が無いことを確かめる試験を1つ足す。実装は変えない（`createCase` だけが request を書くことの確かめ）

### 3. 試験 14 と 28 を足す

- 14: `h2.stateFile`・`h3.stateFile` も読み、どの印（`BODY_MARKER`・`TOKEN_MARKER`・`OPS_MARKER`）も入っていないことを確かめる行を足す。`setup` がそれぞれ別の状態ファイルを持たないなら、そこで止めて報告する
- 28 の隣に新しい試験 29 を足す: 開いたあとの commit に失敗し、`close` だけが例外（`discardRequest` は成功）→ `closes` が `["s9"]`・`discards` が `["s9"]`・「開いた件の窓を閉じられませんでした。agent-console の画面からその窓を閉じてください。」が1回・「件の依頼の写しを消せませんでした。」は0回

### 4. 開いた直後に止められたら、窓と写しを片付ける（`server/discord-intake.ts:590`）

- 今の `if (this.stopped) return;` を次に替える:
  - `opened.ok` が true で `this.stopped` なら、`launcher.close(opened.sessionId)` と `launcher.discardRequest(opened.sessionId)` をこの順に1回ずつ呼ぶ。どちらの例外も飲み込み、知らせは出さない（止まった後なので）。そのあと return
  - `opened.ok` が false で `this.stopped` なら、今と同じく何もせず return
- 理由: 枠（`bugSlot`）を書けないまま窓が残ると、作り直した後に同じ投稿をもう一度開き、写しも消されない
- 試験 30: `openImpl` の中で受け口の `stop()` を呼び、`{ ok: true, sessionId: "s7" }` を返す → `closes` が `["s7"]`・`discards` が `["s7"]`・状態ファイルの `bugSlot` は null のまま・順番待ちの先頭は残る

### 5. watchSlot の書き込みを1回の見回りで1回にする（`server/discord-intake.ts:684-705`）

- kept にする変更と 8時間の `lastLongNoticeAt` の変更を、同じ `next` に積んでから `commit` を1回だけ呼ぶ。commit に失敗したら、どちらの知らせも出さずに return
- 知らせの文・順番（判断待ち → 長くかかっています）・出す条件は変えない
- 試験 31: 開いてから8時間たった見回りで初めて idle が10分に届く（返事に `NEEDS_DECISION:`）→ その見回りで状態ファイルの書き込みが1回（偽の書き込み数で数えられないなら、`bugSlot.kept` と `lastLongNoticeAt` が両方入っていることと、知らせが2つこの順に出ることを確かめる）

### 6. 依頼の写しを消すとき、R がリンクを通っていたら消さない（`server/sessions.ts:500-507`）

- `unlink` の前に、`realpath(R)` と R そのものを比べる。違えば `unlink` せずに `throw new Error("case report dir is not a real path")`。`realpath(R)` が `ENOENT` なら何もせずに return（今の「無ければ何もしない」と同じ）
- 直し（2026-11-07 マージ前審査）: 最初の版では比べる相手を `path.join(realpathSync(this.caseTmpRoot), path.relative(this.caseTmpRoot, R))` と書いていた。R は `casePaths`（`server/case-sandbox.ts:57`）で既にリンクをたどった置き場から作られるので、macOS の既定 `/tmp`（`/private/tmp` へのリンク）では `/private/private/tmp/...` になり、毎回例外になる（この Mac の node で確かめた: `path.relative("/tmp", "/private/tmp/x/id")` = `../private/tmp/x/id`）。比べる相手は R そのもの
- 試験を1つ足す: `caseTmpRoot` を別の置き場へのリンクとして渡しても（`/tmp` → `/private/tmp` と同じ形）、`removeCaseRequest` は request.md を消す
- `realpath` は `node:fs/promises` から import を足す。`realpathSync` は既に import 済み（:2）
- 呼び手（`discord-intake.ts` の `freeSlot`・`advance` の後始末）は例外を今どおり「件の依頼の写しを消せませんでした。」の知らせにする（変えない）
- 試験: `sessions.case.test.ts` に「R の親を別の置き場へのリンクにした場合、`removeCaseRequest` は例外を投げ、リンク先の `request.md` は残る」を1つ足す。試験用の `caseTmpRoot` がリンクを作れない形なら、そこで止めて報告する

### 7. 版

- `package.json`・`package-lock.json`（先頭の2か所）・`extension/manifest.json` を `0.55.1` に。`docs/CHANGELOG.md` の先頭に v0.55.1 の項（上の1〜6を1行ずつ）

## 受入の基準

| 基準 | 確かめ方 |
|---|---|
| caseSandbox の役割が2つの設定は読み込めない | config.test.ts の新しい試験が緑 |
| 件の数え方と作り方が同じ役割を見る | `server/index.ts` に `"discord-case"` の文字が残っていない（`git grep -n '"discord-case"' server/index.ts` が0件） |
| restore で request.md が作られない | sessions.case.test.ts の新しい試験が緑 |
| 試験 14 が3つの状態ファイルを見る・29〜31 がある | discord-intake-launch.test.ts が緑 |
| 開いた直後に止めても窓と写しが残らない | 試験 30 が緑 |
| リンクを通った R の写しは消さない | sessions.case.test.ts の新しい試験が緑 |
| 今までの試験が1つも壊れない | CI（ubuntu・macos）が緑。クラウドでは root のため I8 が赤のまま（v0.55.0 と同じ。PR 本文に書く） |
| 家の場所・Discord の番号・秘密・新しい URL を足さない | 差分を読んで確かめる |

## 戻し方

`bash scripts/ac-update.sh v0.55.0`、またはこのマージの revert。
