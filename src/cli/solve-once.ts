/**
 * Runs one solve-queue cycle and exits.
 *
 *   node src/cli/solve-once.ts                    the whole queue
 *   node src/cli/solve-once.ts SSX-3822           one ticket
 *   node src/cli/solve-once.ts SSX-3822 --claim   writes the claim label
 *   node src/cli/solve-once.ts SSX-3822 --solve   ... and runs the solver
 *   node src/cli/solve-once.ts SSX-3822 --pr      ... and opens the draft PR
 *   node src/cli/solve-once.ts SSX-3822 --advance one review round on the open PR
 *   node src/cli/solve-once.ts --watch            keep looking at every ticket under review
 *   node src/cli/solve-once.ts SSX-3822 --watch   the same loop, one ticket
 *
 * The ladder is `solve-args.ts`. The rungs themselves are `solve-run.ts`, moved out of this file
 * since a module that runs `main()` on import cannot be imported, and `bot-once.ts` needed the
 * same steps.
 *
 * Every write run opens with a claim and, unless it reached a pull request, closes by putting
 * the labels back exactly as found — a ticket the board shows as unclaimed while a solver works
 * on it is the state the queue exists to prevent. A published pull request keeps the claim,
 * since there the work is real and ongoing.
 *
 * A full cycle writes `<OUTPUT_DIR>/solve-cycle.md`; a single-ticket run does not, since a copy
 * narrowed to one ticket would read as a cycle where only one ticket existed.
 *
 * Unlike `poll:once` this holds no cursor and no state file — the queue is a state, not a
 * window, so running it twice is expected to report the same tickets both times.
 */

import { createLogger } from "../logger.ts";
import { describeSettings, readSettings, solveMode, withConfigErrors } from "../settings.ts";
import { runSolveCycle } from "../solve/poller.ts";
import { decisionLines, writeSolveReport } from "../solve/report.ts";
import { createJiraClient, createSolveDeps } from "../wiring.ts";
import { USAGE, parseSolveArgs, repairUnavailable, unavailable, writes } from "./solve-args.ts";
import { runAdvance, runWatch, runWriteRungs } from "./solve-run.ts";

const log = createLogger("solve-once");

async function main(): Promise<void> {
  const args = parseSolveArgs(process.argv.slice(2));
  if (!args.ok) {
    process.stderr.write(`${args.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const settings = readSettings();

  if (args.invocation.mode === "advance") {
    // Shares nothing with the ladder below: no queue read, no claim written, no report produced
    // — it acts on a pull request the ticket only identifies. `--pr`'s configuration check still
    // applies, since the same GitHub owner names the repository this talks to.
    const { issueKey, repair } = args.invocation;
    const missing = unavailable("pr", settings) ?? (repair ? repairUnavailable(settings) : null);
    if (missing !== null) {
      process.stderr.write(`refusing --advance: ${missing}\n`);
      log.warn("solve-once.refused", { mode: "advance", issueKey, repair, reason: missing });
      process.exitCode = 3;
      return;
    }

    log.info("solve-once.settings", { ...describeSettings(settings), mode: "advance", repair });
    await runAdvance(settings, createJiraClient(settings), issueKey, repair);
    log.info("solve-once.done", { mode: "advance", issueKey });
    return;
  }

  if (args.invocation.mode === "watch") {
    // Shares the advance mode's configuration check and nothing else: no queue read and no
    // report, since this command's subject is pull requests already open, not tickets that have
    // none — running `runSolveCycle` here would overwrite `solve-cycle.md` with a report about
    // work this mode never does.
    const { issueKey, repair } = args.invocation;
    const missing = unavailable("pr", settings) ?? (repair ? repairUnavailable(settings) : null);
    if (missing !== null) {
      process.stderr.write(`refusing --watch: ${missing}\n`);
      log.warn("solve-once.refused", { mode: "watch", issueKey, repair, reason: missing });
      process.exitCode = 3;
      return;
    }

    log.info("solve-once.settings", { ...describeSettings(settings), mode: "watch", repair });
    await runWatch(settings, createJiraClient(settings), issueKey, repair);
    log.info("solve-once.done", { mode: "watch", issueKey });
    return;
  }

  const { issueKey, phase, repair } = args.invocation;

  // Checked before the board is read: a rung that cannot run should not cost a Jira round trip,
  // let alone claim and solve a ticket before discovering it was never configured to open a pull request.
  const missing = unavailable(phase, settings);
  if (missing !== null) {
    process.stderr.write(`refusing --${phase}: ${missing}\n`);
    log.warn("solve-once.refused", { phase, issueKey, reason: missing });
    process.exitCode = 3;
    return;
  }
  const unrepairable = repair ? repairUnavailable(settings) : null;
  if (unrepairable !== null) {
    process.stderr.write(`refusing --repair: ${unrepairable}\n`);
    log.warn("solve-once.refused", { phase, issueKey, repair, reason: unrepairable });
    process.exitCode = 3;
    return;
  }

  log.info("solve-once.settings", { ...describeSettings(settings), phase, repair });

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

  // `writes` rather than a phase comparison: the key check just restates the parser's own rule,
  // narrowing a type rather than guarding.
  const attemptedWrites = writes(phase) && issueKey !== null;
  if (attemptedWrites) {
    await runWriteRungs(settings, client, issueKey, phase, outcome, solveMode(settings), repair);
  }

  // Named `cycleDryRun`, not `dryRun`: it's true of the planning pass only, and every write this
  // command makes happens afterward, in `runWriteRungs` — the shorter name once read as a claim
  // about the whole command.
  log.info("solve-once.done", {
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
