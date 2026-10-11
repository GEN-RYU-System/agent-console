const COMPACT_THRESHOLD = 1024;

/** 生バイトの上限付きバッファ。上限を超えたら古い側から捨てる（push ごとの全体コピーはしない）。 */
export class RingBuffer {
  private chunks: Buffer[] = [];
  /** chunks の先頭の有効位置。捨てるたびに配列を詰め直さない（償却 O(1)）。 */
  private head = 0;
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  get byteLength(): number {
    return this.size;
  }

  push(data: string | Buffer): void {
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.chunks.push(chunk);
    this.size += chunk.length;
    this.trim();
  }

  /** 先頭が UTF-8 の途中バイトで始まらないように切り詰めた文字列を返す。 */
  snapshot(): string {
    const all = Buffer.concat(this.chunks.slice(this.head), this.size);
    let start = 0;
    while (start < all.length && (all[start] & 0xc0) === 0x80) start += 1;
    return all.subarray(start).toString("utf8");
  }

  /** 古いチャンクを丸ごと捨て、境界のチャンクだけ subarray（コピーなし）で切り詰める。 */
  private trim(): void {
    let excess = this.size - this.maxBytes;
    if (excess <= 0) return;
    while (this.head < this.chunks.length && this.chunks[this.head].length <= excess) {
      excess -= this.chunks[this.head].length;
      this.size -= this.chunks[this.head].length;
      this.head += 1;
    }
    if (excess > 0 && this.head < this.chunks.length) {
      this.chunks[this.head] = this.chunks[this.head].subarray(excess);
      this.size -= excess;
    }
    if (this.head >= COMPACT_THRESHOLD && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
}
