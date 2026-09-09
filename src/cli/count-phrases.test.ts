/**
 * The class check, and the second test `docs:check` has ever had.
 *
 * `docs-check.ts`'s `expectSites` comment says the class fix "arrives with this
 * file's first test rather than before it", and `PLAN.md` §13 records the debt.
 * `pinned-prose.test.ts` paid the first half; this pays the rest — the scanner
 * that decides whether a number in prose is being watched at all.
 *
 * Every case names the **plausible wrong implementation** it fails against,
 * per `PROVING.md`: a guard is not shipped until a test fails when it is
 * unplugged, and unplugged means the version somebody would actually write, not
 * a straw one. Four of the unpluggings below are mistakes this repository has
 * already made in a neighbouring file — the literal space, the line-only join,
 * the blessing that outlives its subject, and the digit run that is not a count.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  COUNTED_NOUNS,
  type CountPhrase,
  countPhrasesIn,
  type HistoricalFigure,
  staleHistorical,
  unaccountedPhrases,
} from "./count-phrases.ts";

const ROOT = new URL("../../", import.meta.url);

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");
}

function scan(body: string): CountPhrase[] {
  return countPhrasesIn("doc.md", body);
}

describe("finding a count in prose", () => {
  it("finds a plain one and reports its noun, value and line", () => {
    const [only, ...rest] = scan("intro\nthe suite has 2390 tests today\n");

    expect(rest).toEqual([]);
    expect(only).toMatchObject({ file: "doc.md", line: 2, value: 2390, noun: "tests" });
  });

  it("strips the thousands comma rather than truncating at it", () => {
    // Unplugged: `Number(match[1])` with no strip. `Number("4,562")` is NaN, so
    // every comma-formatted citation silently becomes a phrase that can never
    // equal any declared value — the check would then report drift forever on a
    // number that is correct.
    expect(scan("4,562 tests")[0]?.value).toBe(4562);
  });

  it("reports the line the phrase starts on, not the one it ends on", () => {
    expect(scan("a\nb\nc 66\nfiles\n")[0]?.line).toBe(3);
  });

  it("finds a phrase the formatter wrapped mid-citation", () => {
    // Unplugged: build the pattern with a literal space. `oxfmt` reflows prose,
    // so the wrap position is the formatter's to choose. This exact bug disabled
    // half of docs:check twice, on a document nobody had edited.
    const [only] = scan("the suite has 2390\ntests today\n");

    expect(only).toMatchObject({ value: 2390, noun: "tests" });
  });

  it("finds a phrase wrapped inside a blockquote", () => {
    // Unplugged: `\s+` alone. A continuation line in a blockquote begins `> `,
    // which is not whitespace — the second half of the same incident, and the
    // one that survived the first fix.
    const [only] = scan("> the suite has 2390\n> tests today\n");

    expect(only).toMatchObject({ value: 2390, noun: "tests" });
  });

  it("flattens the quoted text so a reader can grep for it", () => {
    expect(scan("has 2390\n> tests")[0]?.text).toBe("2390 tests");
  });

  it("finds every phrase in a document, not just the first", () => {
    expect(scan("46 settings\n\n17 file-homes\n\n12 cases\n")).toHaveLength(3);
  });
});

describe("nouns that contain other nouns", () => {
  it("reads '66 test files' as one phrase about test files", () => {
    // This case is why the module once ordered COUNTED_NOUNS longest-first and
    // deduplicated by offset. The mutation proved the machinery inert: `files`
    // cannot match here at all, because the pattern anchors the digits
    // immediately before the noun and nothing numeric precedes "files". Kept as
    // a test because the *behaviour* is what matters and it is not obvious —
    // deleted machinery is exactly what stops being covered by accident.
    const found = scan("the module map says 66 test files\n");

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ value: 66, noun: "test files" });
  });

  it("finds both counts when each has its own number", () => {
    expect(scan("2390 tests in 66 files")).toHaveLength(2);
  });

  it("has no noun that is a whole-word prefix of another", () => {
    // The one shape that would produce two phrases at one offset. Nothing in
    // the list has it today; this fails on the day somebody adds one, which is
    // cheaper than the duplicate turning up as a phantom unaccounted phrase.
    for (const noun of COUNTED_NOUNS) {
      for (const other of COUNTED_NOUNS) {
        if (other !== noun) {
          expect(other.startsWith(`${noun} `)).toBe(false);
        }
      }
    }
  });
});

describe("digit runs that are not counts", () => {
  it("ignores a pull request number", () => {
    // Unplugged: match digits anywhere. This tree writes `#2661` and friends
    // constantly, and a naive matcher reads the digits and demands they be
    // accounted for. Named in PLAN.md as the false-positive class the design
    // has to handle.
    expect(scan("see #2661 tests")).toEqual([]);
  });

  it("ignores a currency amount", () => {
    expect(scan("$4562 tests")).toEqual([]);
  });

  it("ignores a version or decimal fragment", () => {
    expect(scan("v1.66 files")).toEqual([]);
  });

  it("still counts a number that merely follows a hash elsewhere on the line", () => {
    // The guard looks at the character immediately before the digits, so it
    // must not be a whole-line veto: a line mentioning #24 can still carry a
    // real citation.
    expect(scan("PR #24 landed 46 settings")).toHaveLength(1);
  });
});

describe("what counts as accounted for", () => {
  const phrases = scan("2390 tests in 66 files\n\n93 assertions\n");
  const tests = phrases.find((p) => p.noun === "tests");
  const files = phrases.find((p) => p.noun === "files");

  it("treats a phrase a FACT already checks as accounted", () => {
    const left = unaccountedPhrases(phrases, [{ file: "doc.md", line: 1, value: 2390 }], []);

    expect(left.map((p) => p.noun)).not.toContain("tests");
    expect(tests).toBeDefined();
  });

  it("does not bless the other number on the same line", () => {
    // Unplugged: match a checked site on file and line only. "2390 tests in 66
    // files" is two facts sharing a line; declaring one would silently declare
    // the other, which is precisely how the module map's bare count went wrong
    // while the two canonical sites were being updated correctly.
    const left = unaccountedPhrases(phrases, [{ file: "doc.md", line: 1, value: 2390 }], []);

    expect(left.map((p) => p.noun)).toContain("files");
    expect(files).toBeDefined();
  });

  it("treats a declared historical figure as accounted", () => {
    const historical: HistoricalFigure[] = [
      { file: "doc.md", value: 93, noun: "assertions", why: "one past run" },
    ];

    expect(unaccountedPhrases(phrases, [], historical).map((p) => p.value)).not.toContain(93);
  });

  it("does not let a historical entry excuse a different number", () => {
    // Unplugged: key HISTORICAL on file and noun. The blessing would then follow
    // the sentence through every edit, so rewriting a war story to a new figure
    // — or letting a *current* count drift into that sentence — passes unseen.
    const historical: HistoricalFigure[] = [
      { file: "doc.md", value: 57, noun: "assertions", why: "a different past run" },
    ];

    expect(unaccountedPhrases(phrases, [], historical).map((p) => p.value)).toContain(93);
  });

  it("does not let a historical entry excuse the same number in another file", () => {
    const historical: HistoricalFigure[] = [
      { file: "elsewhere.md", value: 93, noun: "assertions", why: "one past run" },
    ];

    expect(unaccountedPhrases(phrases, [], historical).map((p) => p.value)).toContain(93);
  });

  it("reports nothing when everything is declared one way or the other", () => {
    const left = unaccountedPhrases(
      phrases,
      [
        { file: "doc.md", line: 1, value: 2390 },
        { file: "doc.md", line: 1, value: 66 },
      ],
      [{ file: "doc.md", value: 93, noun: "assertions", why: "one past run" }],
    );

    expect(left).toEqual([]);
  });
});

describe("a blessing that outlived its phrase", () => {
  it("reports a HISTORICAL entry matching nothing in the tree", () => {
    // Unplugged: never check. An exemption whose subject was deleted or
    // reworded is a permanent hole, and the next count to land on that
    // file/value/noun is excused by an entry written about something else. Same
    // argument as expectSites and KNOWN_DANGLING, one level along.
    const stale = staleHistorical(scan("93 assertions"), [
      { file: "doc.md", value: 93, noun: "assertions", why: "still here" },
      { file: "doc.md", value: 57, noun: "assertions", why: "long gone" },
    ]);

    expect(stale.map((entry) => entry.value)).toEqual([57]);
  });

  it("says nothing when every entry still matches", () => {
    expect(
      staleHistorical(scan("93 assertions"), [
        { file: "doc.md", value: 93, noun: "assertions", why: "still here" },
      ]),
    ).toEqual([]);
  });
});

describe("the tree as it stands", () => {
  it("finds the canonical suite citation in both documents that carry it", () => {
    const architecture = countPhrasesIn("ARCHITECTURE.md", read("ARCHITECTURE.md"));
    const plan = countPhrasesIn("PLAN.md", read("PLAN.md"));

    for (const found of [architecture, plan]) {
      expect(found.filter((p) => p.noun === "tests").length).toBeGreaterThan(0);
      expect(found.filter((p) => p.noun === "files").length).toBeGreaterThan(0);
    }
  });
});
