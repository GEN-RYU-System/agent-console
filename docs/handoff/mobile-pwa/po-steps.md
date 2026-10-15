# PO の手作業: 工程0の前に Tailscale を入れる（mobile-pwa）

- 目的: 設計書 docs/handoff/mobile-pwa/design.md §6 工程0（iPhone 実機の確認）の前提をそろえる。
- かかる時間の目安: 未確認（初めて入れる場合の実測はない）。
- この手作業では agent-console の本体には何も変わらない。Mac の待ち受け（127.0.0.1）も変わらない。
- 画面のボタン名は Tailscale 側で変わることがあるため、各手順は公式ページのリンク先の記載を正とする。
- 第2版（2026-10-16）: 新しい端末の承認（Device approval）をやめ、Tailnet Lock だけにした。公式に「両者は同時に使えない（they are mutually exclusive features）」とあるため（https://tailscale.com/kb/1226/tailnet-lock）。鍵の期限と更新の手順を足した（design.md §15）。

## 手順
1. ログインに使うアカウント（Google・Apple・GitHub・Microsoft など）を1つ決め、そのアカウントの2段階認証をオンにする。Tailscale には自前の2段階認証がなく、ログインに使うアカウントの設定に任せる仕組みのため（https://tailscale.com/kb/1010/mfa-tailscale）。
2. Mac に Tailscale を入れ、1 のアカウントでログインする。入れた配布形（App Store 版か、公式サイトの Standalone 版か）を控えておく（設計 §14 L-5 で使う）。
3. Mac の名前を確かめる。名前に本名・会社名などを入れない。HTTPS をオンにすると、名前が公開の証明書記録に載るため（https://tailscale.com/kb/1153/enabling-https）。
4. 管理画面（https://login.tailscale.com/admin）で MagicDNS と HTTPS をオンにする（https://tailscale.com/kb/1153/enabling-https）。新しい端末の承認（Device approval）はオンにしない（手順6の Tailnet Lock と同時に使えないため）。
5. iPhone に App Store から Tailscale を入れ、同じアカウントでログインする。
6. Tailnet Lock をオンにする（https://tailscale.com/kb/1226/tailnet-lock 。手順は公式ページに従う）。
   - 何が守られるか: 署名した端末しか仲間に入れない。ログインアカウントを盗まれても、Tailscale 側が乗っ取られても、署名の無い端末は Mac につながらない。
   - 署名する端末は2台以上が必要（公式 "You must select at least two signing nodes"）。Mac と iPhone の2台を選ぶ。
   - オンにする時、無効化用の合言葉（disablement secret）が10個表示される。**表示はこの1回だけ**。パスワード管理アプリ（または紙に印刷して金庫）に必ず控える。失くすと、この Tailscale の網は元に戻せない（公式 "If you lose your disablement secrets ... the tailnet cannot be recovered"）。
   - 「合言葉を Tailscale のサポートにも送る」選択肢はオフにする（理由: オンにすると Tailscale 側が Tailnet Lock を外せるようになり、上の守りが弱まる。万一合言葉を失くしても、端末2台の網を作り直せば済む）。
   - 終わったら、管理画面で Mac と iPhone の両方が署名済みになっていることを確かめる。
7. 鍵の期限（既定180日。切れるとその端末はつながらなくなる。https://tailscale.com/kb/1028/key-expiry ）:
   - Mac: 管理画面の端末一覧で Mac の「Disable key expiry（鍵の期限を無効にする）」を選ぶ。Mac は家に置いたままで、外出先から直せないため。
   - iPhone: 期限は残す（なくしやすい端末なので、期限で自動的に閉じる方が安全）。管理画面に出る期限日をカレンダーに入れ、期限の前に家で iPhone の Tailscale にログインし直す。ログインし直しても、Tailnet Lock の署名は自動で引き継がれる（公式 "When a signed node key expires, the new node key will not need to be re-signed"）。
8. 更新を常に最新にする: Mac と iPhone の Tailscale を自動更新にする（App Store の自動アップデートをオン。Standalone 版は Tailscale の設定の自動更新をオン）。Mac 用の弱点（TS-2026-001 など）は新しい版で直っているため（https://tailscale.com/security-bulletins ）。
9. Funnel（世界公開）はオンにしない。初期状態はオフ（https://tailscale.com/kb/1223/funnel）。

## 終わったら
- Claude に「Tailscale 入れた」と伝える。Mac に入った CLI の場所と名前の確認（工程0 (k)）から、Claude が工程0を始める。
- 工程0では、使い捨ての確認用サーバーを Mac の別ポートで動かし、iPhone の Safari とホーム画面から開いてもらう（その時に手順を渡す）。本物の agent-console はまだ外に出さない。

## やめたくなったら
- Mac と iPhone で Tailscale からログアウトしてアプリを消せば、元どおり（agent-console は何も変わっていない）。
- Tailnet Lock を先に外したい時は、手順6で控えた合言葉を1つ使う（公式ページの Disable の手順）。
