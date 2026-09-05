import { describe, expect, it } from "vitest";

import {
  BOT_PREFIX,
  findMarker,
  isMarker,
  isNewer,
  isOurs,
  type Marker,
  MARKER_PREFIX,
  parseMarker,
  renderMarker,
} from "./marker.ts";

function marker(overrides: Partial<Marker> = {}): Marker {
  return {
    count: 3,
    lastRead: "2026-09-05T10:22:31Z",
    rounds: ["narrowed the type", "answered without changing code", "split the helper"],
    ...overrides,
  };
}

/** Shorthand for the failure branch, which every parse test in here asserts on. */
function unreadable(body: string): string {
  const result = parseMarker(body);
  expect(result.outcome).toBe("unreadable");
  return result.outcome === "unreadable" ? result.reason : "";
}

describe("isOurs", () => {
  it("recognises a comment by its prefix rather than by who posted it", () => {
    expect(isOurs(`${BOT_PREFIX}iteration count 1\nLast read: 2026-09-05T10:00:00Z`)).toBe(true);
  });

  it("treats a human's comment as somebody else's", () => {
    // The whole reason the prefix exists. `gh` is authenticated as the
    // operator, so this comment and the one above have the same author.
    expect(isOurs("This still leaks on the error path.")).toBe(false);
  });

  it("does not claim a comment that only mentions the prefix", () => {
    expect(isOurs("I think bot: iteration count is a good idea")).toBe(false);
  });
});

describe("isMarker", () => {
  it("separates the marker from our other comments", () => {
    expect(isMarker(`${BOT_PREFIX}replied on three threads`)).toBe(false);
    expect(isMarker(`${MARKER_PREFIX}2\nLast read: 2026-09-05T10:00:00Z`)).toBe(true);
  });
});

describe("renderMarker", () => {
  it("round-trips", () => {
    const parsed = parseMarker(renderMarker(marker()));
    expect(parsed).toEqual({ outcome: "parsed", marker: marker() });
  });

  it("round-trips a marker with no rounds on it yet", () => {
    const empty = marker({ count: 0, rounds: [] });
    expect(parseMarker(renderMarker(empty))).toEqual({ outcome: "parsed", marker: empty });
  });

  it("puts the count and the high-water mark where a human reads first", () => {
    const lines = renderMarker(marker()).split("\n");
    expect(lines[0]).toBe("bot: iteration count 3");
    expect(lines[1]).toBe("Last read: 2026-09-05T10:22:31Z");
  });
});

describe("parseMarker", () => {
  it("reads back a marker written by an earlier process", () => {
    const result = parseMarker(
      "bot: iteration count 2\nLast read: 2026-09-05T10:22:31Z\n\n- narrowed the type\n- split the helper",
    );
    expect(result).toEqual({
      outcome: "parsed",
      marker: {
        count: 2,
        lastRead: "2026-09-05T10:22:31Z",
        rounds: ["narrowed the type", "split the helper"],
      },
    });
  });

  it("keeps the instant exactly as it was written", () => {
    // Re-rendering a Date would rewrite the format on every round and turn the
    // diff between two markers into noise.
    const result = parseMarker("bot: iteration count 1\nLast read: 2026-09-05T10:22:31.482Z");
    expect(result.outcome === "parsed" && result.marker.lastRead).toBe("2026-09-05T10:22:31.482Z");
  });

  it("refuses a comment that is not the marker", () => {
    expect(unreadable("Looks good to me")).toContain("does not begin with the marker line");
  });

  it("refuses a count that is not a whole number of rounds, and does not read it as zero", () => {
    // The mutation that matters most in this file. An unreadable marker read as
    // zero is how a bounded loop becomes an unbounded one, silently, on the one
    // pull request whose marker got mangled.
    expect(unreadable("bot: iteration count three\nLast read: 2026-09-05T10:00:00Z")).toContain(
      "not a whole number",
    );
    expect(unreadable("bot: iteration count 2.5\nLast read: 2026-09-05T10:00:00Z")).toContain(
      "not a whole number",
    );
    expect(unreadable("bot: iteration count -1\nLast read: 2026-09-05T10:00:00Z")).toContain(
      "not a whole number",
    );
    expect(unreadable("bot: iteration count \nLast read: 2026-09-05T10:00:00Z")).toContain(
      "not a whole number",
    );
  });

  it("refuses a count too large to be a round count", () => {
    expect(
      unreadable(`bot: iteration count 99999999999999999999\nLast read: 2026-09-05T10:00:00Z`),
    ).toContain("too large");
  });

  it("refuses a marker with no high-water mark", () => {
    // A marker without one is a cursor that cannot tell a new comment from an
    // old one, which is the whole thing it exists to do.
    expect(unreadable("bot: iteration count 3")).toContain("no high-water mark");
    expect(unreadable("bot: iteration count 3\n\n- narrowed the type")).toContain(
      "no high-water mark",
    );
  });

  it("refuses a high-water mark that is not an instant", () => {
    expect(unreadable("bot: iteration count 3\nLast read: yesterday")).toContain(
      "not a readable instant",
    );
  });

  it("keeps only the round lines, so trailing prose cannot become a round", () => {
    const result = parseMarker(
      "bot: iteration count 1\nLast read: 2026-09-05T10:00:00Z\n\n- narrowed the type\n\nedited by hand",
    );
    expect(result.outcome === "parsed" && result.marker.rounds).toEqual(["narrowed the type"]);
  });
});

