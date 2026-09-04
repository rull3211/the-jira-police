import { describe, expect, it, vi } from "vitest";

import { logger } from "../logger.ts";
import { SessionError, runSession, sessionCost } from "./session.ts";

/**
 * A real `result` event, trimmed to the fields this reads.
 *
 * The numbers are from an actual `storecode -p "say ok"` run on 2026-09-04 —
 * two input tokens, four output tokens, twelve cents. Kept verbatim rather than
 * rounded to something tidy, because the whole point of the shape is that the
 * cost is dominated by the 20k cache-creation tokens rather than by the work.
 */
const RESULT = {
  type: "result",
  subtype: "success",
  total_cost_usd: 0.12730375,
  duration_ms: 3123,
  num_turns: 1,
  usage: {
    input_tokens: 2,
    output_tokens: 4,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 20_351,
  },
} as const;

describe("sessionCost", () => {
  it("reads what a real run reported", () => {
    expect(sessionCost({ ...RESULT })).toStrictEqual({
      costUsd: 0.12730375,
      durationMs: 3123,
      turns: 1,
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 20_351,
    });
  });

  // The distinction the whole `number | null` shape exists for. A run that did
  // not say what it cost and a run that cost nothing are different facts, and
  // only one of them should be safe to add to a total.
  it("does not report an absent cost as a free one", () => {
    expect(sessionCost({ type: "result" }).costUsd).toBeNull();
    expect(sessionCost({ type: "result", total_cost_usd: 0 }).costUsd).toBe(0);
  });

  it("keeps a cache read of zero apart from no cache read at all", () => {
    expect(sessionCost({ usage: { cache_read_input_tokens: 0 } }).cacheReadTokens).toBe(0);
    expect(sessionCost({ usage: {} }).cacheReadTokens).toBeNull();
  });

  // `NaN` is a number, and one of these in a day's worth of runs would make the
  // whole day's total `NaN` rather than merely wrong by one run.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses %p, which would poison every sum it reached",
    (value) => {
      expect(sessionCost({ total_cost_usd: value }).costUsd).toBeNull();
    },
  );

  // Not coerced. A cost arriving as a string means the event shape changed, and
  // a silent `Number("0.12")` would hide that for as long as it kept working.
  it.each([["0.12"], [null], [undefined], [{}], [[]], [true]])(
    "reports %p as not reported rather than guessing at it",
    (value) => {
      expect(sessionCost({ total_cost_usd: value }).costUsd).toBeNull();
    },
  );

  // Telemetry attached to a verdict that has already been decided. If this can
  // throw, a malformed usage block turns a solve that worked into one that did
  // not — the tail wagging the dog.
  it.each([
    ["a missing usage block", { type: "result" }],
    ["a null usage block", { type: "result", usage: null }],
    ["a usage block that is not an object", { type: "result", usage: "lots" }],
    ["a usage array", { type: "result", usage: [] }],
    ["an empty event", {}],
  ])("cannot be made to throw by %s", (_label, event) => {
    expect(() => sessionCost(event as Record<string, unknown>)).not.toThrow();
  });

  it("reports every field as absent when the event says nothing", () => {
    expect(sessionCost({})).toStrictEqual({
      costUsd: null,
      durationMs: null,
      turns: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });
});

/**
 * A fake storecode: a node process that prints the events it was handed.
 *
 * Cheaper and more honest than mocking `spawn` — it exercises the real
 * line-buffered NDJSON reader, which is the part of `runSession` most likely to
 * be broken by a change to it. The cost of a real model run per assertion is
 * why nothing else in this file spawns anything.
 */
function fakeSession(events: readonly Record<string, unknown>[]) {
  const script = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  return {
    executable: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(script)})`],
    workingDirectory: process.cwd(),
    timeoutMs: 10_000,
    env: process.env,
    requiredMcpServers: [] as readonly string[],
    label: "fake pass of SSX-1234",
  };
}

describe("runSession cost reporting", () => {
  it("reports what the run cost", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    await expect(
      runSession(fakeSession([{ ...RESULT, structured_output: { ok: true } }]), () => "parsed"),
    ).resolves.toBe("parsed");

    expect(info).toHaveBeenCalledWith(
      "session.cost",
      expect.objectContaining({ label: "fake pass of SSX-1234", costUsd: 0.12730375, turns: 1 }),
    );
    info.mockRestore();
  });

  /**
   * The reason the log line sits above the success check rather than below it.
   *
   * A run that failed has already been paid for, and a total that silently
   * omitted every failure would look best on exactly the days that went worst —
   * the opposite of what a budget cap needs to be built on.
   */
  it("still reports the cost of a run that failed", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    await expect(
      runSession(
        fakeSession([
          { type: "result", subtype: "error_during_execution", total_cost_usd: 0.42, num_turns: 7 },
        ]),
        () => "parsed",
      ),
    ).rejects.toThrow(SessionError);

    expect(info).toHaveBeenCalledWith(
      "session.cost",
      expect.objectContaining({ costUsd: 0.42, turns: 7 }),
    );
    info.mockRestore();
  });
});
