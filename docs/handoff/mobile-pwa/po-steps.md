# PO の手作業: 工程0の前に Tailscale を入れる（mobile-pwa）

- 目的: 設計書 docs/handoff/mobile-pwa/design.md §6 工程0（iPhone 実機の確認）の前提をそろえる。
- かかる時間の目安: 未確認（初めて入れる場合の実測はない）。
- この手作業では agent-console の本体には何も変わらない。Mac の待ち受け（127.0.0.1）も変わらない。
- 画面のボタン名は Tailscale 側で変わることがあるため、各手順は公式ページのリンク先の記載を正とする。

## 手順
1. ログインに使うアカウント（Google・Apple・GitHub・Microsoft など）を1つ決め、そのアカウントの2段階認証をオンにする。Tailscale には自前の2段階認証がなく、ログインに使うアカウントの設定に任せる仕組みのため（https://tailscale.com/kb/1010/mfa-tailscale）。
2. Mac に Tailscale を入れ、1 のアカウントでログインする。入れた配布形（App Store 版か、公式サイトの Standalone 版か）を控えておく（設計 §14 L-5 で使う）。
3. Mac の名前を確かめる。名前に本名・会社名などを入れない。HTTPS をオンにすると、名前が公開の証明書記録に載るため（https://tailscale.com/kb/1153/enabling-https）。
4. 管理画面（https://login.tailscale.com/admin）で次をオンにする。
   - 新しい端末の承認（Device approval。承認するまで通信できない。https://tailscale.com/kb/1099/device-approval）
   - MagicDNS と HTTPS（https://tailscale.com/kb/1153/enabling-https）
5. iPhone に App Store から Tailscale を入れ、同じアカウントでログインする。管理画面で iPhone を承認する。
6. Tailnet Lock をオンにする（署名した端末だけが参加できる。Tailscale 側が乗っ取られても防ぐと公式が記載。https://tailscale.com/kb/1226/tailnet-lock）。手順は公式ページに従う。Mac と iPhone の両方が署名済みになっていることを管理画面で確かめる。
7. Funnel（世界公開）はオンにしない。初期状態はオフ（https://tailscale.com/kb/1223/funnel）。

## 終わったら
- Claude に「Tailscale 入れた」と伝える。Mac に入った CLI の場所と名前の確認（工程0 (k)）から、Claude が工程0を始める。
- 工程0では、使い捨ての確認用サーバーを Mac の別ポートで動かし、iPhone の Safari とホーム画面から開いてもらう（その時に手順を渡す）。本物の agent-console はまだ外に出さない。

## やめたくなったら
- Mac と iPhone で Tailscale からログアウトしてアプリを消せば、元どおり（agent-console は何も変わっていない）。
