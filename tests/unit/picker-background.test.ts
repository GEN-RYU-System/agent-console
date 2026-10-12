import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(path.resolve("extension", "background.js"), "utf8");
const PORT = 4319;
const TOKEN = "ab".repeat(32);

type Listener = (msg: unknown, sender: unknown, send: (r: unknown) => void) => boolean | undefined;

interface Harness {
  onClicked: (tab: { id: number }) => Promise<void>;
  onMessage: Listener;
  fetchMock: ReturnType<typeof vi.fn>;
  chrome: {
    scripting: { executeScript: ReturnType<typeof vi.fn> };
    action: { setBadgeText: ReturnType<typeof vi.fn> };
    tabs: { captureVisibleTab: ReturnType<typeof vi.fn> };
  };
}

/** service worker を、拡張の API の代役つきで、そのまま実行する。 */
function load(opts: { png?: Uint8Array; captureFails?: boolean } = {}): Harness {
  let clicked: Harness["onClicked"] = async () => undefined;
  let messaged: Listener = () => false;
  const fetchMock = vi.fn(async (url: string, _init?: unknown) => {
    if (String(url).startsWith("http://")) return { status: 201 };
    // 拡張の自分のファイル（chrome-extension://）と、撮影した画像（data:）
    return { text: async () => (String(url).endsWith("picker-tokens.css") ? ":host{--pick-x:1}" : ".frame{}"), blob: async () => ({}) };
  });
  const chrome = {
    runtime: { getURL: (f: string) => `chrome-extension://id/${f}`, onMessage: { addListener: (l: Listener) => (messaged = l) } },
    action: { onClicked: { addListener: (l: Harness["onClicked"]) => (clicked = l) }, setBadgeText: vi.fn(async () => undefined) },
    scripting: { executeScript: vi.fn(async () => undefined) },
    tabs: { captureVisibleTab: vi.fn(async () => { if (opts.captureFails) throw new Error("captureVisibleTab failed"); return "data:image/png;base64,AAAA"; }) },
    i18n: { getMessage: (k: string) => `msg:${k}` },
  };
  const png = opts.png ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const sandbox: Record<string, unknown> = {
    chrome,
    fetch: (url: string, init?: unknown) => (String(url).startsWith("http://") ? fetchMock(url, init) : fetchMock(url)),
    importScripts: () => {
      (sandbox.self as { AC_PICKER?: unknown }).AC_PICKER = { port: PORT, token: TOKEN };
    },
    createImageBitmap: async () => ({ width: 1000, height: 800 }),
    OffscreenCanvas: class {
      constructor(w: number, h: number) {
        canvases.push({ w, h });
      }
      getContext() {
        return { drawImage: () => undefined };
      }
      async convertToBlob() {
        return { size: png.length, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length) };
      }
    },
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    Uint8Array,
    String,
    JSON,
    Math,
  };
  sandbox.self = sandbox;
  vm.runInNewContext(SOURCE, sandbox);
  return { onClicked: clicked, onMessage: messaged, fetchMock, chrome };
}

const canvases: Array<{ w: number; h: number }> = [];
const sender = { tab: { id: 7, windowId: 3 } };
const payload = { url: "https://example.com/", rect: { x: 10, y: 20, w: 100, h: 50 }, vw: 1000 };
const send = (h: Harness, msg: unknown = { type: "pick", payload }, from: unknown = sender): Promise<unknown> =>
  new Promise((resolve) => {
    expect(h.onMessage(msg, from, resolve)).toBe(true);
  });
const postCall = (h: Harness): [string, { headers: Record<string, string>; body: string; method: string }] =>
  h.fetchMock.mock.calls.find((c) => String(c[0]).startsWith("http://")) as [string, { headers: Record<string, string>; body: string; method: string }];

let h: Harness;
beforeEach(() => {
  h = load();
});

