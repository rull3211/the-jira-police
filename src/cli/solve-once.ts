/**
 * Runs one solve-queue cycle and exits.
 *
 *   node src/cli/solve-once.ts                    the whole queue
 *   node src/cli/solve-once.ts SSX-3822           one ticket
 *   node src/cli/solve-once.ts SSX-3822 --claim   writes the claim label
 *   node src/cli/solve-once.ts SSX-3822 --solve   ... and runs the solver
 *   node src/cli/solve-once.ts SSX-3822 --pr      ... and opens the draft PR
 *
 * The ladder is `solve-args.ts`, including why anything past the first two rungs
 * refuses to run without an issue key. This file is what happens afterwards.
 *
 * ## Every rung is wired, and the ladder is cumulative
 *
 * `--pr` claims the ticket, solves it, and opens the pull request. `--solve`
 * does the first two. `--claim` does the first. What each rung *adds* is one
 * phase's worth of privilege, and the run stops at the rung you named.
 *
 * ## Claim first, release last
 *
 * Every write run opens with the claim and, unless it got as far as a pull
 * request, closes by putting the labels back exactly as it found them. Two
 * reasons, and the second is the one that would have bitten:
 *
 * 1. A ticket the board shows as unclaimed while a solver is working on it is
 *    the state the queue exists to prevent.
 * 2. A hand-driven run is expected to be repeated. Leaving `agent:solving` on a
 *    ticket after a `--claim` rehearsal means the next run finds nothing and the
 *    operator has to unpick labels by hand to try again — which is exactly when
 *    somebody edits the field wholesale and loses a PM's label.
 *
 * A published pull request is the one case that keeps the claim, because there
 * the work is real and ongoing.
 *
 * ## The comments this replaces
 *
 * This file used to state that there was deliberately no `--dry-run` flag and no
 * flag to turn the dry run off, "because a flag would imply the other mode
 * exists; it does not." That was true when the only rung was the first one; it
 * was rewritten once the parser grew the flags, to say the other mode existed in
 * the parser and not in the wiring. Both sentences are now spent. There is still
 * no `--dry-run` flag, because dry is the default and the flag you have to type
 * is the one that escalates — but "this command cannot write" is no longer true
 * of anything except the rung you get for free.
 *
 * ## The artifact, and why naming a ticket suppresses it
 *
 * A full cycle writes `<OUTPUT_DIR>/solve-cycle.md`. A single-ticket run does
 * not: it prints, and says it did not write. The report renders a whole cycle —
 * its header counts everything found, in flight and skipped — and a copy of that
 * file narrowed to one ticket would read as a cycle in which only one ticket
 * existed. Overwriting the shared artifact with that is worse than not writing
 * it, so `solve-cycle.md` always means a full cycle.
 *
 * Unlike `poll:once` this holds no cursor and no state file. The queue is a
 * state, not a window: running it twice in a row is expected to report the same
 * tickets both times, and that repetition is the queue working, not a bug.
 */

import type { JiraClient } from "../jira/client.ts";
import { logger } from "../logger.ts";
import {
  type Settings,
  describeSettings,
  readSettings,
  solveMode,
  withConfigErrors,
} from "../settings.ts";
import { type ClaimReceipt, claimTicket, releaseClaim } from "../solve/claim.ts";
import { publish } from "../solve/delivery.ts";
import { reportOutcome } from "../solve/feedback.ts";
import { type SolveOutcome, type SolveRequest, solveWithRetry } from "../solve/orchestrator.ts";
import { type SolveCycleOutcome, runSolveCycle } from "../solve/poller.ts";
import { decisionLines, writeSolveReport } from "../solve/report.ts";
import {
  NotSolvableError,
  buildPublishRequest,
  buildSolveRequest,
  createClaimCapabilities,
  createJiraClient,
  createSolveDeps,
  createSolveRunDeps,
  createTicketReader,
} from "../wiring.ts";
import {
  type SolvePhase,
  USAGE,
  includes,
  parseSolveArgs,
  unavailable,
  writes,
} from "./solve-args.ts";
import { describeSolveOutcome, isFailureExit } from "./solve-outcome.ts";

