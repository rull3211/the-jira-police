import { describe, expect, it } from "vitest";

import { shorten } from "./text.ts";

describe("shorten", () => {
  it("leaves text that fits exactly as it was", () => {
    // Including at the boundary. An off-by-one here puts an ellipsis on a
    // sentence that was never cut, which reads as lost text that is not lost.
    expect(shorten("abcde", 5)).toBe("abcde");
  });

  it("cuts on a word boundary and says that it cut", () => {
    // Not decoration. A silently truncated sentence reads as a model that
    // stopped mid-thought — a bug someone will file — where a marked one reads
    // as a harness that shortened something, which is what happened.
    const out = shorten("the validation lives in three packages", 20);
    expect(out).toBe("the validation lives…");
    expect(out.length).toBeLessThanOrEqual(21);
  });

  it("does not cut inside a file reference", () => {
    // THE ONE THAT MATTERS for a bail comment's readers. Slicing at the index
    // would leave `mapToCommerceCar.ts:1`, a plausible-looking wrong line
    // number, which is worse than saying nothing.
    expect(shorten("see mapToCommerceCar.ts:162 for the mapping", 30)).toBe(
      "see mapToCommerceCar.ts:162…",
    );
  });

  it("still cuts when the text has no space to cut at", () => {
    // The fallback exists so the cap does not stop capping on exactly the
    // unusual input — one enormous token — that most needs capping.
    expect(shorten("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });
});
