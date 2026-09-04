/**
 * The title and body of the draft pull request.
 *
 * Its own module, and pure. `delivery.ts` executes — it runs git and gh and
 * interprets exit codes — and mixing "what does the PR say" into that would mean
 * the only way to see the wording was to open a pull request. This function can
 * be read in a test.
 *
 * ## Who the body is written for
 *
 * A colleague who did not ask for this pull request and is now looking at one.
 * That reader needs four things in the first two lines — a machine wrote it,
 * it is a draft, here is the ticket, here is why — and then wants to stop
 * reading. Everything else is evidence, and evidence goes in `<details>`.
 *
 * The first version of this put all of it on the page and was told, accurately,
 * that it was "a bit long and hard to read". Three model-written blocks did most
 * of the damage: recon's correction to the dev lens, the fix pass's account of
 * itself, and simplify's log of what it considered and rejected. Each is worth
 * keeping and none is worth reading first, which is exactly what a disclosure
 * widget is for. What stayed on the page is what a reviewer decides with: is it
 * green, how big is it, and did anything disagree with anything.
 *
 * ## The model does not write the body
 *
 * It writes the *commit* — `composeCommitMessage` — and its account of the
 * passes. That prose is quoted here under headings that say whose words they
 * are. Everything else is composed from facts the harness established itself:
 * exit codes it read, file and line counts it measured, the recon verdict it
 * parsed. This split is the same one the whole pipeline runs on, and it matters
 * most here because the PR body is the most widely-read artifact the service
 * produces. A model asked to summarise its own work will say the tests pass, and
 * it has no way to know.
 *
 * ## Why the quoted prose is escaped rather than fenced
 *
 * It descends from ticket text, which anyone with a Jira account can write, so
 * it must not be able to forge document structure — a heading, a table, a
 * checklist that reads as though the harness wrote it, a link pointing
 * somewhere else.
 *
 * This used to be a code fence, which is the stronger guarantee and was the
 * right first move. It was traded for `asProse` deliberately and with the
 * tradeoff named: a fence renders prose as a monospace dump with a horizontal
 * scrollbar, and the body's whole job is to be read. `asProse` neutralises the
 * constructs that create structure and leaves the words alone. It is a weaker
 * guarantee than a fence and a testable one — see its own comment for the list
 * and for what is deliberately left renderable.
 */

import type { SolveOutcome } from "./orchestrator.ts";

export interface PullRequestText {
  readonly title: string;
  readonly body: string;
}

/** The `verified` variant, which is the only one that may become a pull request. */
type Verified = Extract<SolveOutcome, { kind: "verified" }>;

export interface PullRequestContext {
  readonly issueKey: string;
  /** Jira base, e.g. `https://example.atlassian.net`. Trailing slash tolerated. */
  readonly jiraBaseUrl: string;
  /** What the operator will type to reproduce this. Quoted, not executed. */
  readonly maxReviewRounds: number;
}

/**
 * Renders untrusted text as markdown prose that cannot create structure.
 *
 * Two steps, and the first is why the second is simple.
 *
 * **Paragraphs are reflowed to one line each.** Blank lines still separate
 * paragraphs; every other run of whitespace becomes one space. This is a
 * readability fix first — GitHub renders a single newline in a pull request body
 * as a line break, so a commit body wrapped at 72 columns for git's sake arrives
 * broken mid-sentence — and it collapses the escaping problem second. A
 * paragraph that is one line has exactly one line-start, so exactly one place a
 * block-level construct can begin.
 *
 * **Then the dangerous characters are escaped.** In order:
 *
 *  - `\` first, or every escape added below could be cancelled by a backslash
 *    the text already contained.
 *  - `` ` ``, `[`, `]`, `|` — inline code, links, images, reference definitions
 *    and table cells. All render as themselves once escaped.
 *  - `<` becomes `&lt;`, closing off raw HTML. An entity rather than a
 *    backslash, because markdown does not escape `<` with one.
 *  - a leading `#`, `>`, `-`, `+`, `*`, `=`, `~` or `1.` — headings, block
 *    quotes, lists, thematic breaks, setext underlines and fences. Only at the
 *    start of a paragraph, which after the reflow is the only place they mean
 *    anything.
 *
 * **What is deliberately left alone:** `*` and `_` inside a paragraph, so
 * emphasis and `snake_case` both survive. Emphasis is cosmetic — it cannot
 * forge a section, a link or a table row, which are the things that would make a
 * reviewer believe something the harness did not say.
 *
 * This is a weaker guarantee than a code fence and the weakness is the point of
 * the trade: the fence could not be read. If a construct is found that gets
 * through, the fix is another line in this function and a test, not a retreat to
 * the fence.
 */
export function asProse(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/u)
    .map((paragraph) => escapeInline(paragraph.replaceAll(/\s+/gu, " ").trim()))
    .filter((paragraph) => paragraph !== "")
    .map(escapeLeading)
    .join("\n\n");
}

