# 設計カード v3: 端末の文字を GPU で描く（xterm WebGL 描画）／agent-console v0.39.0

- 作成: Opus（設計）／2026-10-15 22:20
- 版の履歴:
  - v1: 審査で REVISE（card-review.md）。
  - v2: 指摘をすべて反映。
  - v3: Mac の再起動で /tmp の資料が消えたため、置き場所を ~/CC報告ファイル-keep/ac-webgl/ に移した。基準を origin/main 69e39b9（v0.38.1）に更新し、§0 の進め方を変えた。
- 承認状態:
  - PO 承認: 10/15「y」。範囲は「見た目は変えずに描く処理を軽くし、直す前と後でカクつきを測って比べ、マージと入れ替えまで進める」。
  - 列数の差（§0）は、PO の判断待ち。
- 根拠:
  - recon/recon.md（原本は消失。Opus が読んだ全文の写し）
  - card-review.md
  - visual/（作成中）
- 【事実】304577b と 69e39b9 の間で、次のファイルに差分はない（`git diff --stat 304577b origin/main -- <各パス>` の出力は空）: src/components/TerminalPane、server/config.ts、server/http.ts、src/types.ts、src/pages/ConsolePage.tsx、tests/fixtures/e2e-env.ts、tests/unit/helpers/harness.ts、agent-console.config.json。そのため、行番号は v2 のまま使える。

## 0. PO に決めてもらうこと（マージの前のゲート）
- 【事実】同じ窓（1400x900、DPR=2）で、DOM 描画は 97 列、WebGL 描画は 99 列になる。1マスが約2%狭くなり、Claude の画面の折り返し位置が変わる。
- visual/ の比較画像（今の描き方と GPU の描き方を並べたもの）を PO に見せ、○か×かを決めてもらう。
- v3 の進め方:
  - 実装・試験・測定（K1〜K5）は、PO の答えを待たずに release ブランチで進める。PR は Draft で出す。
  - マージと入れ替えは、PO の○（K0）が出るまで行わない。
  - ×なら PR を閉じる。字の幅を合わせる方法は、別の設計として起こす。
- この判断は「見た目は変えずに」に関わるので、Opus は代わりに決めない。

## 1. 目的と、利用者から見える変化
- 変える前: 端末の文字は DOM 描画で、画面の部品を1行ずつ作り直している。Claude のスクロールでカクつく（PO の判定は ×）。
- 変えた後: 文字を GPU（WebGL2）で描き、スクロールのときの描き直しを軽くする。1行の字数は 97 字から 99 字になる（§0）。
- 対象外:
  - 入力の経路（tmux・WS）
  - ホイールの送り方（wheelLines.ts）
  - classic 表示
  - Mac の負荷そのもの

## 2. 変更
作業場所は `git -C ~/agent-console worktree add` で origin/main から作る。ブランチは release/terminal-webgl。

### 2-1 依存パッケージ
- package.json の dependencies に `"@xterm/addon-webgl": "0.19.0"` を足す。版は固定し、^ を付けない。
  - 0.19.0 は 2025-12-22 公開で、ライセンスは MIT。
- package-lock.json は `npm install` で更新する。
- 手元で `npm audit --audit-level=moderate` と `npm audit signatures` を走らせ、結果を evidence に置く。

### 2-2 設定（正本は config の1か所。terminalSmoothScrollMs と同じ流れにする）
- server/config.ts
  - Config に `terminalRenderer: "webgl" | "dom"` を足す。
  - `parseTerminalRenderer` を、parseTerminalHost（:332-335）と同じ形で作る。
    - 指定が無いときは "webgl"
    - それ以外の値は throw する
  - parseConfig（:311 付近）で値を設定する。
- agent-console.config.json に `"terminalRenderer": "webgl"` をはっきり書く。
  - tests/unit/config.test.ts:248-250 の「the shipped config carries…」にも、この値を足す。
- server/http.ts:158 の直後に `terminalRenderer: config.terminalRenderer,` を足す。
- src/types.ts:77 の直後に `terminalRenderer: "webgl" | "dom";` を足す。
- src/pages/ConsolePage.tsx:562 で `renderer={state.terminalRenderer}` を渡す。
- tests/unit/helpers/harness.ts:172 の config に `terminalRenderer: "dom"` を足す。これが無いと typecheck が落ちる。上書きが必要なら、:125 の形にならう。

