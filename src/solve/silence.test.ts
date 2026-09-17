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
    // Not the epoch: reading an absent date as 1970 would say the pull request had been quiet for fifty years.
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
    // Zero would read as permanently busy (the bound never fires); infinity would fire immediately.
    expect(quietFor(NOW, [])).toBe(null);
  });

  it("clamps a future date to zero", () => {
    // Clock skew between GitHub and this host; negative would misread as "very recently active".
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
    // Otherwise it would silently abandon a pull request it never actually read.
    expect(hasGoneQuiet(null, 1_200_000)).toBe(false);
    expect(hasGoneQuiet(null, 0)).toBe(false);
  });
});
