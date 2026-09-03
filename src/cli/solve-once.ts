/**
 * Runs exactly one solve-queue cycle and exits.
 *
 *   node src/cli/solve-once.ts
 *
 * **This writes nothing.** Not to Jira, not to git, not to disk. It reads the
 * board, works out which tickets it would claim and exactly which label edit
 * each claim would be, and prints that. Phase B of the plan is this command and
 * nothing else — the point is to watch which tickets arrive in the queue for a
 * while before anything is allowed to act on them, because the fitness
 * assessment that puts them there is made by a model that cannot read source
 * code.
 *
 * There is deliberately no `--dry-run` flag, and no flag to turn the dry run
 * off. A flag would imply the other mode exists; it does not. `runSolveCycle`
 * is given no function capable of writing, so this is a property of the wiring
 * rather than of the argument parsing.
 *
 * Unlike `poll:once` this holds no cursor and no state file. The queue is a
 * state, not a window: running it twice in a row is expected to report the same
 * tickets both times, and that repetition is the queue working, not a bug.
 */

import { logger } from "../logger.ts";
import { describeSettings, readSettings, withConfigErrors } from "../settings.ts";
import { runSolveCycle } from "../solve/poller.ts";
import { createJiraClient, createSolveDeps } from "../wiring.ts";

async function main(): Promise<void> {
  const settings = readSettings();

  logger.info("solve-once.settings", describeSettings(settings));

  const client = createJiraClient(settings);
  const outcome = await runSolveCycle(createSolveDeps(settings, client));

  for (const claim of outcome.planned) {
    process.stdout.write(
      `PLAN  ${claim.issueKey}  ${claim.repo}  +[${claim.claim.add.join(", ")}]  -[${claim.claim.remove.join(
        ", ",
      )}]\n`,
    );
  }
  for (const key of outcome.deferred) {
    process.stdout.write(`WAIT  ${key}  eligible, but out of capacity this cycle\n`);
  }
  // Printed rather than counted. A skip is the interesting output of a dry run:
  // it is how you find out that a ticket you expected to be picked up is
  // missing a label, or names a repository nobody added to SOLVE_REPOS.
  for (const skip of outcome.skipped) {
    process.stdout.write(`SKIP  ${skip.issueKey}  ${skip.reason}\n`);
  }

  logger.info("solve-once.done", {
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
