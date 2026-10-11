import { describe, expect, it } from "vitest";
import { startPolling } from "../../server/poll.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startPolling", () => {
  it("never runs the task concurrently even when it is slower than the interval", async () => {
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    const stop = startPolling(
      async () => {
        running += 1;
        runs += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(40);
        running -= 1;
      },
      5,
      () => undefined,
    );
    await sleep(250);
    stop();
    expect(maxRunning).toBe(1);
    expect(runs).toBeGreaterThan(2);
  });

  it("reports errors, keeps polling, and does not throw", async () => {
    const errors: unknown[] = [];
    let runs = 0;
    const stop = startPolling(
      async () => {
        runs += 1;
        throw new Error("boom");
      },
      5,
      (e) => errors.push(e),
    );
    await sleep(100);
    stop();
    expect(runs).toBeGreaterThan(2);
    expect(errors.length).toBe(runs);
  });

  it("stops scheduling after stop()", async () => {
    let runs = 0;
    const stop = startPolling(async () => void (runs += 1), 5, () => undefined);
    await sleep(40);
    stop();
    const after = runs;
    await sleep(60);
    expect(runs).toBe(after);
  });
});
