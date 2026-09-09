/**
 * Count-noun phrases in prose, and which of them nothing is watching.
 *
 * `docs-check.ts` checks a number wherever it is *phrased the way a `FACT`
 * expects*. That is the hole: rewrite a checked citation in a form no `FACT`
 * matches and the check reports green forever, having quietly stopped looking.
 * `expectSites` catches that for a phrasing that *was* declared and then moved.
 * It cannot catch a number that was never declared at all — the module map's
 * "65 test files" was wrong in exactly that way, written in the same commit
 * that updated the two declared sites correctly.
 *
 * So this inverts the question. Instead of "does every declared site agree?",
 * it asks **"is every count-noun phrase in the tree either a declared site or
 * an explicitly listed historical figure?"** A count written in a new phrasing
 * then fails on the day it is written, rather than the day somebody greps.
 *
 * **Why it is a list of nouns and not a shape.** Matching `<digits> <word>`
 * finds 539 phrases in this tree, nearly all of them prose that happens to
 * count something nobody cites — "two rules", "four questions", "39 dangling
 * references". A check with 500 entries to bless is a check somebody deletes.
 * Scoped to the nouns this repository actually cites numbers *about*, the
 * population is 23, small enough that every entry carries a reason. The cost is
 * real and is stated rather than hidden: **a count about a noun not on the list
 * is invisible to this check.** Adding a noun is one line, and the list is
 * expected to grow as new facts get cited.
 *
 * **The current-versus-history call is the whole point, and it is forced into
 * the open.** `docs-check.ts`'s header draws that line — a property of the tree
 * today is checkable, a measurement of one past run is not — and until now the
 * call was made silently by whoever chose not to add a `FACT`. Here it has to
 * be written down: a phrase is either checked or it is in `HISTORICAL` with a
 * sentence saying why it is history. Both halves become reviewable, which is
 * the actual defect being fixed.
 *
 * Kept in its own module because `docs-check.ts` cannot be imported from a test
 * — it runs `vitest list` at module scope, so importing it spawns vitest inside
 * vitest. Everything here is a pure function over text, and
 * `count-phrases.test.ts` is what `PLAN.md` §13 asked to arrive with it.
 */

/**
 * What separates two words of a phrase: a space, unless the formatter wrapped
 * the line there — and if the phrase sits inside a blockquote, the continuation
 * line carries the `> ` marker as well.
 *
 * Shared with `docs-check.ts` rather than copied. Both bugs this guards against
 * were a space that turned out not to be one, and two modules each holding
 * their own idea of "a space" is how the second one would come back.
 */
export const GAP = String.raw`\s+(?:>\s*)?`;

/**
 * A citation pattern, built from its words. Global, because one document may
 * cite the same fact twice. Pass each word separately; there is deliberately no
 * way to write the space yourself.
 */
export function citation(...words: readonly string[]): RegExp {
  return new RegExp(words.join(GAP), "gu");
}

/**
 * The nouns this repository cites numbers about.
 *
 * **Order does not matter here, and the first draft said it did.** That draft
 * ordered the list longest-first and deduplicated matches by start offset, on
 * the theory that "66 test files" would otherwise also be read as "66 files"
 * and reported twice. The mutation written to prove it — reorder the list, watch
 * the behavioural case fail — did not fail, and cannot: every pattern anchors
 * the digits immediately before the noun, and in "66 test files" no number is
 * adjacent to `files`, so the shorter noun never matches at all. The ordering
 * machinery was guarding a case that does not exist. That is `PROVING.md`'s
 * rule doing its job in the direction nobody expects — the guard came out and
 * nothing noticed, so the guard was the thing to delete.
 *
 * What remains is a plain alphabetical list. Two nouns could still collide if
 * one were a whole-word prefix of another (`tests` and `tests in flight`); none
 * are, a test asserts that, and if it ever happens the collision surfaces as a
 * duplicate phrase in the report rather than as silence.
 */
export const COUNTED_NOUNS: readonly string[] = [
  "assertions",
  "cases",
  "file-homes",
  "files",
  // Alphabetised case-insensitively, which is why a capital sits mid-list. The
  // event name is load-bearing rather than decorative: the bare word
  // `registrations` denotes two different populations in the two sentences that
  // use it here — one counts every hook in `.claude/settings.json`, the other
  // counts the `PreToolUse` array alone — and a noun that names two populations
  // cannot be checked against one number. Qualify the noun or leave it out.
  "PreToolUse registrations",
  "production modules",
  "section references",
  "settings",
  "sites",
  "test files",
  "tests",
];

