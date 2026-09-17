import { describe, expect, it } from "vitest";

import {
  RETRIAGE_LABEL_PREFIX,
  reserveRetriage,
  retriageCount,
  retriageLabels,
} from "./counter.ts";

describe("reading the count", () => {
  it("reads the number off the label", () => {
    expect(retriageCount(["agent:watching", "agent:retriage-2", "dor:gaps"])).toBe(2);
  });

  it("counts a ticket with no counter label as nothing spent", () => {
    // The ordinary case, and must not be a refusal.
    expect(retriageCount(["agent:watching"])).toBe(0);
    expect(retriageCount([])).toBe(0);
  });

  it.each([
    "agent:retriage-",
    "agent:retriage-0",
    "agent:retriage-01",
    "agent:retriage-x",
    "agent:retriage-1x",
    "agent:retriage-2.5",
    "agent:retriage--1",
    "agent:retriage-99999",
  ])("refuses %s rather than reading it as zero", (label) => {
    // A count that fails to parse must refuse, not read as a fresh budget.
    expect(retriageCount(["agent:watching", label])).toBeNull();
  });

  it("takes the highest when a remove failed and two are present", () => {
    // Two labels means an add landed and a remove didn't; taking the max can't
    // be engineered into overspending, since adding a label only raises it.
    expect(retriageCount(["agent:retriage-1", "agent:retriage-3", "agent:retriage-2"])).toBe(3);
  });

  it("ignores labels outside the namespace entirely", () => {
    expect(retriageLabels(["agent:watching", "svc:web", "agent:retriage-1"])).toEqual([
      "agent:retriage-1",
    ]);
  });
});

describe("reserving the next one", () => {
  it("writes the successor and clears what it supersedes in one delta", () => {
    // Both halves apply in one server-side operation, so the ticket never
    // carries neither label.
    expect(reserveRetriage(["agent:watching", "agent:retriage-1"])).toEqual({
      add: ["agent:retriage-2"],
      remove: ["agent:retriage-1"],
      count: 2,
    });
  });

  it("starts a ticket at one", () => {
    expect(reserveRetriage(["agent:watching"])).toEqual({
      add: [`${RETRIAGE_LABEL_PREFIX}1`],
      remove: [],
      count: 1,
    });
  });

  it("refuses to reserve from a base it cannot read", () => {
    // Reserving from an unreadable count would write a number derived from nothing.
    expect(reserveRetriage(["agent:retriage-nope"])).toBeNull();
  });

  it("refuses at the top of the range rather than writing a label it cannot read back", () => {
    expect(reserveRetriage(["agent:retriage-9999"])).toBeNull();
  });
});
