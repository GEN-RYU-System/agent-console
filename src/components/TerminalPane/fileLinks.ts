// 端末に出たパスを、そのセッションのファイル一覧に当ててリンクにするための関数（画面を持たない）。
// 設計: docs/handoff/terminal-file-link/design.md §4-2・§4-3

/** xterm の buffer のうち、ここで使う分だけの形（試験で偽物を渡せるようにする） */
export interface LinkCell {
  getChars(): string;
  getWidth(): number;
}
export interface LinkLine {
  readonly length: number;
  readonly isWrapped: boolean;
  getCell(x: number, cell?: LinkCell): LinkCell | undefined;
  translateToString(trimRight?: boolean): string;
}
export interface LinkBuffer {
  getLine(y: number): LinkLine | undefined;
  getNullCell(): LinkCell;
}

export interface FileLink {
  /** 1 始まり、end は含む（xterm の ILink.range と同じ） */
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  /** 端末に出ていた文字 */
  text: string;
  /** 一覧の path（開く対象。端末の文字ではない） */
  path: string;
}

const SEPARATORS = new Set([..."()[]{}<>\"'`,", " ", "\t", "\n", "\r", "　"]);
const TRAILING = new Set([".", ",", ":", ";", ")", "」", "、", "。"]);
const MAX_WINDOW = 2048;

/** 区切りで分けた語のうち `/` を含む物を、末尾の記号を外して返す。index は文字列の添字 */
export function extractPathWords(line: string): { word: string; index: number }[] {
  const result: { word: string; index: number }[] = [];
  let start = -1;
  const flush = (end: number): void => {
    if (start < 0) return;
    let stop = end;
    while (stop > start && TRAILING.has(line[stop - 1] ?? "")) stop -= 1;
    const word = line.slice(start, stop);
    if (word.includes("/")) result.push({ word, index: start });
    start = -1;
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? "";
    if (/\s/u.test(ch) || SEPARATORS.has(ch)) flush(i);
    else if (start < 0) start = i;
  }
  flush(line.length);
  return result;
}

/** 語を一覧（絶対パス）に当てる。当たれば一覧の path、当たらない・取り違えうる時は undefined */
export function matchPath(word: string, paths: readonly string[]): string | undefined {
  if (word.startsWith("/")) return paths.includes(word) ? word : undefined;
  let rest = word;
  for (;;) {
    if (rest.startsWith("~/")) rest = rest.slice(2);
    else if (rest.startsWith("./")) rest = rest.slice(2);
    else if (rest.startsWith("../")) rest = rest.slice(3);
    else break;
  }
  if (rest === "" || !rest.includes("/")) return undefined;
  const hits = paths.filter((p) => p.endsWith(`/${rest}`));
  return hits.length === 1 ? hits[0] : undefined;
}

// 列の数え方は xterm.js 公式 addon-web-links 0.12.0 の WebLinkProvider.ts（MIT、
// https://github.com/xtermjs/xterm.js/blob/6.0.0/addons/addon-web-links/src/WebLinkProvider.ts ）を参考にした。
function windowedLines(lineIndex: number, buffer: LinkBuffer): [string[], number] {
  let line: LinkLine | undefined;
  let topIdx = lineIndex;
  let bottomIdx = lineIndex;
  let length = 0;
  let content = "";
  const lines: string[] = [];
  if ((line = buffer.getLine(lineIndex))) {
    const currentContent = line.translateToString(true);
    if (line.isWrapped && currentContent[0] !== " ") {
      length = 0;
      while ((line = buffer.getLine(--topIdx)) && length < MAX_WINDOW) {
        content = line.translateToString(true);
        length += content.length;
        lines.push(content);
        if (!line.isWrapped || content.indexOf(" ") !== -1) break;
      }
      lines.reverse();
    }
    lines.push(currentContent);
    length = 0;
    while ((line = buffer.getLine(++bottomIdx)) && line.isWrapped && length < MAX_WINDOW) {
      content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      if (content.indexOf(" ") !== -1) break;
    }
  }
  return [lines, topIdx];
}

/** 文字列の添字を [行, 列]（0 始まり、右端は含まない）に戻す。行が無ければ [-1, -1] */
function mapStrIdx(buffer: LinkBuffer, lineIndex: number, rowIndex: number, stringIndex: number): [number, number] {
  const cell = buffer.getNullCell();
  let start = rowIndex;
  let remaining = stringIndex;
  while (remaining) {
    const line = buffer.getLine(lineIndex);
    if (!line) return [-1, -1];
    for (let i = start; i < line.length; ++i) {
      const cur = line.getCell(i, cell) ?? cell;
      const chars = cur.getChars();
      const width = cur.getWidth();
      if (width) {
        remaining -= chars.length || 1;
        // 全角の早い折り返し（最後のセルが空で、次の行の先頭が全角）の補正
        if (i === line.length - 1 && chars === "") {
          const next = buffer.getLine(lineIndex + 1);
          if (next && next.isWrapped) {
            const head = next.getCell(0, cell) ?? cell;
            if (head.getWidth() === 2) remaining += 1;
          }
        }
      }
      if (remaining < 0) return [lineIndex, i];
    }
    lineIndex++;
    start = 0;
  }
  return [lineIndex, start];
}

/** y（1 始まり）の行にかかるリンクを返す。paths は、そのセッションのファイル一覧の path */
export function computeFileLinks(y: number, buffer: LinkBuffer, paths: readonly string[]): FileLink[] {
  const [lines, startLineIndex] = windowedLines(y - 1, buffer);
  const text = lines.join("");
  const result: FileLink[] = [];
  for (const { word, index } of extractPathWords(text)) {
    const path = matchPath(word, paths);
    if (path === undefined) continue;
    const [startY, startX] = mapStrIdx(buffer, startLineIndex, 0, index);
    const [endY, endX] = mapStrIdx(buffer, startY, startX, word.length);
    if (startY === -1 || startX === -1 || endY === -1 || endX === -1) continue;
    result.push({ range: { start: { x: startX + 1, y: startY + 1 }, end: { x: endX, y: endY + 1 } }, text: word, path });
  }
  return result;
}
