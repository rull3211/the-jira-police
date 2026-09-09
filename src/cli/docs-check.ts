/**
 * `pnpm docs:check` — the numbers in the prose, checked against the code.
 *
 * The house rules say prose falsified by a change is rewritten in the same
 * commit, and that numbers in prose are facts that rot like facts. Nothing
 * enforced the second half. A test count is cited in two documents and a
 * settings count in one, and every one of them was last correct on the day
 * somebody remembered to grep.
 *
 * **What this changes about "cite, don't copy".** That rule exists because a
 * fact with two homes has one maintainer. A number this check verifies in every
 * place it appears no longer has that problem — the drift cannot be silent — so
 * copying a *checked* number is fine and copying an unchecked one is not. That
 * is the whole of the exemption; do not read it as licence to duplicate prose.
 *
 * **The failure mode this is designed against is not a wrong number.** It is
 * the check quietly stopping. Rephrase "2367 tests in 64 files" as "2367 tests
 * across 64 files" and a naive regex matches nothing, finds no mismatch, and
 * reports green forever. So every fact declares how many citation sites it
 * expects to find, and finding *fewer* is a failure with the same weight as a
 * wrong value. A check that cannot fail is a check that reports rather than
 * guards.
 *
 * That is not hypothetical, and the first two runs proved it twice. `oxfmt`
 * reflows Markdown prose, and it had already wrapped the `PLAN.md` citation
 * between "64" and "files" — so a line-at-a-time scan saw one site where there
 * are two, and the repository's own formatter, run on a document nobody
 * edited, was enough to disable half the check. Matching whole files fixed
 * one site and not that one: the citation is inside a blockquote, so the
 * continuation line begins `> `, and a `\s+` gap does not span it.
 *
 * Hence `citation()`. Patterns are built from words rather than written as
 * literals, because both bugs were a space that turned out not to be one, and
 * a rule that a pattern must not contain a space is better enforced by there
 * being nowhere to put it.
 *
 * **What it deliberately does not cover.** Assertion counts ("21 assertions
 * redirected", "57 assertions behind pnpm test:hooks"), what a run cost, and
 * anything else that is a measurement of one past run rather than a property of
 * the tree. Those are history, not state, and a check that re-derived them would
 * be asserting that the past has not changed.
 *
 * **They no longer stay a matter of reading, though.** Each one is now listed in
 * `HISTORICAL` below with a sentence saying why it is history, and the class
 * check that reads that list fails on any count-noun phrase which is neither a
 * declared site nor a listed figure. So the current-versus-history call is still
 * a judgement — it is just one somebody has to write down and a reviewer can
 * disagree with, rather than one made by not adding a `FACT`.
 *
 * **The line is what the number measures, not what it is about.** `$4.50` is
 * history and is not checked. *How many documents repeat `$4.50`* is a property
 * of the tree today, and `PLAN.md` §13 cites it while making the argument that
 * facts with many homes drift — so it was itself wrong, by one, within days. The
 * same held for the size of the `§N` cross-reference system, cited at 87 when
 * the tree had nearly three times that. A section that catalogues unchecked
 * facts is the last place an unchecked fact should be, and both are now derived.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { SETTINGS } from "../settings.ts";
import {
  type CheckedSite,
  citation,
  countPhrasesIn,
  type HistoricalFigure,
  staleHistorical,
  unaccountedPhrases,
} from "./count-phrases.ts";
import { CHECKLIST_QUESTIONS, pinnedProseProblems } from "./pinned-prose.ts";
import {
  type DocumentShape,
  maskDisabled,
  referencesIn,
  sectionIds,
  unresolved,
} from "./section-refs.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** `process.stdout.write` is how every other command here prints; `no-console` is on. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Skipped wherever they appear, because they nest. */
const SKIP_ANYWHERE = new Set(["node_modules", ".git"]);

/**
 * Runtime and build output, skipped **only at the repository root**.
 *
 * It used to be one set matched by bare name at any depth, and that quietly
 * excluded `src/state/` — a real source directory whose name collides with the
 * runtime store's output directory. So `src/state/store.ts` was invisible to
 * every walker here: it was not counted as a production module and any `§N` in
 * it was not counted as a section reference. Found by the production-module
 * `FACT` disagreeing with `find` by exactly one, which is the whole argument for
 * deriving a number twice before trusting either.
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
  /**
   * How many sites this fact is known to have. Fewer means a citation was
   * rephrased out of the check's reach, which is the silent failure. More is
   * fine — a new document citing it correctly is not a defect.
   */
  readonly expectSites: number;
}

