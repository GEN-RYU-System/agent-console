// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let lastTerm: { options: Record<string, unknown> } | null = null;
let currentUpload: (file: Blob) => Promise<{ path: string }> = async () => ({ path: "/unset" });
let currentFileUpload: (file: Blob) => Promise<{ path: string }> = async () => ({ path: "/unset" });

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    reset = vi.fn();
    paste = vi.fn((t: string) => calls.push(`paste:${t}`));
    input = vi.fn((d: string) => calls.push(`input:${d}`));
    options: Record<string, unknown>;
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      lastTerm = this;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  uploadImage: (file: Blob) => currentUpload(file),
  uploadFile: (file: Blob) => currentFileUpload(file),
}));

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  close = vi.fn();
  send = vi.fn();
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
}

beforeEach(() => {
  calls.length = 0;
  currentUpload = async () => ({ path: "/unset" });
  currentFileUpload = async () => ({ path: "/unset" });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); disconnect = vi.fn(); });
});
afterEach(() => vi.unstubAllGlobals());

const hostOf = (c: HTMLElement): HTMLElement => c.querySelector('[data-testid="terminal"]') as HTMLElement;
const smooth = (): unknown => lastTerm?.options.smoothScrollDuration;

function wheel(host: HTMLElement, deltaY: number, legacyDeltaY?: number): void {
  const e = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
  if (legacyDeltaY !== undefined) Object.defineProperty(e, "wheelDeltaY", { value: legacyDeltaY });
  host.dispatchEvent(e);
}
const notch = (host: HTMLElement): void => wheel(host, 100, -120);
const pad = (host: HTMLElement): void => wheel(host, 3, -9);

describe("K2: smoothScrollDuration follows the input device", () => {
  it("starts at 0 (unknown means the browser's own movement)", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    render(<TerminalPane sessionId="a" smoothScrollMs={125} />);
    expect(smooth()).toBe(0);
  });

  it("becomes the config value on a physical wheel, and goes back to 0 on a trackpad", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" smoothScrollMs={125} />);
    const host = hostOf(container);
    for (let i = 0; i < 5; i++) notch(host);
    expect(smooth()).toBe(125);
    for (let i = 0; i < 6; i++) pad(host);
    expect(smooth()).toBe(0);
    for (let i = 0; i < 5; i++) notch(host);
    expect(smooth()).toBe(125);
  });

  it("uses the value it was given (not a built-in 125), and 0 from config keeps it off even for a wheel", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const a = render(<TerminalPane sessionId="a" smoothScrollMs={300} />);
    for (let i = 0; i < 5; i++) notch(hostOf(a.container));
    expect(smooth()).toBe(300);
    a.unmount();
    const b = render(<TerminalPane sessionId="a" smoothScrollMs={0} />);
    for (let i = 0; i < 5; i++) notch(hostOf(b.container));
    expect(smooth()).toBe(0);
  });

  it("follows a changed config value while a wheel is in use", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const { container, rerender } = render(<TerminalPane sessionId="a" smoothScrollMs={125} />);
    for (let i = 0; i < 5; i++) notch(hostOf(container));
    rerender(<TerminalPane sessionId="a" smoothScrollMs={50} />);
    expect(smooth()).toBe(50);
  });
});

