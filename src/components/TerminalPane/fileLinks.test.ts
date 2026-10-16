import { describe, expect, it } from "vitest";
import { computeFileLinks, extractPathWords, matchPath, type LinkBuffer, type LinkCell, type LinkLine } from "./fileLinks";

const FILES = ["/tmp/CC報告ファイル/x/candidates.md", "/Users/me/proj/src/a.ts", "/Users/me/proj/src/b/index.ts", "/Users/me/other/src/b/index.ts", "/tmp/r/報告.md"];

describe("extractPathWords（K1 拾い方）", () => {
  it("/ を含む語だけを拾い、末尾の記号を外す", () => {
    const line = "Write(/tmp/r/報告.md) と /Users/me/proj/src/a.ts. さらに ../../../tmp/x.md、 ~/a/b。 plain word";
    expect(extractPathWords(line).map((w) => w.word)).toEqual(["/tmp/r/報告.md", "/Users/me/proj/src/a.ts", "../../../tmp/x.md", "~/a/b"]);
  });
  it("全角の空白・引用符・カンマで区切る。/ の無い語は拾わない", () => {
    expect(extractPathWords("a　/x/y,\"/z/w\" `/q/r` word").map((w) => w.word)).toEqual(["/x/y", "/z/w", "/q/r"]);
    expect(extractPathWords("file.md README")).toEqual([]);
  });
  it("末尾の記号は繰り返し外す", () => {
    expect(extractPathWords("/a/b.md.)。").map((w) => w.word)).toEqual(["/a/b.md"]);
  });
});

describe("matchPath（K1 当て方）", () => {
  it("絶対パスは完全一致だけ", () => {
    expect(matchPath("/Users/me/proj/src/a.ts", FILES)).toBe("/Users/me/proj/src/a.ts");
    expect(matchPath("/Users/me/proj/src/zzz.ts", FILES)).toBeUndefined();
    expect(matchPath("/src/a.ts", FILES)).toBeUndefined();
  });
  it("../../../tmp/… と ~/… は先頭を外して末尾一致（ちょうど1つ）", () => {
    expect(matchPath("../../../tmp/CC報告ファイル/x/candidates.md", FILES)).toBe("/tmp/CC報告ファイル/x/candidates.md");
    expect(matchPath("~/proj/src/a.ts", FILES)).toBe("/Users/me/proj/src/a.ts");
    expect(matchPath("./src/a.ts", FILES)).toBe("/Users/me/proj/src/a.ts");
  });
  it("全角を含む名前に当たる", () => {
    expect(matchPath("r/報告.md", FILES)).toBe("/tmp/r/報告.md");
  });
  it("候補が2つ以上ならリンクにしない", () => {
    expect(matchPath("src/b/index.ts", FILES)).toBeUndefined();
  });
  it("/ を含まない残り・空の残りは当てない", () => {
    expect(matchPath("~/", FILES)).toBeUndefined();
    expect(matchPath("../a.ts", FILES)).toBeUndefined();
    expect(matchPath("a.ts", FILES)).toBeUndefined();
  });
  it("一覧に無ければ undefined", () => {
    expect(matchPath("nothing/here.md", FILES)).toBeUndefined();
  });
});

// 偽のバッファ: 全角は2セル（2つ目は幅0・文字なし）、残りは空セル（幅1・文字なし）
class FakeCell implements LinkCell {
  constructor(private readonly chars: string, private readonly width: number) {}
  getChars(): string {
    return this.chars;
  }
  getWidth(): number {
    return this.width;
  }
}
const wide = (ch: string): boolean => (ch.codePointAt(0) ?? 0) >= 0x2e80;
class FakeLine implements LinkLine {
  readonly cells: FakeCell[] = [];
  constructor(text: string, cols: number, readonly isWrapped = false) {
    for (const ch of text) {
      if (wide(ch)) {
        this.cells.push(new FakeCell(ch, 2), new FakeCell("", 0));
      } else this.cells.push(new FakeCell(ch, 1));
    }
    while (this.cells.length < cols) this.cells.push(new FakeCell("", 1));
  }
  get length(): number {
    return this.cells.length;
  }
  getCell(x: number): LinkCell | undefined {
    return this.cells[x];
  }
  translateToString(trimRight?: boolean): string {
    const s = this.cells.map((c) => (c.getWidth() === 0 ? "" : c.getChars() === "" ? " " : c.getChars())).join("");
    return trimRight ? s.replace(/ +$/u, "") : s;
  }
}
const bufferOf = (lines: FakeLine[]): LinkBuffer => ({ getLine: (y) => lines[y], getNullCell: () => new FakeCell("", 1) });

describe("computeFileLinks（K2 列）", () => {
  it("半角だけの行: 範囲は 1 始まりで end を含む", () => {
    const buf = bufferOf([new FakeLine("see /Users/me/proj/src/a.ts ok", 40)]);
    const [link] = computeFileLinks(1, buf, FILES);
    expect(link).toEqual({ range: { start: { x: 5, y: 1 }, end: { x: 27, y: 1 } }, text: "/Users/me/proj/src/a.ts", path: "/Users/me/proj/src/a.ts" });
    expect(27 - 5 + 1).toBe("/Users/me/proj/src/a.ts".length);
  });
  it("全角（報告）の後ろにあるパスでも、列がパスの文字と一致する", () => {
    // 「報告」= 4 セル。「 /tmp/r/報告.md」: 先頭 4 セル + 空白 1 + パス（/tmp/r/ 7 + 報告 4 + .md 3 = 14 セル）
    const buf = bufferOf([new FakeLine("報告 /tmp/r/報告.md", 40)]);
    const [link] = computeFileLinks(1, buf, FILES);
    expect(link?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 19, y: 1 } });
    expect(link?.path).toBe("/tmp/r/報告.md");
  });
  it("折り返し（isWrapped）にまたがるパスは1つのリンク。どちらの行から呼んでも同じ", () => {
    const path = "/Users/me/proj/src/a.ts";
    const buf = bufferOf([new FakeLine(`x ${path.slice(0, 10)}`, 12), new FakeLine(path.slice(10), 20, true)]);
    const top = computeFileLinks(1, buf, FILES);
    const bottom = computeFileLinks(2, buf, FILES);
    expect(top).toHaveLength(1);
    expect(top[0]?.range).toEqual({ start: { x: 3, y: 1 }, end: { x: path.length - 10, y: 2 } });
    expect(bottom).toEqual(top);
  });
  it("全角の文字が折り返しをまたぐ行でも、パスの範囲が崩れない", () => {
    const path = "/tmp/r/報告.md";
    // 1 行目は 8 セル: 「/tmp/r/」7 セル + 次の全角が入らず空セル 1 つ。2 行目は「報告.md」
    const first = new FakeLine("/tmp/r/", 8);
    const second = new FakeLine("報告.md", 8, true);
    const [link] = computeFileLinks(1, bufferOf([first, second]), FILES);
    expect(link?.text).toBe(path);
    expect(link?.range.start).toEqual({ x: 1, y: 1 });
    expect(link?.range.end).toEqual({ x: 7, y: 2 });
  });
  it("当たらない語・候補が2つ以上の語はリンクにならない", () => {
    const buf = bufferOf([new FakeLine("src/b/index.ts と /no/such/file.md", 60)]);
    expect(computeFileLinks(1, buf, FILES)).toEqual([]);
  });
});