interface Citation {
  readonly file: string;
  readonly line: number;
  readonly value: number;
  readonly text: string;
}

/**
 * Every `.md` in the tree, so a new document citing a checked number is
 * checked rather than exempt by omission.
 */
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
 * Every `.ts` under a directory. Three callers want it for different reasons:
 * `sectionReferences` counts a population that is about code and not about
 * prose, the resolver reads these because a `§N` in a doc comment is a citation
 * like any other, and `productionModules` passes `src/` rather than `ROOT`
 * because the module map counts the service, not the tooling around it.
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
 * How many `§N` references the *code* contains.
 *
 * **Markdown is deliberately excluded, and that is not a simplification.** The
 * first version counted both, and then every sentence written about the problem
 * moved the number it was reporting: documenting the dangling citations in
 * `PLAN.md` and `INCIDENTS.md` — which must name `§7b` and `§3a` in order to say
 * that they resolve to nothing — drove three consecutive failures of this check
 * in the commit that introduced it. A count whose own write-up perturbs it is
 * noise, and a check that cries wolf gets switched off. Restricted to `.ts`, it
 * measures the population that actually matters.
 *
 * **Narrowing the scope was the wrong fix, and this file now contains the
 * counter-example.** "Holds still while being described" was the claim, and it
 * held for one commit: `section-refs.test.ts` needs dangling tokens as fixtures,
 * so building the resolver moved this count by 35 without a single new citation
 * being made. The general fix is the resolver's own — `refs:off` / `refs:on`,
 * marking a region as quoting rather than citing — so this count reads through
 * the same mask instead of through a narrower directory. A test fixture and a
 * write-up are the same thing to a counter, and one mechanism should exempt
 * both.
 *
 * This counts the system's *size* and does not check that any reference
 * resolves. It was written to keep the scale of that problem honest until the
 * resolver existed, and the resolver now runs below it — so what was "roughly
 * 39" is 39 exactly, measured rather than sampled, across markdown as well as
 * code.
 */
/* refs:on */
function sectionReferences(): number {
  let found = 0;
  for (const file of typescriptFiles(ROOT)) {
    found += (maskDisabled(readFileSync(file, "utf8")).match(/§\d/gu) ?? []).length;
  }
  return found;
}

/**
 * Modules that are not tests, under `src/` only.
 *
 * `vitest.config.ts` sits at the root and is excluded deliberately: the module
 * map counts what the service is made of, and the test runner's own
 * configuration is not part of it. Stated here because the alternative reading
 * is one off-by-one away and nothing else in the tree says which was meant.
 */
function productionModules(): number {
  return typescriptFiles(join(ROOT, "src")).filter((file) => !file.endsWith(".test.ts")).length;
}

/**
 * Hook registrations under `PreToolUse` in `.claude/settings.json`.
 *
 * **This is the only fact here measured from a file the agent may not write.**
 * Reading it is allowed and writing it is refused — one rule per direction,
 * which three documents got wrong for a while — and that asymmetry is exactly
 * what makes the number worth checking rather than merely stating. The operator
 * changes the wiring; prose written by an agent claims what the wiring is; and
 * until now nothing connected the two, so `claude-validation-work/SKILL.md` was
 * free to say `PreToolUse` carried two registrations on a day it carried three.
 * That document's own retrospective is about a wiring claim that disagreed with
 * another wiring claim eighty lines away, with nothing to make them disagree
 * loudly. This is the thing that makes one of them disagree loudly.
 *
 * **The noun is qualified for a reason.** `registrations` alone denotes two
 * populations in this tree — every hook across both events in one sentence, the
 * `PreToolUse` array alone in another — so the bare word is deliberately not in
 * `COUNTED_NOUNS`. A noun that names two populations cannot be checked against
 * one number, and the enumeration in that file's "Where the work is" section is
 * left uncheckable rather than checked wrongly.
 *
 * **A missing or unparseable file throws rather than returning 0.** Zero is a
 * plausible count — an operator who has unregistered everything — so returning
 * it on a read failure would report "no hooks are wired" for a file that could
 * not be opened, which is the fail-quiet shape this whole area keeps producing.
 * The throw takes down `docs:check`, which is the correct blast radius: the
 * check cannot do its job and should not pretend the tree agrees with itself.
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
 * The per-ticket cost figures quoted in prose, and how many files repeat each.
 *
 * The sum is what gets cited, rather than four separate counts, because the
 * claim in `PLAN.md` §13 is about the class: these are facts with many homes and
 * no maintainer. One total goes red whichever figure spreads.
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
        // The match rather than the line, since a wrapped citation has no one
        // line to quote, and its own text is what the reader has to go and fix.
        text: match[0].replace(/\s+>?\s*/g, " "),
      });
    }
  }
  return found;
}

