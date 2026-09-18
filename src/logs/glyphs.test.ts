import { describe, expect, it } from "vitest";

import {
  LEVEL_GLYPHS,
  LEVEL_ORDER,
  MARK_GLYPHS,
  displayWidth,
  isWideGlyph,
  truncateToWidth,
} from "./glyphs.ts";

describe("isWideGlyph", () => {
  it("rejects the variation-selector emoji that shear a column", () => {
    // `ℹ️` and `⚠️` are the natural picks for info and warn and are exactly the trap: base character
    // plus U+FE0F, one column in some terminals and two in others.
    expect(isWideGlyph("ℹ️")).toBe(false);
    expect(isWideGlyph("⚠️")).toBe(false);
  });

  it("rejects a bare ASCII character and a multi-code-point sequence", () => {
    expect(isWideGlyph("i")).toBe(false);
    expect(isWideGlyph("🔵🔵")).toBe(false);
  });

  it("accepts a single emoji-presentation code point", () => {
    expect(isWideGlyph("🔵")).toBe(true);
  });
});

describe("the glyphs the viewer actually prints", () => {
  it("are all two columns wide, or the filter rows shear on the first warning", () => {
    // The guard the whole table exists for. Swapping any glyph for a `…️` form fails here.
    for (const glyph of [...Object.values(LEVEL_GLYPHS), ...MARK_GLYPHS]) {
      expect(`${glyph} wide`).toBe(`${glyph} ${isWideGlyph(glyph) ? "wide" : "narrow"}`);
    }
  });

  it("gives every level its own glyph, so two levels never read alike", () => {
    const glyphs = LEVEL_ORDER.map((level) => LEVEL_GLYPHS[level]);

    expect(new Set(glyphs).size).toBe(LEVEL_ORDER.length);
  });

  it("offers the levels in severity order rather than the record's key order", () => {
    expect(LEVEL_ORDER).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("displayWidth", () => {
  it("counts a wide glyph as two columns and ASCII as one", () => {
    expect(displayWidth("ab")).toBe(2);
    expect(displayWidth("🔵")).toBe(2);
    expect(displayWidth("🔵ab")).toBe(4);
  });

  it("counts a variation selector as nothing, since it prints nothing itself", () => {
    expect(displayWidth("ℹ️")).toBe(1);
  });
});

describe("truncateToWidth", () => {
  it("never splits a glyph, even when the budget lands mid-character", () => {
    // A half-written emoji is a broken cell that the next line inherits.
    expect(truncateToWidth("a🔵b", 2)).toBe("a");
    expect(truncateToWidth("a🔵b", 3)).toBe("a🔵");
  });

  it("returns nothing for a window with no room", () => {
    expect(truncateToWidth("abc", 0)).toBe("");
  });
});
