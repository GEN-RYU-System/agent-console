// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { classifyTransfer } from "./imageTransfer";

/** jsdom には DataTransfer が無いので、読む側が使う files と getData だけを持つ作り物にする */
function transfer(files: File[], text = ""): DataTransfer {
  return { files, getData: (type: string) => (type === "text/plain" ? text : "") } as unknown as DataTransfer;
}
const file = (type: string, name = "x"): File => new File([new Uint8Array([1])], name, { type });

describe("classifyTransfer (K4)", () => {
  it("marks PNG and JPEG as image, in the original order", () => {
    const r = classifyTransfer(transfer([file("image/png"), file("image/jpeg")]));
    expect(r.files.map((f) => [f.file.type, f.kind])).toEqual([["image/png", "image"], ["image/jpeg", "image"]]);
  });
  it("marks other files (gif, pdf, no type) as file", () => {
    const r = classifyTransfer(transfer([file("image/gif"), file("application/pdf"), file("")]));
    expect(r.files.map((f) => f.kind)).toEqual(["file", "file", "file"]);
  });
  it("keeps the dropped order when images and others are mixed", () => {
    const r = classifyTransfer(transfer([file("text/csv", "a.csv"), file("image/png", "b.png"), file("", "c")]));
    expect(r.files.map((f) => [f.file.name, f.kind])).toEqual([["a.csv", "file"], ["b.png", "image"], ["c", "file"]]);
  });
  it("reports the plain text so a text+file paste can be left to xterm", () => {
    expect(classifyTransfer(transfer([file("image/png")], "hello")).text).toBe("hello");
    expect(classifyTransfer(transfer([file("image/png")])).text).toBe("");
  });
  it("handles a missing transfer", () => {
    expect(classifyTransfer(null)).toEqual({ files: [], text: "" });
  });
});
