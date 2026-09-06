/**
 * Reports what the sendback watch would do, and does none of it.
 *
 *   node src/cli/watch-once.ts            # every ticket carrying agent:watching
 *   node src/cli/watch-once.ts SSX-1234   # one named ticket, whatever its labels
 *
 * **There is no `--write` yet, and the omission is the phase boundary rather
 * than an oversight.** Everything here reads: the queue query, one issue's
 * status, its comments and its changelog. What a write would mean is a paid
 * re-triage or a label coming off, and neither is built. A flag implying
 * otherwise would be the divergence this project exists to catch, so the flag
 * arrives with the thing it turns on — which is the same argument
 * `solve-once.ts` made for having no `--dry-run` while there was only one mode.
 *
 * What it is for in the meantime is calibration, and that is worth a command on
 * its own. `plausible` has been landing on tickets since the first slice with
 * nothing reading it, so the population of watched tickets exists and has never
 * been looked at. This prints the decision the watcher *would* make against
 * each one, which is how you find out whether `BLOCKER_CLEARING_FIELDS` covers
 * what reporters on this board actually edit before anything is paying per
 * mistake to find out.
 *
 * A named key skips the query and is not required to carry the label, so a
 * ticket can be examined before it is subscribed.
 *
 * **`WATCH_ENABLED` is deliberately not read here**, and that is the opposite
 * of how the master switch works for the daemon. The switch exists so that no
 * money is spent while nobody is watching; this command spends none and is the
 * thing an operator uses to decide whether the switch is safe to turn on.
 * Gating it would mean the only way to find out is to arm the loop first.
 */

import { buildSendbackWatchJql } from "../jira/jql.ts";
import { logger } from "../logger.ts";
import { describeSettings, list, numeric, readSettings, withConfigErrors } from "../settings.ts";
import { assertIssueKey } from "../jira/client.ts";
import type { JiraClient } from "../jira/client.ts";
import { createJiraClient } from "../wiring.ts";
import { decideWatch, type WatchDecision } from "../watch/decide.ts";
import { toWatchSignals } from "../watch/signals.ts";
import { describeDecision, watchKey } from "./watch-args.ts";

async function look(client: JiraClient, key: string, maxRetriage: number): Promise<WatchDecision> {
  const signals = toWatchSignals(await client.fetchActivity(key));
  const decision = decideWatch(signals, maxRetriage);

  logger.debug("watch.looked", {
    key,
    closed: signals.closed,
    comments: signals.comments.length,
    changes: signals.changes.length,
    decision: decision.kind,
    // **The calibration datum, and the decision cannot carry it.**
    //
    // `decideWatch` reads comments before the changelog and returns on the
    // first trigger, so any ticket somebody has also commented on reports the
    // comment and says nothing about the fields — which is precisely the
    // ticket a reporter answering a sendback produces. The one question this
    // command exists to answer would therefore be masked on exactly the
    // population it was pointed at.
    //
    // Every distinct field name, whatever its age and whether or not it is
    // allowlisted, because the failure being hunted is a name this board uses
    // that `BLOCKER_CLEARING_FIELDS` does not: a filtered list can only ever
    // confirm the guess it was filtered by.
    fields: [...new Set(signals.changes.flatMap((change) => change.fields))].toSorted(),
  });

  return decision;
}

async function main(): Promise<void> {
  const named = watchKey(process.argv.slice(2));

  const settings = readSettings();
  logger.info("watch-once.settings", describeSettings(settings));

  const client = createJiraClient(settings);
  const maxRetriage = numeric(settings, "MAX_RETRIAGE_PER_TICKET");

  let keys: readonly string[];
  if (named === null) {
    const jql = buildSendbackWatchJql({
      project: settings.JIRA_PROJECT,
      components: list(settings, "JIRA_COMPONENTS"),
    });
    logger.info("watch-once.query", { jql });
    keys = (await client.search(jql)).map((ticket) => ticket.key);
  } else {
    // Validated here as well as inside `fetchActivity`, so a typo is refused
    // before a request is made rather than after one comes back 404.
    assertIssueKey(named);
    keys = [named];
  }

  const counts = { retriage: 0, quiet: 0, unsubscribe: 0 };

  for (const key of keys) {
    const decision = await look(client, key, maxRetriage);
    counts[decision.kind] += 1;
    process.stdout.write(`${describeDecision(key, decision)}\n`);
  }

  logger.info("watch-once.done", {
    looked: keys.length,
    maxRetriage,
    ...counts,
    // Named rather than left implicit: this command reads and the watcher it
    // rehearses does not, so the number that matters to a reader is what a real
    // run would have cost, and today that is nothing.
    wouldSpend: `${counts.retriage} re-triage run(s)`,
  });
}

await withConfigErrors(main);