describe("service worker: start (§3-1)", () => {
  it("injects picker.js into the top frame only, then starts it with the generated tokens followed by the rules", async () => {
    await h.onClicked({ id: 7 });
    const [first, second] = h.chrome.scripting.executeScript.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(first).toEqual({ target: { tabId: 7 }, files: ["picker.js"] });
    expect((second.target as Record<string, unknown>).allFrames).toBeUndefined();
    expect(second.args).toEqual([":host{--pick-x:1}\n.frame{}"]);
    expect(h.chrome.action.setBadgeText).not.toHaveBeenCalled();
  });

  it("puts × on the badge when the page cannot be scripted (chrome:// and the like)", async () => {
    h.chrome.scripting.executeScript.mockRejectedValue(new Error("Cannot access a chrome:// URL"));
    await h.onClicked({ id: 7 });
    expect(h.chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "msg:badgeError" });
  });
});

describe("service worker: sending a pick (§3-1, K6)", () => {
  it("POSTs to the app's own port with the token in the header only, JSON, no cookies", async () => {
    expect(await send(h)).toEqual({ status: "sent" });
    const [url, init] = postCall(h);
    expect(url).toBe(`http://127.0.0.1:${PORT}/api/picks`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-ac-picker-token": TOKEN });
    expect(init.body).not.toContain(TOKEN);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.url).toBe("https://example.com/");
    expect(body.imageBase64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64"));
    expect((init as unknown as { credentials: string }).credentials).toBe("omit");
  });

  it.each([
    [201, "sent"],
    [403, "forbidden"],
    [400, "error"],
    [500, "error"],
  ])("maps HTTP %i to %s", async (status, expected) => {
    h.fetchMock.mockImplementation(async (url: string) => (String(url).startsWith("http://") ? { status } : { text: async () => "", blob: async () => ({}) }));
    expect(await send(h)).toEqual({ status: expected });
  });

  it("answers notRunning when the app cannot be reached", async () => {
    h.fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).startsWith("http://")) return { text: async () => "", blob: async () => ({}) };
      throw new TypeError("Failed to fetch");
    });
    expect(await send(h)).toEqual({ status: "notRunning" });
  });

  it("sends without an image and says why when the screenshot cannot be taken", async () => {
    h = load({ captureFails: true });
    expect(await send(h)).toEqual({ status: "sent" });
    const body = JSON.parse(postCall(h)[1].body) as Record<string, unknown>;
    expect(body.imageBase64).toBeUndefined();
    expect(String(body.imageError)).toContain("captureVisibleTab failed");
  });

  it("sends without an image when the crop is over 1MiB", async () => {
    h = load({ png: new Uint8Array(1024 * 1024 + 1) });
    await send(h);
    const body = JSON.parse(postCall(h)[1].body) as Record<string, unknown>;
    expect(body.imageBase64).toBeUndefined();
    expect(body.imageError).toBe("image is too large");
  });

  it("sends without an image when the part is outside what is visible", async () => {
    await send(h, { type: "pick", payload: { ...payload, rect: { x: 5000, y: 5000, w: 10, h: 10 } } });
    const body = JSON.parse(postCall(h)[1].body) as Record<string, unknown>;
    expect(body.imageBase64).toBeUndefined();
    expect(String(body.imageError)).toMatch(/outside/);
  });

  it("crops only the part's own area when it sticks out of the visible area on the left or top", async () => {
    canvases.length = 0;
    await send(h, { type: "pick", payload: { ...payload, rect: { x: -100, y: -10, w: 300, h: 50 } } });
    expect(canvases).toEqual([{ w: 200, h: 40 }]);
    canvases.length = 0;
    await send(h, { type: "pick", payload: { ...payload, rect: { x: 900, y: 780, w: 300, h: 50 } } });
    expect(canvases).toEqual([{ w: 100, h: 20 }]);
  });

  it("ignores messages that are not a pick or do not come from a tab", () => {
    expect(h.onMessage({ type: "other" }, sender, () => undefined)).toBe(false);
    expect(h.onMessage({ type: "pick", payload }, {}, () => undefined)).toBe(false);
    expect(h.onMessage(null, sender, () => undefined)).toBe(false);
  });
});
