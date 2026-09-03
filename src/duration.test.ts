import { describe, expect, it } from "vitest";

import { parseDuration } from "./duration.ts";

describe("parseDuration", () => {
  it.each([
    ["250ms", 250],
    ["30s", 30_000],
    ["4m", 240_000],
    ["2h", 7_200_000],
    ["1.5m", 90_000],
  ])("parses %s", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("treats a bare number as milliseconds, matching the settings", () => {
    expect(parseDuration("240000")).toBe(240_000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseDuration("  30s ")).toBe(30_000);
  });

  it.each(["", "soon", "30 s", "-30s", "30sec", "m"])("rejects %s", (input) => {
    expect(() => parseDuration(input)).toThrow(/Not a duration/);
  });

  it("does not silently accept a unit it cannot scale", () => {
    // A typo like `4d` must fail loudly: falling back to milliseconds would
    // turn an intended four days into four milliseconds.
    expect(() => parseDuration("4d")).toThrow(/Not a duration/);
  });
});
