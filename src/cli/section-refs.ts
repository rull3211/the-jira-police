/**
 * `§N` cross-references, resolved against the document that owns the id rather than against
 * every document that happens to define one with the same number.
 *
 * The most-used citation form in the repository, appearing in `.ts` comments as well as prose,
 * and the only check for it.
 *
 * refs:off
 *
 * Almost no citation names its target document — `§7b` in `src/watch/decide.ts` says nothing
 * about where §7b would live — so resolution runs three tiers: a document name immediately before
 * the token pins it there; failing that, the citing document's own section wins over any other
 * document sharing the number, since a document is allowed to discuss its own retired numbers;
 * failing that, exactly one other document defining the id resolves unambiguously, and two or
 * more is `ambiguous` rather than a silent pick. A clean run still does not mean a resolved
 * citation names the right thing: `architecture/guardrails.md §16` resolves there because it says
 * so, not because that is provably what the author meant.
 *
 * refs:on
 *
 * The exemption is a region, not a file, because checking markdown means the check would flag
 * prose that discusses dangling references, like this comment, as more of them.
 */

import { basename } from "node:path";

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
   * `architecture/invariants.md` §14's invariants are cited as `§14.11`. Absent where no list is addressable.
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
 * How a `§N` reference resolved. `ambiguous` is the state the old pooled check could not
 * represent at all — it would pick one of `candidates` silently instead of asking for a name.
 */
export type Resolution =
  | { readonly kind: "resolved" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "dangling" };

/** How far back a qualifying document name may sit before its `§N`, in the same line. */
const QUALIFIER_WINDOW = 100;

/** A `.md` path immediately before the cursor, tolerating a closing backtick and a possessive `'s`. */
const QUALIFIER = /([\w./-]+\.md)`?[’']?s?\s*$/u;

/**
 * The document a reference names immediately before it, if any — `architecture/guardrails.md
 * §16` qualifies; a bare `§16` does not. `byBasename` is keyed by filename rather than full path
 * because every numbered document here has a distinct one, and a citation is written relative to
 * wherever it sits. Looks only within `QUALIFIER_WINDOW` characters on the same line, so an
 * unrelated `.md` mention earlier in a wrapped paragraph is not mistaken for one.
 */
export function qualifierOf(
  line: string,
  ref: Pick<SectionRef, "id">,
  byBasename: ReadonlyMap<string, string>,
): string | null {
  const marker = `§${ref.id}`;
  const at = line.indexOf(marker);
  if (at === -1) {
    return null;
  }
  const before = line.slice(Math.max(0, at - QUALIFIER_WINDOW), at);
  const name = QUALIFIER.exec(before)?.[1];
  return name === undefined ? null : (byBasename.get(basename(name)) ?? null);
}

/**
 * Resolves one reference against the documents that might define its id. See the header for the
 * three tiers; a citing document not itself in `definedByDocument` (a `.ts` file, `README.md`)
 * simply has no local tier and falls through to the other-document search.
 */
export function resolveReference(
  ref: SectionRef,
  qualifiedDoc: string | null,
  definedByDocument: ReadonlyMap<string, ReadonlySet<string>>,
): Resolution {
  if (qualifiedDoc !== null) {
    return definedByDocument.get(qualifiedDoc)?.has(ref.id) === true
      ? { kind: "resolved" }
      : { kind: "dangling" };
  }
  if (definedByDocument.get(ref.file)?.has(ref.id) === true) {
    return { kind: "resolved" };
  }
  const others = [...definedByDocument.entries()]
    .filter(([path]) => path !== ref.file)
    .filter(([, ids]) => ids.has(ref.id))
    .map(([path]) => path);
  if (others.length === 0) {
    return { kind: "dangling" };
  }
  return others.length === 1 ? { kind: "resolved" } : { kind: "ambiguous", candidates: others };
}