export interface CountPhrase {
  /** Repository-relative, as the caller supplied it. */
  readonly file: string;
  /** 1-indexed, of the phrase's *first* character — a wrapped phrase has no one line. */
  readonly line: number;
  /** The cited number, commas stripped. */
  readonly value: number;
  /** Which entry of `COUNTED_NOUNS` matched. */
  readonly noun: string;
  /** The phrase itself, whitespace flattened, for quoting back at a reader. */
  readonly text: string;
}

/**
 * A number that is a measurement of one past run rather than a property of the
 * tree, and so is deliberately not checked.
 *
 * Keyed by all three of file, value and noun, which is stricter than it looks:
 * change the number and the entry stops matching, so a war story cannot be
 * quietly edited into a different war story. The `why` is not decoration — it
 * is the record of the current-versus-history call, and a reviewer disagreeing
 * with it is the mechanism working.
 */
export interface HistoricalFigure {
  readonly file: string;
  readonly value: number;
  readonly noun: string;
  readonly why: string;
}

/** A site some `FACT` already checks: same file, same line, same value. */
export interface CheckedSite {
  readonly file: string;
  readonly line: number;
  readonly value: number;
}

/**
 * A digit run that is part of a larger token rather than a count.
 *
 * `#2661` is a pull request number and this tree writes plenty of them; a naive
 * matcher reads the digits and calls it a count. Currency and version dots go
 * the same way. Checked on the character *before* the match, because the
 * alternative — widening the pattern — makes the pattern the thing that has to
 * be got right twice.
 */
const NOT_A_COUNT_BEFORE = new Set(["#", "$", ".", "-", "/"]);

/** Every count-noun phrase in one document, in reading order. */
export function countPhrasesIn(file: string, body: string): CountPhrase[] {
  const found: CountPhrase[] = [];

  for (const noun of COUNTED_NOUNS) {
    const matcher = citation(String.raw`(\d[\d,]*)`, ...noun.split(" "));
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(body)) !== null) {
      const start = match.index;
      const digits = match[1];
      if (digits === undefined) {
        continue;
      }
      if (start > 0 && NOT_A_COUNT_BEFORE.has(body[start - 1] ?? "")) {
        continue;
      }
      found.push({
        file,
        line: body.slice(0, start).split("\n").length,
        value: Number(digits.replace(/,/gu, "")),
        noun,
        text: match[0].replace(/\s+>?\s*/gu, " "),
      });
    }
  }

  return found.toSorted((a, b) => a.line - b.line || a.value - b.value);
}

function historyKey(phrase: { file: string; value: number; noun: string }): string {
  return `${phrase.file} ${phrase.value} ${phrase.noun}`;
}

function siteKey(site: { file: string; line: number; value: number }): string {
  return `${site.file} ${site.line} ${site.value}`;
}

/**
 * The phrases nothing is watching: neither a site some `FACT` already checks,
 * nor a declared historical figure.
 *
 * A phrase counts as checked when a `FACT` matched at the same file, line and
 * value. Line rather than offset because that is what `docs-check.ts` already
 * records, and **value** because one line can carry two different counts —
 * "2390 tests in 66 files" is two facts and two phrases, and blessing the line
 * would bless both when only one is declared.
 */
export function unaccountedPhrases(
  phrases: readonly CountPhrase[],
  checked: readonly CheckedSite[],
  historical: readonly HistoricalFigure[],
): CountPhrase[] {
  const checkedKeys = new Set(checked.map(siteKey));
  const historicalKeys = new Set(historical.map(historyKey));

  return phrases.filter(
    (phrase) => !checkedKeys.has(siteKey(phrase)) && !historicalKeys.has(historyKey(phrase)),
  );
}

/**
 * `HISTORICAL` entries that no longer match anything.
 *
 * The same argument as `expectSites` and `KNOWN_DANGLING`, one level along: a
 * blessing that has outlived its phrase is a permanent hole waiting for a new
 * count to fall into it. If somebody rewrites a war story, the entry that
 * excused it should fail rather than sit there excusing whatever lands next.
 */
export function staleHistorical(
  phrases: readonly CountPhrase[],
  historical: readonly HistoricalFigure[],
): HistoricalFigure[] {
  const present = new Set(phrases.map(historyKey));
  return historical.filter((entry) => !present.has(historyKey(entry)));
}
