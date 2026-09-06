import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NEWS_MARK, QUIET_MARK, logger } from "./logger.ts";

/**
 * Captures what actually reached the stream, parsed back the way a reader would.
 *
 * Deliberately reads the written string rather than spying on `emit`: the two
 * properties under test here are *what the JSON looks like* and *which stream it
 * went to*, and neither is observable from inside.
 */
function capture(): {
  readonly out: string[];
  readonly err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

/** The one line written, parsed. Fails loudly rather than returning `undefined`. */
function onlyLine(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}

describe("logger", () => {
  const savedLevel = process.env["LOG_LEVEL"];

  beforeEach(() => {
    process.env["LOG_LEVEL"] = "debug";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedLevel === undefined) {
      delete process.env["LOG_LEVEL"];
    } else {
      process.env["LOG_LEVEL"] = savedLevel;
    }
  });

  it("marks a line news when nobody said otherwise", () => {
    // The fail-safe direction, and the mutation that matters most in this file:
    // flip the default to quiet and every call site nobody has classified — 130
    // of them today — disappears into the noise pile at once.
    const { out } = capture();

    logger.info("solve.pr.opened", { number: 2663 });

    expect(onlyLine(out)["q"]).toBe(NEWS_MARK);
  });

  it("marks a line quiet only when the call site asks", () => {
    const { out } = capture();

    logger.info("review.cycle", { watched: 5 }, { quiet: true });

    expect(onlyLine(out)["q"]).toBe(QUIET_MARK);
  });

  it("treats `quiet: false` as news, not as an absent option", () => {
    // `isQuietCycle(...)` is passed straight in, so `false` is the commonest way
    // a call site says "news" and must not be read as "unspecified" by some
    // future truthiness check that only looks for the key.
    const { out } = capture();

    logger.info("review.cycle", { watched: 5 }, { quiet: false });

    expect(onlyLine(out)["q"]).toBe(NEWS_MARK);
  });

  it("puts the mark first, so a person can run their eye down one column", () => {
    // The whole reason it is a field and not a prefix: the line stays one
    // `JSON.parse`, and the emoji still lands at a fixed offset. Move `q` after
    // `ts` and it is at a column that moves with the timestamp's length.
    const { out } = capture();

    logger.info("poll.done", { triaged: 1 });

    expect(Object.keys(onlyLine(out))).toEqual(["q", "ts", "level", "message", "triaged"]);
  });

  it("stays valid JSON with the emoji in it", () => {
    // The mark buys a human something and must cost the machine nothing —
    // `jq 'select(.q=="⏳")'` is half the point of putting it on a key.
    const { out } = capture();

    logger.info("review.cycle", { watched: 5 }, { quiet: true });

    const line = out[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(line)).toMatchObject({ q: QUIET_MARK, level: "info", watched: 5 });
  });

  it("keeps the mark when a field is called `q`, and keeps the field too", () => {
    // Nobody passes this today. The reason it is guarded is `WatchSweepOutcome`,
    // which has a numeric member named `quiet` that `watch-loop.ts` spreads
    // wholesale into its fields — a payload arriving under a name the logger
    // cares about is a thing that has already happened once.
    const { out } = capture();

    logger.info("watch.cycle.done", { q: 3 }, { quiet: true });

    const line = onlyLine(out);
    expect(line["q"]).toBe(QUIET_MARK);
    expect(line["_q"]).toBe(3);
  });

  it("marks warnings and errors as news whatever they ask for", () => {
    // Not a rule in `emit` — it is the default doing its job. The test exists
    // because a future reader might add `{ quiet: true }` to a warning, and
    // this records that the answer is to delete the warning instead.
    const { err } = capture();

    logger.warn("poll.interrupted", { abandoned: 2 });

    expect(onlyLine(err)["q"]).toBe(NEWS_MARK);
  });

  it("still routes by level, and the mark does not change the stream", () => {
    // The mark is about attention, the stream is about severity. A quiet error
    // is still an error and still goes to stderr.
    const { out, err } = capture();

    logger.error("poll.issue_failed", {}, { quiet: true });

    expect(out).toHaveLength(0);
    expect(onlyLine(err)["q"]).toBe(QUIET_MARK);
  });

  it("still drops a line below the threshold, mark and all", () => {
    process.env["LOG_LEVEL"] = "warn";
    const { out } = capture();

    logger.info("solve.query", { jql: "project = SSX" });

    expect(out).toHaveLength(0);
  });

  it("still serialises an `error` field, which the mark must not have displaced", () => {
    const { err } = capture();

    logger.error("solve.claim.failed", { error: new Error("nope") });

    expect(onlyLine(err)["error"]).toMatchObject({ name: "Error", message: "nope" });
  });
});