/**
 * Collected rather than run. `vitest list` resolves and counts the suite
 * without executing it — about a second, against minutes for `vitest run` —
 * which is what makes this affordable as its own CI step rather than something
 * bolted onto the test job and skipped when the test job is skipped.
 */
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
   * The same number as the fact above, in the one place it is written as a bare
   * count rather than as "<N> tests in <N> files" — the module map's header.
   * It is a separate entry because the phrasing is what the check matches on,
   * and that is exactly how this site went wrong: `96998cc` updated both of the
   * canonical-phrasing sites and wrote 65 here, in the same commit whose message
   * says the count "was updated in both" documents.
   *
   * This pins one more phrasing, and **the class fix it asked for now runs
   * below** — see the unaccounted-phrase check and `count-phrases.ts`. A count
   * written in a third form is no longer invisible: it has to be declared here
   * or listed as history, and this entry is one of the declarations.
   */
  {
    what: "test files, written as a bare count",
    actual: suite.files,
    phrase: "<N> test files",
    cited: citation(CAPTURED, "test", "files"),
    expectSites: 1,
  },
  /**
   * The other half of the module map's header, and the first thing the class
   * check below found. It read "72 production modules" while `src/` held 73 —
   * stale before this commit added the 74th, never drifted *visibly* because
   * nothing was watching the noun. Derived rather than counted by hand: every
   * `.ts` under `src/` that is not a test, which is what "production module"
   * means everywhere else in this document.
   */
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

  // Per fact, not cumulative: a running total marks every later fact bad once
  // one has failed, which is the report lying about which one to go and look at.
  const mark = problems.length === before ? "ok  " : "FAIL";
  const shown = sites.length === 0 ? "no sites" : `${sites.length} site(s)`;
  say(`${mark} ${fact.what}: ${fact.actual}, ${shown}`);
}

/**
 * Numbers in prose that are a measurement of one past run, not a property of
 * the tree — so they are read rather than derived.
 *
 * **This list is the current-versus-history call, written down.** Until it
 * existed the call was made by silence: whoever wrote a number and did not add
 * a `FACT` had decided it was history, and nobody could tell that from having
 * forgotten. Every entry here is a claim a reviewer can disagree with, and an
 * entry that stops matching its phrase fails the run rather than sitting there
 * blessing whatever lands on that file, value and noun next.
 *
 * The bar for adding one: the number describes a run that has already happened
 * and cannot be re-derived from the tree as it stands. If it can be re-derived,
 * it belongs in `FACTS` instead.
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
    file: "ARCHITECTURE.md",
    value: 264,
    noun: "tests",
    why: "the suite size on the day deleting assertPostable left it green. The number is the argument: that many tests, and none of them noticed",
  },
  {
    file: "ARCHITECTURE.md",
    value: 21,
    noun: "assertions",
    why: "the isEligible finding, stated twice in one passage because the second use contradicts the first",
  },
  {
    file: "ARCHITECTURE.md",
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

say(
  `${unaccounted.length === 0 && stale.length === 0 ? "ok  " : "FAIL"} count-noun phrases: ` +
    `${phrases.length} found, ${checkedSites.length} checked, ${HISTORICAL.length} historical`,
);

/**
 * Prose that is deliberately copied, and is therefore checked in every place it
 * appears — which is the whole of the exemption this file's header describes.
 * `CLAUDE.md` carries `FINISHING.md`'s four checklist questions because it is
 * the only document a compacted context is guaranteed to still have; the
 * reasoning, and the reason a wrapped copy still passes, are in
 * `pinned-prose.ts`.
 */
