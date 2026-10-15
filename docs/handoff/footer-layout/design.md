# agent-console 下の帯（フッター）の組み直し 設計（第1.3版）

状態: 設計案（Opus 作成、2026-10-15）。審査: Fable 上限のため PO「Y」により Opus 代行の自己審査で APPROVE（/tmp/CC報告ファイル/footer-layout/review-design-1.md。K6 はダーク・ライト両方で撮る）。第1.1版（同日）: PO 条件「デザイントークンとデザインシステムを遵守、金型登録のないハードコード禁止」により、直値（20rem・3em・4rem・opacity 0.75・calc）を全廃（§3-0）。第1.2版（同日）: 実装の実測（/tmp/CC報告ファイル/footer-impl/、高さ 224px・K4 428.5px で不合格）を受け、(a) ログイン行は PO の言葉「Claude ログイン: … maxアカウントを切り替える→左上、プログレスバーはこの下に垂直」に合わせて横並び（折り返し可）に戻す、(b) 右下の情報は縦に1項目1行にして幅を縮める、(c) 版の記載を3ファイルに。第1.3版（同日）: PO「メモリとログアウトは不要なので非表示、🌙展開元・版・コミットは右下に小さく表示で良い」（2026-10-15、原文）により、メモリ・ログアウトのボタンを下の帯から外し、🌙（ThemeToggle）を右下の情報の列に入れる（§3-1・§3-2・§3-6）。PO 実装承認: 2026-10-15「Y推測は禁止して…金型登録のないハードコードを禁止する。…確立したなら進める。」（直前の y/n＝実装・マージ・導入 v0.36.0 への返事）。
対象リポジトリ: GEN-RYU-System/agent-console（origin/main d46d365、v0.35.0）。調査の生出力: /tmp/CC報告ファイル/footer-layout/（行番号は保存ファイルの行番号）。

PO の言葉（2026-10-15、原文）:
「下部がゴチャついてきたので整理したい、Sales Anchor 展開元: 4667364b1565 版: 0.35.0 コミット: d46d365→これらはあまり見えなくて良いものなので右下に配置、Claude ログイン: highlifejpn@gmail.com maxアカウントを切り替える→下部の左上に配置　プログレスバーはこの下に垂直に配置、画面いっぱいを使わずに（Claude ログイン…アカウントを切り替える）の下に収まる程度で表示してくれ、理解できるか？CODEXやGROKを追加したときに隣に追加していく余力を残したい」
Opus が示した図（左上に Claude のまとまり＝ログイン・プラン・切替・週/5時間のバー、右隣は Codex/Grok 用の空き、右上にメモリ・テーマ・ログアウト、右下に展開元・版・コミット・Claude Code の版を小さく薄く）に PO「Y」。

## 1. 目的（PO に見える変化）
- 下の帯の左端に「Claude のまとまり」が1つ。1行目に「Claude ログイン: メール max アカウントを切り替える」（幅に入らなければ切替ボタンだけ次の行へ折り返す）。その下に縦に、週のバー／5時間のバー／「N分前に書かれた値」。
- まとまりの幅は固定（320px。アプリ固有トークン --ac-provider-w に登録）。バーはこの幅の中に収まり、画面の端までは伸びない。
- まとまりの右は空いている（後で Codex・Grok のまとまりを同じ形で並べる場所）。
- メモリ・ログアウトのボタンは出さない（PO 第1.3版）。右下に、🌙（テーマ切替）と「Sales Anchor 展開元・版・コミット・Claude Code」を薄い色で、1項目1行の縦並び（右揃え）。

