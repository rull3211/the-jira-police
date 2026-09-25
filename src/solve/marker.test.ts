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
    reviewerCount: 3,
    failedStarts: 0,
    landed: 3,
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
    // Same author as ours, since `gh` posts as the operator; only the prefix distinguishes them.
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
    const empty = marker({ count: 0, reviewerCount: 0, landed: 0, rounds: [] });
    expect(parseMarker(renderMarker(empty))).toEqual({ outcome: "parsed", marker: empty });
  });

  it("puts the count and the high-water mark where a human reads first", () => {
    const lines = renderMarker(marker()).split("\n");
    expect(lines[0]).toBe("bot: iteration count 3");
    expect(lines[1]).toBe("Last read: 2026-09-05T10:22:31Z");
  });

  it("writes the reviewer count after the high-water mark, not before it", () => {
    // The first two lines are read positionally; inserting above them would make older markers unreadable.
    const lines = renderMarker(marker({ reviewerCount: 2 })).split("\n");
    expect(lines[2]).toBe("Reviewer rounds: 2");
  });

  it("appends the attempt count rather than inserting it", () => {
    // New fields go at the end of the header block, same rule as the reviewer count above.
    const lines = renderMarker(marker({ reviewerCount: 2, failedStarts: 1 })).split("\n");
    expect(lines[2]).toBe("Reviewer rounds: 2");
    expect(lines[3]).toBe("Failed starts: 1");
  });

  it("says nothing at all when nothing has gone wrong", () => {
    // A healthy pull request's marker should not carry a line reporting that nothing failed.
    expect(renderMarker(marker({ failedStarts: 0 }))).not.toContain("Failed starts");
  });

  it("round-trips a marker whose rounds were not all the reviewer's", () => {
    const mixed = marker({ count: 5, reviewerCount: 2 });
    expect(parseMarker(renderMarker(mixed))).toEqual({ outcome: "parsed", marker: mixed });
  });

  it("round-trips a marker whose newest round has not landed", () => {
    const reserved = marker({ count: 4, reviewerCount: 4, landed: 3 });
    expect(parseMarker(renderMarker(reserved))).toEqual({ outcome: "parsed", marker: reserved });
  });

  it("writes the last landed round even when every round landed", () => {
    // Omitted when equal to the count, an absent line could mean "all landed" or "written before this existed".
    expect(renderMarker(marker({ count: 3, landed: 3 }))).toContain("\nLast landed: 3\n");
  });
});

