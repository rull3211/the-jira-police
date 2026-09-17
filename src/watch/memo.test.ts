import { describe, expect, it } from "vitest";

import { createWatchMemo } from "./memo.ts";

const MONDAY = Date.parse("2026-09-01T10:00:00.000+0200");
const TUESDAY = Date.parse("2026-09-02T10:00:00.000+0200");

describe("what the memo stops the watch paying for twice", () => {
  it("skips activity it has already paid to decline", () => {
    // A `no` writes nothing to the ticket, so without this the daemon buys the
    // same refusal every sweep until somebody speaks.
    const memo = createWatchMemo();
    memo.declined("SSX-1234", MONDAY);

    expect(memo.seen("SSX-1234", MONDAY)).toBe(true);
  });

  it("does not skip when something newer has arrived", () => {
    // The unrecoverable direction: get this wrong and a genuine later answer
    // is never read, silently, for as long as the ticket stays subscribed.
    const memo = createWatchMemo();
    memo.declined("SSX-1234", MONDAY);

    expect(memo.seen("SSX-1234", TUESDAY)).toBe(false);
  });

  it("treats the same instant as the same activity", () => {
    // A strict `<` here would disable the memo entirely: it would re-ask every
    // sweep on exactly the tickets whose newest foreign item never moves.
    const memo = createWatchMemo();
    memo.declined("SSX-1234", MONDAY);

    expect(memo.seen("SSX-1234", MONDAY)).toBe(true);
    expect(memo.seen("SSX-1234", MONDAY - 1)).toBe(true);
  });

  it("knows nothing about a ticket it has not declined", () => {
    const memo = createWatchMemo();
    memo.declined("SSX-1234", MONDAY);

    expect(memo.seen("SSX-9999", MONDAY)).toBe(false);
  });

  it("never skips activity it cannot date", () => {
    // Fails towards spending: a skip here is silent and permanent, a check is cents.
    const memo = createWatchMemo();
    memo.declined("SSX-1234", MONDAY);

    expect(memo.seen("SSX-1234", Number.NaN)).toBe(false);
  });

  it("does not remember an undatable decline as anything", () => {
    // Storing `NaN` would be a no-op that looks like a bound; dropping it is
    // the same outcome and legible in `size()`.
    const memo = createWatchMemo();
    memo.declined("SSX-1234", Number.NaN);

    expect(memo.size()).toBe(0);
    expect(memo.seen("SSX-1234", MONDAY)).toBe(false);
  });

  it("keeps the newest decline rather than the first", () => {
    const memo = createWatchMemo();
    memo.declined("SSX-1234", MONDAY);
    memo.declined("SSX-1234", TUESDAY);

    expect(memo.seen("SSX-1234", TUESDAY)).toBe(true);
    expect(memo.size()).toBe(1);
  });

  it("starts empty, so a fresh one is a run that has judged nothing", () => {
    // `watch:once` builds one of these per invocation, so a hand run must look
    // at what the operator pointed it at, not an earlier process's decision.
    expect(createWatchMemo().seen("SSX-1234", MONDAY)).toBe(false);
  });
});
