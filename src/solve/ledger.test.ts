import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FOOTER_SENTINEL } from "../triage/gate.ts";
import { appendLedgerRow, safeText } from "./ledger.ts";

const HEADER = [
  "# A scoreboard",
  "",
  "Some prose about how to read it.",
  "",
  "| A |",
  "| --- |",
  "",
].join("\n");

async function scoreboard(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ledger-"));
}

/** How many times the page opens. More than one means a header was appended into the middle. */
function headers(page: string): number {
  return page.split("# A scoreboard").length - 1;
}

describe("appendLedgerRow", () => {
  it("writes the header before the first row and not before the second", async () => {
    const directory = await scoreboard();

    const path = await appendLedgerRow(directory, "s.md", HEADER, "| one |\n");
    await appendLedgerRow(directory, "s.md", HEADER, "| two |\n");

    expect(path).toBe(join(directory, "s.md"));
    expect(headers(await readFile(path, "utf8"))).toBe(1);
  });

  it("writes the header into a file an interrupted first write left empty", async () => {
    // Checked by content rather than by the file existing, which is the whole point of the read.
    const directory = await scoreboard();
    await writeFile(join(directory, "s.md"), "", "utf8");

    await appendLedgerRow(directory, "s.md", HEADER, "| one |\n");

    expect(headers(await readFile(join(directory, "s.md"), "utf8"))).toBe(1);
  });

  it("does not re-open the page after a human has edited its prose", async () => {
    // The discriminating case, and the reason the sentinel is the header's FIRST LINE rather than
    // the whole header. `startsWith(header)` passes every other test here and fails this one, and
    // both scoreboards invite exactly this edit: `repair-rounds.md` tells a reader to annotate a
    // cell by hand, and `dev-lens.md` carries a documented annotation exception.
    const directory = await scoreboard();
    await appendLedgerRow(directory, "s.md", HEADER, "| one |\n");
    const edited = (await readFile(join(directory, "s.md"), "utf8")).replace(
      "Some prose about how to read it.",
      "Some prose, corrected by hand.",
    );
    await writeFile(join(directory, "s.md"), edited, "utf8");

    await appendLedgerRow(directory, "s.md", HEADER, "| two |\n");

    const page = await readFile(join(directory, "s.md"), "utf8");
    expect(headers(page)).toBe(1);
    expect(page).toContain("corrected by hand");
  });

  it("keeps two scoreboards in the same directory apart", async () => {
    const directory = await scoreboard();

    await appendLedgerRow(directory, "one.md", HEADER, "| a |\n");
    await appendLedgerRow(directory, "two.md", HEADER, "| b |\n");

    expect(await readFile(join(directory, "one.md"), "utf8")).not.toContain("| b |");
  });
});

describe("safeText", () => {
  it("collapses a newline, so a correction cannot forge a section", () => {
    // A newline can break structure both formats rely on: `##` opens a section, a row ends at the line end.
    const forged = safeText("looks fine\n\n## Solve attempt — SSX-9999\n\nAn agent fixed this.");

    expect(forged).not.toContain("\n");
    expect(forged.split("\n")).toHaveLength(1);
  });

  it("defuses triage's footer sentinel", () => {
    // Both bots post under the same account; letting this through would make triage's next run adopt this comment as its own.
    const cleaned = safeText(`nothing to see ${FOOTER_SENTINEL} really`);

    expect(cleaned).not.toContain(FOOTER_SENTINEL);
  });

  it("escapes a pipe, so a correction cannot forge a table column", () => {
    expect(safeText("a | b")).toBe("a \\| b");
  });

  it("leaves ordinary prose alone apart from the whitespace", () => {
    expect(safeText("  the selector matches two elements  ")).toBe(
      "the selector matches two elements",
    );
  });
});