describe("parseMarker", () => {
  it("reads back a marker written by an earlier process", () => {
    // Predates the reviewer count and the landed round; each missing line reads as `count`.
    const result = parseMarker(
      "bot: iteration count 2\nLast read: 2026-09-05T10:22:31Z\n\n- narrowed the type\n- split the helper",
    );
    expect(result).toEqual({
      outcome: "parsed",
      marker: {
        count: 2,
        reviewerCount: 2,
        failedStarts: 0,
        landed: 2,
        lastRead: "2026-09-05T10:22:31Z",
        rounds: ["narrowed the type", "split the helper"],
      },
    });
  });

  it("reads a missing attempt count as none rather than refusing", () => {
    // Opposite reading from an unreadable round count: an absent attempt line means the pull request has never failed to start.
    const result = parseMarker("bot: iteration count 2\nLast read: 2026-09-05T10:22:31Z");
    expect(result.outcome === "parsed" && result.marker.failedStarts).toBe(0);
  });

  it("reads the attempt count back out of a marker that carries one", () => {
    const result = parseMarker(
      "bot: iteration count 2\nLast read: 2026-09-05T10:22:31Z\nFailed starts: 3",
    );
    expect(result.outcome === "parsed" && result.marker.failedStarts).toBe(3);
  });

  it("refuses an attempt count it cannot read, and does not read it as zero", () => {
    // Zero is right for an absent line but wrong for one present and mangled.
    expect(
      unreadable("bot: iteration count 2\nLast read: 2026-09-05T10:00:00Z\nFailed starts: three"),
    ).toContain("not a whole number");
  });

  it("keeps the attempt count across a round trip", () => {
    const parsed = parseMarker(renderMarker(marker({ failedStarts: 2 })));
    expect(parsed.outcome === "parsed" && parsed.marker.failedStarts).toBe(2);
  });

  it("keeps the instant exactly as it was written", () => {
    // Re-rendering a Date would rewrite the format every round and turn marker diffs into noise.
    const result = parseMarker("bot: iteration count 1\nLast read: 2026-09-05T10:22:31.482Z");
    expect(result.outcome === "parsed" && result.marker.lastRead).toBe("2026-09-05T10:22:31.482Z");
  });

  it("refuses a comment that is not the marker", () => {
    expect(unreadable("Looks good to me")).toContain("does not begin with the marker line");
  });

  it("refuses a count that is not a whole number of rounds, and does not read it as zero", () => {
    // An unreadable marker read as zero would silently turn a bounded loop into an unbounded one.
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
    // Without one the cursor cannot tell a new comment from an old one.
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

  it("reads a missing reviewer line as every round, not as none of them", () => {
    // Reading a pre-split marker's rounds as human would hand back the whole budget on every open pull request.
    const result = parseMarker("bot: iteration count 4\nLast read: 2026-09-05T10:00:00Z");
    expect(result.outcome === "parsed" && result.marker.reviewerCount).toBe(4);
  });

  it("finds the reviewer line wherever it sits, since only two lines are positional", () => {
    const result = parseMarker(
      "bot: iteration count 3\nLast read: 2026-09-05T10:00:00Z\n\n- narrowed the type\n\nReviewer rounds: 1",
    );
    expect(result.outcome === "parsed" && result.marker.reviewerCount).toBe(1);
  });

  it("refuses a reviewer count that is not a whole number, and does not read it as zero", () => {
    // Zero here would be a fresh reviewer budget on a pull request that already spent one.
    expect(
      unreadable("bot: iteration count 3\nLast read: 2026-09-05T10:00:00Z\nReviewer rounds: two"),
    ).toContain("not a whole number of reviewer rounds");
    expect(
      unreadable("bot: iteration count 3\nLast read: 2026-09-05T10:00:00Z\nReviewer rounds: -1"),
    ).toContain("not a whole number of reviewer rounds");
  });

  it("refuses a reviewer count too large to be one", () => {
    expect(
      unreadable(
        "bot: iteration count 3\nLast read: 2026-09-05T10:00:00Z\nReviewer rounds: 99999999999999999999",
      ),
    ).toContain("too large");
  });

  it("refuses more reviewer rounds than rounds rather than clamping them", () => {
    // Clamping with min(a, b) is tempting and wrong: a marker in this state was edited by something that did not understand it.
    expect(
      unreadable("bot: iteration count 2\nLast read: 2026-09-05T10:00:00Z\nReviewer rounds: 3"),
    ).toContain("3 reviewer rounds out of 2 rounds");
  });

  it("reads a missing last-landed line as every round landed", () => {
    // An older marker never recorded a landing; reading its rounds as failed would hold correct handovers in draft.
    const result = parseMarker("bot: iteration count 4\nLast read: 2026-09-05T10:00:00Z");
    expect(result.outcome === "parsed" && result.marker.landed).toBe(4);
  });

  it("refuses a last landed round that is not a whole number, rather than reading it as landed", () => {
    expect(
      unreadable("bot: iteration count 3\nLast read: 2026-09-05T10:00:00Z\nLast landed: two"),
    ).toContain("not a whole round number");
    expect(
      unreadable(
        "bot: iteration count 3\nLast read: 2026-09-05T10:00:00Z\nLast landed: 99999999999999999999",
      ),
    ).toContain("too large");
  });

  it("refuses a landed round the marker never reserved rather than clamping it", () => {
    expect(
      unreadable("bot: iteration count 2\nLast read: 2026-09-05T10:00:00Z\nLast landed: 3"),
    ).toContain("round 3 landed out of 2 rounds");
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
    // Choosing one would orphan the other and hide that something already went wrong.
    const result = findMarker([at(MARKER, "IC_1"), at(MARKER, "IC_2")]);

    expect(result).toMatchObject({ outcome: "unusable" });
    expect(result.outcome === "unusable" ? result.reason : "").toContain("2 marker comments");
  });

  it("refuses a marker with no node id rather than reading it as absent", () => {
    // Reading it as absent would post a second marker immediately and report nothing.
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
    // Strictly newer: a comment at the recorded instant was already read, so treating it as fresh would re-handle it every tick.
    expect(isNewer("2026-09-05T10:22:31Z", "2026-09-05T10:22:31Z")).toBe(false);
  });

  it("is false for a comment older than the mark", () => {
    expect(isNewer("2026-09-05T09:00:00Z", "2026-09-05T10:22:31Z")).toBe(false);
  });

  it("compares instants rather than strings", () => {
    // Same moment in two offsets; a lexical comparison would call the first one newer.
    expect(isNewer("2026-09-05T11:22:31+01:00", "2026-09-05T10:22:31Z")).toBe(false);
  });

  it("treats an unreadable timestamp on either side as new", () => {
    // Not symmetric: re-reading a comment costs a round, dropping one loses a request silently.
    expect(isNewer("who knows", "2026-09-05T10:22:31Z")).toBe(true);
    expect(isNewer("2026-09-05T10:22:31Z", "who knows")).toBe(true);
  });
});
