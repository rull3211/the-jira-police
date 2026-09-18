/**
 * `pnpm docs:check` — the numbers in the prose, checked against the code, so a fact with two homes
 * doesn't quietly drift. Citing a number this check verifies is fine; citing an unchecked one is not.
 *
 * The failure mode guarded against is the check going quiet, not a wrong number: each `Fact`
 * declares how many citation sites it expects, so a citation rephrased out of the pattern's reach
 * fails as loudly as a wrong value. `citation()` builds patterns from words, not literals, because
 * a formatter's line wrap or a blockquote's `> ` prefix breaks a literal space.
 *
 * `HISTORICAL` lists numbers that measure one past run rather than a property of the tree
 * (`PLAN.md` §13); the class check below fails on any count-noun phrase that is neither a declared
 * site nor a listed figure.
 *
 * `length-budget.ts` and `rule-citations.ts` are separate modules because importing this file runs
 * `vitest list` at import time.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { checkDiff, FORBIDDEN_PATHS, VERIFICATION_PATHS } from "../solve/diff-gate.ts";
import { SETTINGS } from "../settings.ts";
import {
  type CheckedSite,
  citation,
  countPhrasesIn,
  type HistoricalFigure,
  staleHistorical,
  unaccountedPhrases,
} from "./count-phrases.ts";
import {
  AGGREGATE_FLOOR,
  aggregateCeiling,
  budgetProblems,
  BUDGETS,
  countWords,
  parseBudgets,
  raisedCeilings,
  raiseNotice,
  ratchetProblems,
  resolveBaseline,
  unresolvedBaselineProblem,
} from "./length-budget.ts";
import { CHECKLIST_QUESTIONS, pinnedProseProblems } from "./pinned-prose.ts";
import { scopeBoundsProblems } from "./scope-bounds.ts";
import {
  CITING_FILES,
  incidentAddedArgs,
  incidentEntries,
  ruleCitationProblems,
  ruleCitedArgs,
} from "./rule-citations.ts";
import {
  type DocumentShape,
  maskDisabled,
  qualifierOf,
  referencesIn,
  resolveReference,
  type SectionRef,
  sectionIds,
} from "./section-refs.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** `process.stdout.write` is how every other command here prints; `no-console` is on. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * One check's result. `unchecked` states what a green `ok` here still doesn't prove, so the
 * closing tally is built from these rather than from a hand-written summary.
 */
interface CheckLine {
  readonly ok: boolean;
  /** What was checked, as the `ok`/`FAIL` line names it. */
  readonly what: string;
  /** The measurement that line carries. */
  readonly measured: string;
  /** What a green run of *this* check still does not say. */
  readonly unchecked: string;
}

const checks: CheckLine[] = [];

/** Print the `ok`/`FAIL` line, and keep it for the closing tally. */
function record(line: CheckLine): void {
  checks.push(line);
  say(`${line.ok ? "ok  " : "FAIL"} ${line.what}: ${line.measured}`);
}

/** Keeps a check for the tally without printing it, for the block that prints one line per `FACT` instead. */
function carry(line: CheckLine): void {
  checks.push(line);
}

/** Skipped wherever they appear, because they nest. */
const SKIP_ANYWHERE = new Set(["node_modules", ".git"]);

/**
 * Runtime and build output, skipped only at the repository root — matching by bare name at any
 * depth would also hide `src/state/`, a real source directory with a colliding name.
 */
const SKIP_AT_ROOT = new Set(["state", "groomed", "dist", "coverage"]);

function skip(dir: string, entry: string): boolean {
  return SKIP_ANYWHERE.has(entry) || (dir === ROOT && SKIP_AT_ROOT.has(entry));
}

interface Fact {
  /** What the number is, for the failure message. */
  readonly what: string;
  /** The value the tree actually has, right now. */
  readonly actual: number;
  /** The phrase being looked for, quoted back when the check stops finding it. */
  readonly phrase: string;
  /** Matches a citation and captures the cited number in group 1. */
  readonly cited: RegExp;
  /** How many sites this fact is known to have; fewer means a citation was rephrased out of reach — the silent failure. */
  readonly expectSites: number;
}

