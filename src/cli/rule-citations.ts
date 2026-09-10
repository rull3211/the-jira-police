/**
 * Rules and incidents, checked where the corpus supports a check and counted
 * where it does not.
 *
 * **Guarded: every citation resolves, and every entry has a rule or a
 * declaration that parses.** Measured on 2026-09-09 by this file against the
 * tree: 44 entries, 39 of them cited from the six documents in `CITING_FILES`,
 * 69 citation links, none dangling. That nothing dangles today is the argument
 * for the check and not against it — anchors follow headings, so retitling one
 * entry breaks every link to it from the other files at once, silently, without
 * either document being edited. The second half is the same fact read
 * backwards: an incident with no rule is a story, so an entry nothing cites
 * either gets a rule or says in the file that it has not got one, in a
 * `**No rule yet**` line that is parsed rather than read.
 *
 * **Reported and guarded by nobody: how many rule paragraphs cite no
 * incident.** 42 of the 71, on the same measurement. "Every rule cites an
 * incident" is a property somebody wants, not one this corpus has. The
 * population is every paragraph opening with a bold sentence at column zero,
 * and 18 of those 42 are file openers, reading pointers, list lead-ins and
 * section labels rather than rules — one of them is the sentence "Why every
 * rule here exists is in `INCIDENTS.md`", flagged for citing no incident. There
 * is no per-paragraph citation convention here to enforce, so the only routes
 * to green are 42 citations written to satisfy a check, or a grandfather list
 * longer than the debt it excuses and still present after it is paid. The
 * number goes in the summary instead: the same move this file already makes for
 * the authoring gap below, for the same reason.
 *
 * **What this deliberately does not check.** Whether the incident a rule cites
 * is the incident it came from. A link resolving proves the slug exists, not
 * that the story underneath supports the rule; that needs a human, and this
 * file's job is to shrink the set that needs one rather than to claim it is
 * empty. A clean run here does not mean the rules are earned.
 *
 * **And it does not guard the authoring gap.** Writing the incident and its
 * rule in one commit was considered as a rule and rejected as too clever: it is
 * not decidable at the moment it fires, because an incident found this
 * afternoon legitimately producing its rule this afternoon is the behaviour we
 * want, and the same argument is already made in writing in `CLAUDE.md` about
 * `commit-brief.sh` carrying no permission decision. The gap is reported as a
 * number and guarded by nobody.
 *
 * This module is separate from `docs-check.ts` rather than inside it for the
 * reason `pinned-prose.ts` gives: that file is a top-level script with no
 * exports, which is why it is the only one of `docs:check`'s own modules with
 * no test — the entrypoints `poll-once`, `solve-once` and `watch-once` have
 * none either, for the same reason. These are the two checks whose failure mode
 * is silently matching nothing, so they are the last two that could afford to
 * live somewhere a test cannot reach.
 *
 * No line count here on purpose: the first draft said "755-line", and the same
 * commit added 322 lines to that file. A number describing a file this one only
 * refers to has no check behind it and rots the moment either moves.
 */

import { dirname, join, normalize } from "node:path/posix";

/** A document, by repository-relative path, and its contents. */
export interface SourceFile {
  readonly path: string;
  readonly body: string;
}

/**
 * The documents whose citations count as a rule citing an incident.
 *
 * **The exclusions are the whole value of this list.**
 * `.claude/skills/claude-validation-work/SKILL.md` carries two citations into
 * `INCIDENTS.md`, and both name entries nothing else cites: admitting that one
 * file turns two of the five uncited entries green, on a citation from a skill
 * that is on no reading path and is loaded only when somebody invokes it by
 * name. An incident whose only rule lives there has not produced a rule; it has
 * produced a footnote in a document the working contract never routes you to.
 * `.claude/skills/scaffolding-audit/SKILL.md` is the other off-path skill and
 * cites no entry at all today, which is the state in which an inclusion gets
 * added without anybody noticing what it forgives. If either is ever put on the
 * path from `SKILL.md`, add it here in the same commit that does so.
 *
 * Listed by exact path rather than by directory, following `NOT_OURS` in
 * `docs-check.ts`: an exemption that covers a folder quietly covers the next
 * file put in it, and this list has the opposite failure — an *inclusion* that
 * covers a folder quietly blesses the next skill written under it.
 */
