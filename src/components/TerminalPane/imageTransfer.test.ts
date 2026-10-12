// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { classifyTransfer } from "./imageTransfer";

/** jsdom には DataTransfer が無いので、読む側が使う files と getData だけを持つ作り物にする */
function transfer(files: File[], text = ""): DataTransfer {
  return { files, getData: (type: string) => (type === "text/plain" ? text : "") } as unknown as DataTransfer;
}
const file = (type: string, name = "x"): File => new File([new Uint8Array([1])], name, { type });

describe("classifyTransfer (K4)", () => {
  it("returns the PNG and JPEG files as images", () => {
    const r = classifyTransfer(transfer([file("image/png"), file("image/jpeg")]));
    expect(r.images.map((f) => f.type)).toEqual(["image/png", "image/jpeg"]);
    expect(r.hasOtherFiles).toBe(false);
  });
  it("reports other files (gif, pdf, no type) as not images", () => {
    const r = classifyTransfer(transfer([file("image/gif"), file("application/pdf"), file("")]));
    expect(r.images).toEqual([]);
    expect(r.hasOtherFiles).toBe(true);
  });
  it("keeps images and notes the others when mixed", () => {
    const r = classifyTransfer(transfer([file("image/png"), file("text/plain")]));
    expect(r.images).toHaveLength(1);
    expect(r.hasOtherFiles).toBe(true);
  });
  it("reports the plain text so a text+image paste can be left to xterm", () => {
    expect(classifyTransfer(transfer([file("image/png")], "hello")).text).toBe("hello");
    expect(classifyTransfer(transfer([file("image/png")])).text).toBe("");
  });
  it("handles a missing transfer", () => {
    expect(classifyTransfer(null)).toEqual({ images: [], hasOtherFiles: false, text: "" });
  });
});
