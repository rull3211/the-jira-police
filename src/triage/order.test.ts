import { describe, expect, it } from "vitest";

import type { TicketRef } from "../jira/types.ts";
import { byCreatedAscending, byStatusPriority, settledCursor, statusRank } from "./order.ts";

function ticket(key: string, created: string, status: Partial<TicketRef> = {}): TicketRef {
  return {
    key,
    summary: `Summary for ${key}`,
    issueTypeId: "10007",
    issueTypeName: "Oppgave",
    created,
    updated: created,
    statusId: "",
    statusName: "",
    labels: [],
    url: `https://example.invalid/browse/${key}`,
    ...status,
  };
}

const MOTTATT = { statusId: "10165", statusName: "Mottatt" };
const BACKLOG = { statusId: "10025", statusName: "Backlog" };
const HOLD = { statusId: "10194", statusName: "On Hold" };

describe("statusRank", () => {
  it("finds the position of a status named by id", () => {
    expect(statusRank(["10025", "10165"], ticket("SSX-1", "2026-09-02T10:00:00Z", MOTTATT))).toBe(
      1,
    );
  });

  it("finds the position of a status named by its board name", () => {
    expect(
      statusRank(["Backlog", "Mottatt"], ticket("SSX-1", "2026-09-02T10:00:00Z", MOTTATT)),
    ).toBe(1);
  });

  /** Names fold case; ids don't, since a case-differing id is a different id, not a typo. */
  it("folds case on names but treats an id as exact", () => {
    const t = ticket("SSX-1", "2026-09-02T10:00:00Z", MOTTATT);
    expect(statusRank(["MOTTATT"], t)).toBe(0);
    expect(statusRank([" mottatt "], t)).toBe(0);
    expect(statusRank(["10165 "], t)).toBe(0);
    expect(statusRank(["101650"], t)).toBe(1);
  });

  it("sorts an unlisted status after every listed one", () => {
    expect(statusRank(["10025", "10165"], ticket("SSX-1", "2026-09-02T10:00:00Z", HOLD))).toBe(2);
  });

  /** An unknown status must not match a blank entry — `TRIAGE_STATUS_PRIORITY=10165,,10025` is a typo. */
  it("never matches an empty configured entry against an unknown status", () => {
    expect(statusRank(["10165", "", "10025"], ticket("SSX-1", "2026-09-02T10:00:00Z"))).toBe(3);
  });

  it("takes the first position when a status is listed twice", () => {
    expect(
      statusRank(["10165", "10025", "10165"], ticket("SSX-1", "2026-09-02T10:00:00Z", MOTTATT)),
    ).toBe(0);
  });
});

describe("byStatusPriority", () => {
  it("works the leftmost column first, oldest first inside it", () => {
    const tickets = [
      ticket("SSX-1", "2026-09-02T10:00:00Z", BACKLOG),
      ticket("SSX-2", "2026-09-02T10:05:00Z", MOTTATT),
      ticket("SSX-3", "2026-09-02T10:01:00Z", MOTTATT),
      ticket("SSX-4", "2026-09-02T09:00:00Z", HOLD),
    ];

    const ordered = tickets.toSorted(byStatusPriority(["10165", "10025"]));

    expect(ordered.map((t) => t.key)).toEqual(["SSX-3", "SSX-2", "SSX-1", "SSX-4"]);
  });

  /** The unset case must be today's behaviour exactly, so this setting is opt-in, not a silent policy change. */
  it("is plain created-ascending when no priority is configured", () => {
    const tickets = [
      ticket("SSX-2", "2026-09-02T10:05:00Z", MOTTATT),
      ticket("SSX-1", "2026-09-02T10:00:00Z", HOLD),
    ];

    expect(tickets.toSorted(byStatusPriority([])).map((t) => t.key)).toEqual(["SSX-1", "SSX-2"]);
    expect(byStatusPriority([])).toBe(byCreatedAscending);
  });

  it("orders equal columns and equal instants by key, so the order is total", () => {
    const tickets = [
      ticket("SSX-2", "2026-09-02T10:00:00Z", MOTTATT),
      ticket("SSX-1", "2026-09-02T10:00:00Z", MOTTATT),
    ];

    expect(tickets.toSorted(byStatusPriority(["10165"])).map((t) => t.key)).toEqual([
      "SSX-1",
      "SSX-2",
    ]);
  });
});

describe("byCreatedAscending", () => {
  /** Jira prints an offset rather than `Z`, so string order and instant order disagree across a DST boundary. */
  it("orders by instant rather than by the printed string", () => {
    const earlier = ticket("SSX-1", "2026-10-25T02:30:00.000+0200");
    const later = ticket("SSX-2", "2026-10-25T02:00:00.000+0100");

    expect([later, earlier].toSorted(byCreatedAscending).map((t) => t.key)).toEqual([
      "SSX-1",
      "SSX-2",
    ]);
  });

  it("refuses to guess at an unparseable timestamp", () => {
    expect(() =>
      [ticket("SSX-1", "yesterday"), ticket("SSX-2", "2026-09-02T10:00:00Z")].toSorted(
        byCreatedAscending,
      ),
    ).toThrow(/SSX-1 has an unparseable created timestamp/);
  });
});

/**
 * Unplugging the guard — returning the newest success instead of the end of the contiguous
 * prefix — fails every case below except all-succeeded and empty, since those two are the only
 * ones where the two answers coincide.
 */
describe("settledCursor", () => {
  const oldest = ticket("SSX-1", "2026-09-02T10:00:00Z");
  const middle = ticket("SSX-2", "2026-09-02T10:05:00Z");
  const newest = ticket("SSX-3", "2026-09-02T10:10:00Z");
  const all = [oldest, middle, newest];

  it("reaches the newest when everything succeeded", () => {
    expect(settledCursor(all, new Set(["SSX-1", "SSX-2", "SSX-3"]))).toBe("2026-09-02T10:10:00Z");
  });

  it("stops at the gap when a middle issue did not succeed", () => {
    expect(settledCursor(all, new Set(["SSX-1", "SSX-3"]))).toBe("2026-09-02T10:00:00Z");
  });

  it("does not move at all when the oldest did not succeed", () => {
    expect(settledCursor(all, new Set(["SSX-2", "SSX-3"]))).toBeNull();
  });

  /** Priority order can triage the newest ticket first and stop before the older ones are attempted; the cursor may not pass them regardless. */
  it("treats an unattempted issue exactly like a failed one", () => {
    expect(settledCursor(all, new Set(["SSX-3"]))).toBeNull();
  });

  it("has nothing to say about an empty cycle", () => {
    expect(settledCursor([], new Set())).toBeNull();
  });
});