## 2. 現在地（事実）
- フッター: src/pages/ConsolePage.tsx:601-630。中身は sa-source(602)・app-version(605)・commit(608, commit が空でないときだけ)・claude-version(613)・AccountBadge(616)・account-error(617)・UsageMeter(622)・メモリ(623)・ThemeToggle(626)・ログアウト(627) の順に横に並び、折り返す。
- フッターの CSS: src/pages/ConsolePage.css:48-58（flex・flex-wrap: wrap・gap var(--space-4)・font-size var(--font-xs)・color var(--text-muted)）。ページ全体は grid で、footer は3列全部を使う（:1-11）。
- AccountBadge: src/components/AccountBadge/AccountBadge.tsx:45-71（.ac-account の中に .ac-account__info（ラベル・メール・プラン Badge）と切替ボタン）。CSS は AccountBadge.css:1-23（どれも横並び）。
- UsageMeter: src/components/UsageMeter/UsageMeter.tsx:116-122（週・5時間の行と「N分前」）、1行は :40-59（ラベル・バー・%・バッジ・リセット日時）。CSS UsageMeter.css:1-36（.ac-usage は flex: 1 1 100%、.ac-usage__win は flex: 1 1 40%、バーは残り幅）。UsageMeter はフッターでしか使われない（ConsolePage.tsx:45・:622 のみ）。
- 試験が見ている目印: data-testid の footer・sa-source・app-version・commit・claude-version・account-badge・account-email・account-plan・account-message・account-switch・usage-meter*（tests/e2e/console.spec.ts:238-296、:1676-1725）。e2e の画面幅は 1400×800（playwright.config.ts:36）。console.spec.ts:276-296 はフッターの幅ごとのスクリーンショットを AC_USAGE_SHOT_DIR 指定時に保存する。

## 3-0. デザインの決まり（事実。/tmp/CC報告ファイル/footer-layout/r2/）
- `npm run lint` = scripts/check-design-governance.mjs（r2/1-pkg-scripts.txt:15）。CSS の宣言値に px・rem・em の直書きがあると違反（0 と border/outline の 1px、@media だけ例外。r2/1-check-design-governance.mjs.txt:89-124）。
- アプリ固有の値は src/tokens.app.css に `--ac-` 始まりのカスタムプロパティで登録する（値は font stack か px・rem の長さだけ。同:102-108）。前例 `--ac-tab-h: 56px`（「SA に 56px のタブ用トークンが無いための置き場」r2/1-tokens.app.css.txt:10-11）。
- opacity の中間値は ADR-067 で禁止、`--opacity-*` トークンを使う（r2/4-ADR-067…:89,117）。SA に `--opacity-muted: 0.7`「タイムスタンプ・補足テキストの減光」がある（r2/3-token-list-cache.txt:89）。前例 ChatPane.css:118。
- SA のトークンに 320px 前後の「横に並べるまとまりの幅」は無い。近い値は `--size-search-field-max: 320px`（検索欄の最大幅）だけで、意味が違うので流用しない（r2/3-token-list-cache.txt:79）。
- 金型: 縦並びの Stack（gap だけ、data-testid・幅を渡せない）、Text/Caption の部品は無い（r2/5-stack-twocolumn.txt）。Card は Preview 専用（sa-Card.tsx.txt:10）。
- 方針: まとまりの幅だけ tokens.app.css に `--ac-provider-w: 320px` を登録する（前例と同じ手続き）。ラベルの幅（3em）・バーの最小幅（4rem）・字下げ（calc）は、CSS grid の列（max-content / minmax(0, 1fr)）で揃えて直値を無くす。薄さは var(--opacity-muted)。

## 3. 変更（対象ファイルと変更後）
### 3-1 src/pages/ConsolePage.tsx（601-630 を置き換え。中の要素・data-testid・文言・条件は変えず、入れ物だけ足す）
```tsx
<footer className="ac-page__footer" data-testid="footer">
  <div className="ac-page__providers" data-testid="footer-providers">
    <section className="ac-provider" data-testid="provider-claude">
      <AccountBadge refreshKey={accountRefreshKey} switchEnabled={state.accountSwitchEnabled} onSwitch={() => setAccountConfirmOpen(true)} />
      {accountError !== null && (
        <span className="ac-page__footer-error" data-testid="account-error">{accountError}</span>
      )}
      <UsageMeter />
    </section>
  </div>
  <div className="ac-page__footer-side">
    <div className="ac-page__footer-meta" data-testid="footer-meta">
      <ThemeToggle />{/* 今の 626 の要素をそのまま */}
      {/* sa-source・app-version・commit・claude-version（今の 602-615 をそのまま、順番も同じ） */}
    </div>
  </div>
</footer>
```
- section に見出しは足さない（「Claude ログイン:」がその役）。文言・i18n キーは足さない。

