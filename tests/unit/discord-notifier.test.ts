import { describe, expect, it, vi } from "vitest";
import { DiscordNotifier, NOTIFY_QUEUE_LIMIT, NOTIFY_RETRY_DELAYS_MS } from "../../server/discord-notifier.ts";

/** 偽のタイマー。fire() で一番早いものを発火させる */
function timers() {
  const pending: { f: () => void; ms: number; id: number }[] = [];
  let n = 0;
  return {
    setTimer: (f: () => void, ms: number) => { const id = ++n; pending.push({ f, ms, id }); return id; },
    clearTimer: (h: unknown) => { const i = pending.findIndex((p) => p.id === h); if (i >= 0) pending.splice(i, 1); },
    pending,
    fire: () => { const t = pending.shift(); t?.f(); return t?.ms; },
  };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const URL_FAKE = "https://discord.com/api/webhooks/100000000000000001/fake";

describe("DiscordNotifier", () => {
  it("retry delays are 30s / 2min / 10min", () => {
    expect(NOTIFY_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000]);
  });

  it("sends once on success", async () => {
    const t = timers();
    const send = vi.fn(async () => ({ ok: true }));
    const macos = vi.fn();
    new DiscordNotifier({ webhookUrl: URL_FAKE, send, macos, ...t }).notify("a");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(URL_FAKE, "a");
    expect(macos).not.toHaveBeenCalled();
    expect(t.pending).toHaveLength(0);
  });

  it("retries at 30s, 2min, 10min then falls back to macOS once", async () => {
    const t = timers();
    const send = vi.fn(async () => ({ ok: false }));
    const macos = vi.fn();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    new DiscordNotifier({ webhookUrl: URL_FAKE, send, macos, ...t }).notify("a");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    const waits: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) { waits.push(t.fire()); await flush(); }
    expect(waits).toEqual([30_000, 120_000, 600_000]);
    expect(send).toHaveBeenCalledTimes(4);
    expect(macos).toHaveBeenCalledTimes(1);
    expect(macos).toHaveBeenCalledWith("a");
    expect(err).toHaveBeenCalledWith("discord-notify: failed after retries");
    err.mockRestore();
  });

  it("does not call macOS when a retry succeeds", async () => {
    const t = timers();
    const send = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const macos = vi.fn();
    new DiscordNotifier({ webhookUrl: URL_FAKE, send, macos, ...t }).notify("a");
    await flush();
    t.fire();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(macos).not.toHaveBeenCalled();
  });

  it("goes straight to macOS when the URL is null", async () => {
    const t = timers();
    const send = vi.fn();
    const macos = vi.fn();
    new DiscordNotifier({ webhookUrl: null, send, macos, ...t }).notify("a");
    expect(macos).toHaveBeenCalledWith("a");
    expect(send).not.toHaveBeenCalled();
  });

  it("stop() cancels the retry timer and later sends", async () => {
    const t = timers();
    const send = vi.fn(async () => ({ ok: false }));
    const macos = vi.fn();
    const n = new DiscordNotifier({ webhookUrl: URL_FAKE, send, macos, ...t });
    n.notify("a");
    await flush();
    expect(t.pending).toHaveLength(1);
    n.stop();
    expect(t.pending).toHaveLength(0);
    n.notify("b");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(macos).not.toHaveBeenCalled();
  });

  it("sends one at a time, in order: the second waits for the first's retries", async () => {
    const t = timers();
    const send = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const macos = vi.fn();
    const n = new DiscordNotifier({ webhookUrl: URL_FAKE, send, macos, ...t });
    n.notify("one");
    n.notify("two");
    await flush();
    expect(send.mock.calls.map((c) => c[1])).toEqual(["one"]);
    t.fire();
    await flush();
    expect(send.mock.calls.map((c) => c[1])).toEqual(["one", "one", "two"]);
  });

  it("the 51st queued notification goes straight to macOS", async () => {
    const t = timers();
    const send = vi.fn(async () => ({ ok: false }));
    const macos = vi.fn();
    const n = new DiscordNotifier({ webhookUrl: URL_FAKE, send, macos, ...t });
    for (let i = 0; i < NOTIFY_QUEUE_LIMIT; i++) n.notify(`m${i}`);
    expect(macos).not.toHaveBeenCalled();
    n.notify("overflow");
    expect(macos).toHaveBeenCalledTimes(1);
    expect(macos).toHaveBeenCalledWith("overflow");
  });
});
