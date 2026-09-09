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
 * be asserting that the past has not changed. They stay a matter of reading.
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
import { CHECKLIST_QUESTIONS, pinnedProseProblems } from "./pinned-prose.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** `process.stdout.write` is how every other command here prints; `no-console` is on. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "state", "groomed", "dist", "coverage"]);

/**
 * What separates two words of a citation: a space, unless the formatter
 * wrapped the line there — and if the citation sits inside a blockquote, the
 * continuation line carries the `> ` marker as well.
 */
const GAP = String.raw`\s+(?:>\s*)?`;

/**
 * A citation pattern, built from its words. Global, because one document may
 * cite the same fact twice. Pass each word separately; there is deliberately
 * no way to write the space yourself.
 */
function citation(...words: readonly string[]): RegExp {
  return new RegExp(words.join(GAP), "g");
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
    if (SKIP_DIRS.has(entry)) {
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

/** Every `.ts` in the tree, for a count that is about code and not about prose. */
function typescriptFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
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
 * measures the population that actually matters and holds still while being
 * described.
 *
 * This counts the system's *size* and does not check that any reference
 * resolves. `PLAN.md` §13 records that gap; roughly 39 of these point at
 * sections that have never existed in any revision of the document they appear
 * to cite. Sizing it keeps the cited scale of that problem honest until the
 * resolver is built. It is not the resolver.
 */
function sectionReferences(): number {
  let found = 0;
  for (const file of typescriptFiles(ROOT)) {
    found += (readFileSync(file, "utf8").match(/§\d/gu) ?? []).length;
  }
  return found;
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
   * This pins one more phrasing. It does not close the class: a count written in
   * a third form is still invisible, and there are 20 count-noun phrases in
   * tracked markdown against 4 declared sites. The class fix is `expectSites`
   * one level up — every count-noun phrase must be a declared site or a listed
   * historical figure — and it is too large to hand-watch, so it arrives with
   * this file's first test rather than before it. Recorded in `PLAN.md` §13.
   *
   * `pinned-prose.test.ts` is not that test and does not discharge this. It
   * covers a sibling module extracted so that it *could* be tested; nothing
   * below this line — no count, no `expectSites`, no link — is under a test yet.
   */
  {
    what: "test files, written as a bare count",
    actual: suite.files,
    phrase: "<N> test files",
    cited: citation(CAPTURED, "test", "files"),
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
    what: "file-homes shared by the quoted cost figures",
    actual: costHomes(files),
    phrase: "<N> file-homes",
    cited: citation(CAPTURED, "file-homes"),
    expectSites: 1,
  },
];

const problems: string[] = [];

for (const fact of FACTS) {
  const sites = citationsOf(fact, files);
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
