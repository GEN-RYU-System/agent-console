// @vitest-environment jsdom
import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { TerminalHandle } from "./TerminalPane";

const webglMock = vi.hoisted(() => ({
  /** 作られた WebglAddon の代役（新しい順に末尾へ） */
  instances: [] as { dispose: ReturnType<typeof vi.fn>; lossCb: (() => void) | null }[],
  throwOnLoad: false,
  throwOnConstruct: false,
}));
/** registerLinkProvider の代役（登録された物と、外した回数） */
const linkMock = vi.hoisted(() => ({
  providers: [] as { provideLinks: (y: number, cb: (links: { range: unknown; text: string; activate: (e: unknown, t: string) => void }[] | undefined) => void) => void }[],
  dispose: vi.fn(),
  fetchFiles: vi.fn(),
  lineText: "",
}));
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
    loadAddon = vi.fn((a: unknown) => {
      if (webglMock.instances.includes(a as never) && webglMock.throwOnLoad) throw new Error("webgl2 unavailable");
    });
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
    registerLinkProvider = vi.fn((p: (typeof linkMock.providers)[number]) => {
      linkMock.providers.push(p);
      return { dispose: linkMock.dispose };
    });
    // 半角だけの 1 行（linkMock.lineText）を返す偽のバッファ
    buffer = {
      active: {
        getLine: (y: number) => {
          if (y !== 0) return undefined;
          const cells = [...linkMock.lineText].map((ch) => ({ getChars: () => ch, getWidth: () => 1 }));
          return {
            length: 80,
            isWrapped: false,
            getCell: (x: number) => cells[x] ?? { getChars: () => "", getWidth: () => 1 },
            translateToString: () => linkMock.lineText,
          };
        },
        getNullCell: () => ({ getChars: () => "", getWidth: () => 1 }),
      },
    };
    dispose = disposeTerm;
    constructor() {
      lastTerm = this;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    dispose = vi.fn();
    lossCb: (() => void) | null = null;
    onContextLoss = vi.fn((cb: () => void) => {
      this.lossCb = cb;
      return { dispose: vi.fn() };
    });
    constructor() {
      if (webglMock.throwOnConstruct) throw new Error("no WebGL");
      webglMock.instances.push(this);
    }
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchFiles: (id: string) => linkMock.fetchFiles(id),
}));

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
  webglMock.instances.length = 0;
  webglMock.throwOnLoad = false;
  webglMock.throwOnConstruct = false;
  disposeTerm.mockClear();
  linkMock.providers.length = 0;
  linkMock.dispose.mockClear();
  linkMock.fetchFiles.mockReset();
  linkMock.fetchFiles.mockResolvedValue({ status: "ok", files: [{ path: "/w/a.md" }] });
  linkMock.lineText = "";
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

