/**
 * Count-noun phrases in prose, and which of them nothing is watching — catches a citation that was
 * never declared as a `FACT` at all, not just one that drifted from its declared phrasing.
 * Scoped to `COUNTED_NOUNS` rather than any `<digits> <word>` shape, because the latter matches
 * hundreds of phrases nobody cites (a count about a noun not on the list is invisible to this check).
 *
 * Its own module because `docs-check.ts` runs `vitest list` at module scope, so importing it would
 * spawn vitest inside vitest; `PLAN.md` §13 asked for `count-phrases.test.ts` to arrive with it.
 */

/**
 * What separates two words of a phrase: a space, unless the formatter wrapped the line there, or
 * the phrase sits inside a blockquote whose continuation line carries a `> ` marker instead.
 * Shared with `docs-check.ts` rather than copied, so the two can't drift on what counts as "a space".
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
 * The nouns this repository cites numbers about. Order doesn't matter: each pattern anchors its
 * digits immediately before the noun, so a shorter noun that's a prefix of a longer one
 * (`files` inside `test files`) can't falsely match — a test asserts no entry has that shape anyway.
 */
export const COUNTED_NOUNS: readonly string[] = [
  "assertions",
  "cases",
  "file-homes",
  "files",
  // Qualified rather than bare "registrations": the bare word denotes two different populations
  // elsewhere in this tree, and a noun naming two populations can't be checked against one number.
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
 * A number that is a measurement of one past run rather than a property of the tree, and so is
 * deliberately not checked. Keyed by file, value and noun together, so editing the number
 * invalidates the exemption rather than silently carrying it to a new figure.
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
 * A digit run that's part of a larger token (a PR number, currency, a version) rather than a count.
 * Checked via the character before the match rather than by widening the citation pattern itself.
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
 * The phrases nothing is watching: neither a site some `FACT` already checks, nor a declared
 * historical figure. Keyed on file, line *and* value — one line can carry two counts ("2390 tests
 * in 66 files"), so keying on line alone would bless both when only one is declared.
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

/** `HISTORICAL` entries that no longer match anything — an outlived exemption is a hole a new count could fall into. */
export function staleHistorical(
  phrases: readonly CountPhrase[],
  historical: readonly HistoricalFigure[],
): HistoricalFigure[] {
  const present = new Set(phrases.map(historyKey));
  return historical.filter((entry) => !present.has(historyKey(entry)));
}
