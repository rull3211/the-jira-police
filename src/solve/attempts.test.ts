import { describe, expect, it } from "vitest";

import { createAttemptLedger } from "./attempts.ts";

describe("what stops the daemon claiming the same ticket forever", () => {
  it("offers a ticket the operator's number of times and no more", () => {
    // THE ONE THAT MATTERS. A refused, failed or transiently abandoned run
    // writes no terminal label and releases every label it found, `agent:start`
    // included, so the queue offers the ticket again next tick. Unplug this and
    // the loop pays the full solve cost on the same ticket every two minutes,
    // with no condition that ever clears it — the runaway D4c recorded as E's.
    const ledger = createAttemptLedger(3);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(ledger.exhausted("SSX-1234")).toBe(false);
      ledger.attempted("SSX-1234");
    }

    expect(ledger.exhausted("SSX-1234")).toBe(true);
  });

  it("counts the attempt at the cap as spent", () => {
    // The mutation is `>` instead of `>=`, which hands out one attempt more than
    // was asked for. It is the quiet kind of wrong: the bound still fires, one
    // solve late, and every test that only checks "it eventually stops" passes.
    const ledger = createAttemptLedger(1);
    ledger.attempted("SSX-1234");

    expect(ledger.exhausted("SSX-1234")).toBe(true);
  });

  it("counts each ticket separately", () => {
    // Keyed wrong — a single counter for the whole loop — and one bad ticket
    // silently stops the queue for every other one, which looks like an empty
    // board rather than like a brake.
    const ledger = createAttemptLedger(2);
    ledger.attempted("SSX-1111");
    ledger.attempted("SSX-1111");

    expect(ledger.exhausted("SSX-1111")).toBe(true);
    expect(ledger.exhausted("SSX-2222")).toBe(false);
    expect(ledger.size()).toBe(1);
  });

  it("knows nothing about a ticket it has never been offered", () => {
    const ledger = createAttemptLedger(3);

    expect(ledger.exhausted("SSX-1234")).toBe(false);
    expect(ledger.countFor("SSX-1234")).toBe(0);
    expect(ledger.size()).toBe(0);
  });

  it("refuses everything when the cap is zero", () => {
    // Zero means "look at the queue, claim nothing", which is the dry posture
    // the review side spells `MAX_REVIEW_ROUNDS_PER_TICK=0`. It must not be
    // treated as unset and floored up to the default.
    const ledger = createAttemptLedger(0);

    expect(ledger.exhausted("SSX-1234")).toBe(true);
  });

  it("keeps counting past the cap, so a log line can say how far past", () => {
    const ledger = createAttemptLedger(2);
    ledger.attempted("SSX-1234");
    ledger.attempted("SSX-1234");
    ledger.attempted("SSX-1234");

    expect(ledger.countFor("SSX-1234")).toBe(3);
  });
});
