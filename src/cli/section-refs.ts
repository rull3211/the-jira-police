/**
 * `§N` cross-references, resolved against the headings that would satisfy them.
 *
 * The most-used citation form in the repository, appearing in `.ts` comments as well as prose,
 * and the only check for it.
 *
 * refs:off
 *
 * Almost no citation names its target document — `§7b` in `src/watch/decide.ts` says nothing
 * about where §7b would live — so the strongest rule available is that the token is a heading in
 * **some** section-numbered document. A clean run does not mean the cross-references are right:
 * six sites say "§1 refuses on-disk state" when that rule is `ARCHITECTURE.md` §5, and those need
 * a human.
 *
 * refs:on
 *
 * The exemption is a region, not a file, because checking markdown means the check would flag
 * prose that discusses dangling references, like this comment, as more of them.
 */

/** A `§N` occurrence in the tree, with enough to go and look at it. */
export interface SectionRef {
  readonly file: string;
  readonly line: number;
  /** The token without its `§`, e.g. `7b`, `6.1c`, `14.12`. */
  readonly id: string;
}

/**
 * Where a document's section numbers come from. Declared per document, not inferred:
 *
 * refs:off
 *
 * a rule that "any numbered list under a section defines sub-sections" would make `§6.1` legal
 * the moment §6 grew a list, and `§6.1` is one of the references this exists to catch.
 *
 * refs:on
 */
export interface DocumentShape {
  /** Path relative to the repository root. */
  readonly path: string;
  /**
   * The one section whose top-level numbered list items are addressable as `<section>.<item>` —
   * `ARCHITECTURE.md` §14's invariants are cited as `§14.11`. Absent where no list is addressable.
   */
  readonly numberedListIn?: string;
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/gm;

/** A numbered heading: `## 14. Invariants`, `### 2a. The simplify pass`. */
const NUMBERED = /^(\d+[a-z]?)\.[ \t]/u;

/** A top-level item of the one addressable list: `11. **A label write ...` */
const LIST_ITEM = /^(\d+)\.[ \t]+\*\*/gmu;

/**
 * The section ids a document defines: headings, plus `<section>.<item>` for the one document
 * with an addressable list.
 */
export function sectionIds(
  body: string,
  shape: Pick<DocumentShape, "numberedListIn">,
): Set<string> {
  const found = new Set<string>();

  // Unnumbered headings matter too: they bound a section (§14 ends at the next heading of its
  // level or above), and the invariants list is what lies between.
  const headings = [...body.matchAll(HEADING)].map((match) => ({
    level: (match[1] ?? "").length,
    text: match[2] ?? "",
    at: match.index,
  }));

  for (const [index, heading] of headings.entries()) {
    const numbered = NUMBERED.exec(heading.text);
    const id = numbered?.[1];
    if (id === undefined) {
      continue;
    }
    found.add(id);

    if (id !== shape.numberedListIn) {
      continue;
    }
    const ends = headings.slice(index + 1).find((later) => later.level <= heading.level);
    const span = body.slice(heading.at, ends?.at ?? body.length);
    for (const item of span.matchAll(LIST_ITEM)) {
      found.add(`${id}.${item[1]}`);
    }
  }

  return found;
}

/**
 * A marker is a line that is *only* a marker, once comment punctuation is stripped:
 * `<!-- refs:off -->`, `// refs:off`, ` * refs:off`.
 *
 * Deliberately not a substring search — this file documents its own markers, so a substring
 * rule would let the sentence naming both tokens open and close a region by itself.
 */
const MARKER = /^[\s*/]*(?:<!--)?\s*refs:(off|on)\s*(?:-->)?\s*(?:\*\/)?\s*$/u;

/**
 * Blanks out `refs:off` regions line by line, keeping every line number after them true.
 *
 * An unterminated region runs to the end of the file rather than being ignored — a forgotten
 * closing marker is noticed that way, where silently ignoring it reads identically in the diff.
 */
export function maskDisabled(body: string): string {
  let masked = false;
  return body
    .split("\n")
    .map((line) => {
      const marker = MARKER.exec(line);
      if (marker !== null) {
        masked = marker[1] === "off";
        return "";
      }
      return masked ? "" : line;
    })
    .join("\n");
}

const REFERENCE = /§(\d+[a-z]?(?:\.\d+[a-z]?)*)/gu;

/** Every `§N` in one file, with `refs:off` regions already removed. */
export function referencesIn(file: string, body: string): SectionRef[] {
  const masked = maskDisabled(body);
  const found: SectionRef[] = [];
  for (const match of masked.matchAll(REFERENCE)) {
    const id = match[1];
    if (id === undefined) {
      continue;
    }
    found.push({ file, line: masked.slice(0, match.index).split("\n").length, id });
  }
  return found;
}

/**
 * The references naming a section no document defines — deliberately not "references whose
 * target document disagrees," which this cannot answer. See the header.
 */
export function unresolved(
  refs: readonly SectionRef[],
  defined: ReadonlySet<string>,
): SectionRef[] {
  return refs.filter((ref) => !defined.has(ref.id));
}
