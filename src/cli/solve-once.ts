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
 * refuses to run without an issue key. The rungs themselves are `solve-run.ts`,
 * which this file used to contain: they moved out because a second command needs
 * the same four steps, and a module that runs `main()` on import cannot be
 * imported to get at them.
 * What is left here is this command's own shape — parse, configure, read the
 * queue, report it, and hand a named ticket to the rungs.
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

import { logger } from "../logger.ts";
import { describeSettings, readSettings, withConfigErrors } from "../settings.ts";
import { runSolveCycle } from "../solve/poller.ts";
import { decisionLines, writeSolveReport } from "../solve/report.ts";
import { createJiraClient, createSolveDeps } from "../wiring.ts";
import { USAGE, parseSolveArgs, unavailable, writes } from "./solve-args.ts";
import { runWriteRungs } from "./solve-run.ts";

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