/**
 * Runs the four passes against one named ticket and reports what happened.
 *
 * Everything it does to code is confined to a temporary worktree: it does not
 * push and does not open anything. The claim label is already written by the
 * time this is called — that is the rung below — so "writes nothing to Jira" is
 * true of this function and no longer true of the command.
 *
 * Returns the outcome so the rung above can decide whether there is anything to
 * publish. `null` means the request could not be built, which has already been
 * reported and is not a solve failure.
 *
 * The queue's own opinion is printed but not enforced. An operator who typed a
 * key has already made the decision the queue would make, and refusing a ticket
 * for want of a label would make the solver untestable from the command line.
 * What is enforced is `SOLVE_REPOS`, in `buildSolveRequest`, because that one is
 * not about workflow — it is the answer to which repository may be written to.
 */
async function runSolver(
  settings: Settings,
  client: JiraClient,
  issueKey: string,
  cycle: SolveCycleOutcome,
): Promise<SolveOutcome | null> {
  const planned = cycle.planned.some((candidate) => candidate.issueKey === issueKey);
  process.stdout.write(
    planned
      ? `\n${issueKey} is in the queue; solving it.\n`
      : `\n${issueKey} is NOT in the queue right now — solving it anyway because you named it.\n`,
  );

  const read = createTicketReader(client);
  const { text, detail, inlined, omitted } = await read(issueKey);
  process.stdout.write(
    `Ticket: ${text.length} characters, ${detail.comments.length} comment(s)` +
      `${inlined.length > 0 ? `, inlined ${inlined.join(", ")}` : ""}` +
      `${omitted.length > 0 ? `, omitted ${omitted.length}` : ""}\n`,
  );

  let request: SolveRequest;
  try {
    request = buildSolveRequest(settings, detail, text);
  } catch (error) {
    if (error instanceof NotSolvableError) {
      process.stderr.write(`refusing --solve: ${error.message}\n`);
      process.exitCode = 3;
      return null;
    }
    throw error;
  }

  process.stdout.write(`Repository: ${request.repoPath} @ ${request.baseRef}\n\n`);

  // `solveWithRetry`, not `solveTicket`, and the difference only ever shows on
  // one outcome: a fix pass stopped by the *machine* rather than by the code
  // gets one clean rerun. Everything else is passed through untouched, so this
  // is the same command it was on every other path.
  const { outcome, attempts, retryBlocked } = await solveWithRetry(
    createSolveRunDeps(settings),
    request,
  );
  process.stdout.write(`\n${describeSolveOutcome(outcome)}\n`);
  if (attempts > 1) {
    process.stdout.write(
      `This ran ${String(attempts)} times — the first attempt was stopped by the environment, not by the code.\n`,
    );
  }
  if (retryBlocked !== "") {
    // Said out loud rather than logged. "Abandoned on an environment cause"
    // means something different depending on whether a retry was even
    // attempted, and the operator is the one who has to know which.
    process.stdout.write(`A retry was warranted and did not happen: ${retryBlocked}\n`);
  }

  // The calibration row, and the reason this call is here rather than left for
  // a later phase. Triage makes the `agent:solvable` call **without reading a
  // line of source**; recon is the first thing that opens the repository, so
  // its `devLensAccurate` reading is the only feedback that assessment ever
  // gets. `feedback.ts` was written to accumulate exactly that and was wired to
  // nothing, so the first run ever to reach `verified` reported
  // `devLensAccurate: false` — triage's lens was wrong, the single most useful
  // thing the pipeline had produced — and the process exited and lost it.
  //
  // **No commenter is passed, and that is the phase gate, not an oversight.**
  // `reportOutcome` posts only if given a `TicketCommenter`; with none it
  // writes the local record and says the comment was not posted. So this adds a
  // local artifact and no Jira write, which is the same posture as the rest of
  // the command.
  const feedback = await reportOutcome(
    { outputDirectory: settings.OUTPUT_DIR },
    issueKey,
    outcome,
    new Date(),
  );
  process.stdout.write(
    `\nCalibration row appended to ${feedback.recordPath}` +
      `${feedback.posted ? "" : ` — ${feedback.reason ?? "not posted"}`}\n`,
  );

  // Which outcomes count, and why, is `isFailureExit` — kept there rather than
  // here so it can be tested without spawning this command.
  if (isFailureExit(outcome)) {
    process.exitCode = 1;
  }

  return outcome;
}

