import { describe, expect, it } from "vitest";

import { shorten, shortenToSentence } from "./text.ts";

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

describe("shortenToSentence", () => {
  it("leaves text that fits exactly as it was", () => {
    expect(shortenToSentence("One. Two.", 9)).toBe("One. Two.");
  });

  it("ends on the last whole sentence the limit allows, and says that it cut", () => {
    const text = "First sentence here. Second sentence here. Third one runs on past the limit";

    expect(shortenToSentence(text, 45)).toBe("First sentence here. Second sentence here. …");
  });

  it("counts a question mark and an exclamation mark as the end of a sentence", () => {
    expect(shortenToSentence("Is it Back? Yes! And then it keeps going without end", 25)).toBe(
      "Is it Back? Yes! …",
    );
  });

  it("falls back to a word boundary when the only sentence end is in the first half", () => {
    const text = `Ok. ${"word ".repeat(20)}`;

    expect(shortenToSentence(text, 40)).toBe(shorten(text, 40));
  });

  it("falls back to a word boundary when no sentence ends at all", () => {
    expect(shortenToSentence("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("does not treat the stop inside a file reference as the end of a sentence", () => {
    const text = "The change lives in LandingPage.tsx:20 and hooks.ts:6-16 and also in many places";

    expect(shortenToSentence(text, 60)).toBe(shorten(text, 60));
    expect(shortenToSentence(text, 60)).toContain("hooks.ts:6-16");
  });
});
