// @vitest-environment jsdom
import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { TerminalHandle } from "./TerminalPane";

const disposeTerm = vi.fn();
let lastTerm: { options: Record<string, unknown>; paste: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> } | null = null;
const calls: string[] = [];
const closeWs = vi.fn();
let lastWs: { onopen: (() => void) | null; readyState: number; send: ReturnType<typeof vi.fn> } | null = null;
/** 端末への書き込み・リセットの順（つなぎ直しの試験用） */
const termEvents: string[] = [];
const sockets: FakeWebSocket[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn((d: string) => termEvents.push(`write:${d}`));
    reset = vi.fn(() => termEvents.push("reset"));
    paste = vi.fn((t: string) => calls.push(`paste:${t}`));
    focus = vi.fn(() => calls.push("focus"));
    input = vi.fn((d: string) => calls.push(`input:${d}`));
    options: Record<string, unknown> = {};
    modes = { mouseTrackingMode: "none" };
    element = document.createElement("div");
    attachCustomWheelEventHandler = vi.fn();
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
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastWs = this;
    sockets.push(this);
  }
}

afterEach(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

beforeEach(() => {
  disposeTerm.mockClear();
  calls.length = 0;
  termEvents.length = 0;
  sockets.length = 0;
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

  it("pasteOnly pastes through xterm paste(), moves focus to the terminal, and never sends Enter", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const ref = createRef<TerminalHandle>();
    render(<TerminalPane ref={ref} sessionId="a" />);
    expect(ref.current?.pasteOnly("a", "line1\nline2")).toBe(true);
    expect(calls).toEqual(["paste:line1\nline2", "focus"]);
    expect(lastTerm?.paste).toHaveBeenCalledOnce();
  });

  it("never pastes into a terminal that belongs to a different session than the one the text was checked for", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const ref = createRef<TerminalHandle>();
    const { rerender } = render(<TerminalPane ref={ref} sessionId="a" />);
    // 確認したのは a。表示が b に切り替わった後に a の確認結果が届いても、b の端末には入れない
    rerender(<TerminalPane ref={ref} sessionId="b" />);
    expect(ref.current?.pasteOnly("a", "secret")).toBe(false);
    expect(calls).toEqual([]);
    expect(ref.current?.pasteOnly("b", "for-b")).toBe(true);
    expect(calls).toEqual(["paste:for-b", "focus"]);
  });

  it("does nothing after the terminal was disposed", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const ref = createRef<TerminalHandle>();
    const { unmount } = render(<TerminalPane ref={ref} sessionId="a" />);
    unmount();
    expect(ref.current?.pasteOnly("a", "x") ?? false).toBe(false);
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

  describe("reconnecting after the server restarts (keep-login K8)", () => {
    const open = (socket: FakeWebSocket | undefined): void => {
      if (socket) socket.readyState = 1;
      act(() => socket?.onopen?.());
    };
    const drop = (socket: FakeWebSocket | undefined): void => {
      if (socket) socket.readyState = 3;
      act(() => socket?.onclose?.());
    };
    const advance = (ms: number): Promise<void> =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    it("reconnects after 1s, 2s, 4s... (max 10s) and resets the screen on open, then writes what the server sends (replay right after open)", async () => {
      vi.useFakeTimers();
      try {
        const { TerminalPane } = await import("./TerminalPane");
        render(<TerminalPane sessionId="a" />);
        open(sockets[0]);
        termEvents.length = 0;
        drop(sockets[0]);
        expect(screen.getByTestId("terminal-reconnecting").textContent).toContain("つなぎ直しています");
        await advance(999);
        expect(sockets).toHaveLength(1);
        await advance(1);
        expect(sockets).toHaveLength(2);
        drop(sockets[1]); // つながらないまま切れる: 次は 2 秒
        await advance(1999);
        expect(sockets).toHaveLength(2);
        await advance(1);
        expect(sockets).toHaveLength(3);
        drop(sockets[2]);
        await advance(4000);
        drop(sockets[3]);
        await advance(8000);
        drop(sockets[4]);
        await advance(9999);
        expect(sockets).toHaveLength(5);
        await advance(1); // 8 秒の次は 16 秒ではなく上限の 10 秒
        expect(sockets).toHaveLength(6);
        // つながった: 描き直し → サーバーが送る中身
        termEvents.length = 0;
        open(sockets[5]);
        act(() => sockets[5]?.onmessage?.({ data: "REPLAY-1" }));
        expect(termEvents).toEqual(["reset", "write:REPLAY-1"]);
        expect(screen.queryByTestId("terminal-reconnecting")).toBeNull();
        // 数え直し: 次に切れたらまた 1 秒
        drop(sockets[5]);
        await advance(1000);
        expect(sockets).toHaveLength(7);
      } finally {
        vi.useRealTimers();
      }
    });

    it("also handles the replay arriving 1s after open (reset first, the late content is still written)", async () => {
      vi.useFakeTimers();
      try {
        const { TerminalPane } = await import("./TerminalPane");
        render(<TerminalPane sessionId="a" />);
        open(sockets[0]);
        drop(sockets[0]);
        await advance(1000);
        termEvents.length = 0;
        open(sockets[1]);
        expect(termEvents).toEqual(["reset"]);
        await advance(1000);
        act(() => sockets[1]?.onmessage?.({ data: "LATE-REPLAY" }));
        expect(termEvents).toEqual(["reset", "write:LATE-REPLAY"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends nothing to the old socket while reconnecting, and ignores late messages from it", async () => {
      vi.useFakeTimers();
      try {
        const { TerminalPane } = await import("./TerminalPane");
        render(<TerminalPane sessionId="a" />);
        open(sockets[0]);
        drop(sockets[0]);
        expect(sockets[0]?.send).not.toHaveBeenCalled();
        await advance(1000);
        // 古い ws の遅れた通知はもう届かない
        act(() => sockets[0]?.onmessage?.({ data: "OLD" }));
        expect(termEvents).not.toContain("write:OLD");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops retrying and closes the socket when unmounted while reconnecting", async () => {
      vi.useFakeTimers();
      try {
        const { TerminalPane } = await import("./TerminalPane");
        const { unmount } = render(<TerminalPane sessionId="a" />);
        open(sockets[0]);
        drop(sockets[0]);
        unmount();
        await advance(20_000);
        expect(sockets).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
