/**
 * Reports what the sendback watch would do, and does none of it.
 *
 *   node src/cli/watch-once.ts                 # every ticket carrying agent:watching
 *   node src/cli/watch-once.ts SSX-1234        # one named ticket, whatever its labels
 *   node src/cli/watch-once.ts --unsubscribe   # ... and act on the drops
 *
 * **`--unsubscribe` is the only write, and the narrow name is the point.** A
 * decision has three outcomes; the re-triage hand-off is not built, so a flag
 * called `--write` would do nothing on the outcome that matters most while
 * still reporting a clean run — the divergence this project exists to catch,
 * spelled as a command-line flag. It becomes `--write` when it means it.
 *
 * That ordering is deliberate rather than incidental. Unsubscribing is the only
 * action here that *reduces* what the watcher can spend: it takes tickets off
 * the list. The re-triage is what puts money on it. Shipping the brake first
 * means the engine cannot later be armed without one already in place, and it
 * means the terminals in `decideWatch` — `exhausted` and `uncountable`, both of
 * which exist to stop a runaway — are reachable before anything can run away.
 *
 * Without the flag it is still a calibration tool, which is what it was built
 * for and what it has already earned. Run against SSX-3830 on 2026-09-06 it
 * confirmed that this board spells the changed field `description`, so
 * `BLOCKER_CLEARING_FIELDS` needed no change — and that `labels`, which this
 * service writes constantly, is not in that set and must never be added to it,
 * since the allowlist is the changelog's entire self-trigger defence.
 *
 * A named key skips the query and is not required to carry the label, so a
 * ticket can be examined before it is subscribed. That is also why
 * `unsubscribeEdit` refuses to write on a ticket without the label rather than
 * sending a removal Jira would accept and ignore.
 *
 * **`WATCH_ENABLED` is deliberately not read here**, and that is the opposite
 * of how the master switch works for the daemon. The switch exists so nothing
 * is spent while nobody is watching, and it guards the loop rather than the
 * operator: this is the command someone uses to decide whether the switch is
 * safe to arm, and gating it would mean the only way to find out is to arm it
 * first. The reading survives `--unsubscribe`, because what that flag spends is
 * bounded by tickets already on the list and every write it makes takes one
 * *off* — it cannot start a watch, only end one.
 */

import { buildSendbackWatchJql } from "../jira/jql.ts";
import { logger } from "../logger.ts";
import { describeSettings, list, numeric, readSettings, withConfigErrors } from "../settings.ts";
import { assertIssueKey } from "../jira/client.ts";
import type { IssueActivity, JiraClient } from "../jira/client.ts";
import { createJiraClient, createSolveCommenter } from "../wiring.ts";
import { decideWatch, type WatchDecision } from "../watch/decide.ts";
import { endWatch } from "../watch/end.ts";
import { toWatchSignals } from "../watch/signals.ts";
import { describeDecision, watchKey, watchWrites } from "./watch-args.ts";

interface Look {
  readonly activity: IssueActivity;
  readonly decision: WatchDecision;
}

async function look(client: JiraClient, key: string, maxRetriage: number): Promise<Look> {
  const activity = await client.fetchActivity(key);
  const signals = toWatchSignals(activity);
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

  return { activity, decision };
}

async function main(): Promise<void> {
  const named = watchKey(process.argv.slice(2));
  const writes = watchWrites(process.argv.slice(2));

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
  let ended = 0;

  // Built once and only when it could be used, because constructing it is how
  // this command would acquire the ability to write at all. A dry run holds no
  // commenter, which makes the refusal structural rather than a branch that
  // could be got wrong — the same argument B1 made for `SolveDeps`.
  const commenter = writes ? createSolveCommenter(settings) : null;

  for (const key of keys) {
    const { activity, decision } = await look(client, key, maxRetriage);
    counts[decision.kind] += 1;
    process.stdout.write(`${describeDecision(key, decision)}\n`);

    if (commenter !== null && decision.kind === "unsubscribe") {
      const did = await endWatch({ client, commenter }, key, activity, decision.reason);
      if (did === "unsubscribed") {
        ended += 1;
      }
    }
  }

  logger.info("watch-once.done", {
    looked: keys.length,
    maxRetriage,
    unsubscribing: writes,
    ended,
    ...counts,
    // Named rather than left implicit: this command reads and the watcher it
    // rehearses does not, so the number that matters to a reader is what a real
    // run would have cost, and today that is nothing.
    wouldSpend: `${counts.retriage} re-triage run(s)`,
  });
}

await withConfigErrors(main);
