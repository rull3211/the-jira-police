import { describe, expect, it } from "vitest";

import { interruptibleSleep, nextDelayMs, runLoop } from "./loop.ts";

const INTERVAL = 1000;
const CAP = 60_000;

describe("nextDelayMs", () => {
  it("uses the plain interval after a success", () => {
    expect(nextDelayMs(0, INTERVAL, CAP)).toBe(INTERVAL);
  });

  it("doubles for each consecutive failure", () => {
    expect(nextDelayMs(1, INTERVAL, CAP)).toBe(2000);
    expect(nextDelayMs(2, INTERVAL, CAP)).toBe(4000);
    expect(nextDelayMs(3, INTERVAL, CAP)).toBe(8000);
  });

  it("never exceeds the cap", () => {
    expect(nextDelayMs(20, INTERVAL, CAP)).toBe(CAP);
  });

  it("survives an exponent large enough to overflow to Infinity", () => {
    // 2 ** 1100 is Infinity; without the cap this would be an infinite wait.
    expect(nextDelayMs(1100, INTERVAL, CAP)).toBe(CAP);
  });
});

/** Records what it was asked to wait for, without waiting. */
function recordingSleep(waits: number[]) {
  return async (ms: number): Promise<void> => {
    waits.push(ms);
  };
}

describe("runLoop", () => {
  it("does not run a cycle when it starts already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let cycles = 0;

    const summary = await runLoop({
      runCycle: async () => {
        cycles += 1;
      },
      intervalMs: INTERVAL,
      backoffCapMs: CAP,
      signal: controller.signal,
      sleep: recordingSleep([]),
    });

    expect(cycles).toBe(0);
    expect(summary).toEqual({ cycles: 0, failures: 0 });
  });

  it("runs until shutdown and reports what it did", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    let cycles = 0;

    const summary = await runLoop({
      runCycle: async () => {
        cycles += 1;
        if (cycles === 3) {
          controller.abort();
        }
      },
      intervalMs: INTERVAL,
      backoffCapMs: CAP,
      signal: controller.signal,
      sleep: recordingSleep(waits),
    });

    expect(summary).toEqual({ cycles: 3, failures: 0 });
    // No trailing sleep: shutdown during a cycle should not be followed by a
    // wait the caller then has to sit through.
    expect(waits).toEqual([INTERVAL, INTERVAL]);
  });

  it("keeps going after a failed cycle, backing off as it does", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    let cycles = 0;

    const summary = await runLoop({
      runCycle: async () => {
        cycles += 1;
        if (cycles === 3) {
          controller.abort();
        }
        if (cycles < 3) {
          throw new Error("Jira is down");
        }
      },
      intervalMs: INTERVAL,
      backoffCapMs: CAP,
      signal: controller.signal,
      sleep: recordingSleep(waits),
    });

    expect(summary).toEqual({ cycles: 3, failures: 2 });
    expect(waits).toEqual([2000, 4000]);
  });

  it("resets the backoff once a cycle succeeds", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    const outcomes = [false, false, true, true];
    let index = 0;

    await runLoop({
      runCycle: async () => {
        const ok = outcomes[index] ?? true;
        index += 1;
        if (index >= outcomes.length) {
          controller.abort();
        }
        if (!ok) {
          throw new Error("transient");
        }
      },
      intervalMs: INTERVAL,
      backoffCapMs: CAP,
      signal: controller.signal,
      sleep: recordingSleep(waits),
    });

    expect(waits).toEqual([2000, 4000, INTERVAL]);
  });
});

describe("interruptibleSleep", () => {
  it("returns early when aborted rather than throwing", async () => {
    const controller = new AbortController();
    const started = Date.now();

    const waited = interruptibleSleep(60_000, controller.signal);
    controller.abort();

    await expect(waited).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("resolves normally when it is not interrupted", async () => {
    await expect(interruptibleSleep(1, new AbortController().signal)).resolves.toBeUndefined();
  });
});
