/** 文字列を maxUnits（UTF-16 単位）以下に分割する。サロゲートペアは割らない。 */
export function splitByCodePoints(data: string, maxUnits: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + maxUnits, data.length);
    // 境界が上位サロゲートの直後なら、ペアを割らないよう手前で切る（1 単位指定のときはペアごと含める）
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end = end - 1 > start ? end - 1 : end + 1;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
