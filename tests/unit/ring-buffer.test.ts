import { describe, expect, it } from "vitest";
import { RingBuffer } from "../../server/ring-buffer.ts";

describe("RingBuffer", () => {
  it("keeps everything while under the limit", () => {
    const rb = new RingBuffer(16);
    rb.push("hello ");
    rb.push("world");
    expect(rb.snapshot()).toBe("hello world");
  });

  it("drops the oldest bytes when the limit is exceeded", () => {
    const rb = new RingBuffer(5);
    rb.push("abc");
    rb.push("defgh");
    expect(rb.snapshot()).toBe("defgh");
    expect(rb.byteLength).toBe(5);
  });

  it("never returns a broken multibyte character at the head", () => {
    const rb = new RingBuffer(4);
    rb.push("あい"); // 6 bytes -> tail 4 bytes starts mid-character
    const s = rb.snapshot();
    expect(s).not.toContain("�");
    expect(s).toBe("い");
  });

  it("keeps exactly the newest bytes across many small pushes", () => {
    const rb = new RingBuffer(10);
    for (let i = 0; i < 100; i++) rb.push(String(i % 10));
    expect(rb.snapshot()).toBe("0123456789");
    expect(rb.byteLength).toBe(10);
  });

  it("drops across chunk boundaries (partial trim of the oldest chunk)", () => {
    const rb = new RingBuffer(6);
    rb.push("abcd");
    rb.push("efgh");
    expect(rb.snapshot()).toBe("cdefgh");
  });

  it("handles 10MB of writes into a 1MB buffer within a time budget (no full copy per push)", () => {
    const rb = new RingBuffer(1024 * 1024);
    const chunk = "x".repeat(64);
    const start = performance.now();
    for (let i = 0; i < (10 * 1024 * 1024) / 64; i++) rb.push(chunk);
    const elapsed = performance.now() - start;
    expect(rb.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(rb.snapshot().length).toBe(1024 * 1024);
    expect(elapsed).toBeLessThan(1500);
  });
});