### 3-2 src/pages/ConsolePage.css（48-58 を置き換え、規則を足す）
```css
.ac-page__footer {
  grid-area: footer;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border);
  font-size: var(--font-xs);
  color: var(--text-muted);
}
.ac-page__providers {   /* 右隣に Codex・Grok のまとまりを足していく列 */
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  min-width: 0;
  overflow-x: auto;
}
.ac-provider {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 0 0 var(--ac-provider-w);
  width: var(--ac-provider-w);
  min-width: 0;
}
.ac-page__footer-side {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: flex-end;
  gap: var(--space-2);
  flex: 0 0 auto;
}
.ac-page__footer-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 0; color: var(--text-muted); opacity: var(--opacity-muted); }  /* 1項目1行。横幅を最長の1項目分に抑え、左の空き（K4）を確保する */
```
- 色・間隔・薄さは既存の変数だけ。幅は次の 3-2b で登録する変数を使う。

### 3-2b src/tokens.app.css（1つ足す）
```css
  /* 下の帯の「プロバイダのまとまり」（Claude・後の Codex/Grok）1つの幅。SA に該当する幅のトークンが無いための置き場（ConsolePage.css が var() で参照する）。 */
  --ac-provider-w: 320px;
```

### 3-3 src/components/AccountBadge/AccountBadge.css（横並びのまま、まとまりの幅で折り返す。tsx は変えない）
```css
.ac-account { display: flex; flex-wrap: wrap; align-items: center; column-gap: var(--space-2); row-gap: var(--space-1); min-width: 0; }
.ac-account__info { display: flex; align-items: center; gap: var(--space-2); min-width: 0; max-width: 100%; }
.ac-account__label { color: var(--text-secondary); white-space: nowrap; }
.ac-account__email { color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
```
- 第1版の縦積み（ラベル・メール・プラン・切替を各1行）は、PO の言葉（ログイン行の「下に」バー）より行が多く、高さ 224px になった（実測）。

### 3-4 src/components/UsageMeter/UsageMeter.css（まとまりの幅に収める縦並び。tsx は変えない）
```css
/* 4列: ラベル | バー | % | 警告バッジ。週と5時間の列を揃えるため、各行は subgrid で親の列を使う */
.ac-usage { display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content max-content; column-gap: var(--space-2); row-gap: var(--space-1); align-items: center; min-width: 0; width: 100%; }
.ac-usage__win { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; row-gap: 0; align-items: center; min-width: 0; }
.ac-usage__label { grid-column: 1; color: var(--text-secondary); white-space: nowrap; }
.ac-usage__bar { grid-column: 2; min-width: 0; }
.ac-usage__pct { grid-column: 3; color: var(--text-primary); white-space: nowrap; }
.ac-usage__win > [data-level] { grid-column: 4; }
.ac-usage__text { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ac-usage__win > .ac-usage__text { grid-column: 2 / -1; }  /* リセット日時・リセット済みはバーの下（ラベルの右）の行 */
.ac-usage > .ac-usage__text { grid-column: 1 / -1; }       /* 「N分前」・案内文は全幅の最後の行 */
```
- 各行（usage-meter-week 等）は箱を持ったまま（display: contents は使わない）なので、既存 e2e の toBeVisible・toContainText は同じ要素を見る。
- 100% のときバーが無くても、% は3列目に固定されるので位置がずれない（UsageMeter.tsx:43-50）。

### 3-5 版と記録
- 版: package.json・package-lock.json・extension/manifest.json の version を 0.36.0（過去の版上げコミットと同じ3ファイル）。docs/CHANGELOG.md に1項目。docs/handoff/footer-layout/{recon.md, design.md}（本書の写し）と evidence/。