const at = (body: string, id = "IC_1"): { body: string; id: string } => ({ body, id });

describe("findMarker", () => {
  const MARKER = "bot: iteration count 2\nLast read: 2026-09-05T10:00:00Z";

  it("finds the marker among ordinary comments", () => {
    const mine = at(MARKER);
    const result = findMarker([at("Looks good", "IC_0"), mine, at("bot: replied", "IC_2")]);

    expect(result).toEqual({ outcome: "found", comment: mine });
  });

  it("reports no marker on a pull request that has never had a round", () => {
    expect(findMarker([at("Looks good", "IC_0")])).toEqual({ outcome: "absent" });
  });

  it("refuses two markers rather than picking one", () => {
    // Picking the higher count would resume from one and orphan the other, and
    // the reason there are two is that something already went wrong. A loop
    // that repairs it by choosing has stopped being able to report it.
    const result = findMarker([at(MARKER, "IC_1"), at(MARKER, "IC_2")]);

    expect(result).toMatchObject({ outcome: "unusable" });
    expect(result.outcome === "unusable" ? result.reason : "").toContain("2 marker comments");
  });

  it("refuses a marker with no node id rather than reading it as absent", () => {
    // Absent is the tempting shortcut and the worst of the three: it posts a
    // second marker immediately and reports nothing.
    const result = findMarker([at(MARKER, "")]);

    expect(result).toMatchObject({ outcome: "unusable" });
    expect(result.outcome === "unusable" ? result.reason : "").toContain("node id");
  });
});

describe("isNewer", () => {
  it("is true for a comment posted after the last round read", () => {
    expect(isNewer("2026-09-05T10:22:32Z", "2026-09-05T10:22:31Z")).toBe(true);
  });

  it("is false at exactly the high-water mark", () => {
    // Strictly newer, and this is the off-by-one the cursor exists to close: a
    // comment created at the recorded instant was the newest thing the last
    // round read, so treating it as fresh re-handles it every tick forever.
    expect(isNewer("2026-09-05T10:22:31Z", "2026-09-05T10:22:31Z")).toBe(false);
  });

  it("is false for a comment older than the mark", () => {
    expect(isNewer("2026-09-05T09:00:00Z", "2026-09-05T10:22:31Z")).toBe(false);
  });

  it("compares instants rather than strings", () => {
    // The same moment in two offsets. A lexical comparison calls the first one
    // newer and drops a real comment.
    expect(isNewer("2026-09-05T11:22:31+01:00", "2026-09-05T10:22:31Z")).toBe(false);
  });

  it("treats an unreadable timestamp on either side as new", () => {
    // Not symmetric: re-reading a comment costs a round, dropping one loses a
    // reviewer's request with nothing saying so.
    expect(isNewer("who knows", "2026-09-05T10:22:31Z")).toBe(true);
    expect(isNewer("2026-09-05T10:22:31Z", "who knows")).toBe(true);
  });
});
