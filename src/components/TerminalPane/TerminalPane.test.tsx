// @vitest-environment jsdom
import { createRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalHandle } from "./TerminalPane";

const disposeTerm = vi.fn();
let lastTerm: { options: Record<string, unknown>; paste: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> } | null = null;
const calls: string[] = [];
const closeWs = vi.fn();
let lastWs: { onopen: (() => void) | null; readyState: number; send: ReturnType<typeof vi.fn> } | null = null;

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
  onopen: (() => void) | null = null;
  constructor(public url: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastWs = this;
  }
}

afterEach(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

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
    const ref = createRef<TerminalHandle>();
    render(<TerminalPane ref={ref} sessionId="a" />);
    expect(ref.current?.pasteAndEnter("a", "line1\nline2")).toBe(true);
    expect(calls).toEqual(["paste:line1\nline2", "input:\r"]);
    expect(lastTerm?.paste).toHaveBeenCalledOnce();
  });

  it("never pastes into a terminal that belongs to a different session than the one the text was checked for", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const ref = createRef<TerminalHandle>();
    const { rerender } = render(<TerminalPane ref={ref} sessionId="a" />);
    // 確認したのは a。表示が b に切り替わった後に a の確認結果が届いても、b の端末には入れない
    rerender(<TerminalPane ref={ref} sessionId="b" />);
    expect(ref.current?.pasteAndEnter("a", "secret")).toBe(false);
    expect(calls).toEqual([]);
    expect(ref.current?.pasteAndEnter("b", "for-b")).toBe(true);
    expect(calls).toEqual(["paste:for-b", "input:\r"]);
  });

  it("does nothing after the terminal was disposed", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const ref = createRef<TerminalHandle>();
    const { unmount } = render(<TerminalPane ref={ref} sessionId="a" />);
    unmount();
    expect(ref.current?.pasteAndEnter("a", "x") ?? false).toBe(false);
    expect(calls).toEqual([]);
  });

  it("pasteSubmitAfter pastes first, waits the given time, then sends Enter, and answers 'sent' (K5)", async () => {
    vi.useFakeTimers();
    try {
      const { TerminalPane } = await import("./TerminalPane");
      const ref = createRef<TerminalHandle>();
      render(<TerminalPane ref={ref} sessionId="a" />);
      const result = ref.current?.pasteSubmitAfter("a", "text", 2000);
      expect(calls).toEqual(["paste:text"]);
      await vi.advanceTimersByTimeAsync(1999);
      expect(calls).toEqual(["paste:text"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual(["paste:text", "input:\r"]);
      await expect(result).resolves.toBe("sent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pasteSubmitAfter does not press Enter when the session was switched during the wait, and answers 'pastedNotSent' (K14)", async () => {
    vi.useFakeTimers();
    try {
      const { TerminalPane } = await import("./TerminalPane");
      const ref = createRef<TerminalHandle>();
      const { rerender } = render(<TerminalPane ref={ref} sessionId="a" />);
      const result = ref.current?.pasteSubmitAfter("a", "text", 2000);
      rerender(<TerminalPane ref={ref} sessionId="b" />);
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toEqual(["paste:text"]);
      await expect(result).resolves.toBe("pastedNotSent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pasteSubmitAfter does not press Enter when the session was switched away and back (a different terminal now)", async () => {
    vi.useFakeTimers();
    try {
      const { TerminalPane } = await import("./TerminalPane");
      const ref = createRef<TerminalHandle>();
      const { rerender } = render(<TerminalPane ref={ref} sessionId="a" />);
      const result = ref.current?.pasteSubmitAfter("a", "text", 2000);
      rerender(<TerminalPane ref={ref} sessionId="b" />);
      rerender(<TerminalPane ref={ref} sessionId="a" />);
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toEqual(["paste:text"]);
      await expect(result).resolves.toBe("pastedNotSent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pasteSubmitAfter pastes nothing for another session and answers 'notPasted'", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const ref = createRef<TerminalHandle>();
    render(<TerminalPane ref={ref} sessionId="b" />);
    await expect(ref.current?.pasteSubmitAfter("a", "text", 0)).resolves.toBe("notPasted");
    expect(calls).toEqual([]);
  });
});

describe("TerminalPane size sync while hidden (K12)", () => {
  const setSize = (w: number, h: number): void => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => w });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => h });
  };
  const sentMessages = (): unknown[] => (lastWs?.send.mock.calls ?? []).map((c) => JSON.parse(String(c[0])));

  it("sends no resize while the wrapper has no width or height (display:none), so the pty never gets 2x1", async () => {
    setSize(0, 0);
    const { TerminalPane } = await import("./TerminalPane");
    render(<TerminalPane sessionId="a" />);
    if (lastWs) lastWs.readyState = 1;
    lastWs?.onopen?.();
    expect(sentMessages()).toEqual([]);
  });

  it("sends the resize when it has a size", async () => {
    setSize(800, 600);
    const { TerminalPane } = await import("./TerminalPane");
    render(<TerminalPane sessionId="a" />);
    if (lastWs) lastWs.readyState = 1;
    lastWs?.onopen?.();
    expect(sentMessages()).toEqual([{ type: "resize", cols: 80, rows: 24 }]);
  });
});
