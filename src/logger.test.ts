import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NEWS_MARK, QUIET_MARK, createLogger } from "./logger.ts";

/** Captures the raw written string rather than spying on `emit`, since JSON shape and stream choice aren't observable from inside. */
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
  const log = createLogger("solve");

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
    // Guards the fail-safe default: flip it to quiet and every unclassified call site
    // disappears into the noise pile at once.
    const { out } = capture();

    log.info("solve.pr.opened", { number: 2663 });

    expect(onlyLine(out)["q"]).toBe(NEWS_MARK);
  });

  it("marks a line quiet only when the call site asks", () => {
    const { out } = capture();

    log.info("review.cycle", { watched: 5 }, { quiet: true });

    expect(onlyLine(out)["q"]).toBe(QUIET_MARK);
  });

  it("treats `quiet: false` as news, not as an absent option", () => {
    // `false` must not be read as "unspecified" by a future truthiness check on the key.
    const { out } = capture();

    log.info("review.cycle", { watched: 5 }, { quiet: false });

    expect(onlyLine(out)["q"]).toBe(NEWS_MARK);
  });

  it("puts the mark first, so a person can run their eye down one column", () => {
    // Must stay first: after `ts` it would land at a column that moves with the timestamp's length.
    const { out } = capture();

    log.info("poll.done", { triaged: 1 });

    expect(Object.keys(onlyLine(out))).toEqual(["q", "ts", "level", "src", "message", "triaged"]);
  });

  it("names the source it was created with, before the message", () => {
    // `src` is what the viewer's source filter reads; ahead of `message` so both sit in fixed columns.
    const { out } = capture();

    createLogger("watch").info("watch.sweep.done", { watched: 5 });

    expect(onlyLine(out)["src"]).toBe("watch");
  });

  it("returns the same instance for a source, so a spy catches what a module holds", () => {
    // Modules call `createLogger` at import time; a fresh object per call would make every
    // existing `vi.spyOn(createLogger(…), …)` silently observe nothing.
    expect(createLogger("solve")).toBe(createLogger("solve"));
    expect(createLogger("solve")).not.toBe(createLogger("watch"));
  });

  it("keeps the source when a field is called `src`, and keeps the field too", () => {
    // Same shape as the `q` collision below. A spread field overwriting `src` would make the
    // viewer's filter hide the line under a source that never emitted it.
    const { out } = capture();

    log.info("solve.pr.opened", { src: "elsewhere" });

    const line = onlyLine(out);
    expect(line["src"]).toBe("solve");
    expect(line["_src"]).toBe("elsewhere");
  });

  it("stays valid JSON with the emoji in it", () => {
    // The mark must cost the machine nothing: still valid, `jq`-selectable JSON.
    const { out } = capture();

    log.info("review.cycle", { watched: 5 }, { quiet: true });

    const line = out[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(line)).toMatchObject({ q: QUIET_MARK, level: "info", watched: 5 });
  });

  it("keeps the mark when a field is called `q`, and keeps the field too", () => {
    // Guards against `WatchSweepOutcome`, whose `quiet` member `watch-loop.ts` spreads
    // wholesale into fields, colliding with the marker's own key.
    const { out } = capture();

    log.info("watch.cycle.done", { q: 3 }, { quiet: true });

    const line = onlyLine(out);
    expect(line["q"]).toBe(QUIET_MARK);
    expect(line["_q"]).toBe(3);
  });

  it("marks warnings and errors as news whatever they ask for", () => {
    // If a warning seems to need `{ quiet: true }`, delete the warning instead.
    const { err } = capture();

    log.warn("poll.interrupted", { abandoned: 2 });

    expect(onlyLine(err)["q"]).toBe(NEWS_MARK);
  });

  it("still routes by level, and the mark does not change the stream", () => {
    // The mark is about attention, the stream is about severity — a quiet error still goes to stderr.
    const { out, err } = capture();

    log.error("poll.issue_failed", {}, { quiet: true });

    expect(out).toHaveLength(0);
    expect(onlyLine(err)["q"]).toBe(QUIET_MARK);
  });

  it("still drops a line below the threshold, mark and all", () => {
    process.env["LOG_LEVEL"] = "warn";
    const { out } = capture();

    log.info("solve.query", { jql: "project = SSX" });

    expect(out).toHaveLength(0);
  });

  it("still serialises an `error` field, which the mark must not have displaced", () => {
    const { err } = capture();

    log.error("solve.claim.failed", { error: new Error("nope") });

    expect(onlyLine(err)["error"]).toMatchObject({ name: "Error", message: "nope" });
  });
});