export const CITING_FILES: readonly string[] = [
  "CLAUDE.md",
  ".claude/skills/dev-house-rules/SKILL.md",
  ".claude/skills/dev-house-rules/STARTING.md",
  ".claude/skills/dev-house-rules/BUILDING.md",
  ".claude/skills/dev-house-rules/PROVING.md",
  ".claude/skills/dev-house-rules/FINISHING.md",
];

/** The four phase files, which are where rule paragraphs are looked for. */
export const PHASE_FILES: readonly string[] = [
  ".claude/skills/dev-house-rules/STARTING.md",
  ".claude/skills/dev-house-rules/BUILDING.md",
  ".claude/skills/dev-house-rules/PROVING.md",
  ".claude/skills/dev-house-rules/FINISHING.md",
];

/**
 * How many rule paragraphs each phase file is known to have.
 *
 * **This pin is the only thing between the reported bare count and a silent
 * zero.** Nothing fails on how many rule paragraphs cite no incident — see the
 * header — so that number's only job is to be read, and a dead extractor
 * reports "0 citing no incident", which reads like the debt was paid. Change
 * how a rule opens — indent it, wrap it in a list, reflow the `**` onto a
 * second line — and a derived population finds nothing, compares nothing, and
 * is green forever. Declared rather than derived for the reason `docs-check.ts`
 * declares `expectSites` and `pinned-prose.ts` declares `CHECKLIST_QUESTIONS`,
 * and it is the one thing here that fails on the extractor rather than on the
 * corpus.
 *
 * Two-sided on purpose. Fewer means the extractor lost sight of rules that are
 * still there; more means rules arrived without anyone updating the count they
 * are pinned by.
 */
export const RULE_PARAGRAPHS: Record<string, number> = {
  ".claude/skills/dev-house-rules/STARTING.md": 15,
  ".claude/skills/dev-house-rules/BUILDING.md": 13,
  ".claude/skills/dev-house-rules/PROVING.md": 27,
  ".claude/skills/dev-house-rules/FINISHING.md": 16,
};

/**
 * How many `**No rule yet**` declarations are written in `INCIDENTS.md`.
 *
 * **Counted against declarations in the file, not against entries nothing
 * cites.** Those two were confused when this constant first got a value: it was
 * set to 5 by pointing at the five uncited entries, at a moment when the file
 * carried no declaration at all, so the check it pins was red the day it
 * shipped. The five are written now — one per uncited entry, each naming what
 * would have to be true and when it comes due — which is what makes 5 the
 * number. An uncited entry that carries no declaration is a different failure,
 * reported per entry.
 *
 * **Exact, not a ceiling, for the same reason `KNOWN_DANGLING` is.** Fewer
 * means somebody wrote one of the missing rules and left this number claiming a
 * debt that is already paid, which is how a budget stops being read. More means
 * a new entry took the exemption. Both are worth stopping for.
 *
 * There is deliberately no grandfather list. 39 of the 44 entries cite a rule
 * today, and a clause forgiving the other five by path would be longer than the
 * debt it excuses — and would still be here after the debt was paid. A
 * declaration expires; a path exemption does not.
 */
export const UNRESOLVED_ON_PURPOSE = 5;

/** How stale a dated `**No rule yet**` is allowed to get. */
export const UNRESOLVED_DAYS = 30;

/**
 * Fenced code blocks, blanked line by line so every line number after them
 * stays true — the same trick `section-refs.ts` uses for `refs:off` regions,
 * and for the same reason: a message that points at the wrong line is a message
 * somebody stops trusting.
 *
 * A fence closes only on a marker of the same character and at least the same
 * length, which is what lets a ```` ``` ```` block contain a `~~~` sample.
 */
