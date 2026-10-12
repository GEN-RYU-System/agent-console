# recon: v0.6.1 リポジトリを組織 GEN-RYU-System へ移したことに合わせる

- 作成: 設計者（Opus）が 2026-10-12 に実行した結果。読み取りのコマンドと、PO 承認済みの移管の結果。
- 基準: origin/main 7692cae（v0.6.0）

## 1. 移管の前の事実
- 移管の前: shingo-cc/agent-console（private）。shingo-cc の権限は admin:true（`gh api repos/shingo-cc/agent-console --jq .permissions`）。
- 組織 GEN-RYU-System:
  - shingo-cc は member（active）。
  - members_can_create_repositories は true、plan は free（`gh api orgs/GEN-RYU-System`、`gh api orgs/GEN-RYU-System/memberships/shingo-cc`）。
- 同じ名前の GEN-RYU-System/agent-console は無かった（404）。open の PR は0件。
- branch protection と ruleset は、移管の前から使えていなかった。どちらも 403 で、文言は「Upgrade to GitHub Pro or make this repository public to enable this feature.」。そのため、移管で失うものは無い。
- secrets 0件、variables 0件、webhook 0件、deploy key 0件。workflow は .github/workflows/ci.yml の1本。
- CI は公開リポジトリ shingo-ops/salesanchor を認証なしで clone している（.github/workflows/ci.yml:31-32。salesanchor の visibility は public）。そのため、組織に移っても clone できる。
- 組織の private リポジトリでも Actions は動いている。例: GEN-RYU-System/bay-auto（private）の最新の実行は 2026-10-12T05:12:40Z、schedule、success（`gh run list`）。
- GitHub 公式（docs.github.com, Transferring a repository, 2026-10-12 取得）:
  - issues、PR、wiki、stars、watchers が一緒に移る。
  - 以前の場所へのリンクと、git の clone・fetch・push は、新しい場所へ自動で転送される。
  - 手元の clone は `git remote set-url` で直すことが推奨されている。
  - 移管するには、リポジトリの admin であることと、移す先の組織でリポジトリを作れることが必要。

## 2. 移管の後の事実（2026-10-12）
- `gh api -X POST repos/shingo-cc/agent-console/transfer -f new_owner=GEN-RYU-System` を実行した。
  - 15秒後、`repos/GEN-RYU-System/agent-console` は visibility:private、owner GEN-RYU-System だった。
  - タグは15個、マージ済みの PR は #18・#17・#16 を確認した。
- shingo-cc の権限は {admin:false, maintain:false, pull:true, push:true, triage:true} に変わった。push はできる。admin は無い（組織の既定の権限）。
- 手元の本店の clone の origin を https://github.com/GEN-RYU-System/agent-console.git に変え、fetch で origin/main が 7692cae であることを確かめた。worktree は同じ .git を使うので、まとめて変わる。

## 3. 旧い名前が残っている箇所（`git grep -n "shingo-cc" -- . ':!package-lock.json' ':!docs/handoff'`）
- scripts/lib/ac-common.sh:26 `AC_REPO="${AC_REPO:-shingo-cc/agent-console}"`。アプリの更新が、版を取りに行く先。
- tests/unit/scripts.test.ts:96 と :449。上の既定値を期待している。
- tests/unit/pr-status.test.ts:21-22。URL を owner/name に分ける関数の試験の例の文字列で、実際の取得先ではない。
- 導入済みの各版（versions/v0.2.0〜v0.6.0）の clone の origin は、旧い URL のまま。更新の仕組みは毎回 AC_REPO から新しく clone するので、古い版の origin は使われない（転送も効く）。
- docs/handoff の過去の記録にも旧い名前があるが、過去の記録なので書き換えない。