interface Citation {
  readonly file: string;
  readonly line: number;
  readonly value: number;
  readonly text: string;
}

/** Every `.md` in the tree, so a new document citing a checked number isn't exempt by omission. */
function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (skip(dir, entry)) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      markdownFiles(path, found);
    } else if (entry.endsWith(".md")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Every `.ts` under a directory; `productionModules` passes `src/` rather than `ROOT` because the
 * module map counts the service, not the tooling around it.
 */
function typescriptFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (skip(dir, entry)) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      typescriptFiles(path, found);
    } else if (entry.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

/* refs:off */
/**
 * How many `§N` references the *code* contains. Markdown is excluded deliberately: prose *about*
 * dangling citations (which must itself write tokens like `§7b` and `§3a` to describe them) would
 * otherwise perturb the count it's describing. `refs:off` / `refs:on` marks a quoted region so a
 * test fixture or a write-up can't move this number either.
 */
/* refs:on */
function sectionReferences(): number {
  let found = 0;
  for (const file of typescriptFiles(ROOT)) {
    found += (maskDisabled(readFileSync(file, "utf8")).match(/§\d/gu) ?? []).length;
  }
  return found;
}

/** Modules that are not tests, under `src/` only; `vitest.config.ts` at the root is deliberately excluded. */
function productionModules(): number {
  return typescriptFiles(join(ROOT, "src")).filter((file) => !file.endsWith(".test.ts")).length;
}

/**
 * Hook registrations under `PreToolUse` in `.claude/settings.json` — the only fact here read from
 * a file the agent may not write. Throws rather than returning 0 on a missing/unparseable file,
 * since 0 is a plausible real count and defaulting to it would silently report "no hooks wired".
 */
function preToolUseRegistrations(): number {
  const raw = readFileSync(join(ROOT, ".claude", "settings.json"), "utf8");
  const parsed = JSON.parse(raw) as { hooks?: { PreToolUse?: readonly unknown[] } };
  const entries = parsed.hooks?.PreToolUse;
  if (!Array.isArray(entries)) {
    throw new TypeError(".claude/settings.json has no PreToolUse array to count");
  }
  return entries.length;
}

/**
 * Per-ticket cost figures quoted in prose, summed into one total rather than counted separately —
 * the `PLAN.md` §13 claim is about the class of facts with many homes and no maintainer.
 */
const COST_FIGURES = ["$0.94", "$0.11", "$3.99", "$4.50"] as const;

function costHomes(files: readonly string[]): number {
  const contents = files.map((file) => readFileSync(file, "utf8"));
  return COST_FIGURES.reduce(
    (total, figure) => total + contents.filter((text) => text.includes(figure)).length,
    0,
  );
}

function citationsOf(fact: Fact, files: readonly string[]): Citation[] {
  const found: Citation[] = [];
  for (const file of files) {
    const body = readFileSync(file, "utf8");
    // A fresh matcher per file: a global regex carries lastIndex across calls,
    // and reusing one silently skips every other match.
    const matcher = new RegExp(fact.cited.source, fact.cited.flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(body)) !== null) {
      found.push({
        file: relative(ROOT, file),
        line: body.slice(0, match.index).split("\n").length,
        value: Number(match[1]),
        // The match itself, not the line: a wrapped citation has no single line to quote.
        text: match[0].replace(/\s+>?\s*/g, " "),
      });
    }
  }
  return found;
}

