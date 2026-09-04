/**
 * The solve cycle, written down so it can be checked.
 *
 * Phase B runs dry on purpose: the fitness call that fills this queue is made
 * by a model with no access to source code, so the queue's picks are meant to
 * be watched for a while before anything acts on them. Watching requires an
 * artifact. Until now the only trace a cycle left was a log line and some
 * stdout, which answers "what did it decide" and not "was that decision right"
 * — and the second question is the entire reason the phase exists.
 *
 * So this renders the whole cycle: the configuration it ran under, the two
 * queries verbatim, and every candidate with the decision made about it and the
 * labels that decision was made from. A `SKIP` reading "no single svc:<repo>
 * label" is unactionable on its own and self-evident beside the ticket's actual
 * labels.
 *
 * It goes to `<OUTPUT_DIR>/solve-cycle.md` — beside the groomed reports, under
 * a name no issue key can collide with, and **never** into `<KEY>.md`. Those
 * files are rewritten wholesale by `FileSink` on the next triage, so a section
 * appended to one would vanish at a moment unrelated to anything the solve
 * queue did. The same reasoning that gives refusals their own `.rejected.md`.
 *
 * One cycle at a time: the file is replaced on every run, and it is a snapshot
 * rather than a history. The log line `solve.dry_run` remains the append-only
 * record.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SolveCandidate, SolveCycleOutcome, SolveDeps } from "./poller.ts";

/** Stable name, so the artifact is easy to open and impossible to confuse with an issue key. */
export const SOLVE_REPORT_FILE = "solve-cycle.md";

/**
 * Ticket text on one line, always.
 *
 * A summary is attacker-controlled — anyone who can file an SSX issue chooses
 * it — and this document uses `##` headings to separate one ticket's decision
 * from the next. A summary containing a newline and a `## PLAN — SSX-9999`
 * would therefore forge a decision that the cycle never made, in the one file
 * an operator reads to find out what the cycle decided. Collapsing every
 * whitespace run to a single space removes the newline and with it the forgery;
 * nothing else about the text needs sanitising, because markdown's remaining
 * tricks can only make a line ugly, not make it lie about structure.
 */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function labelList(labels: readonly string[]): string {
  return labels.length > 0 ? labels.map((label) => `\`${label}\``).join(" ") : "—";
}

/** Indexed by key so each decision can be shown against the ticket it was made about. */
function index(candidates: readonly SolveCandidate[]): Map<string, SolveCandidate> {
  return new Map(candidates.map((candidate) => [candidate.key, candidate]));
}

/**
 * The lines every section shares: what the ticket is, and what it looks like now.
 *
 * Returns nothing when the candidate is missing, which cannot happen for a
 * decision the cycle made — every one of them came from the candidate list. It
 * is handled rather than asserted because a report is a diagnostic, and a
 * diagnostic that throws while explaining a problem is worse than one with a
 * gap in it.
 */
function ticketLines(candidate: SolveCandidate | undefined): readonly string[] {
  if (candidate === undefined) {
    return [];
  }
  return [
    oneLine(candidate.summary),
    "",
    `- **Labels now:** ${labelList(candidate.labels)}`,
    `- **Updated:** ${candidate.updated}`,
    `- **Issue:** ${candidate.url}`,
  ];
}

function plannedSection(
  claim: SolveCycleOutcome["planned"][number],
  candidate: SolveCandidate | undefined,
): readonly string[] {
  return [
    `## PLAN — ${claim.issueKey}`,
    "",
    ...ticketLines(candidate),
    `- **Repo:** \`${claim.repo}\``,
    // Additions and removals in one list, signed. Two lists would let a reader
    // take in the additions and miss that the human's `agent:start` is being
    // consumed in the same edit, which is the half of the claim that stops the
    // ticket coming round again.
    `- **Claim:** ${labelList([
      ...claim.claim.add.map((label) => `+${label}`),
      ...claim.claim.remove.map((label) => `-${label}`),
    ])}`,
    `- **Labels after:** ${labelList(claim.labelsAfter)}`,
    "",
    "> Not written. This is the edit the claim would have made.",
    "",
  ];
}

function skippedSection(
  skip: SolveCycleOutcome["skipped"][number],
  candidate: SolveCandidate | undefined,
): readonly string[] {
  return [
    `## SKIP — ${skip.issueKey}`,
    "",
    ...ticketLines(candidate),
    `- **Reason:** ${oneLine(skip.reason)}`,
    "",
    "> Left exactly as it was. Nothing needs resetting for a later cycle to pick it up.",
    "",
  ];
}

function deferredSection(key: string, candidate: SolveCandidate | undefined): readonly string[] {
  return [
    `## WAIT — ${key}`,
    "",
    ...ticketLines(candidate),
    "",
    "> Eligible and allowed, but the concurrency bound left no room this cycle.",
    "",
  ];
}

