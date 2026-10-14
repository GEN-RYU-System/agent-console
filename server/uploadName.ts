/** 端末に貼るファイルの名前を、安全な 1 段の名前に直す（許す文字だけ残す方式）。設計: docs/handoff/attach-files/design.md §3-3 */

const MAX_NAME_CHARS = 120;
const MAX_EXT_CHARS = 10;
const DISALLOWED = /[^\p{L}\p{M}\p{N}._-]/gu;
const EXTENSION = /^(.+)\.([\p{L}\p{N}]{1,10})$/u;

export function safeUploadName(raw: string): string {
  // 1. 不正なサロゲートを U+FFFD にする（手順 4 で `_` になる）
  // lib の型に toWellFormed がまだ無いので、型だけ足して呼ぶ（Node 24 の実体を使う）
  let name = (raw as string & { toWellFormed(): string }).toWellFormed();
  // 2. NFC にまとめる
  name = name.normalize("NFC");
  // 3. 最後の / または \ より後だけを使う
  name = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  // 4. 許す文字以外は `_`
  name = name.replace(DISALLOWED, "_");
  // 5. 続いた `_` は 1 つに
  name = name.replace(/_+/g, "_");
  // 6. 先頭の `.` と `-` を落とす
  name = name.replace(/^[.-]+/, "");
  // 7. 120 文字（コードポイント）を超えたら切る。拡張子は残す
  const chars = Array.from(name);
  if (chars.length > MAX_NAME_CHARS) {
    const m = EXTENSION.exec(name);
    if (m && Array.from(m[2]).length <= MAX_EXT_CHARS) {
      const keep = MAX_NAME_CHARS - (Array.from(m[2]).length + 1);
      name = `${Array.from(m[1]).slice(0, keep).join("")}.${m[2]}`;
    } else {
      name = chars.slice(0, MAX_NAME_CHARS).join("");
    }
  }
  // 8. 空・`.`・`..`・`_` だけなら file
  if (name === "" || /^[._]+$/.test(name)) return "file";
  return name;
}
