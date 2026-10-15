# 測定の記録（terminal-webgl / v0.39.0）

## まとめ方（測る前に決めた）
- K1・K2 は「組ごとに中央値を出し、その 4 つの中央値を取る」。K2 の組ごとの値は 12 回の中央値。
- 比べる 2 つは同じビルド（npm run build 1 回分）。違いは試験用 config の `terminalRenderer`（dom / webgl）だけ。
- 試験用サーバー: ポート 4392（DOM）・4393（WebGL）、terminalHost は direct（tmux は使わない）。本番 4319・本番 dataDir・本番 tmux には触れていない。
- ブラウザ: 実 Chrome 155.0.8059.40（channel chrome, headless:false, 1400x900, DPR=2）。UNMASKED_RENDERER_WEBGL = `ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)`。
- term の取得: 本番コードに口を足さず、React の fiber をたどって取った（measure/lib.mjs の GET_TERM_SRC）。計測用パッチを当てたビルドは使っていない。CSP のため Playwright の bypassCSP を使用。
- 測定時の Mac の load average は 90〜130（他の作業が同時に走っていた）。組ごとの load・memory_pressure は raw/*.json と下の表にある。交互（DOM→WebGL）で測ったので負荷は両方にかかる。
- 注意: wheel で送られる信号の総数（signals）は実行ごとに違う（DOM 中央値 181、WebGL 155）。ホイールの変換が時間依存のため。同じ仕事量では比べていない。参考に CPU/行 を出している。

## K1（30 ノッチ @30ms、redraw 役、4 組の中央値）
| 指標 | DOM | WebGL | 判定（WebGL < DOM） |
|---|---|---|---|
| span (ms) | 7972.6 | 4449.0 | True |
| 33ms 超フレーム数 | 61.5 | 41 | True |
| renderer CPU 秒 | 1.039 | 0.502 | True |
| （参考）CPU/行 ms | 0.153 | 0.086 | - |
| （参考）longtask 最大 ms | 322 | 129 | - |

組ごとの値と load・memory_pressure: raw/summary.json、生データ: raw/k1-raw.json。4 組すべてで 3 指標とも WebGL < DOM だった。

## K2（echo 役、IME 確定→描画 commitToRenderMs、4 組 x 12 回）
- 組ごとの中央値（DOM / WebGL, ms）: 116.1 / 54.1, 166.5 / 79.6, 85.8 / 17.0, 42.1 / 20.7
- 4 組の中央値: DOM 100.9 ms、WebGL 37.4 ms、比 0.37（基準 ≤ 1.2）→ 合格 = True
- 測り方: CDP の Input.imeSetComposition → Input.insertText。compositionend の時刻から、目印の文字列が buffer に入った最初の term.onRender まで。欠測は 0 件。

## K3（見た目）
| 画像 | 描き方 | cols x rows |
|---|---|---|
| k3/dom-light.png | dom | 97 x 38 |
| k3/dom-dark.png | dom | 97 x 38 |
| k3/dom-light-to-dark.png | dom | 97 x 38 |
| k3/webgl-light.png | webgl | 99 x 38 |
| k3/webgl-dark.png | webgl | 99 x 38 |
| k3/webgl-light-to-dark.png | webgl | 99 x 38 |

- 左右に並べた画像: k3/compare-light.png / k3/compare-dark.png / k3/compare-light-to-dark.png（上のラベル「今の描き方」「GPU の描き方」）。
- 同じビルドで撮った実測。cols は DOM 97、WebGL 99（card の 97/99 と一致）。ライト→ダークは表示したままボタンで切り替えた後の 1 枚。
- 判定は Opus / PO（K0）。

## K4（WebGL を失っても使える）
- loseContext() 呼び出し: {'ok': True, 'isLost': True}。5 秒後: renderer=dom, `.xterm-rows > div`=38, canvas=0, 入力が返る=True（前: {'renderer': 'webgl', 'domRows': 0, 'canvases': 2}）。console: `webgl context not restored; firing onContextLoss`。
- 20 回切り替え: "Too many active WebGL contexts" = 0 件、毎回の描き方は全て webgl、最後も webgl。
- 合否: pass1=True pass2=True → True。生データ: k4/k4-raw.json

## K5（手元で走らせた試験）
- npm audit --audit-level=moderate / npm audit signatures: どちらも rc=0（npm-audit*.txt）。0.19.0 のみ導入、peer 警告なし。
- typecheck rc=0、lint rc=0、vitest（関係ファイル 10 本 179 件）: 178 通過 + ConsolePage の 1 件は負荷で 5 秒の時間切れ → 30 秒に伸ばして同ファイルを再実行して 45/45 通過（k5-vitest*.txt）。
- e2e: terminal-wheel 1/1 通過。console.spec.ts は「K5: テスト前後で ~/.claude の hash が変わらない」だけ失敗（ほかの Claude セッションが ~/.claude.json を書き換えるため。環境要因で、この変更とは無関係）。直列のため後続が走らなかったので、そのテストを除いて再実行し 47 通過・1 skip。pc-meter.spec.ts は負荷で時間切れ（この変更と無関係の MacMeter）。全件は CI に任せる。
