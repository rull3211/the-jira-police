/**
 * The title and body of the draft pull request. Pure and its own module so the
 * wording can be read in a test rather than only by opening a PR.
 *
 * The model writes the commit message and its account of each pass, quoted here
 * under headings that say whose words they are; everything else (exit codes,
 * file/line counts, the recon verdict) is composed from facts the harness
 * itself measured, since a model summarising its own work can't know it passed.
 * Long model-written prose goes behind `<details>` — the page itself is what a
 * reviewer decides from: green or not, how big, did anything disagree.
 */

import type { SolveOutcome } from "./orchestrator.ts";
import { type CommitMessage, composeCommitMessage } from "./runner.ts";

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
 * Renders untrusted text as markdown prose that cannot create structure: reflows
 * each paragraph to one line (so a block-level construct can only start there),
 * then escapes `\`, `` ` ``/`[`/`]`/`|`, `<`, and a leading `#>-+*=~`/`1.`.
 * `*`/`_` are left alone deliberately — emphasis is cosmetic and can't forge a
 * section, link, or table row.
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

/** `asProse`, or an explicit marker when empty, so a blank doesn't read as a rendering fault. */
function prose(text: string): string {
  const rendered = asProse(text);
  return rendered === "" ? "_(nothing said)_" : rendered;
}

/**
 * A collapsed section, or nothing at all when empty — an empty widget teaches the
 * reader that none of these are worth opening.
 * The blank lines around the content are load-bearing: GitHub stops parsing
 * markdown inside an HTML block unless a blank line reopens it.
 */
function details(summary: string, text: string): string {
  const content = asProse(text);
  return content === ""
    ? ""
    : `<details>\n<summary>${summary}</summary>\n\n${content}\n\n</details>`;
}

/**
 * The change the pull request is for. On an ordinary solve that is `commit`; on a promoted repair
 * `commit` is the repair's, committed on top of the fix, and the pull request is still the fix.
 */
function changeOf(outcome: Verified, issueKey: string): CommitMessage {
  return outcome.repair === undefined
    ? outcome.commit
    : composeCommitMessage(outcome.fix, issueKey);
}

/** The PR title: the change's subject (what was actually done) plus the issue key, not the ticket summary. */
export function composeTitle(outcome: Verified, issueKey: string): string {
  return `${changeOf(outcome, issueKey).subject} (${issueKey})`;
}

function browseUrl(base: string, issueKey: string): string {
  return `${base.replace(/\/+$/u, "")}/browse/${issueKey}`;
}

/** The commit body without the `Refs:` trailer — redundant once the PR links the ticket up top. */
export function withoutTrailer(body: string): string {
  return body.replace(/\n*^Refs:.*$/mu, "").trim();
}

/** The verification steps as one scannable line; exit codes shown only when non-zero. */
function checkLine(outcome: Verified): string {
  if (outcome.verification.outcome === "refused") {
    // Unreachable today; written so widening `verified` later degrades the body instead of crashing it.
    return "_no verification steps were discovered_";
  }
  return outcome.verification.steps
    .map((step) => `${step.name} ${step.passed ? "✅" : `❌ exit ${String(step.exitCode)}`}`)
    .join(" · ");
}

/**
 * The fail-first finding, rendered only for `vacuous` (a regression test that
 * passes even against the unfixed code — invisible from the diff otherwise).
 * `guarded`/`skipped`/`inconclusive` render nothing rather than overclaim (see `checkFailFirst`).
 */
function failFirstLine(outcome: Verified): string {
  if (outcome.failFirst.outcome !== "vacuous") {
    return "";
  }
  const tests = outcome.failFirst.tests.map((path) => `\`${path}\``).join(", ");
  return (
    `⚠️ **The new tests pass without the fix.** The harness put ${tests} onto ` +
    `an unmodified checkout of the base and the suite went green, so nothing here ` +
    `separates the fix from the bug it is named for. The fix may still be right — ` +
    `this is a finding about the test.`
  );
}

/**
 * What a promoted repair owes the reviewer, harness-composed and above every model-written line:
 * a green check reached by weakening a test looks exactly like one reached by a fix.
 */
function repairBanner(outcome: Verified): string {
  if (outcome.repair === undefined) {
    return "";
  }
  const failure = asProse(outcome.repairedFailure ?? "") || "the reason was not recorded";
  return (
    `⚠️ **A repair pass finished this change after it failed verification — read the second commit ` +
    `on its own.** The first commit is the fix, and alone it did not pass this repository's checks ` +
    `(${failure}). A second agent was shown that failure and wrote the second commit, and only then ` +
    `did every check below pass. Correcting the code and weakening the assertion that failed come ` +
    `back equally green, and nothing here tells them apart: look for an assertion removed, loosened, ` +
    `or no longer reached.`
  );
}

export function composePullRequest(
  outcome: Verified,
  context: PullRequestContext,
): PullRequestText {
  const { issueKey, jiraBaseUrl, maxReviewRounds } = context;
  const { recon, fix, simplify, repair } = outcome;

  // On the page, not in a disclosure: it's the only feedback triage's `agent:solvable`
  // call ever gets, since triage never reads a line of source.
  const lens = recon.devLensAccurate
    ? "✅ Recon confirmed triage's read of this ticket before making any edit."
    : "⚠️ **Recon disagreed with triage's read of this ticket** and proceeded on its own reading.";

  const body = [
    `🤖 **A bot wrote this.** It is a draft; a human reviews and merges — this service has no ` +
      `merge path. Ticket: [${issueKey}](${browseUrl(jiraBaseUrl, issueKey)})`,

    repairBanner(outcome),

    prose(withoutTrailer(changeOf(outcome, issueKey).body)),

    `**${String(outcome.files)} file(s), ${String(outcome.lines)} line(s)** · ${checkLine(outcome)}`,

    `<sub>Exit codes the harness read, having run each command itself. The model was never asked ` +
      `whether they passed, and cannot undraft this — at most ${String(maxReviewRounds)} review ` +
      `rounds, then a person decides.</sub>`,

    lens,
    failFirstLine(outcome),

    details("What a reviewer should check by hand", fix.residualRisk),
    details("What a reviewer should check about the repair", repair?.residualRisk ?? ""),
    recon.devLensAccurate ? "" : details("Where triage was wrong", recon.devLensCorrection),
    details("What the fix pass says it did", fix.summary),
    details("What the repair pass says it did", repair?.summary ?? ""),
    // Reported, not omitted: "looked and left it alone" and "never ran" are different facts.
    details(
      simplify.changed ? "What the simplify pass changed" : "Why the simplify pass changed nothing",
      simplify.changed ? simplify.changes.join("\n\n") : simplify.declined,
    ),
  ]
    .filter((section) => section !== "")
    .join("\n\n");

  return { title: composeTitle(outcome, issueKey), body };
}
