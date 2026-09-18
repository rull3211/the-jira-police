/**
 * Runs exactly one poll cycle and exits.
 *
 *   node src/cli/poll-once.ts --dry-run   # list what would be triaged, spend nothing
 *   node src/cli/poll-once.ts             # triage the unseen ones for real
 *
 * Wired from the same factory as the daemon (`wiring.ts`), so it's a real rehearsal, not a lookalike.
 * `--dry-run` lists in the order a real run would spend in (not query order), which is the only
 * way to judge `TRIAGE_STATUS_PRIORITY` against a real backlog without paying for a model run.
 */

import { logger } from "../logger.ts";
import { runPollCycle } from "../poller.ts";
import { describeSettings, list, readSettings, withConfigErrors } from "../settings.ts";
import { isUnseen, loadState } from "../state/store.ts";
import { byStatusPriority } from "../triage/order.ts";
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

    // The query window overlaps deliberately, so the raw result count overstates a real run's spend.
    const fresh = candidates.filter((ticket) => isUnseen(state, ticket.key));

    // Applied to everything found, not just the fresh ones, so a `seen` line stays context for the order.
    const priority = list(settings, "TRIAGE_STATUS_PRIORITY");
    for (const ticket of candidates.toSorted(byStatusPriority(priority))) {
      const marker = isUnseen(state, ticket.key) ? "NEW " : "seen";
      const status =
        ticket.statusName === "" ? ticket.statusId || "(no status)" : ticket.statusName;
      process.stdout.write(
        `${marker}  ${ticket.key}  ${ticket.created}  ${status}  ${ticket.issueTypeName}  ${ticket.summary}\n`,
      );
    }

    logger.info("poll-once.dry_run", {
      found: candidates.length,
      alreadySeen: candidates.length - fresh.length,
      wouldTriage: fresh.length,
      // Named even when empty, so the listing is never ambiguous about configured order vs. oldest-first.
      priority,
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

  // A cycle where every issue failed is not a success; a scheduler should see that without parsing logs.
  if (outcome.failed > 0 && outcome.triaged === 0) {
    process.exitCode = 1;
  }
}

await withConfigErrors(main);
