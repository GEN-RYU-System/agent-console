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
});
