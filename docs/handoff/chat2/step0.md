# chat2 工程0（L1）: サーバーから括弧付きで長い本文を書いたときの確認

実施日 2026-10-13 / claude 2.1.296 --model sonnet / node-pty 1.1.0（サーバーの SessionManager と同じく、pty へ括弧付きを1回の write で書く）

## 手順
- 道具: /private/tmp/claude-501/chat2work/step0.cjs（recon の run.cjs と同じ作り。リポジトリ外）。生ログ: /private/tmp/claude-501/chat2work/out-step0.txt
- 本文は 30,005 バイト・525 行（先頭に「MARKER の後ろの語だけを答える」指示、途中に 520 行の詰め物、末尾に `MARKER ZEBRA-7731-KIWI`）。
- `\x1b[200~` ＋ 本文 ＋ `\x1b[201~` を 1 回の `pty.write` で書き、2.5 秒待ってから `\r` を送った。

## 結果（生ログから）
```
[  4.09] body bytes=30005 lines=525
[  4.10] WROTE bracketed paste (single p.write)
[  6.60] --- after paste +2.5s (before Enter) ---
    | ❯ [Pasted text #1 +524 lines]
[  6.61] ENTER sent after 2500ms
[ 10.62] --- Enter +4s ---
    |   MARKER ZEBRA-7731-KIWI
    | ⏺ ZEBRA-7731-KIWI
[ 12.66] pasted-placeholder-seen=false  reply-marker-found=true
```
- 貼った直後、入力欄には `[Pasted text #1 +524 lines]` の 1 行だけが出た（長い本文は包まれた）。道具の判定語 `pasted-placeholder-seen=false` は、探す語が実際の表示（`Pasted text`）と大文字小文字・空白の違いで外れたもの。表示そのものは上のとおり。
- Enter の後、Claude は本文の末尾の語 `ZEBRA-7731-KIWI` を正しく答えた（本文が欠けずに届いた）。
- 試験後、`claude --model sonnet` のプロセスは 0 件。

## 判定
- 受け取れる。長い本文は包まれ、全文が届く。xterm.paste() のときと同じ動き。実装に進む（本文の上限は下げない: 32KiB）。
- 【未確認】32,768 バイトちょうどの本文での確認（30,005 バイトで確認）。
