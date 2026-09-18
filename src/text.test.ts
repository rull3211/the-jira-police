import { describe, expect, it } from "vitest";

import { shorten } from "./text.ts";

describe("shorten", () => {
  it("leaves text that fits exactly as it was", () => {
    // An off-by-one here would put an ellipsis on a sentence that was never cut.
    expect(shorten("abcde", 5)).toBe("abcde");
  });

  it("cuts on a word boundary and says that it cut", () => {
    const out = shorten("the validation lives in three packages", 20);
    expect(out).toBe("the validation lives…");
    expect(out.length).toBeLessThanOrEqual(21);
  });

  it("does not cut inside a file reference", () => {
    // Slicing at the raw index would leave `mapToCommerceCar.ts:1`, a plausible-looking
    // wrong line number.
    expect(shorten("see mapToCommerceCar.ts:162 for the mapping", 30)).toBe(
      "see mapToCommerceCar.ts:162…",
    );
  });

  it("still cuts when the text has no space to cut at", () => {
    expect(shorten("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });
});
