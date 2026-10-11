// @vitest-environment jsdom
import { createRef } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const disposeTerm = vi.fn();
let lastTerm: { options: Record<string, unknown>; paste: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> } | null = null;
const calls: string[] = [];
const closeWs = vi.fn();

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    paste = vi.fn((t: string) => calls.push(`paste:${t}`));
    input = vi.fn((d: string) => calls.push(`input:${d}`));
    options: Record<string, unknown> = {};
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = disposeTerm;
    constructor() {
      lastTerm = this;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  close = closeWs;
  send = vi.fn();
  constructor(public url: string) {}
}

beforeEach(() => {
  disposeTerm.mockClear();
  calls.length = 0;
  closeWs.mockClear();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); disconnect = vi.fn(); });
});

describe("TerminalPane", () => {
  it("disposes the terminal and socket when unmounted", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const { unmount } = render(<TerminalPane sessionId="abc" />);
    unmount();
    expect(disposeTerm).toHaveBeenCalledOnce();
    expect(closeWs).toHaveBeenCalledOnce();
  });

  it("recreates the terminal when the session changes", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const { rerender } = render(<TerminalPane sessionId="a" />);
    rerender(<TerminalPane sessionId="b" />);
    expect(disposeTerm).toHaveBeenCalledOnce();
  });

  it("re-reads the theme from the tokens when the html class changes (dark toggle)", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    render(<TerminalPane sessionId="a" />);
    document.documentElement.style.setProperty("--bg-surface", "dark-bg");
    document.documentElement.classList.add("force-dark");
    await vi.waitFor(() => expect((lastTerm?.options.theme as { background: string } | undefined)?.background).toBe("dark-bg"));
    document.documentElement.classList.remove("force-dark");
    document.documentElement.style.removeProperty("--bg-surface");
  });

  it("pasteAndEnter pastes the text through xterm paste() and then sends Enter, in that order", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const ref = createRef<{ pasteAndEnter: (t: string) => void }>();
    render(<TerminalPane ref={ref} sessionId="a" />);
    ref.current?.pasteAndEnter("line1\nline2");
    expect(calls).toEqual(["paste:line1\nline2", "input:\r"]);
    expect(lastTerm?.paste).toHaveBeenCalledOnce();
  });

  it("does nothing after the terminal was disposed", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const ref = createRef<{ pasteAndEnter: (t: string) => void }>();
    const { unmount } = render(<TerminalPane ref={ref} sessionId="a" />);
    unmount();
    ref.current?.pasteAndEnter("x");
    expect(calls).toEqual([]);
  });
});