export function maskFences(body: string): string {
  let fence: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
      if (fence === null) {
        if (marker !== undefined) {
          fence = marker;
          return "";
        }
        return line;
      }
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      return "";
    })
    .join("\n");
}

/**
 * A rule paragraph: a paragraph opening at column zero with a bold sentence.
 *
 * **The definition was picked by measurement, out of three.** `^#{2,4} `
 * headings give 46, which is a section and not a rule — most sections here
 * carry three or four. Any line containing bold gives 157, which sweeps in
 * every checklist item and every table cell. A bold sentence at column zero
 * gives 71, and it is the shape the corpus mostly uses for "here is a rule".
 *
 * **Mostly, not always, which is why nothing fails on this population.** 18 of
 * the 71 are file openers, reading pointers, list lead-ins and section labels
 * wearing the same shape. The definition is not tightened to exclude them,
 * because every tightening is a place a rule could be parked out of sight, and
 * the number it feeds is reported rather than enforced — an over-broad
 * population costs an inflated count in the summary and nothing else.
 *
 * **The obvious noise is excluded by the definition rather than by an exemption
 * list.** `- **…**` list items do not start at column zero, so `FINISHING.md`'s
 * eleven-item checklist and the four pinned questions are out without anything
 * naming them; table rows start with `|`, so they are out too. An exemption
 * list would have had to be maintained against every new checklist.
 */
export interface RuleParagraph {
  readonly file: string;
  /** 1-indexed, in the unmasked file. */
  readonly line: number;
  /** The bold opening sentence, without its `**`. */
  readonly headline: string;
  /** The rule's own paragraph plus, when it is not itself a rule, the next one. */
  readonly scope: string;
}

const RULE_OPENS = /^\*\*(.+?)\*\*/u;

/**
 * A run of non-blank lines, with the 1-indexed line it starts on.
 *
 * Paragraphs rather than lines, because **the headline is matched against the
 * flattened paragraph and not against its first line.** Four of the 71 rules
 * here wrap their bold sentence onto a second line, and a line-at-a-time match
 * finds none of them — which is not a hypothetical: `oxfmt` reflows this prose,
 * so which rules a line-based extractor can see is decided by the formatter.
 * `pinned-prose.ts` hit the same thing and its header says so in one sentence:
 * matching line-by-line looks correct in the file and breaks the moment a
 * headline wraps.
 */
function paragraphsOf(body: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let start: number | null = null;
  const lines = body.split("\n");

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      if (start !== null) {
        found.push({ line: start + 1, text: lines.slice(start, index).join("\n") });
        start = null;
      }
      continue;
    }
    start ??= index;
  }
  if (start !== null) {
    found.push({ line: start + 1, text: lines.slice(start).join("\n") });
  }

  return found;
}

function headlineOf(paragraph: string): string | undefined {
  if (!paragraph.startsWith("**")) {
    return undefined;
  }
  return RULE_OPENS.exec(paragraph.replaceAll(/\s+/gu, " "))?.[1];
}

/**
 * Every rule paragraph in one document.
 *
 * A rule's scope is its own paragraph and the paragraph after it — the corpus
 * puts the `[→ …](INCIDENTS.md#…)` citation on its own line, sometimes inside
 * the paragraph and sometimes after a blank. The following paragraph is
 * **not** in scope when it is itself a rule, because then the citation belongs
 * to that one, and rules here are routinely written back to back.
 *
 * Attribution decides only the reported count of paragraphs citing nothing, not
 * whether anything fails. It is kept exact anyway: a number that quietly credits
 * one paragraph's citation to its neighbour is a number that reads better than
 * the corpus is, which is the failure this whole file was written out of.
 */
export function ruleParagraphs(file: string, body: string): RuleParagraph[] {
  const paragraphs = paragraphsOf(maskFences(body));
  const found: RuleParagraph[] = [];

  for (const [index, paragraph] of paragraphs.entries()) {
    const headline = headlineOf(paragraph.text);
    if (headline === undefined) {
      continue;
    }

    const next = paragraphs[index + 1];
    const trailing =
      next !== undefined && headlineOf(next.text) === undefined ? `\n${next.text}` : "";

    found.push({
      file,
      line: paragraph.line,
      headline,
      scope: `${paragraph.text}${trailing}`,
    });
  }

  return found;
}