### 2-3 TerminalPane.tsx
- props に `renderer?: "webgl" | "dom"` を足す。既定値は "dom"。
  - 値は latest の ref（:67-68）に入れる。
  - effect の deps には足さず、端末を作るときに1回だけ読む。
- `term.open(host)`（:114）の直後に、次のコードを入れる。

```ts
let webgl: WebglAddon | null = null;
const markRenderer = (r: "webgl" | "dom"): void => {
  host.dataset.renderer = r;
};
markRenderer("dom");
if (latest.current.renderer === "webgl") {
  try {
    webgl = new WebglAddon();
    // GPU の文脈を失って 3 秒で戻らなければ DOM 描画に戻す（addon の dispose で xterm が DOM レンダラへ切り替える。README「Handling Context Loss」と同じ形）
    webgl.onContextLoss(() => {
      webgl?.dispose();
      webgl = null;
      markRenderer("dom");
    });
    term.loadAddon(webgl);
    markRenderer("webgl");
  } catch {
    // WebGL2 が無い環境では loadAddon の中で throw する（WebglRenderer.ts:88-90）。addon を外して DOM のまま続ける
    webgl?.dispose();
    webgl = null;
  }
}
```

- 後片付け（:288-305）は変えない。`term.dispose()` で addon も片付く（card-review LOW-1）。
- import に `import { WebglAddon } from "@xterm/addon-webgl";` を足す。
- 【推測】表示中の GPU の文脈は1つ。片付けた端末の文脈は、GC まで残る。これは K4 の「20回切り替え」で確かめる。
- まれな失敗で、空の canvas が残ることがある。直さない（LOW-2）。

### 2-4 試験
- e2e は DOM のまま走らせる。
  - tests/fixtures/e2e-env.ts:112 の config に `terminalRenderer: "dom"` を足す（tmux 用は :173・:177 で引き継ぐ）。
  - playwright.config.ts:35 のコメントは「端末は config の terminalRenderer: "dom" で DOM 描画にして読む」に直す。
- vitest（TerminalPane.test.tsx・ux.test.tsx に `@xterm/addon-webgl` の vi.mock を足す。形は :17-40 にならう）:
  - W1: 未指定、または "dom" のとき、WebglAddon を作らない。data-renderer は "dom"。
  - W2: "webgl" のとき、open の後で loadAddon(WebglAddon) を呼ぶ。data-renderer は "webgl"。
  - W3a: loadAddon が WebglAddon で throw しても、端末は使える（write と onData が動く）。addon の dispose が呼ばれ、data-renderer は "dom"。
  - W3b: コンストラクターが throw しても、端末は使える。data-renderer は "dom"。
  - W4: onContextLoss のコールバックで addon.dispose が呼ばれ、data-renderer は "dom"。
  - W5: unmount で term.dispose が呼ばれる。既存の試験で足りていれば足さない。
- config.test.ts:
  - 未指定なら "webgl"
  - "dom" は通る
  - "canvas" は throw する
- 配線:
  - ConsolePage.test.tsx の stub（:100 の型、:115 の div）に `data-renderer={props.renderer}` を足す。:19 のひな形に `terminalRenderer: "webgl"` を足し、:595 と同じ形で確かめる。
  - /api/state が terminalRenderer を返すことを確かめる（uploads.integration.test.ts:111-114 と同じ形）。
- 今ある console.spec と terminal-wheel.spec の DOM の検査は変えない。

### 2-5 版と記録
- 版を 0.38.1 から 0.39.0 にする。場所は package.json:3、package-lock.json:3,:9、extension/manifest.json:4。実装のときに origin/main の版をもう一度確かめ、0.39.0 が既に使われていたら止める。
- docs/CHANGELOG.md
- README の設定の一覧に terminalRenderer を足す。
- docs/handoff/terminal-webgl/（design.md = このカードの写し、evidence/）

### 触らない範囲
- wheelLines.ts、ホイールの処理（:153-172）
- terminalTokens.ts
- TerminalPane.css
- 入力の経路
- サーバーの PTY・tmux

