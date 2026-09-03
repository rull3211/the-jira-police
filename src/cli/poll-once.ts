/**
 * Runs exactly one poll cycle and exits.
 *
 *   node src/cli/poll-once.ts --dry-run   # list what would be triaged, spend nothing
 *   node src/cli/poll-once.ts             # triage the unseen ones for real
 *
 * This is the daemon minus the loop, wired from the same factory (see
 * `wiring.ts`), so it is a real rehearsal rather than a lookalike.
 *
 * `--dry-run` stops after discovery. It is free, it spends no model budget, and
 * it is the fastest way to tell whether the credential, the project key, the
 * component filter and the lookback window are all right.
 */

import { logger } from "../logger.ts";
import { runPollCycle } from "../poller.ts";
import { describeSettings, readSettings, withConfigErrors } from "../settings.ts";
import { isUnseen, loadState } from "../state/store.ts";
import { createDiscover, createJiraClient, createPollDeps } from "../wiring.ts";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const settings = readSettings();

  logger.info("poll-once.settings", describeSettings(settings));

  const client = createJiraClient(settings);
  const state = await loadState(settings.STATE_PATH);
  logger.info("poll-once.state", { cursor: state.cursor, seen: state.seenKeys.length });

  if (dryRun) {
    const candidates = await createDiscover(settings, client)(state.cursor);

    // The query window overlaps deliberately, so most of what comes back on a
    // steady-state run has already been handled. Reporting the raw result
    // count would overstate the work — and the spend — of a real run.
    const fresh = candidates.filter((ticket) => isUnseen(state, ticket.key));

    for (const ticket of candidates) {
      const marker = isUnseen(state, ticket.key) ? "NEW " : "seen";
      process.stdout.write(
        `${marker}  ${ticket.key}  ${ticket.created}  ${ticket.issueTypeName}  ${ticket.summary}\n`,
      );
    }

    logger.info("poll-once.dry_run", {
      found: candidates.length,
      alreadySeen: candidates.length - fresh.length,
      wouldTriage: fresh.length,
    });
    return;
  }

  const outcome = await runPollCycle(state, createPollDeps(settings, client));

  logger.info("poll-once.done", {
    found: outcome.found,
    skipped: outcome.skipped,
    triaged: outcome.triaged,
    failed: outcome.failed,
    abandoned: outcome.abandoned,
    cursor: outcome.state.cursor,
    skill: settings.SKILL_NAME,
  });

  // A cycle where every issue failed is not a success, and a scheduler should
  // be able to see that without parsing logs.
  if (outcome.failed > 0 && outcome.triaged === 0) {
    process.exitCode = 1;
  }
}

await withConfigErrors(main);