/**
 * Why the cycle read nothing, when it read nothing.
 *
 * `found: 0` is the most common outcome and the least self-explanatory one, and
 * it has two entirely different causes that look identical in the logs: the
 * switch is off, or the switch is on and the board genuinely has no work. The
 * artifact distinguishes them, because an operator who has just added a label
 * and seen nothing happen is about to debug the wrong one.
 */
function emptyNote(enabled: boolean): readonly string[] {
  if (!enabled) {
    return [
      "## Nothing was read",
      "",
      "`SOLVE_ENABLED` is off, so the board was never queried. The queries above are",
      "the ones this configuration *would* run.",
      "",
    ];
  }
  return [
    "## The queue was empty",
    "",
    "The queue query ran and matched no issue. If you expected a ticket here, run the",
    "query above in Jira with its last clause removed — a candidate that appears then",
    "and not now is one label away, and the missing label is named by the clause you",
    "dropped.",
    "",
  ];
}

function planLine(claim: SolveCycleOutcome["planned"][number]): string {
  return `PLAN  ${claim.issueKey}  ${claim.repo}  +[${claim.claim.add.join(", ")}]  -[${claim.claim.remove.join(", ")}]`;
}

/**
 * The cycle as stdout lines — the same decisions as the artifact, for the
 * operator watching the run rather than reading it back later.
 *
 * `issueKey` narrows to one ticket. The narrowing is a filter over decisions the
 * cycle already made, never a second query: a single-ticket run reads the same
 * board as a full one, so what it prints is what the queue would have done, not
 * what a differently-scoped queue might do.
 *
 * A ticket with no decisions gets an explicit `NONE` line rather than silence.
 * Empty output is the one result an operator cannot act on — it looks identical
 * to a crash, a typo in the key, and a correctly-working queue that simply does
 * not want that ticket.
 */
export function decisionLines(outcome: SolveCycleOutcome, issueKey?: string): readonly string[] {
  const mine = (key: string): boolean => issueKey === undefined || key === issueKey;
  const lines = [
    ...outcome.planned.filter((claim) => mine(claim.issueKey)).map(planLine),
    ...outcome.deferred
      .filter((key) => mine(key))
      .map((key) => `WAIT  ${key}  eligible, but out of capacity this cycle`),
    // Printed rather than counted. A skip is the interesting output of a dry
    // run: it is how you find out that a ticket you expected to be picked up is
    // missing a label, or names a repository nobody added to SOLVE_REPOS.
    ...outcome.skipped
      .filter((skip) => mine(skip.issueKey))
      .map((skip) => `SKIP  ${skip.issueKey}  ${oneLine(skip.reason)}`),
  ];

  if (lines.length === 0 && issueKey !== undefined) {
    return [
      `NONE  ${issueKey}  not in the queue this cycle — it matched neither the queue query nor the in-flight query`,
    ];
  }
  return lines;
}

/** Renders the cycle. Pure, so the artifact is testable without a filesystem. */
export function formatSolveReport(outcome: SolveCycleOutcome, deps: SolveDeps, now: Date): string {
  const byKey = index(outcome.candidates);
  const decisions = [
    ...outcome.planned.flatMap((claim) => plannedSection(claim, byKey.get(claim.issueKey))),
    ...outcome.deferred.flatMap((key) => deferredSection(key, byKey.get(key))),
    ...outcome.skipped.flatMap((skip) => skippedSection(skip, byKey.get(skip.issueKey))),
  ];

  return [
    `# Solve cycle — ${now.toISOString()}`,
    "",
    `- **Enabled:** ${deps.enabled} · **Mode:** ${deps.mode}`,
    `- **Found:** ${outcome.found} · **In flight:** ${outcome.inFlight} · **Capacity:** ${outcome.capacity}`,
    `- **Planned:** ${outcome.planned.length} · **Waiting:** ${outcome.deferred.length} · **Skipped:** ${outcome.skipped.length}`,
    `- **Allowed repos:** ${labelList(deps.allowedRepos)}`,
    `- **Max concurrent:** ${deps.maxConcurrent}`,
    "",
    // Stated in the artifact itself, not only in the module that produced it.
    // This file is the thing someone reads six weeks from now, possibly after
    // the write path has landed, and a planned claim reads exactly like a
    // performed one unless the page says otherwise.
    "> **Dry run.** No label was written, no branch created, no command run.",
    "",
    "## Queries",
    "",
    "```",
    `queue:     ${deps.queueJql ?? "— (deps not composed from settings)"}`,
    `in-flight: ${deps.inFlightJql ?? "— (deps not composed from settings)"}`,
    "```",
    "",
    "---",
    "",
    ...(decisions.length > 0 ? decisions : emptyNote(deps.enabled)),
  ].join("\n");
}

/** Writes the cycle report, creating the directory if this is the first run. */
export async function writeSolveReport(
  directory: string,
  outcome: SolveCycleOutcome,
  deps: SolveDeps,
  now: Date,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, SOLVE_REPORT_FILE);
  await writeFile(path, formatSolveReport(outcome, deps, now), "utf8");
  return path;
}