describe("TerminalPane renderer (WebGL)", () => {
  const rendererOf = () => screen.getByTestId("terminal").dataset.renderer;

  it("W1: does not create a WebglAddon when renderer is unset or dom", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const { unmount } = render(<TerminalPane sessionId="abc" />);
    expect(webglMock.instances).toHaveLength(0);
    expect(rendererOf()).toBe("dom");
    unmount();
    render(<TerminalPane sessionId="abc" renderer="dom" />);
    expect(webglMock.instances).toHaveLength(0);
    expect(rendererOf()).toBe("dom");
  });

  it("W2: loads the WebglAddon after open when renderer is webgl", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    render(<TerminalPane sessionId="abc" renderer="webgl" />);
    expect(webglMock.instances).toHaveLength(1);
    const term = lastTerm as unknown as { open: ReturnType<typeof vi.fn>; loadAddon: ReturnType<typeof vi.fn> };
    expect(term.loadAddon).toHaveBeenCalledWith(webglMock.instances[0]);
    const openOrder = term.open.mock.invocationCallOrder[0] ?? 0;
    const webglLoadOrder = term.loadAddon.mock.invocationCallOrder[term.loadAddon.mock.calls.findIndex((c) => c[0] === webglMock.instances[0])] ?? 0;
    expect(webglLoadOrder).toBeGreaterThan(openOrder);
    expect(rendererOf()).toBe("webgl");
  });

  it("W3a: keeps the terminal usable when loadAddon throws for the WebglAddon", async () => {
    webglMock.throwOnLoad = true;
    const { TerminalPane } = await import("./TerminalPane");
    render(<TerminalPane sessionId="abc" renderer="webgl" />);
    expect(webglMock.instances[0]?.dispose).toHaveBeenCalled();
    expect(rendererOf()).toBe("dom");
    const term = lastTerm as unknown as { onData: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    expect(term.onData).toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    act(() => {
      sockets[0]!.onopen?.();
      sockets[0]!.onmessage?.({ data: "hello" });
    });
    expect(term.write).toHaveBeenCalled();
  });

  it("W3b: keeps the terminal usable when the WebglAddon constructor throws", async () => {
    webglMock.throwOnConstruct = true;
    const { TerminalPane } = await import("./TerminalPane");
    render(<TerminalPane sessionId="abc" renderer="webgl" />);
    expect(rendererOf()).toBe("dom");
    const term = lastTerm as unknown as { onData: ReturnType<typeof vi.fn> };
    expect(term.onData).toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it("W4: disposes the addon and falls back to dom when the context is lost", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    render(<TerminalPane sessionId="abc" renderer="webgl" />);
    expect(rendererOf()).toBe("webgl");
    act(() => webglMock.instances[0]!.lossCb?.());
    expect(webglMock.instances[0]!.dispose).toHaveBeenCalled();
    expect(rendererOf()).toBe("dom");
  });
  it("K3: registers the link provider once per terminal and disposes it on unmount / session change", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const { rerender, unmount } = render(<TerminalPane sessionId="a" />);
    expect(linkMock.providers).toHaveLength(1);
    rerender(<TerminalPane sessionId="a" filesRev={3} />);
    expect(linkMock.providers).toHaveLength(1);
    expect(linkMock.dispose).not.toHaveBeenCalled();
    rerender(<TerminalPane sessionId="b" />);
    expect(linkMock.providers).toHaveLength(2);
    expect(linkMock.dispose).toHaveBeenCalledTimes(1);
    unmount();
    expect(linkMock.dispose).toHaveBeenCalledTimes(2);
  });

  it("K4: clicking a link calls onOpenFile with the path from the list; the list is fetched once per filesRev", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    const onOpenFile = vi.fn();
    linkMock.lineText = "wrote /w/a.md done";
    const { rerender } = render(<TerminalPane sessionId="a" onOpenFile={onOpenFile} filesRev={1} />);
    const provide = (): Promise<{ range: unknown; text: string; activate: (e: unknown, t: string) => void }[] | undefined> =>
      new Promise((resolve) => linkMock.providers[0]!.provideLinks(1, resolve));
    const [first] = (await provide())!;
    expect(first?.text).toBe("/w/a.md");
    await provide();
    expect(linkMock.fetchFiles).toHaveBeenCalledTimes(1);
    first!.activate({}, first!.text);
    expect(onOpenFile).toHaveBeenCalledWith("/w/a.md");
    rerender(<TerminalPane sessionId="a" onOpenFile={onOpenFile} filesRev={2} />);
    await provide();
    expect(linkMock.fetchFiles).toHaveBeenCalledTimes(2);
  });

  it("K4: no links when the list is unavailable or the line has no listed path", async () => {
    const { TerminalPane } = await import("./TerminalPane");
    render(<TerminalPane sessionId="a" />);
    linkMock.lineText = "wrote /other/x.md";
    expect(await new Promise((r) => linkMock.providers[0]!.provideLinks(1, r))).toBeUndefined();
    linkMock.fetchFiles.mockRejectedValue(new Error("x"));
    render(<TerminalPane sessionId="b" filesRev={9} />);
    linkMock.lineText = "wrote /w/a.md";
    expect(await new Promise((r) => linkMock.providers[1]!.provideLinks(1, r))).toBeUndefined();
  });
});