/** `INCIDENTS.md#the-slug`, and only with an anchor — a bare link cites nothing. */
const INCIDENT_LINK = /\]\(([^)\s#]*INCIDENTS\.md)#([^)\s]+)\)/gu;

/** An entry: `### <title>` in `INCIDENTS.md`, and whatever it says about its rule. */
export interface IncidentEntry {
  /** 1-indexed. */
  readonly line: number;
  readonly title: string;
  readonly slug: string;
  readonly unresolved: Unresolved | null;
}

/** A parsed `**No rule yet**` line. `kind: "malformed"` means it did not parse. */
export type Unresolved =
  | { readonly kind: "dated"; readonly on: string }
  | { readonly kind: "counted"; readonly tag: string; readonly at: number }
  | { readonly kind: "malformed"; readonly text: string };

/**
 * `**No rule yet** — <what would have to be true>, and <a date, or a count>.`
 *
 * Shaped after the `**Found by**` line the file already carries, and parsed
 * rather than read: a deliberate exemption that nothing can check is a comment,
 * and this repository's whole subject is what happens to those. The trailing
 * clause is required to be the last thing on the line so that a date mentioned
 * in the reason cannot be mistaken for the deadline.
 */
const NO_RULE_YET = /\*\*No rule yet\*\*\s*—\s*(.+?),\s+and\s+(.+?)\.\s*$/u;

const DATED = /^(\d{4}-\d{2}-\d{2})$/u;
const COUNTED = /^`([\w:-]+)`\s+at\s+(\d+)$/u;

function parseUnresolved(text: string): Unresolved {
  const declaration = NO_RULE_YET.exec(text.replaceAll(/\s+/gu, " ").trim());
  if (declaration === null) {
    return { kind: "malformed", text: text.replaceAll(/\s+/gu, " ").trim() };
  }

  const tail = declaration[2] ?? "";
  const dated = DATED.exec(tail);
  if (dated?.[1] !== undefined) {
    return { kind: "dated", on: dated[1] };
  }

  const counted = COUNTED.exec(tail);
  if (counted?.[1] !== undefined && counted[2] !== undefined) {
    return { kind: "counted", tag: counted[1], at: Number(counted[2]) };
  }

  return { kind: "malformed", text: tail };
}

const ENTRY_HEADING = /^### +(.+?)\s*$/u;
const SECTION_HEADING = /^#{1,3} /u;

/** Every `### ` entry in `INCIDENTS.md`, with its declaration if it has one. */
export function incidentEntries(
  body: string,
  slugOf: (heading: string) => string,
): IncidentEntry[] {
  const lines = maskFences(body).split("\n");
  const found: IncidentEntry[] = [];

  for (const [index, line] of lines.entries()) {
    const title = ENTRY_HEADING.exec(line)?.[1];
    if (title === undefined) {
      continue;
    }

    let end = index + 1;
    while (end < lines.length && !SECTION_HEADING.test(lines[end] ?? "")) {
      end++;
    }

    // The declaration is taken as a *paragraph*, not as a line. `oxfmt` reflows
    // this prose and the trailing `, and <a date, or a count>.` is the last
    // thing on it, so a line-at-a-time read loses exactly the half that is
    // parsed and reports every wrapped declaration as malformed.
    const opens = lines
      .slice(index, end)
      .findIndex((entryLine) => entryLine.startsWith("**No rule yet**"));
    let declared: string | undefined;
    if (opens !== -1) {
      let closes = index + opens;
      while (closes + 1 < end && (lines[closes + 1] ?? "").trim() !== "") {
        closes++;
      }
      declared = lines.slice(index + opens, closes + 1).join(" ");
    }

    found.push({
      line: index + 1,
      title,
      slug: slugOf(title),
      unresolved: declared === undefined ? null : parseUnresolved(declared),
    });
  }

  return found;
}

/**
 * Which incident slugs one document cites, resolved against that document's own
 * location.
 *
 * Per source file, not by substring: `CLAUDE.md` writes the path as
 * `.claude/skills/dev-house-rules/INCIDENTS.md` and the phase files write it as
 * `INCIDENTS.md`, and a check that matched the tail of either would also count
 * a link into some other repository's `INCIDENTS.md` the day one appears.
 */
export function citedSlugs(source: SourceFile, incidentsPath: string): Set<string> {
  const target = normalize(incidentsPath);
  const found = new Set<string>();
  for (const match of maskFences(source.body).matchAll(INCIDENT_LINK)) {
    const [, path, anchor] = match;
    if (path === undefined || anchor === undefined) {
      continue;
    }
    if (normalize(join(dirname(source.path), path)) === target) {
      found.add(anchor);
    }
  }
  return found;
}

/** Everything the check needs, and no way for it to read the disk itself. */
export interface RuleCitationInput {
  /** Repository-relative path of `INCIDENTS.md`, to resolve links against. */
  readonly incidentsPath: string;
  readonly incidents: string;
  /** One entry per `CITING_FILES` path. */
  readonly citing: readonly SourceFile[];
  /**
   * `slugOf` from `docs-check.ts`, passed in rather than copied. GitHub's
   * heading-to-anchor rule is a fact with one home, and this check exists
   * because facts with two homes drift.
   */
  readonly slugOf: (heading: string) => string;
  /** Passed in so the dated exemption can be tested without waiting a month. */
  readonly today: Date;
  /**
   * Minutes between an incident being written and its rule citing it, most
   * recent first. Reported, never guarded — see the header.
   */
  readonly authoringGaps?: readonly number[];
  /**
   * The pinned counts, defaulting to the constants above.
   *
   * Overridable for one reason: a pin that cannot be given a wrong value in a
   * test is a pin nothing proves fires. Production passes neither of these.
   */
  readonly population?: Readonly<Record<string, number>>;
  readonly unresolvedOnPurpose?: number;
}

export interface RuleCitationReport {
  readonly problems: readonly string[];
  /** The line printed whether or not anything failed. */
  readonly summary: string;
}

/** The median, or `null` when there is nothing to take it of. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** How many of the most recent gaps the reported median is taken over. */
export const GAP_WINDOW = 15;

const DAY = 24 * 60 * 60 * 1000;

/**
 * `git log` arguments that find when an incident heading was first written, and
 * when the first citation of its slug was. Built here rather than in
 * `docs-check.ts` so the semantics of "authoring gap" live beside the check
 * that reports it, and so they can be asserted.
 */
export function incidentAddedArgs(entry: IncidentEntry, incidentsPath: string): string[] {
  return ["log", "--reverse", "--format=%ct", `-S### ${entry.title}`, "--", incidentsPath];
}

export function ruleCitedArgs(entry: IncidentEntry, citing: readonly string[]): string[] {
  return ["log", "--reverse", "--format=%ct", `-S#${entry.slug}`, "--", ...citing];
}

/**
 * Every failure, as messages ready to print, plus the one line that prints
 * either way.
 *
 * Order matters for reading: the population check comes first, because if it
 * has moved then every count after it is describing a population nobody has
 * agreed to — including the reported one, which nothing else would catch.
 */
export function ruleCitationProblems(input: RuleCitationInput): RuleCitationReport {
  const problems: string[] = [];
  const byPath = new Map(input.citing.map((file) => [file.path, file]));

  for (const path of CITING_FILES) {
    if (!byPath.has(path)) {
      problems.push(
        `rule citations: ${path} is in CITING_FILES but was not handed to the check.\n` +
          `  Every citing document has to be read, or the incidents it cites look uncited. Fix the\n` +
          `  list in src/cli/rule-citations.ts and the reader in src/cli/docs-check.ts together.`,
      );
    }
  }

  // The rule paragraphs, extracted only so the count can be pinned and
  // reported. Nothing below fails on whether one of them cites anything.
  const rules: RuleParagraph[] = [];
  for (const path of PHASE_FILES) {
    const file = byPath.get(path);
    if (file === undefined) {
      continue;
    }
    rules.push(...ruleParagraphs(path, file.body));
  }

  for (const [path, expected] of Object.entries(input.population ?? RULE_PARAGRAPHS)) {
    if (!byPath.has(path)) {
      continue;
    }
    const actual = rules.filter((rule) => rule.file === path).length;
    if (actual !== expected) {
      problems.push(
        `${path}: RULE_PARAGRAPHS says ${expected} rule paragraph(s), extracted ${actual}.\n` +
          `  ${actual < expected ? "Either paragraphs were removed, or one stopped opening with a bold sentence at column zero and this check can no longer see it — which quietly lowers the count reported below and reads like a debt being paid." : "Paragraphs were added."}\n` +
          `  The population is every paragraph opening **…** at column zero outside a fence. Nothing\n` +
          `  fails on whether they cite an incident; this pin proves only that the count is still\n` +
          `  being taken. If the population genuinely changed, update RULE_PARAGRAPHS in\n` +
          `  src/cli/rule-citations.ts in the same commit.`,
      );
    }
  }

  const entries = incidentEntries(input.incidents, input.slugOf);
  const slugs = new Set(entries.map((entry) => entry.slug));

  // How many rule paragraphs cite nothing. Reported in the summary and never a
  // problem — the header says why, and `RULE_PARAGRAPHS` above is what stops
  // this number reaching zero by the extractor dying rather than by the corpus
  // changing.
  const bare = rules.filter((rule) => [...rule.scope.matchAll(INCIDENT_LINK)].length === 0).length;

  // Direction 1 — every citation resolves to an entry that is there.
  //
  // Over whole documents rather than over rule scopes. A citation is at risk
  // from a heading being renamed wherever it sits, and half of them sit outside
  // any rule's scope: of the 69 in the tree on 2026-09-09, 13 are table rows
  // and 20 are indented continuations, and not one of the 69 opens a bold
  // paragraph. Scoping the check to rule paragraphs inspects 37 of the 69 and
  // says nothing about the other 32.
  //
  // Direction 2's `cited` set is built in the same pass, and is filtered
  // against `CITING_FILES` here rather than trusting what the caller handed
  // over. The exclusion of the two off-path skills is the whole value of that
  // direction, and an exclusion a caller can undo by passing one more file is
  // not one.
  const counts = new Set(CITING_FILES);
  const cited = new Set<string>();
  for (const file of input.citing) {
    if (!counts.has(file.path)) {
      continue;
    }
    for (const slug of citedSlugs(file, input.incidentsPath)) {
      cited.add(slug);
      if (!slugs.has(slug)) {
        // `docs-check.ts`'s link check reports the broken anchor. This says the
        // other half, and it is worth saying twice because the repairs differ:
        // one is a typo in a link, the other is a document standing on evidence
        // that is not there.
        problems.push(
          `${file.path} cites ${input.incidentsPath}#${slug}, which is not an entry there.\n` +
            `  Either the entry was retitled — anchors follow the heading, so renaming one heading\n` +
            `  breaks every citation of it at once, in files nobody edited — or it was never\n` +
            `  written. Fix the link, or write the entry.`,
        );
      }
    }
  }

  const declared = entries.filter((entry) => entry.unresolved !== null);
  const tagged = new Map<string, number>();
  for (const entry of declared) {
    if (entry.unresolved?.kind === "counted") {
      tagged.set(entry.unresolved.tag, (tagged.get(entry.unresolved.tag) ?? 0) + 1);
    }
  }

  for (const entry of entries) {
    const unresolved = entry.unresolved;

    if (unresolved === null) {
      if (!cited.has(entry.slug)) {
        problems.push(
          `${input.incidentsPath}:${entry.line} has produced no rule that cites it.\n` +
            `  "${entry.title}"\n` +
            `  Nothing in ${CITING_FILES.length} rule documents links to #${entry.slug}. A story with\n` +
            `  no rule is a story. Write the rule, or declare the gap on purpose with a trailing\n` +
            `  **No rule yet** — <what would have to be true>, and <a date, or \`tag\` at N>.`,
        );
      }
      continue;
    }

    if (cited.has(entry.slug)) {
      problems.push(
        `${input.incidentsPath}:${entry.line} says **No rule yet**, and a rule cites it.\n` +
          `  "${entry.title}"\n` +
          `  Remove the declaration and lower UNRESOLVED_ON_PURPOSE in src/cli/rule-citations.ts.`,
      );
      continue;
    }

    if (unresolved.kind === "malformed") {
      problems.push(
        `${input.incidentsPath}:${entry.line} has a **No rule yet** line that does not parse.\n` +
          `  "${unresolved.text}"\n` +
          `  The shape is: **No rule yet** — <what would have to be true to write one>, and <a\n` +
          `  date, or \`tag\` at N>. It is parsed rather than read, because a deliberate exemption\n` +
          `  nothing can check is just a comment.`,
      );
      continue;
    }

    if (unresolved.kind === "dated") {
      const due = Date.parse(unresolved.on);
      if (Number.isNaN(due)) {
        problems.push(
          `${input.incidentsPath}:${entry.line} declares **No rule yet** as of ${unresolved.on}, which is not a date.`,
        );
        continue;
      }
      const days = Math.floor((input.today.getTime() - due) / DAY);
      if (days > UNRESOLVED_DAYS) {
        problems.push(
          `${input.incidentsPath}:${entry.line} has been waiting for a rule since ${unresolved.on} — ${days} days.\n` +
            `  "${entry.title}"\n` +
            `  A dated exemption is a promise with a deadline, and ${UNRESOLVED_DAYS} days is it. Write the\n` +
            `  rule, or replace the date with what is actually still missing.`,
        );
      }
      continue;
    }

    const instances = tagged.get(unresolved.tag) ?? 0;
    if (instances >= unresolved.at) {
      problems.push(
        `${input.incidentsPath}:${entry.line} waits for ${unresolved.at} instance(s) of \`${unresolved.tag}\`, and there are ${instances}.\n` +
          `  "${entry.title}"\n` +
          `  This is the file's own instruction — "at instance two, write it" — coming due. The\n` +
          `  entry that waited seven instances is why it is mechanical now.`,
      );
    }
  }

  const owed = input.unresolvedOnPurpose ?? UNRESOLVED_ON_PURPOSE;
  if (declared.length !== owed) {
    // Three different repairs, and the middle one used to be printed for all
    // three: "some were paid" was the message on a tree where none had ever
    // been written, which is the confusion that gave this constant its first
    // wrong value. It counts **No rule yet** lines, not entries nothing cites.
    const why =
      declared.length > owed
        ? "A new entry took the exemption — that is a debt going up, not a number to raise."
        : declared.length === 0
          ? "None is written. Either they were never written and this number was set by counting something else — uncited entries, most likely — or every one was removed at once."
          : "Fewer are written than this pins. Either a declaration was removed because its rule got written, in which case lower UNRESOLVED_ON_PURPOSE in src/cli/rule-citations.ts to match, or one stopped parsing and is reported above.";
    problems.push(
      `incidents declared unresolved on purpose: ${declared.length} written in ${input.incidentsPath}, and UNRESOLVED_ON_PURPOSE says ${owed}.\n  ${why}`,
    );
  }

  const gap = median((input.authoringGaps ?? []).slice(0, GAP_WINDOW));
  const gapText =
    gap === null
      ? "authoring gap not measured"
      : `median authoring gap ${Math.round(gap)} min over the last ${Math.min((input.authoringGaps ?? []).length, GAP_WINDOW)}`;

  return {
    problems,
    summary:
      `rule<->incident: ${entries.length} entries, ${entries.filter((entry) => cited.has(entry.slug)).length} cited, ` +
      `${declared.length} declared unresolved; ${rules.length} rule paragraphs, ` +
      `${bare} citing no incident (reported, not guarded); ${gapText}`,
  };
}