## 3. 受入表

| # | 基準（合格の線） | 検証方法 | 担当 |
|---|---|---|---|
| K0 | §0 で PO が ○ | PO の返答。○ が無ければマージしない | PO |
| K1 | 30ノッチで、span・33ms超のフレーム数・renderer の CPU 秒の3つとも、4組の中央値が WebGL < DOM | 実 GPU の Chrome（channel chrome、headless:false）、redraw 役、別ポート 4390/4391 で、DOM と WebGL を交互に4組測る。負荷は外さない。各組の load と memory_pressure を記録する。CPU/行は参考として出す | Sonnet が測る／Opus が判定 |
| K2 | `commitToRenderMs` の中央値で、WebGL ≤ DOM × 1.2 | 交互に4組、各12回 | 同上 |
| K3 | §0 で PO が見た差（列数）のほかに差が無い。行末の句読点がはみ出さず、罫線が切れない | visual/ と同じ画面（日本語の句読点・英数・罫線・色・太字・下線）を、DOM と WebGL、ライトとダークで撮る。cols と rows を evidence に残す | Sonnet が撮る／Opus が判定 |
| K4 | WebGL を失っても使える | W3a・W3b・W4 に加え、実 Chrome で loseContext() を呼ぶ。5秒後に `.xterm-rows > div` ≥1、`.xterm-screen canvas` が 0、data-renderer が "dom"、入力が返ってくること。さらにセッションを20回切り替えたあと、"Too many active WebGL contexts" が出ず、data-renderer が "webgl" のままであること | Sonnet |
| K5 | 既存の試験が緑 | 関係するファイルの vitest、typecheck、lint、npm audit 2種。e2e の terminal-wheel と console は手元で、全件は CI で | Sonnet／CI |
| K6 | 本番で WebGL になっている | 入れ替えの後、healthz が 0.39.0。本番の画面で data-renderer が "webgl"、canvas ≥1 | Opus |
| K7 | PO の体感 | PO の実機でスクロールと入力を試し、○か×か | PO |

## 4. 想定分岐（止めて Opus に報告する）
1. npm install で 0.19.0 以外が入る。peer の警告が出る。npm audit か signatures が落ちる。
2. W3a・W3b で、throw の後に term が壊れる。
3. K1 で、3つの指標のうち1つでも WebGL ≥ DOM になる。
4. K2 で 1.2 倍を超える。
5. K3 で、列数のほかに差が出る。
6. K4 で警告が出る。または DOM に戻らない。
7. e2e を dom にしても落ちる。
8. カードの行番号が実物とずれている。
9. 本番が AGENT_CONSOLE_CONFIG で、agent-console.config.json 以外を読んでいる。

## 5. リスクと対処
- 列数の差: §0 のゲートで扱う。
- 句読点のはみ出し: v0.8.0 で入れた対策（README.md:256、CHANGELOG.md:39）の CSS が、WebGL では効かない。K3 で確かめる。
- IME の遅れ: recon では WebGL の方が遅く出た（58ms→133ms）。遅い区間は描画の前で、原因は確かめていない。K2 で判定する。
- 戻し方:
  1. agent-console.config.json を `"terminalRenderer": "dom"` にし、再起動して、ブラウザを再読み込みする。
  2. v0.38.1 のタグで入れ替える。

## 6. 維持の仕組み
- 設定の正本は agent-console.config.json の1か所。/api/state で配り、config.test.ts で守る。
- WebGL の経路は W1〜W4 と配線の試験で守る。DOM の経路は今の e2e で守る。
- xterm か addon-webgl の版を上げるときは、K3・K4・K6 をやり直す。design.md にも書く。
- 今どちらで描いているかは、host の data-renderer で外から分かる。

## 7. 外部事例
- 【事実】@xterm/addon-webgl 0.19.0 の README「Handling Context Loss」の例（`addon.onContextLoss(e => addon.dispose())`）に、コードの形を合わせた。
- 効果の数値は、手元で測った値（recon §3）だけを根拠にする。

## 8. 置き場所
- 資料は ~/CC報告ファイル-keep/ac-webgl/ に置く。/tmp は再起動で消えるので使わない。
