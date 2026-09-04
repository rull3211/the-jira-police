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
 * ## What actually runs today, and what refuses
 *
 * The first two rungs work and change nothing: they read the board, work out
 * which tickets would be claimed and exactly which label edit each claim would
 * be, and report that. **Every rung above them refuses**, because the write path
 * they need is not wired — `createSolveDeps` composes two readers and no writer,
 * so there is no function present in this process capable of making the edit.
 *
 * That refusal is worth having now rather than when the writer lands. It is the
 * difference between a command that does nothing because nobody implemented it
 * and a command that says which phase is missing, and it means the argument
 * parsing, the usage text and the "one ticket at a time" rule are all in place
 * and tested *before* the privilege arrives rather than in the same change as it.
 *
 * ## The comment this replaces
 *
 * This file used to state that there was deliberately no `--dry-run` flag and no
 * flag to turn the dry run off, "because a flag would imply the other mode
 * exists; it does not." That was true when the only rung was the first one. The
 * plan's own rule is that the sentence gets rewritten in the change that makes it
 * false, rather than being left to become exactly the kind of prose/behaviour
 * divergence this project exists to catch — so here is the honest version:
 *
 * The other mode now exists in the argument parser and does not exist in the
 * wiring. There is still no `--dry-run` flag, because dry is the default and the
 * flag that has to be typed is the one that escalates. What changed is that
 * "this command cannot write" stopped being a property of the whole command and
 * became a property of the phase you asked for.
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
import { type Settings, describeSettings, readSettings, withConfigErrors } from "../settings.ts";
import { reportOutcome } from "../solve/feedback.ts";
import { type SolveRequest, solveTicket } from "../solve/orchestrator.ts";
import { type SolveCycleOutcome, runSolveCycle } from "../solve/poller.ts";
import { decisionLines, writeSolveReport } from "../solve/report.ts";
import {
  NotSolvableError,
  buildSolveRequest,
  createJiraClient,
  createSolveDeps,
  createSolveRunDeps,
  createTicketReader,
} from "../wiring.ts";
import { USAGE, parseSolveArgs, unavailable } from "./solve-args.ts";
import { describeSolveOutcome, isFailureExit } from "./solve-outcome.ts";

/**
 * Runs the four passes against one named ticket and reports what happened.
 *
 * Everything it can do is confined to a temporary worktree. It does not write
 * to Jira, does not push, and does not open anything — `--pr` is the flag that
 * would, and it still refuses.
 *
 * The queue's own opinion is printed but not enforced. An operator who typed a
 * key has already made the decision the queue would make, and refusing a ticket
 * for want of a label would make the solver untestable until the label workflow
 * is wired. What is enforced is `SOLVE_REPOS`, in `buildSolveRequest`, because
 * that one is not about workflow — it is the answer to which repository may be
 * written to.
 */
async function runSolver(
  settings: Settings,
  client: JiraClient,
  issueKey: string,
  cycle: SolveCycleOutcome,
): Promise<void> {
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
      return;
    }
    throw error;
  }

  process.stdout.write(`Repository: ${request.repoPath} @ ${request.baseRef}\n\n`);

  const outcome = await solveTicket(createSolveRunDeps(settings), request);
  process.stdout.write(`\n${describeSolveOutcome(outcome)}\n`);

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
}

async function main(): Promise<void> {
  const args = parseSolveArgs(process.argv.slice(2));
  if (!args.ok) {
    process.stderr.write(`${args.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { issueKey, phase } = args.invocation;

  // Checked before the board is read. A phase that cannot run should not cost a
  // Jira round trip, and more importantly should not print a plan that reads
  // like a prelude to the thing it is about to refuse to do.
  const missing = unavailable(phase);
  if (missing !== null) {
    process.stderr.write(`refusing --${phase}: ${missing}\n`);
    logger.warn("solve-once.refused", { phase, issueKey, reason: missing });
    process.exitCode = 3;
    return;
  }

  const settings = readSettings();
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

  if (phase === "solve" && issueKey !== null) {
    await runSolver(settings, client, issueKey, outcome);
  }

  logger.info("solve-once.done", {
    phase,
    issueKey,
    dryRun: outcome.dryRun,
    found: outcome.found,
    inFlight: outcome.inFlight,
    capacity: outcome.capacity,
    planned: outcome.planned.length,
    skipped: outcome.skipped.length,
    deferred: outcome.deferred.length,
  });
}

await withConfigErrors(main);
