/**
 * `§N` cross-references, resolved against the headings that would satisfy them.
 *
 * This is the most-used citation form in the repository and the only one that
 * appears in `.ts` comments as well as in prose, and until this file existed
 * nothing checked it. Thirty-nine references named a section that has never
 * been a heading in any document here — not renamed, not renumbered, never
 * written — and they were found by reading, which does not scale and does not
 * happen twice.
 *
 * refs:off
 *
 * **What it can prove, and it is weaker than it looks.** Almost no citation
 * names its target document: `§7b` in `src/watch/decide.ts` says nothing about
 * where §7b would live. So the strongest rule available is _this token is a
 * heading in **some** section-numbered document_. That is enough to catch every
 * one of the 39, and it is not enough to catch a reference that still resolves
 * while meaning something else — six sites say "§1 refuses on-disk state" when
 * that rule is `ARCHITECTURE.md` §5. Those need a human, and this file's job is
 * to shrink the set that needs one rather than to claim it is empty. A clean
 * run here does not mean the cross-references are right.
 *
 * refs:on
 *
 * **Why the exemption is a region and not a file.** Checking markdown means the
 * check reads the documents that _discuss_ dangling references — this file's
 * own plan entry quotes ten of them — so prose about the problem would fail the
 * check for the problem. The last count added to `docs:check` had the same
 * shape and was fixed by narrowing its scope to `.ts`; that cannot work here,
 * because four of the 39 are in `ARCHITECTURE.md`. A file-level exemption would
 * silently cover every reference added to that document afterwards, so the
 * exemption is `refs:off` / `refs:on` around the paragraph that needs it.
 */

/** A `§N` occurrence in the tree, with enough to go and look at it. */
export interface SectionRef {
  readonly file: string;
  readonly line: number;
  /** The token without its `§`, e.g. `7b`, `6.1c`, `14.12`. */
  readonly id: string;
}

/**
 * Where a document's section numbers come from. Declared per document rather
 * than inferred, because inference here loses the check:
 *
 * refs:off
 *
 * a rule that "any numbered list under a section defines sub-sections" would
 * make `§6.1` legal the moment §6 grew a list, and `§6.1` is one of the
 * references this exists to catch.
 *
 * refs:on
 */
export interface DocumentShape {
  /** Path relative to the repository root. */
  readonly path: string;
  /**
   * The one section whose top-level numbered list items are themselves
   * addressable, as `<section>.<item>` — `ARCHITECTURE.md` §14's invariants are
   * cited as `§14.11`. Absent for documents where no list is addressable.
   */
  readonly numberedListIn?: string;
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/gm;

/** A numbered heading: `## 14. Invariants`, `### 2a. The simplify pass`. */
const NUMBERED = /^(\d+[a-z]?)\.[ \t]/u;

/** A top-level item of the one addressable list: `11. **A label write ...` */
const LIST_ITEM = /^(\d+)\.[ \t]+\*\*/gmu;

/**
 * The section ids a document defines. Both the headings and, for the one
 * document that has an addressable list, `<section>.<item>` for each of its
 * items.
 */
export function sectionIds(
  body: string,
  shape: Pick<DocumentShape, "numberedListIn">,
): Set<string> {
  const found = new Set<string>();

  // Every heading, numbered or not, because the *un*numbered ones are what
  // bound a section: §14 ends at the next heading of its level or above, and
  // the invariants list is what lies between.
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
 * A marker is a line that is *only* a marker, once comment punctuation is
 * stripped: `<!-- refs:off -->`, `// refs:off`, ` * refs:off`.
 *
 * Deliberately not a substring search. This file has to document its own
 * markers, and a substring rule would let the sentence explaining them open
 * and close regions — which it did, on the first run: the prose at the top
 * naming both tokens closed the region that was hiding the examples above it.
 * Requiring the marker to be the whole line means writing about it is free.
 */
const MARKER = /^[\s*/]*(?:<!--)?\s*refs:(off|on)\s*(?:-->)?\s*(?:\*\/)?\s*$/u;

/**
 * Blanks out `refs:off` regions line by line, which keeps every line number
 * after them true. An unterminated region runs to the end of the file rather
 * than being ignored: forgetting the closing marker then silences the rest of
 * the document, which someone notices, where the alternative silences nothing
 * and reads identically in the diff.
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
 * The references naming a section no document defines. Deliberately not
 * "references whose target document disagrees" — see the header; that is a
 * question this cannot answer.
 */
export function unresolved(
  refs: readonly SectionRef[],
  defined: ReadonlySet<string>,
): SectionRef[] {
  return refs.filter((ref) => !defined.has(ref.id));
}