/** Collected via `vitest list`, not run — resolves and counts the suite in about a second, not minutes. */
function suiteShape(): { tests: number; files: number } {
  const raw = execFileSync(join(ROOT, "node_modules", ".bin", "vitest"), ["list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const entries: Array<{ name: string; file: string }> = JSON.parse(raw);
  if (entries.length === 0) {
    throw new Error("vitest list returned no tests");
  }
  return { tests: entries.length, files: new Set(entries.map((e) => e.file)).size };
}

const suite = suiteShape();

const COUNT = String.raw`\d[\d,]*`;
const CAPTURED = String.raw`(\d[\d,]*)`;

const files = markdownFiles(ROOT);

const FACTS: readonly Fact[] = [
  {
    what: "tests in the suite",
    actual: suite.tests,
    phrase: "<N> tests in <N> files",
    cited: citation(CAPTURED, "tests", "in", COUNT, "files"),
    expectSites: 2,
  },
  {
    what: "test files",
    actual: suite.files,
    phrase: "<N> tests in <N> files",
    cited: citation(COUNT, "tests", "in", CAPTURED, "files"),
    expectSites: 2,
  },
  {
    what: "settings in SETTINGS",
    actual: SETTINGS.length,
    phrase: "all <N> settings are read",
    cited: citation("all", CAPTURED, "settings", "are", "read"),
    expectSites: 1,
  },
  /**
   * Same number as the fact above, in the one place it's written as a bare count ("<N> test
   * files") rather than "<N> tests in <N> files" — a different phrasing needs its own declared site.
   */
  {
    what: "test files, written as a bare count",
    actual: suite.files,
    phrase: "<N> test files",
    cited: citation(CAPTURED, "test", "files"),
    expectSites: 1,
  },
  /** The other half of the module map's header; derived from `productionModules()` rather than counted by hand. */
  {
    what: "production modules",
    actual: productionModules(),
    phrase: "<N> production modules",
    cited: citation(CAPTURED, "production", "modules"),
    expectSites: 1,
  },
  {
    what: "section references in the tree",
    actual: sectionReferences(),
    phrase: "<N> section references",
    cited: citation(CAPTURED, "section", "references"),
    expectSites: 1,
  },
  {
    what: "PreToolUse registrations in .claude/settings.json",
    actual: preToolUseRegistrations(),
    phrase: "<N> PreToolUse registrations",
    cited: citation(CAPTURED, "PreToolUse", "registrations"),
    expectSites: 1,
  },
  {
    what: "file-homes shared by the quoted cost figures",
    actual: costHomes(files),
    phrase: "<N> file-homes",
    cited: citation(CAPTURED, "file-homes"),
    expectSites: 1,
  },
];

const problems: string[] = [];

/** Every site a `FACT` matched, so the class check below knows what is watched. */
const checkedSites: CheckedSite[] = [];

for (const fact of FACTS) {
  const sites = citationsOf(fact, files);
  checkedSites.push(...sites);
  const before = problems.length;

  if (sites.length < fact.expectSites) {
    problems.push(
      `${fact.what}: expected at least ${fact.expectSites} citation(s), found ${sites.length}.\n` +
        `  The number is not wrong — the check has stopped finding it. Either a citation was\n` +
        `  deleted (lower expectSites in src/cli/docs-check.ts and say why) or it was rephrased\n` +
        `  away from "${fact.phrase}", which is this check failing open.`,
    );
  }

  for (const site of sites) {
    if (site.value !== fact.actual) {
      problems.push(
        `${fact.what}: ${site.file}:${site.line} says ${site.value}, the tree has ${fact.actual}.\n` +
          `  ${site.text}`,
      );
    }
  }

  // Per fact, not cumulative — a running total would mark every later fact bad once one has failed.
  const mark = problems.length === before ? "ok  " : "FAIL";
  const shown = sites.length === 0 ? "no sites" : `${sites.length} site(s)`;
  say(`${mark} ${fact.what}: ${fact.actual}, ${shown}`);
}

carry({
  ok: problems.length === 0,
  what: "numbers derived from the tree",
  measured: `${FACTS.length} fact(s) across ${checkedSites.length} citation site(s)`,
  unchecked:
    "a number nobody declared. A FACT only sees the phrasing it was written for, " +
    "which is why the check below exists",
});

/**
 * Numbers that measure one past run rather than a property of the tree, so they're read rather
 * than derived. Add one only if the number can't be re-derived from the tree; if it can, it
 * belongs in `FACTS` instead.
 */
const HISTORICAL: readonly HistoricalFigure[] = [
  {
    file: ".claude/skills/claude-validation-work/SKILL.md",
    value: 93,
    noun: "assertions",
    why: "the hook suite as it stood before the exit-code assertions; the point of the sentence is that none of those 93 checked one",
  },
  {
    file: ".claude/skills/dev-house-rules/BUILDING.md",
    value: 21,
    noun: "assertions",
    why: "the guard with no production caller, as it was found. Re-deriving it would assert the past has not changed",
  },
  {
    file: ".claude/skills/dev-house-rules/INCIDENTS.md",
    value: 21,
    noun: "assertions",
    why: "same incident, told where the evidence lives",
  },
  {
    file: ".claude/skills/dev-house-rules/INCIDENTS.md",
    value: 57,
    noun: "assertions",
    why: "the hook suite at the moment rule 2 was guarded, quoted to date the incident",
  },
  {
    file: ".claude/skills/dev-house-rules/INCIDENTS.md",
    value: 87,
    noun: "assertions",
    why: "the suite when the branch-name quoting defect was found",
  },
  {
    file: ".claude/skills/dev-house-rules/INCIDENTS.md",
    value: 186,
    noun: "assertions",
    why: "the write-verb audit's before-and-after, 107 to 186. It equals today's count by coincidence of timing; the sentence is about the change, and pinning it to the tree would make an incident rewrite itself",
  },
  {
    file: ".claude/skills/dev-house-rules/PROVING.md",
    value: 87,
    noun: "assertions",
    why: "the same suite snapshot as the incident it cites",
  },
  {
    file: ".claude/skills/dev-house-rules/PROVING.md",
    value: 21,
    noun: "assertions",
    why: "the unreferenced-guard incident, cited from the rule it produced",
  },
  {
    file: "architecture/overview.md",
    value: 264,
    noun: "tests",
    why: "the suite size on the day deleting assertPostable left it green. The number is the argument: that many tests, and none of them noticed",
  },
  {
    file: "architecture/not-built.md",
    value: 21,
    noun: "assertions",
    why: "the isEligible finding, stated twice in one passage because the second use contradicts the first",
  },
  {
    file: "architecture/solve.md",
    value: 4562,
    noun: "tests",
    why: "insurance-commerce-rest-api's suite, not ours. Another repository's count can never be derived from this tree",
  },
  {
    file: "PLAN.md",
    value: 4562,
    noun: "tests",
    why: "the same foreign suite, cited where the base-check cost is argued",
  },
  {
    file: "PLAN.md",
    value: 4562,
    noun: "tests",
    why: "and again in the dev-lens calibration item; two homes for one foreign number, which is exactly the drift this file is about and still not ours to derive",
  },
];

const phrases = files.flatMap((file) =>
  countPhrasesIn(relative(ROOT, file), readFileSync(file, "utf8")),
);
const unaccounted = unaccountedPhrases(phrases, checkedSites, HISTORICAL);
const stale = staleHistorical(phrases, HISTORICAL);

for (const phrase of unaccounted) {
  problems.push(
    `${phrase.file}:${phrase.line} writes "${phrase.text}", and nothing is watching it.\n` +
      `  Either it is a property of the tree — add a FACT in src/cli/docs-check.ts so it is\n` +
      `  checked wherever it appears — or it is a measurement of one past run, in which case\n` +
      `  add it to HISTORICAL with a sentence saying why. Deciding in silence is the defect.`,
  );
}

if (stale.length > 0) {
  problems.push(
    `HISTORICAL has ${stale.length} entry(s) matching no phrase in the tree:\n` +
      stale.map((entry) => `    ${entry.file} — ${entry.value} ${entry.noun}`).join("\n") +
      `\n  The prose moved and the blessing did not. Delete the entry or repoint it, or it will\n` +
      `  quietly excuse the next count that lands on the same file, value and noun.`,
  );
}

record({
  ok: unaccounted.length === 0 && stale.length === 0,
  what: "count-noun phrases",
  measured: `${phrases.length} found, ${checkedSites.length} checked, ${HISTORICAL.length} historical`,
  unchecked:
    `whether the ${HISTORICAL.length} historical figures were ever right. They are read, not ` +
    "derived, and the entry only pins the file, value and noun",
});

/**
 * Prose that's deliberately copied and checked wherever it appears — `CLAUDE.md` carries
 * `FINISHING.md`'s four checklist questions since it's the doc a compacted context is guaranteed
 * to keep. See `pinned-prose.ts` for why a wrapped copy still passes.
 */
const beforePinned = problems.length;
problems.push(
  ...pinnedProseProblems(
    readFileSync(join(ROOT, ".claude", "skills", "dev-house-rules", "FINISHING.md"), "utf8"),
    readFileSync(join(ROOT, "CLAUDE.md"), "utf8"),
  ),
);
record({
  ok: problems.length === beforePinned,
  what: "CLAUDE.md's copy of the checklist",
  measured: `${CHECKLIST_QUESTIONS} question(s)`,
  unchecked:
    "that anyone asked them. There is no mechanical test for having asked yourself a " +
    "question, which is why commit-brief.sh reminds and cannot refuse",
});

/**
 * GitHub's heading-to-anchor rule: lowercase, drop non-word/space/hyphen characters, then turn
 * spaces into hyphens. Does not collapse runs of spaces, so e.g. an arrow produces a double hyphen
 * a hand-written link will guess wrong.
 *
 * Passed into `rule-citations.ts` as an argument rather than duplicated there, since importing
 * this file runs `vitest list`.
 */
function slugOf(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // a link in a heading contributes its text
    .replace(/[`*_]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
}

function anchorsOf(file: string): Set<string> {
  const found = new Set<string>();
  for (const match of readFileSync(file, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const heading = match[1];
    if (heading !== undefined) {
      found.add(slugOf(heading));
    }
  }
  return found;
}

/**
 * Documents whose links are not ours to fix — `upstream-README.md` is vendored verbatim and its
 * relative links describe the source repository's layout. Listed by path, not directory, so the
 * exemption can't silently cover a file added later; exempts a file only as a link *source*, never a target.
 */
const NOT_OURS = new Set(["docs/backlog-governance/upstream-README.md"]);

/** Cross-document links: a rule whose link has rotted has lost the incident behind it, so links are checked mechanically rather than trusted. */
const anchorCache = new Map<string, Set<string> | null>();
const beforeLinks = problems.length;
let links = 0;

for (const file of files) {
  const here = relative(ROOT, file);
  if (NOT_OURS.has(here)) {
    continue;
  }
  const body = readFileSync(file, "utf8");

  for (const match of body.matchAll(/\]\(([^)\s#]*\.md)?(?:#([^)\s]+))?\)/g)) {
    const [, path, anchor] = match;
    if (path === undefined && anchor === undefined) {
      continue;
    }
    links++;

    const target = path === undefined ? file : resolve(dirname(file), path);
    const line = body.slice(0, match.index).split("\n").length;

    let anchors = anchorCache.get(target);
    if (anchors === undefined) {
      anchors = existsSync(target) ? anchorsOf(target) : null;
      anchorCache.set(target, anchors);
    }

    if (anchors === null) {
      problems.push(`${here}:${line} links to ${path}, which does not exist.`);
      continue;
    }
    if (anchor !== undefined && anchor.length > 0 && !anchors.has(anchor)) {
      problems.push(
        `${here}:${line} links to ${path ?? "this file"}#${anchor}, which is not a heading there.`,
      );
    }
  }
}

record({
  ok: problems.length === beforeLinks,
  what: "markdown links",
  measured: `${links} checked across ${files.length} files`,
  unchecked:
    "whether the heading a link lands on says what the link claims it says, and " +
    `${NOT_OURS.size} document(s) are exempt as a source of links`,
});

/**
 * Documents with numbered sections, declared rather than discovered — see `section-refs.ts` for
 * why inferring "has a numbered list" from a document loses the check.
 */
const NUMBERED_DOCUMENTS: readonly DocumentShape[] = [
  { path: "architecture/overview.md" },
  { path: "architecture/module-map.md" },
  { path: "architecture/triage.md" },
  { path: "architecture/solve.md" },
  { path: "architecture/configuration.md" },
  { path: "architecture/invariants.md", numberedListIn: "14" },
  { path: "architecture/not-built.md" },
  { path: "architecture/guardrails.md" },
  { path: "PLAN.md" },
  { path: ".claude/skills/intake-triage/INTAKE_INSTRUCTIONS.md" },
  { path: ".claude/skills/agent-solve/SOLVE_INSTRUCTIONS.md" },
];

const definedByDocument = new Map<string, ReadonlySet<string>>();
for (const document of NUMBERED_DOCUMENTS) {
  const body = readFileSync(join(ROOT, document.path), "utf8");
  definedByDocument.set(document.path, sectionIds(body, document));
}

/** basename -> document path, so a citation naming a file relatively still resolves. */
const byBasename = new Map<string, string>();
for (const document of NUMBERED_DOCUMENTS) {
  byBasename.set(basename(document.path), document.path);
}

/**
 * References already known to name nothing, being fixed under `PLAN.md` §14.
 *
 * Compared exactly, not as a ceiling: fewer means one was fixed and this number is stale, more
 * means a new one arrived, and both are worth stopping for. One number for the whole tree, so it
 * cannot quietly grow to fit, and it names no file, so nothing is permanently blessed.
 */
const KNOWN_DANGLING = 41;

/**
 * References that resolve in more than one document with no name saying which, being fixed under
 * `PLAN.md` §19. Compared exactly, the same as `KNOWN_DANGLING` and for the same reason.
 */
const KNOWN_AMBIGUOUS = 119;

const refFiles = [...files, ...typescriptFiles(ROOT)];
const refBodies = new Map(
  refFiles.map((file) => [relative(ROOT, file), readFileSync(file, "utf8")]),
);
const refs = refFiles.flatMap((file) =>
  referencesIn(relative(ROOT, file), refBodies.get(relative(ROOT, file)) ?? ""),
);

const dangling: SectionRef[] = [];
const ambiguous: { ref: SectionRef; candidates: readonly string[] }[] = [];
for (const ref of refs) {
  const body = refBodies.get(ref.file) ?? "";
  const line = body.split("\n")[ref.line - 1] ?? "";
  const qualifiedDoc = qualifierOf(line, ref, byBasename);
  const resolution = resolveReference(ref, qualifiedDoc, definedByDocument);
  if (resolution.kind === "dangling") {
    dangling.push(ref);
  } else if (resolution.kind === "ambiguous") {
    ambiguous.push({ ref, candidates: resolution.candidates });
  }
}

if (dangling.length !== KNOWN_DANGLING) {
  for (const ref of dangling) {
    problems.push(
      `${ref.file}:${ref.line} cites §${ref.id}, which is not a section in any document here.\n` +
        `  Sections come from ARCHITECTURE.md, PLAN.md and the two instruction skills. If the\n` +
        `  reference is being quoted rather than made, put it in a refs:off / refs:on region.`,
    );
  }
  problems.push(
    `section references: ${dangling.length} resolve to nothing, and KNOWN_DANGLING says ${KNOWN_DANGLING}.\n` +
      `  ${dangling.length > KNOWN_DANGLING ? "A new one arrived — fix it rather than raising the number." : "Some were fixed: lower KNOWN_DANGLING in src/cli/docs-check.ts to match."}`,
  );
}

if (ambiguous.length !== KNOWN_AMBIGUOUS) {
  for (const { ref, candidates } of ambiguous) {
    problems.push(
      `${ref.file}:${ref.line} cites §${ref.id}, which is a section in more than one document: ` +
        `${candidates.join(", ")}.\n` +
        `  Name the document it means — "${candidates[0]} §${ref.id}" — rather than leaving it to guess.`,
    );
  }
  problems.push(
    `section references: ${ambiguous.length} resolve in more than one document, and KNOWN_AMBIGUOUS says ${KNOWN_AMBIGUOUS}.\n` +
      `  ${ambiguous.length > KNOWN_AMBIGUOUS ? "A new one arrived — qualify it rather than raising the number." : "Some were qualified: lower KNOWN_AMBIGUOUS in src/cli/docs-check.ts to match."}`,
  );
}

record({
  ok: dangling.length === KNOWN_DANGLING && ambiguous.length === KNOWN_AMBIGUOUS,
  what: "section references",
  // "held at", not "owed": a line reading like a shrinking debt is how this number sat still for years.
  measured:
    `${refs.length} checked against ${definedByDocument.size} documents, ` +
    `${dangling.length} resolving to nothing (held at KNOWN_DANGLING) and ` +
    `${ambiguous.length} resolving to more than one document (held at KNOWN_AMBIGUOUS)`,
  unchecked:
    `those ${dangling.length + ambiguous.length}. They are counted, not fixed, and nothing here ` +
    "makes either number fall on its own",
});

/**
 * How long the mandatory-reading path is, against the band the cut landed in. The one check here
 * that isn't a consistency check — a corpus that grows can agree with itself the whole way.
 * A missing budgeted file is left out of `sizes` rather than read as zero, since `budgetProblems`
 * treats "not measured" as a failure and zero would report it as spectacularly under budget.
 */
const beforeBudget = problems.length;
const sizes = new Map<string, number>();
for (const budget of BUDGETS) {
  const path = join(ROOT, budget.path);
  if (existsSync(path)) {
    sizes.set(budget.path, countWords(readFileSync(path, "utf8")));
  }
}
problems.push(...budgetProblems(sizes));

/**
 * The ratchet: a ceiling in the working tree above the one at the fork point. Compared against the
 * merge base with the default branch, not `HEAD` — on any ref CI checks out, the working tree *is*
 * `HEAD`, so that comparison could never fail. Requires `fetch-depth: 0` in CI for `origin/main` to
 * exist as a merge base.
 *
 * `git show` throwing means "no previous budget" (not a failure) for any commit before this file
 * existed; a baseline that fails to resolve at all is different, and is reported rather than swallowed.
 */
const git = (args: readonly string[]): string | null => {
  try {
    return execFileSync("git", [...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

const baseline = resolveBaseline(git);
if (baseline === null) {
  problems.push(unresolvedBaselineProblem());
}
const baselineBudgets =
  baseline === null ? "" : (git(["show", `${baseline.rev}:src/cli/length-budget.ts`]) ?? "");
const raises = raisedCeilings(parseBudgets(baselineBudgets), BUDGETS);
problems.push(...ratchetProblems(raises));

const notice = raiseNotice(raises);
if (notice !== null) {
  say(notice);
}

const budgeted = [...sizes.values()].reduce((total, size) => total + size, 0);
record({
  ok: problems.length === beforeBudget,
  what: "length of the mandatory-reading path",
  measured: `${budgeted} words across ${sizes.size} of ${BUDGETS.length} budgeted file(s), band ${AGGREGATE_FLOOR}-${aggregateCeiling()}`,
  unchecked:
    "every other document. INCIDENTS, BUILDING, PROVING, ARCHITECTURE and PLAN have no " +
    "ceiling at all, because a budget on a file nobody must read is one nobody defends",
});

/** Rules against incidents, checked in both directions; the module is pure and takes `slugOf` and the documents as arguments. */
const beforeCitations = problems.length;
const incidentsPath = ".claude/skills/dev-house-rules/INCIDENTS.md";
const incidents = readFileSync(join(ROOT, incidentsPath), "utf8");

/**
 * Minutes between an incident being written and the first rule citing it — reported, not
 * guarded: an incident found this afternoon may legitimately produce its rule this afternoon.
 */
function firstCommitSeconds(args: readonly string[]): number | null {
  try {
    const raw = execFileSync("git", [...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = raw.split("\n")[0]?.trim();
    return first === undefined || first === "" ? null : Number(first);
  } catch {
    return null;
  }
}

const measuredGaps: Array<{ written: number; minutes: number }> = [];
for (const entry of incidentEntries(incidents, slugOf)) {
  const written = firstCommitSeconds(incidentAddedArgs(entry, incidentsPath));
  const cited = firstCommitSeconds(ruleCitedArgs(entry, CITING_FILES));
  if (written !== null && cited !== null && cited >= written) {
    measuredGaps.push({ written, minutes: (cited - written) / 60 });
  }
}
// Sorted by when the incident was written, not by its position in the file; GAP_WINDOW takes the most recent fifteen.
const authoringGaps = measuredGaps
  .toSorted((a, b) => b.written - a.written)
  .map((gap) => gap.minutes);

const citations = ruleCitationProblems({
  incidentsPath,
  incidents,
  citing: CITING_FILES.map((path) => ({ path, body: readFileSync(join(ROOT, path), "utf8") })),
  slugOf,
  today: new Date(),
  authoringGaps,
});
problems.push(...citations.problems);

record({
  ok: problems.length === beforeCitations,
  what: "rules against incidents",
  measured: citations.summary,
  unchecked:
    "whether the incident a rule cites is the incident it came from — a slug resolving " +
    "proves the entry exists, not that the story under it earns the rule — and whether a rule " +
    "cites one at all, which is counted in the line above and failed on by nobody",
});

/**
 * The solver's scope prose against the gate that actually runs. The only check here that reads a
 * skill file for what it *claims*, and whose failure costs a run rather than just misleading a reader.
 * `refusesBySize` is measured by running a huge diff through the real `checkDiff`, not read from
 * `diff-gate.ts`, so the check isn't trusting the same source it's meant to hold the prose against.
 */
const beforeScope = problems.length;
const hugeCleanDiff = Array.from({ length: 500 }, (_, index) => ({
  path: `src/generated/module-${index}.ts`,
  added: 400,
  removed: 400,
}));
const sizeVerdict = checkDiff(hugeCleanDiff);
const instructionsPath = ".claude/skills/agent-solve/SOLVE_INSTRUCTIONS.md";
const solveSkillPath = ".claude/skills/agent-solve/SKILL.md";
const scope = scopeBoundsProblems({
  instructionsPath,
  instructions: readFileSync(join(ROOT, instructionsPath), "utf8"),
  skillPath: solveSkillPath,
  skill: readFileSync(join(ROOT, solveSkillPath), "utf8"),
  tables: [
    { name: "FORBIDDEN_PATHS", rules: FORBIDDEN_PATHS },
    { name: "VERIFICATION_PATHS", rules: VERIFICATION_PATHS },
  ],
  refusesBySize: !sizeVerdict.ok,
});
problems.push(...scope.problems);

record({
  ok: problems.length === beforeScope,
  what: "the solver's scope prose against the diff gate",
  measured: scope.summary,
  unchecked:
    "everything the prose says that is not a path or the size sentence — the bail rows, the " +
    "worktree description and §0a's out-of-worktree bound have no mechanical counterpart here. " +
    "It also cannot see a cap added to the prose *alongside* the sentence denying one, since it " +
    "asks whether that sentence is present and not whether the document contradicts itself",
});

/**
 * The closing tally, printed whether or not the run passed — the coverage of these checks is the
 * same either way, and the run that most needs to know what's uncovered is the one that went green.
 */
const failed = checks.filter((check) => !check.ok);
say(
  `\n${checks.length - failed.length} of ${checks.length} check(s) passed. ` +
    `None of them checks the following, on any run:`,
);
for (const check of checks) {
  say(`  ${check.what} — ${check.unchecked}.`);
}

if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} problem(s):\n\n`);
  for (const problem of problems) {
    process.stderr.write(`- ${problem}\n\n`);
  }
  process.stderr.write(
    "Fix the prose, not this file — unless a citation or a link genuinely went away, in\n" +
      "which case adjust it here and record why in the commit message.\n",
  );
  process.exit(1);
}