/**
 * Writes the claim, or explains why it did not.
 *
 * `null` means do not proceed, and the three ways of getting there are not the
 * same event:
 *
 * - **refused** — the board moved between the queue reading it and this reading
 *   it. Nothing was written and nothing is wrong; exit 3, the same code the
 *   other "you asked for something I will not do" paths use.
 * - **unverified** — the write landed and could not be confirmed. This is the
 *   dangerous one, so it prints the restore point to stderr. The result carries
 *   no receipt precisely so that this branch cannot mechanically undo a write it
 *   does not understand; a person has to look.
 * - a thrown `ClaimWriteError` is not caught here. It reaches `withConfigErrors`
 *   with its own restore point attached, which is the right handling for a fault.
 */
async function runClaim(
  settings: Settings,
  client: JiraClient,
  issueKey: string,
): Promise<ClaimReceipt | null> {
  const result = await claimTicket(createClaimCapabilities(client), {
    issueKey,
    mode: solveMode(settings),
  });

  if (result.outcome === "refused") {
    process.stdout.write(`\nNot claimed: ${result.reason}\n`);
    process.exitCode = 3;
    return null;
  }

  if (result.outcome === "unverified") {
    process.stderr.write(
      `\nThe claim was written to ${issueKey} and could not be confirmed: ${result.reason}\n` +
        `Nothing else will run. Put the labels back by hand if they are wrong; they were: ${result.labelsBefore.join(", ")}\n`,
    );
    process.exitCode = 1;
    return null;
  }

  process.stdout.write(
    `\nClaimed ${issueKey}. Labels are now: ${result.receipt.labelsAfter.join(", ")}\n`,
  );
  return result.receipt;
}

/**
 * Puts the labels back, and says so either way.
 *
 * Never throws for a refusal: this runs on the way out of a run that has often
 * already failed, and turning "the claim was gone before I could undo it" into
 * an exception would replace the operator's real error with a bookkeeping one.
 * It does not set an exit code for the same reason — the outcome of the run is
 * the outcome of the run.
 */
async function runRelease(client: JiraClient, receipt: ClaimReceipt): Promise<void> {
  const result = await releaseClaim(createClaimCapabilities(client), receipt);

  if (result.outcome === "released") {
    process.stdout.write(`\nReleased ${receipt.issueKey}: ${result.labels.join(", ")}\n`);
    return;
  }

  process.stderr.write(
    `\nThe claim on ${receipt.issueKey} was NOT released (${result.outcome}): ${result.reason}\n` +
      `Check the ticket's labels; it may still read as claimed.\n`,
  );
}

/**
 * Commits, pushes and opens the draft pull request.
 *
 * Returns whether the pull request exists, because that answer decides whether
 * the claim is released on the way out. `published-unreviewed` counts as yes:
 * the branch is public and a pull request is open, so releasing the claim would
 * put a solved ticket back in the queue for a second solver to duplicate. The
 * missing reviewer is a `gh pr edit` away and is reported as such.
 */
async function runPublish(
  settings: Settings,
  outcome: Extract<SolveOutcome, { kind: "verified" }>,
  issueKey: string,
): Promise<boolean> {
  const result = await publish(
    createSolveRunDeps(settings),
    buildPublishRequest(settings, outcome, issueKey),
  );

  switch (result.kind) {
    case "published": {
      process.stdout.write(`\nDraft pull request opened: ${result.url}\n`);
      return true;
    }
    case "published-unreviewed": {
      process.stdout.write(
        `\nDraft pull request opened: ${result.url}\n` +
          `The reviewer was not added: ${result.reason}\n` +
          `Add one with: gh pr edit ${String(result.number)} --add-reviewer @copilot\n`,
      );
      return true;
    }
    case "nothing-to-commit": {
      process.stderr.write(`\nNothing to commit — the verified worktree held no change.\n`);
      process.exitCode = 1;
      return false;
    }
    case "failed": {
      process.stderr.write(`\nNo pull request (${result.stage}): ${result.reason}\n`);
      process.exitCode = 1;
      return false;
    }
  }
}

/**
 * The write rungs, in order, with the release as the last thing that happens.
 *
 * `try`/`finally` rather than a release at each exit: the rungs below can set an
 * exit code and return, `runSolver` can throw, and a claim left behind by either
 * is a ticket nobody can pick up again. The one case that must *not* release is
 * a pull request that exists, so that is a flag rather than an early return.
 */