### 3-6 メモリ・ログアウトのボタンを外す（事実: /tmp/CC報告ファイル/pc-meter/ の調査、origin/main）
- 外す: ConsolePage.tsx:623-625（メモリのボタン）と :667-668 の Modal（MemoryPanel を開く）、それに使う memoryOpen の state。:627-629（ログアウトのボタン）と :366-370 の handleLogout。どちらも入口はこの1か所だけ（grep。ショートカット等 grep に出ない入口は未確認→実装時に再確認）。
- 残す（次の版「この Mac」・セッション別の値で使う／戻すとき用）: MemoryPanel 部品と試験、server の /api/memory（server/memory.ts）、api.ts の fetchMemory・logout、server の /api/logout とその試験。
- 試験の直し: 外したボタンを押す試験だけを、ボタンが無いことの確認に置き換える（e2e console.spec.ts:342-345 ログアウト、:860-881 メモリ画面。unit ConsolePage.test.tsx:316-320 ログアウト）。ほかの試験は変えない。
- 使わなくなる i18n キー（ac.memory.* のうち MemoryPanel 以外の分・ログアウトの文言）は消さない。未使用キーを検査する仕組みがあって落ちる場合は、止まって報告。
- ログアウトが無くなる影響: 画面からこのブラウザのログインを取り消す手段が無くなる（Claude のアカウントには関係しない。docs/handoff/account-switch/recon.md:9）。PO の判断（不要）による。

## 4. 触らない範囲
- AccountBadge.tsx・UsageMeter.tsx・usageLogic.ts・サーバー・API・i18n（ja.json）・確認ダイアログ（ConsolePage.tsx:631 以降。ただし §3-6 のメモリの Modal を除く）・左右の領域（:1-46）。

## 5. 代替案
- まとまりを @sa の Stack で作る: Stack は gap だけで data-testid と幅を渡せない（r2/5-stack-twocolumn.txt）。試験の目印と幅の変数が付けられないので不採用（section に class を付ける）。
- ラベル幅を em のトークンで登録する: grid の列で揃えれば登録が要らず、文字の大きさが変わっても揃う。不採用。
- 「プロバイダ」部品を新しく作り Claude を設定で並べる: 2つ目（Codex）が来たときに作る方が形が決まる。今回は入れ物（.ac-page__providers / .ac-provider）だけ用意。不採用。
- まとまりを @sa の Card で囲む: Card.tsx は Preview 画面専用と注記（sa-Card.tsx.txt:10）。枠は付けない。不採用。

## 6. リスクと対処
| リスク | 対処 |
|---|---|
| 下の帯が縦に高くなり、上の領域（端末）が狭くなる | 変更前後のフッターの高さを e2e で実測し evidence へ。変更後が変更前の3倍を超えるか 200px を超えたら、導入前に PO にスクリーンショットで確認 |
| メールが長いと幅をはみ出す | 省略記号（…）で切る。title にヒントがある（AccountBadge.tsx:48） |
| 既存試験のセレクタが壊れる | data-testid はすべて残す。新しい入れ物の testid を足すだけ |

## 7. 受入条件
| 基準 | 検証方法 |
|---|---|
| K1 provider-claude の中で、account-badge の下に usage-meter がある（usage-meter の上端 ≥ account-badge の下端） | e2e（1400×800）で boundingBox を比べる |
| K2 provider-claude の幅が 320px±2、usage-meter-bar-week と -fiveHour の右端が provider-claude の右端を超えない | e2e boundingBox |
| K3 footer-meta の右端が footer の右端から 24px 以内、下端が footer の下端から 16px 以内。テーマ切替のボタンが footer-meta の中にある。footer の中に「メモリ」「ログアウト」のボタンが無い | e2e boundingBox |
| K4 provider-claude の右端から footer-side の左端まで 600px 以上空く（Codex・Grok の余力） | e2e boundingBox（1400 幅）。フッターの高さを記録 |
| K5 既存の試験（unit・e2e・typecheck・lint）が全部通る。lint（check-design-governance）の違反0件 | npm の各コマンドの生出力を evidence へ |
| K6 見た目 | 1400 と 1024 幅で、値あり（週41%・5時間23%）・値なし・80%以上 の3状態のフッターのスクリーンショットを evidence/ に。導入後 PO 目視 |

## 8. 戻し方
- revert して前の版（v0.35.0）を `ac-update.sh v0.35.0` で入れ直す。

## 9. 維持
- 本書を docs/handoff/footer-layout/design.md に置く。2つ目のプロバイダは .ac-page__providers に .ac-provider を足す形で設計する（本書 §5）。
