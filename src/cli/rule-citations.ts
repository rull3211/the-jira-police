/**
 * Rules and incidents, checked where the corpus supports it and counted where it does not.
 *
 * Guaranteed: every citation resolves, and every entry has a rule or a `**No rule yet**`
 * declaration. Reported only, never guarded: how many rule paragraphs cite no incident, and
 * whether a rule's citation actually supports it — both need a human to judge.
 *
 * Separate from `docs-check.ts` for the reason `pinned-prose.ts` gives, and untested for the
 * same reason `poll-once`/`solve-once`/`watch-once` are: importing it would run it.
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
 * Deliberately excludes `.claude/skills/claude-validation-work/SKILL.md` and
 * `.claude/skills/scaffolding-audit/SKILL.md` — both link into `INCIDENTS.md` but are off the
 * reading path, so a citation there is not a citation anyone is routed to. Listed by exact path
 * rather than by directory, so an inclusion cannot silently bless the next skill written there.
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
 * Pinned rather than derived: a dead extractor (say, a headline that starts wrapping across a
 * second line) would otherwise report "0 citing no incident" silently, which reads as paid debt.
 * Two-sided: fewer means the extractor lost sight of rules; more means the count went stale.
 */
export const RULE_PARAGRAPHS: Record<string, number> = {
  ".claude/skills/dev-house-rules/STARTING.md": 16,
  ".claude/skills/dev-house-rules/BUILDING.md": 16,
  ".claude/skills/dev-house-rules/PROVING.md": 27,
  ".claude/skills/dev-house-rules/FINISHING.md": 16,
};

/**
 * How many `**No rule yet**` declarations are written in `INCIDENTS.md`.
 *
 * Counted against declarations in the file, not against entries nothing cites — those are
 * different failures, each reported on its own. Exact, not a ceiling: fewer means a paid debt is
 * still being claimed, more means a new entry took the exemption without writing one.
 *
 * Deliberately no grandfather list — a path exemption never expires the way a dated declaration
 * does.
 */
export const UNRESOLVED_ON_PURPOSE = 9;

/** How stale a dated `**No rule yet**` is allowed to get. */
export const UNRESOLVED_DAYS = 30;

/**
 * Fenced code blocks, blanked line by line so every line number after them stays true.
 *
 * A fence closes only on a marker of the same character and at least the same length, which is
 * what lets a ```` ``` ```` block contain a `~~~` sample.
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
 * Picked by measurement over headings (too coarse) and any bold text (too broad); the shape is
 * not tightened further, since every tightening is a place a rule could be parked out of sight.
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
 * Paragraphs rather than lines: a bold sentence wrapped onto a second line by `oxfmt` is
 * invisible to a line-at-a-time match.
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
 * A rule's scope is its own paragraph plus the next, unless that next paragraph is itself a rule
 * — rules here are routinely written back to back, and its citation belongs to it, not its neighbour.
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
 * Parsed rather than read: a deliberate exemption nothing can check is a comment. The trailing
 * clause must be the last thing on the line so a date in the reason isn't mistaken for the deadline.
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

    // Taken as a paragraph, not a line: `oxfmt` can wrap the trailing clause onto a second line,
    // and a line-at-a-time read would report every wrapped declaration as malformed.
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
 * Which incident slugs one document cites, resolved against that document's own location.
 *
 * Resolved per source file rather than by substring match, since different documents write the
 * path to `INCIDENTS.md` differently and a substring match would also catch another repository's.
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
  /** `slugOf` from `docs-check.ts`, passed in rather than copied — a fact with two homes drifts. */
  readonly slugOf: (heading: string) => string;
  /** Passed in so the dated exemption can be tested without waiting a month. */
  readonly today: Date;
  /**
   * Minutes between an incident being written and its rule citing it, most
   * recent first. Reported, never guarded — see the header.
   */
  readonly authoringGaps?: readonly number[];
  /**
   * The pinned counts, defaulting to the constants above — overridable only so the pin can be
   * given a wrong value in a test. Production passes neither of these.
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
 * `git log` arguments finding when an incident heading was first written.
 *
 * Built here rather than in `docs-check.ts` so the semantics of "authoring gap" live beside the
 * check that reports it.
 */
export function incidentAddedArgs(entry: IncidentEntry, incidentsPath: string): string[] {
  return ["log", "--reverse", "--format=%ct", `-S### ${entry.title}`, "--", incidentsPath];
}

export function ruleCitedArgs(entry: IncidentEntry, citing: readonly string[]): string[] {
  return ["log", "--reverse", "--format=%ct", `-S#${entry.slug}`, "--", ...citing];
}

/**
 * Every failure, as messages ready to print, plus the one line that prints either way.
 *
 * Order matters: the population check comes first, since a moved population makes every count
 * after it describe something nobody agreed to.
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

  // How many rule paragraphs cite nothing — reported in the summary and never a problem, since
  // `RULE_PARAGRAPHS` above is what stops this number reaching zero by the extractor dying rather
  // than by the corpus changing.
  const bare = rules.filter((rule) => [...rule.scope.matchAll(INCIDENT_LINK)].length === 0).length;

  // Direction 1 — every citation resolves to an entry that is there.
  //
  // Checked over whole documents rather than rule scopes: half of all citations sit outside any
  // rule's scope, so scoping the check to rules would miss most of them.
  //
  // Direction 2's `cited` set is built in the same pass and filtered against `CITING_FILES` here
  // rather than trusting the caller — an exclusion the caller can undo by passing one more file
  // isn't one.
  const counts = new Set(CITING_FILES);
  const cited = new Set<string>();
  for (const file of input.citing) {
    if (!counts.has(file.path)) {
      continue;
    }
    for (const slug of citedSlugs(file, input.incidentsPath)) {
      cited.add(slug);
      if (!slugs.has(slug)) {
        // `docs-check.ts`'s link check reports the broken anchor; this says the other half — the
        // repairs differ, a typo in a link vs. a document standing on evidence that isn't there.
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
    // Counts **No rule yet** lines, not entries nothing cites — a different failure, reported
    // separately below.
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