const beforePinned = problems.length;
problems.push(
  ...pinnedProseProblems(
    readFileSync(join(ROOT, ".claude", "skills", "dev-house-rules", "FINISHING.md"), "utf8"),
    readFileSync(join(ROOT, "CLAUDE.md"), "utf8"),
  ),
);
say(
  `${problems.length === beforePinned ? "ok  " : "FAIL"} CLAUDE.md's copy of the checklist: ` +
    `${CHECKLIST_QUESTIONS} question(s)`,
);

/**
 * GitHub's heading-to-anchor rule: lowercase, drop everything that is not a
 * word character, space or hyphen, then turn spaces into hyphens.
 *
 * Note what it does *not* do: collapse runs of spaces. So a heading containing
 * `→` produces a double hyphen where the arrow was, and a reader writing the
 * link by hand will guess one. Two headings here were renamed rather than
 * linked to, because a slug nobody can predict is one that gets typed wrong
 * once and then stays wrong.
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
 * Documents whose links are not ours to fix. `upstream-README.md` is vendored
 * verbatim from `backlog-governance` and its relative links describe *that*
 * repository's layout — `docs/backlog-governance/INTEGRATION.md` says plainly
 * that a local edit here is invisible on the next re-sync and that this is the
 * one file we do not own. So the broken link is real, and correcting it is the
 * wrong fix.
 *
 * Listed by path rather than by directory on purpose: an exemption that covers
 * a folder quietly covers the next file put in it.
 *
 * It exempts a file as a *source* of links, never as a target. Measured by
 * widening it to a phase file: the run still failed, because the other phase
 * files link into that one's headings. So the blast radius of getting this
 * list wrong is one document's outgoing links, not a hole in the check.
 */
const NOT_OURS = new Set(["docs/backlog-governance/upstream-README.md"]);

/**
 * Cross-document links, which are how the rules cite their evidence. A rule
 * whose link has rotted has lost the incident behind it, and that is the one
 * failure the house rules single out as turning a rule back into an opinion —
 * so it is checked mechanically rather than trusted.
 */
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

say(
  `${problems.length === beforeLinks ? "ok  " : "FAIL"} markdown links: ${links} checked across ${files.length} files`,
);

/**
 * The four documents that number their sections, and the one section whose
 * list items are addressable. Declared here rather than discovered, because
 * every document with a numbered list is not a document with sub-sections —
 * see `section-refs.ts` for why inferring that loses the check.
 */
const NUMBERED_DOCUMENTS: readonly DocumentShape[] = [
  { path: "ARCHITECTURE.md", numberedListIn: "14" },
  { path: "PLAN.md" },
  { path: ".claude/skills/intake-triage/INTAKE_INSTRUCTIONS.md" },
  { path: ".claude/skills/agent-solve/SOLVE_INSTRUCTIONS.md" },
];

const defined = new Set<string>();
for (const document of NUMBERED_DOCUMENTS) {
  const body = readFileSync(join(ROOT, document.path), "utf8");
  for (const id of sectionIds(body, document)) {
    defined.add(id);
  }
}

/**
 * References already known to name nothing, being fixed under `PLAN.md` §14.
 *
 * **Exact, not a ceiling, for the same reason `expectSites` is.** Fewer means
 * somebody fixed one and left this number claiming a debt that is already paid,
 * which is how a budget stops being read. More means a new one arrived. Both
 * are worth stopping for, and a `<=` here would catch only half of that.
 *
 * This is a debt and not an exemption: it is one number for the whole tree, so
 * it cannot quietly grow to fit, and it names no file, so nothing is
 * permanently blessed. It goes to zero.
 */
const KNOWN_DANGLING = 39;

const refs = [...files, ...typescriptFiles(ROOT)].flatMap((file) =>
  referencesIn(relative(ROOT, file), readFileSync(file, "utf8")),
);
const dangling = unresolved(refs, defined);

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

say(
  `${dangling.length === KNOWN_DANGLING ? "ok  " : "FAIL"} section references: ${refs.length} checked against ${defined.size} sections, ${dangling.length} owed`,
);

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

say(`\nEvery cited number agrees with the tree and every link resolves.`);
