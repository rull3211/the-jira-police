import { describe, expect, it } from "vitest";

import { createAttemptLedger } from "./attempts.ts";

describe("what stops the daemon claiming the same ticket forever", () => {
  it("offers a ticket the operator's number of times and no more", () => {
    // Without this bound, an escaped run — the one outcome `terminalLabelAfter` still releases,
    // since its cause is an operator's own concurrent edits, not the ticket — offers the ticket
    // again next tick with nothing to ever stop it. Every other outcome now labels `agent:failed`
    // on its own and needs no bound.
    const ledger = createAttemptLedger(3);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(ledger.exhausted("SSX-1234")).toBe(false);
      ledger.attempted("SSX-1234");
    }

    expect(ledger.exhausted("SSX-1234")).toBe(true);
  });

  it("counts the attempt at the cap as spent", () => {
    // Guards against `>` in place of `>=`, which would grant one attempt more
    // than the cap allows.
    const ledger = createAttemptLedger(1);
    ledger.attempted("SSX-1234");

    expect(ledger.exhausted("SSX-1234")).toBe(true);
  });

  it("counts each ticket separately", () => {
    // Guards against a single shared counter, which would let one bad ticket
    // block every other ticket too.
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
    // A cap of zero means claim nothing; it must not be treated as unset and
    // floored up to a default.
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