/** Characters that mean something to markdown wherever they appear. */
function escapeInline(paragraph: string): string {
  return paragraph
    .replaceAll("\\", "\\\\")
    .replaceAll(/[`[\]|]/gu, (char) => `\\${char}`)
    .replaceAll("<", "&lt;");
}

/** Characters that only mean something at the start of a line. */
function escapeLeading(paragraph: string): string {
  return paragraph.replace(/^([#>\-+*=~])/u, "\\$1").replace(/^(\d+)([.)])/u, "$1\\$2");
}

/**
 * `asProse`, or an explicit marker when there was nothing to render.
 *
 * For text that is shown unconditionally. A blank where prose was promised reads
 * as a rendering fault rather than as an absence, and the two are worth telling
 * apart in a document whose whole claim is that everything in it was measured.
 *
 * A `<details>` section wants the opposite and does not use this — see below.
 */
function prose(text: string): string {
  const rendered = asProse(text);
  return rendered === "" ? "_(nothing said)_" : rendered;
}

/**
 * A collapsed section, or nothing at all when there is nothing to put in it.
 *
 * It takes raw text and escapes it itself, rather than accepting rendered
 * markdown, so that "there was nothing to say" is decided here. Composing this
 * with `prose` instead was the first attempt and it rendered a widget for every
 * absent field: `_(nothing said)_` is not empty, so nothing was ever omitted. A
 * marker earns its place on the page, where the reader can see it without
 * acting; behind a disclosure triangle it is a click that returns nothing, and
 * a few of those teach the reader that none of these widgets is worth opening.
 *
 * The blank lines around the content are load-bearing: GitHub stops parsing
 * markdown inside an HTML block unless a blank line reopens it, and without them
 * the whole section renders as one run of literal text.
 */
function details(summary: string, text: string): string {
  const content = asProse(text);
  return content === ""
    ? ""
    : `<details>\n<summary>${summary}</summary>\n\n${content}\n\n</details>`;
}

/**
 * The PR title.
 *
 * The commit subject with the issue key appended, rather than the ticket
 * summary. The subject is a Conventional Commits line the fix pass wrote about
 * what it actually did; the summary is what somebody hoped would be done, and
 * the two part company whenever recon corrected the brief. The key goes in
 * because a PR list is read without opening anything.
 */
export function composeTitle(outcome: Verified, issueKey: string): string {
  return `${outcome.commit.subject} (${issueKey})`;
}

function browseUrl(base: string, issueKey: string): string {
  return `${base.replace(/\/+$/u, "")}/browse/${issueKey}`;
}

/**
 * The commit body without the trailer the harness appended to it.
 *
 * `Refs: SSX-1234` is there so `git log` can be searched. In a pull request that
 * already links the ticket in its first line it is a duplicate, and a reader who
 * has to skip a line learns to skip the block.
 */
export function withoutTrailer(body: string): string {
  return body.replace(/\n*^Refs:.*$/mu, "").trim();
}

/**
 * The verification steps as one scannable line.
 *
 * A four-row table for four values that are all `exit 0` spent eight lines
 * saying "green". Exit codes appear only where they are not zero, because a
 * number a reader has to check against an expectation is worse than a tick, and
 * a failure is the only case where the number itself tells them anything.
 */
function checkLine(outcome: Verified): string {
  if (outcome.verification.outcome === "refused") {
    // Unreachable today — a `verified` outcome always carries passed steps — and
    // written rather than asserted, so that widening `verified` later produces a
    // thinner pull request body instead of a crash while rendering one.
    return "_no verification steps were discovered_";
  }
  return outcome.verification.steps
    .map((step) => `${step.name} ${step.passed ? "✅" : `❌ exit ${String(step.exitCode)}`}`)
    .join(" · ");
}

export function composePullRequest(
  outcome: Verified,
  context: PullRequestContext,
): PullRequestText {
  const { issueKey, jiraBaseUrl, maxReviewRounds } = context;
  const { recon, fix, simplify } = outcome;

  // Stated on the page rather than in a disclosure, because it is the single
  // most useful thing this pipeline produces and the only feedback triage's
  // `agent:solvable` call ever receives — triage makes that call without reading
  // a line of source. The correction itself is long and goes below; that it
  // happened at all is one line and stays up here.
  const lens = recon.devLensAccurate
    ? "✅ Recon confirmed triage's read of this ticket before making any edit."
    : "⚠️ **Recon disagreed with triage's read of this ticket** and proceeded on its own reading.";

  const body = [
    `🤖 **A bot wrote this.** It is a draft; a human reviews and merges — this service has no ` +
      `merge path. Ticket: [${issueKey}](${browseUrl(jiraBaseUrl, issueKey)})`,

    prose(withoutTrailer(outcome.commit.body)),

    `**${String(outcome.files)} file(s), ${String(outcome.lines)} line(s)** · ${checkLine(outcome)}`,

    `<sub>Exit codes the harness read, having run each command itself. The model was never asked ` +
      `whether they passed, and cannot undraft this — at most ${String(maxReviewRounds)} review ` +
      `rounds, then a person decides.</sub>`,

    lens,

    details("What a reviewer should check by hand", fix.residualRisk),
    recon.devLensAccurate ? "" : details("Where triage was wrong", recon.devLensCorrection),
    details("What the fix pass says it did", fix.summary),
    // The declined case is reported, not omitted. "The simplify pass looked and
    // left it alone" and "the simplify pass never ran" are different facts about
    // a diff a reviewer is about to read, and a missing section conflates them.
    details(
      simplify.changed ? "What the simplify pass changed" : "Why the simplify pass changed nothing",
      simplify.changed ? simplify.changes.join("\n\n") : simplify.declined,
    ),
  ]
    .filter((section) => section !== "")
    .join("\n\n");

  return { title: composeTitle(outcome, issueKey), body };
}