async function runWriteRungs(
  settings: Settings,
  client: JiraClient,
  issueKey: string,
  phase: SolvePhase,
  cycle: SolveCycleOutcome,
): Promise<void> {
  const receipt = await runClaim(settings, client, issueKey);
  if (receipt === null) {
    return;
  }

  let keepClaim = false;
  try {
    if (!includes(phase, "solve")) {
      // The `--claim` rehearsal, and the experiment the plan asks for, performed
      // rather than described: with the claim in place the queue must no longer
      // offer this ticket. Running it here means the check cannot be forgotten,
      // and it costs one query on a command that has already made a round trip.
      const again = await runSolveCycle(createSolveDeps(settings, client));
      const stillOffered = again.planned.some((candidate) => candidate.issueKey === issueKey);
      process.stdout.write(
        stillOffered
          ? `\nThe queue STILL offers ${issueKey} while it is claimed — the claim is not deduplicating.\n`
          : `\nThe queue no longer offers ${issueKey} while it is claimed, which is the dedupe working.\n`,
      );
      if (stillOffered) {
        process.exitCode = 1;
      }
      return;
    }

    const outcome = await runSolver(settings, client, issueKey, cycle);
    if (outcome === null || !includes(phase, "pr") || outcome.kind !== "verified") {
      return;
    }

    keepClaim = await runPublish(settings, outcome, issueKey);
    if (keepClaim) {
      // Said out loud because the rest of the label state machine — `agent:reviewing`,
      // `agent:done` — is not built. The ticket stays on `agent:solving`, which is
      // accurate about the work and wrong about the stage, and a person moving it
      // on is currently the only thing that will.
      process.stdout.write(
        `\n${issueKey} keeps agent:solving. Nothing here writes agent:reviewing yet; move it by hand.\n`,
      );
    }
  } finally {
    if (!keepClaim) {
      await runRelease(client, receipt);
    }
  }
}

async function main(): Promise<void> {
  const args = parseSolveArgs(process.argv.slice(2));
  if (!args.ok) {
    process.stderr.write(`${args.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { issueKey, phase } = args.invocation;

  const settings = readSettings();

  // Checked before the board is read, and long before anything is written. A
  // rung that cannot run should not cost a Jira round trip, and above all should
  // not claim a ticket and solve it on the way to discovering it was never
  // configured to open the pull request the operator asked for.
  const missing = unavailable(phase, settings);
  if (missing !== null) {
    process.stderr.write(`refusing --${phase}: ${missing}\n`);
    logger.warn("solve-once.refused", { phase, issueKey, reason: missing });
    process.exitCode = 3;
    return;
  }

  logger.info("solve-once.settings", { ...describeSettings(settings), phase });

  const client = createJiraClient(settings);
  const deps = createSolveDeps(settings, client);
  const outcome = await runSolveCycle(deps);

  for (const line of decisionLines(outcome, issueKey ?? undefined)) {
    process.stdout.write(`${line}\n`);
  }

  if (issueKey === null) {
    // After the stdout lines, so a failure to write the artifact cannot cost the
    // operator the summary they came for.
    const report = await writeSolveReport(settings.OUTPUT_DIR, outcome, deps, new Date());
    process.stdout.write(`\nWrote ${report}\n`);
  } else {
    process.stdout.write(
      `\nNo artifact written — solve-cycle.md always describes a whole cycle. Run without an issue key for that.\n`,
    );
  }

  // `writes` rather than a phase comparison, and the key check is the parser's
  // rule restated: no rung above the first may run without a named ticket. The
  // parser already rejects that, so this narrows a type rather than guarding.
  const attemptedWrites = writes(phase) && issueKey !== null;
  if (attemptedWrites) {
    await runWriteRungs(settings, client, issueKey, phase, outcome);
  }

  // `cycleDryRun`, not `dryRun`. The field used to carry the shorter name and it
  // read as a claim about the whole command — the first live `--pr` run logged
  // `dryRun: true` on a run that had written the ticket's labels twice. It is
  // true of the planning pass, which never writes and is the only thing
  // `runSolveCycle` does; every write this command makes happens after it, in
  // `runWriteRungs`. So both are reported, and neither pretends to be the other.
  logger.info("solve-once.done", {
    phase,
    issueKey,
    cycleDryRun: outcome.dryRun,
    attemptedWrites,
    found: outcome.found,
    inFlight: outcome.inFlight,
    capacity: outcome.capacity,
    planned: outcome.planned.length,
    skipped: outcome.skipped.length,
    deferred: outcome.deferred.length,
  });
}

await withConfigErrors(main);
