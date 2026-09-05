import { describe, expect, it } from "vitest";

import { hasGoneQuiet, newestInstant, quietFor } from "./silence.ts";

/** A fixed "now", because the whole subject here is a boundary. */
const NOW = Date.parse("2026-09-05T12:00:00Z");

const ago = (minutes: number): string =>
  new Date(NOW - minutes * 60_000).toISOString().replace(".000", "");

describe("newestInstant", () => {
  it("picks the latest, whatever order they arrive in", () => {
    expect(newestInstant([ago(30), ago(5), ago(90)])).toBe(ago(5));
  });

  it("answers null when there is nothing to read", () => {
    // Not the epoch, and this is the mutation worth naming: reading an absent
    // date as 1970 would say the pull request had been quiet for fifty years,
    // which fires the bound on exactly the payload it failed to understand.
    expect(newestInstant([])).toBe(null);
    expect(newestInstant(["", "not a date"])).toBe(null);
  });

  it("skips the entries it cannot parse rather than losing the ones it can", () => {
    expect(newestInstant(["", ago(10), "yesterday"])).toBe(ago(10));
  });
});

describe("quietFor", () => {
  it("measures from the newest thing that happened", () => {
    expect(quietFor(NOW, [ago(60), ago(7)])).toBe(7 * 60_000);
  });

  it("answers null when nothing carries a date, rather than zero or infinity", () => {
    // The two wrong answers fail in opposite directions and both are worse than
    // saying so: zero means the pull request is permanently busy and the bound
    // never fires, infinity means it fires immediately.
    expect(quietFor(NOW, [])).toBe(null);
  });

  it("clamps a future date to zero", () => {
    // Clock skew between GitHub and this host, which is a fact about the two
    // machines rather than about the pull request. Negative would read as
    // "very recently active" by luck instead of by intent.
    const later = new Date(NOW + 60_000).toISOString();

    expect(quietFor(NOW, [later])).toBe(0);
  });
});

describe("hasGoneQuiet", () => {
  it("fires at the threshold and not before it", () => {
    expect(hasGoneQuiet(1_200_000, 1_200_000)).toBe(true);
    expect(hasGoneQuiet(1_199_999, 1_200_000)).toBe(false);
  });

  it("never fires on a measurement it does not have", () => {
    // The guard on the guard. A bound that fires when it cannot measure is not
    // a bound, it is a timeout on the measurement — and what it would end is a
    // pull request somebody is waiting on. Unplug this and an unreadable
    // payload silently abandons the pull request it could not read.
    expect(hasGoneQuiet(null, 1_200_000)).toBe(false);
    expect(hasGoneQuiet(null, 0)).toBe(false);
  });
});