/** jsdom には ClipboardEvent / DragEvent / DataTransfer が無いので、読む側が使う部分だけの作り物を載せる */
function fire(host: HTMLElement, type: string, files: File[], text = ""): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const transfer = { files, types: files.length > 0 ? ["Files"] : ["text/plain"], getData: (t: string) => (t === "text/plain" ? text : "") };
  Object.defineProperty(e, type === "paste" ? "clipboardData" : "dataTransfer", { value: transfer });
  act(() => {
    host.dispatchEvent(e);
  });
  return e;
}
const png = (): File => new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
const flush = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("K4: pasting and dropping images", () => {
  it("an image-only paste is stopped, uploaded, and its path is pasted into the terminal with spaces around it and no Enter", async () => {
    const uploads: Blob[] = [];
    currentUpload = async (f) => {
      uploads.push(f);
      return { path: "/data/Application Support/uploads/abc.png" };
    };
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" />);
    const e = fire(hostOf(container), "paste", [png()]);
    expect(e.defaultPrevented).toBe(true);
    await flush();
    expect(uploads).toHaveLength(1);
    expect(calls).toEqual(["paste: /data/Application Support/uploads/abc.png "]);
    expect(calls.some((c) => c.startsWith("input:"))).toBe(false);
  });

  it("a paste that also has text is left to xterm: not stopped, nothing uploaded", async () => {
    const upload = vi.fn(async () => ({ path: "/x" }));
    currentUpload = upload;
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" />);
    const e = fire(hostOf(container), "paste", [png()], "some text");
    await flush();
    expect(e.defaultPrevented).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("a text-only paste is untouched", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" />);
    expect(fire(hostOf(container), "paste", [], "hello").defaultPrevented).toBe(false);
  });

  it("dragover and drop are always stopped on the wrapper (so the browser never opens the file as a page)", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" />);
    const host = hostOf(container);
    expect(fire(host, "dragover", [png()]).defaultPrevented).toBe(true);
    expect(fire(host, "dragover", [new File(["x"], "a.pdf", { type: "application/pdf" })]).defaultPrevented).toBe(true);
    expect(fire(host, "drop", [new File(["x"], "a.pdf", { type: "application/pdf" })]).defaultPrevented).toBe(true);
  });

  it("dropping an image uploads it and pastes the path", async () => {
    currentUpload = async () => ({ path: "/p/1.png" });
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" />);
    expect(fire(hostOf(container), "drop", [png()]).defaultPrevented).toBe(true);
    await flush();
    expect(calls).toEqual(["paste: /p/1.png "]);
  });

  it("dropping a non-image file uploads it through uploadFile (not uploadImage) and pastes the path", async () => {
    const imageUpload = vi.fn(async () => ({ path: "/img" }));
    const fileUpload = vi.fn(async () => ({ path: "/data/uploads/files/u/a.pdf" }));
    currentUpload = imageUpload;
    currentFileUpload = fileUpload;
    const notices: string[] = [];
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" onUploadNotice={(k) => notices.push(k)} />);
    fire(hostOf(container), "drop", [new File(["x"], "a.pdf", { type: "application/pdf" })]);
    await flush();
    expect(imageUpload).not.toHaveBeenCalled();
    expect(fileUpload).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["paste: /data/uploads/files/u/a.pdf "]);
    expect(notices).toEqual([]);
  });

  it("a mixed drop is pasted one by one in the original order (file, image, file)", async () => {
    currentUpload = async () => ({ path: "/p/img.png" });
    currentFileUpload = async (f) => ({ path: `/p/${(f as File).name}` });
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" />);
    fire(hostOf(container), "drop", [new File(["1"], "a.csv", { type: "text/csv" }), png(), new File(["2"], "b.txt", { type: "" })]);
    await flush();
    expect(calls).toEqual(["paste: /p/a.csv ", "paste: /p/img.png ", "paste: /p/b.txt "]);
  });

  it("a non-image file that cannot be read (uploadFile rejects) tells the user (failed) and pastes nothing", async () => {
    currentFileUpload = async () => {
      throw new Error("read failed");
    };
    const notices: string[] = [];
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" onUploadNotice={(k) => notices.push(k)} />);
    fire(hostOf(container), "drop", [new File([""], "folder", { type: "" })]);
    await flush();
    expect(calls).toEqual([]);
    expect(notices).toEqual(["failed"]);
  });

  it("a non-image file over uploadMaxBytes is not sent (tooLarge)", async () => {
    const fileUpload = vi.fn(async () => ({ path: "/x" }));
    currentFileUpload = fileUpload;
    const notices: string[] = [];
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" uploadMaxBytes={2} onUploadNotice={(k) => notices.push(k)} />);
    fire(hostOf(container), "drop", [new File(["abcdef"], "big.csv", { type: "text/csv" })]);
    await flush();
    expect(fileUpload).not.toHaveBeenCalled();
    expect(notices).toEqual(["tooLarge"]);
  });

  it("a file-only paste (no text) is stopped and uploaded; with text it is left to xterm", async () => {
    currentFileUpload = async () => ({ path: "/p/a.csv" });
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" />);
    const csv = new File(["x"], "a.csv", { type: "text/csv" });
    expect(fire(hostOf(container), "paste", [csv], "text").defaultPrevented).toBe(false);
    expect(fire(hostOf(container), "paste", [csv]).defaultPrevented).toBe(true);
    await flush();
    expect(calls).toEqual(["paste: /p/a.csv "]);
  });

  it("a file over uploadMaxBytes is not sent, and the user is told (tooLarge)", async () => {
    const upload = vi.fn(async () => ({ path: "/x" }));
    currentUpload = upload;
    const notices: string[] = [];
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" uploadMaxBytes={2} onUploadNotice={(k) => notices.push(k)} />);
    fire(hostOf(container), "drop", [png()]);
    await flush();
    expect(upload).not.toHaveBeenCalled();
    expect(notices).toEqual(["tooLarge"]);
  });

  it("a server failure becomes a notice (failed) and nothing is pasted", async () => {
    currentUpload = async () => {
      throw new Error("boom");
    };
    const notices: string[] = [];
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" onUploadNotice={(k) => notices.push(k)} />);
    fire(hostOf(container), "drop", [png()]);
    await flush();
    expect(calls).toEqual([]);
    expect(notices).toEqual(["failed"]);
  });

  it("does not paste when the session was switched while the upload ran (switched)", async () => {
    let release: (v: { path: string }) => void = () => undefined;
    currentUpload = () => new Promise((r) => { release = r; });
    const notices: string[] = [];
    const { TerminalPane } = await import("./TerminalPane");
    const { container, rerender } = render(<TerminalPane sessionId="a" onUploadNotice={(k) => notices.push(k)} />);
    fire(hostOf(container), "drop", [png()]);
    await flush(); // アップロードが始まって（まだ終わっていない）から切り替える
    rerender(<TerminalPane sessionId="b" onUploadNotice={(k) => notices.push(k)} />);
    release({ path: "/late.png" });
    await flush();
    expect(calls).toEqual([]);
    expect(notices).toEqual(["switched"]);
  });

  it("several images are uploaded one after another, each pasted in order", async () => {
    let n = 0;
    currentUpload = async () => ({ path: `/p/${++n}.png` });
    const { TerminalPane } = await import("./TerminalPane");
    const { container } = render(<TerminalPane sessionId="a" />);
    fire(hostOf(container), "drop", [png(), png()]);
    await flush();
    await flush();
    expect(calls).toEqual(["paste: /p/1.png ", "paste: /p/2.png "]);
  });
});
