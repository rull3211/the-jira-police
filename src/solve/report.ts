/**
 * The solve cycle, written down so a dry-run decision can be checked against
 * the ticket's actual labels rather than only logged.
 *
 * Goes to `<OUTPUT_DIR>/solve-cycle.md`, never `<KEY>.md` — those files are
 * rewritten wholesale by `FileSink` on the next triage, so a section appended
 * there would vanish unrelated to anything the solve queue did. One snapshot
 * per run, replaced each cycle; `solve.dry_run` is the append-only record.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { oneLine } from "../text.ts";
import type { SolveCandidate, SolveCycleOutcome, SolveDeps } from "./poller.ts";

/** Stable name, so the artifact is easy to open and impossible to confuse with an issue key. */
export const SOLVE_REPORT_FILE = "solve-cycle.md";

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
 * Returns nothing when the candidate is missing (which shouldn't happen) rather
 * than throwing — a diagnostic that crashes explaining a problem is worse than one with a gap.
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
    // One signed list, not two: separating additions from removals would let a
    // reader miss that the human's `agent:start` is being consumed in the same edit.
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

/** Why the cycle read nothing — distinguishes "disabled" from "board genuinely empty", which look identical in the logs. */
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
 * The cycle as stdout lines, for the operator watching the run live.
 *
 * `issueKey` filters decisions the cycle already made rather than running a
 * second query, so a single-ticket run reflects the same board a full one
 * would. A ticket with no decisions gets an explicit `NONE` line — silence
 * would look identical to a crash or a typo in the key.
 */
export function decisionLines(outcome: SolveCycleOutcome, issueKey?: string): readonly string[] {
  const mine = (key: string): boolean => issueKey === undefined || key === issueKey;
  const lines = [
    ...outcome.planned.filter((claim) => mine(claim.issueKey)).map(planLine),
    ...outcome.deferred
      .filter((key) => mine(key))
      .map((key) => `WAIT  ${key}  eligible, but out of capacity this cycle`),
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
