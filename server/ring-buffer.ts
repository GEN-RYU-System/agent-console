/** 生バイトの上限付きバッファ。上限を超えたら古い側から捨てる。 */
export class RingBuffer {
  private chunks: Buffer[] = [];
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
    const all = Buffer.concat(this.chunks, this.size);
    let start = 0;
    while (start < all.length && (all[start] & 0xc0) === 0x80) start += 1;
    return all.subarray(start).toString("utf8");
  }

  private trim(): void {
    if (this.size <= this.maxBytes) return;
    const all = Buffer.concat(this.chunks, this.size);
    const tail = all.subarray(all.length - this.maxBytes);
    this.chunks = [tail];
    this.size = tail.length;
  }
}
