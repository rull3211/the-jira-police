import { describe, expect, it } from "vitest";

import { createWatchMemo } from "./memo.ts";

const MONDAY = Date.parse("2026-09-01T10:00:00.000+0200");
const TUESDAY = Date.parse("2026-09-02T10:00:00.000+0200");

describe("what the memo stops the watch paying for twice", () => {
  it("skips activity it has already paid to decline", () => {
    // The whole point. A `no` writes nothing to the ticket, so the trigger is
    // still there next sweep and the content is identical. Without this the
    // daemon buys the same refusal every six hours until somebody speaks.
    const memo = createWatchMemo();
    memo.declined("SSX-1234", MONDAY);

    expect(memo.seen("SSX-1234", MONDAY)).toBe(true);
  });

  it("does not skip when something newer has arrived", () => {
    // THE ONE THAT MATTERS, and the direction that is not recoverable: a
    // reporter who was told to add a baseline, said "I'll get to it" on Monday
    // and added it on Tuesday. Get this wrong and the answer this whole feature
    // exists to catch is never read — silently, and for as long as the ticket
    // stays subscribed.
    const memo = createWatchMemo();
    memo.declined("SSX-1234", MONDAY);

    expect(memo.seen("SSX-1234", TUESDAY)).toBe(false);
  });

  it("treats the same instant as the same activity", () => {
    // The mutation is `<` instead of `<=`. It looks more careful and it disables
    // the memo completely: the remembered instant *is* one that was judged, so
    // a strict comparison re-asks on every sweep for exactly the tickets whose
    // newest foreign item never moves — which is every ticket this exists for.
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
    // Fails towards spending, and it is the only place in this feature that
    // does. A skip is silent and permanent for that ticket; a check is cents.
    const memo = createWatchMemo();
    memo.declined("SSX-1234", MONDAY);

    expect(memo.seen("SSX-1234", Number.NaN)).toBe(false);
  });

  it("does not remember an undatable decline as anything", () => {
    // The mutation stores `NaN`, and every later comparison against it is false,
    // so the entry is a no-op that looks like a bound. Dropping it is the same
    // outcome and is legible in `size()`.
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
    // `watch:once` builds one of these per invocation and relies on this: a
    // command run by hand must look at what an operator pointed it at, not at
    // what some earlier process decided about the same ticket.
    expect(createWatchMemo().seen("SSX-1234", MONDAY)).toBe(false);
  });
});
