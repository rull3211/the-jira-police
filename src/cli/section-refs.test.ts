import { describe, expect, it } from "vitest";

import { maskDisabled, referencesIn, sectionIds, unresolved } from "./section-refs.ts";

// Every `§N` below is a fixture, so the region is the whole file rather than a
// paragraph — the one place where that is the honest scope, since a reference
// this file *makes* rather than tests would be the anomaly. The markers only
// match a line that is nothing but a marker, which is why the ones appearing
// inside the fixtures further down do not close this region.
// refs:off

describe("sectionIds", () => {
  it("takes numbered headings at any level and ignores unnumbered ones", () => {
    const ids = sectionIds(
      ["# Title", "## 1. First", "### Not numbered", "### 2a. Lettered", "## 10. Tenth"].join("\n"),
      {},
    );
    expect([...ids].toSorted()).toEqual(["1", "10", "2a"]);
  });

  it("registers list items only under the section declared as addressable", () => {
    const body = [
      "## 6. The subprocess contract",
      "",
      "1. **Not addressable.** This section was never declared as carrying one.",
      "",
      "## 14. Invariants",
      "",
      "1. **First invariant.** Text.",
      "2. **Second invariant.** Text.",
      "",
      "## 15. After",
    ].join("\n");

    const ids = sectionIds(body, { numberedListIn: "14" });

    expect(ids.has("14.1")).toBe(true);
    expect(ids.has("14.2")).toBe(true);
    // The whole point of declaring it: §6.1 is a reference this check must
    // catch, and inferring sub-sections from any numbered list would legalise
    // it the moment §6 grew one.
    expect(ids.has("6.1")).toBe(false);
  });

  it("stops the addressable list at the next heading of the same level or above", () => {
    const body = [
      "## 14. Invariants",
      "",
      "1. **Inside.** Text.",
      "",
      "### A subsection of 14",
      "",
      "2. **Still inside, because this heading is deeper.** Text.",
      "",
      "## 15. A different section",
      "",
      "3. **Outside.** Belongs to §15 and is not an invariant.",
    ].join("\n");

    const ids = sectionIds(body, { numberedListIn: "14" });

    expect(ids.has("14.1")).toBe(true);
    expect(ids.has("14.2")).toBe(true);
    expect(ids.has("14.3")).toBe(false);
  });
});

describe("maskDisabled", () => {
  it("blanks a region without moving any line number after it", () => {
    const body = [
      "§1 before",
      "<!-- refs:off -->",
      "§7b quoted",
      "<!-- refs:on -->",
      "§2 after",
    ].join("\n");

    const masked = maskDisabled(body);

    expect(masked.split("\n")).toHaveLength(5);
    expect(masked).toContain("§1 before");
    expect(masked).toContain("§2 after");
    expect(masked).not.toContain("§7b");
  });

  it("accepts the marker in each comment syntax it has to survive", () => {
    for (const off of ["<!-- refs:off -->", "// refs:off", " * refs:off", "  refs:off"]) {
      expect(maskDisabled([off, "§7b"].join("\n"))).not.toContain("§7b");
    }
  });

  it("runs an unterminated region to the end of the file", () => {
    // Fails loudly by silencing the rest of the document. The alternative —
    // ignoring an unclosed marker — silences nothing and reads identically in
    // the diff, so the mistake would only ever show up as the check passing.
    const masked = maskDisabled(["<!-- refs:off -->", "§7b", "§3a"].join("\n"));

    expect(masked).not.toContain("§7b");
    expect(masked).not.toContain("§3a");
  });
});

describe("referencesIn", () => {
  it("reports each reference with the line it is on", () => {
    const found = referencesIn("a.ts", ["// see §6.1c", "", "/** and §14.11 */"].join("\n"));

    expect(found).toEqual([
      { file: "a.ts", line: 1, id: "6.1c" },
      { file: "a.ts", line: 3, id: "14.11" },
    ]);
  });

  it("does not read a sentence-ending period as a sub-section", () => {
    expect(referencesIn("a.md", "recorded in §13.")).toEqual([{ file: "a.md", line: 1, id: "13" }]);
  });

  it("skips references inside a disabled region", () => {
    const found = referencesIn(
      "a.md",
      ["§1", "<!-- refs:off -->", "§7b", "<!-- refs:on -->", "§2"].join("\n"),
    );

    expect(found.map((ref) => ref.id)).toEqual(["1", "2"]);
    expect(found.map((ref) => ref.line)).toEqual([1, 5]);
  });

  it("does not let a marker mentioned mid-sentence open a region", () => {
    // This file and its module both have to document the markers. A substring
    // rule made writing that sentence disable the rest of the document.
    const found = referencesIn("a.md", "Wrap it in `refs:off` and `refs:on`, then cite §3.");

    expect(found.map((ref) => ref.id)).toEqual(["3"]);
  });
});

describe("unresolved", () => {
  it("keeps only the references no document defines", () => {
    const refs = referencesIn("a.ts", "§1 §7b §14.11");

    expect(unresolved(refs, new Set(["1", "14.11"])).map((ref) => ref.id)).toEqual(["7b"]);
  });
});

// refs:on
