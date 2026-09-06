/**
 * Reports what the sendback watch would do, and with `--write` does it.
 *
 *   node src/cli/watch-once.ts                 # every ticket carrying agent:watching
 *   node src/cli/watch-once.ts SSX-1234        # one named ticket, whatever its labels
 *   node src/cli/watch-once.ts --write         # ... and act: drop, or re-triage
 *
 * **The flag was `--unsubscribe` until the hand-off landed**, because until then
 * only one of three outcomes had a writer and a `--write` doing nothing on the
 * outcome that matters most, while reporting a clean run, is the divergence this
 * project exists to catch spelled as a command-line flag. Both have writers now.
 *
 * The order those two arrived in was deliberate rather than incidental.
 * Unsubscribing is the action that *reduces* what the watcher can spend: it
 * takes tickets off the list. The re-triage is what puts money on it. Shipping
 * the brake first meant the engine could not be armed without one already in
 * place, and that the terminals in `decideWatch` — `exhausted` and
 * `uncountable`, both of which exist to stop a runaway — were reachable before
 * anything could run away.
 *
 * **A re-triage here posts, and it is not left to `WRITE_BACK` to decide.** The
 * watch is self-limiting only because a re-triage moves the high-water mark it
 * measures from, and the mark is our own comment. A paid run that analysed and
 * posted nothing would leave the ticket triggered on identical content and buy
 * the same run again on the next sweep — §7b's infinite loop, restored by a
 * setting in `.env` rather than by any code here. So the flag decides
 * `WRITE_BACK` for the run, both ways, exactly as `triage:once` learned to.
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
 * first. That argument was easy while the flag only unsubscribed; it survives
 * `--write` for a narrower reason, and the narrowness is worth stating. What
 * this command can spend is bounded by the tickets already carrying the label,
 * by `MAX_RETRIAGE_PER_TICKET` through a counter it writes before it spends,
 * and by a person typing the command once. `WATCH_ENABLED` bounds the thing
 * none of those bound: a loop that types it again.
 */

import { buildSendbackWatchJql } from "../jira/jql.ts";
import { logger } from "../logger.ts";
import type { Settings } from "../settings.ts";
import { describeSettings, list, numeric, readSettings, withConfigErrors } from "../settings.ts";
import { assertIssueKey } from "../jira/client.ts";
import { FileSink } from "../output/sink.ts";
import {
  createGroom,
  createJiraClient,
  createSolveCommenter,
  createWatchChecker,
} from "../wiring.ts";
import { createWatchMemo } from "../watch/memo.ts";
import type { RetriageDeps } from "../watch/retriage.ts";
import { runWatchSweep, type WatchActing } from "../watch/sweep.ts";
import { watchKey, watchWrites } from "./watch-args.ts";

/**
 * The same settings, with the re-triage's comment turned on.
 *
 * Its own function rather than an inline override, so the one line that decides
 * whether a paid run reaches the ticket is greppable and can be argued with.
 * The argument is in the header: the watch is bounded by its own comment moving
 * the high-water mark, so a re-triage that does not post is a charge that
 * repeats. `triage:once` reached the same conclusion from the other direction —
 * that leaving `.env` in charge makes the flag decorative.
 */
function posting(settings: Settings): Settings {
  return { ...settings, WRITE_BACK: "true" };
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

  // Built once, and only when they could be used, because constructing them is
  // how this command acquires the ability to write at all. A dry run holds
  // neither, which makes the refusal structural rather than a branch that could
  // be got wrong — the same argument B1 made for `SolveDeps`.
  //
  // The groom is composed with posting forced on rather than left to the
  // configured value, for the reason in the header: a re-triage that analyses
  // and posts nothing leaves the mark it measures from where it was, so the
  // ticket stays triggered and buys the same run again on the next sweep.
  const acting: WatchActing | null = writes
    ? {
        commenter: createSolveCommenter(settings),
        sink: new FileSink(settings.OUTPUT_DIR),
        retriage: {
          client,
          checker: createWatchChecker(settings),
          groom: createGroom(posting(settings)),
          baseUrl: settings.JIRA_BASE_URL,
        } satisfies RetriageDeps,
      }
    : null;

  const outcome = await runWatchSweep(
    {
      client,
      maxRetriage,
      // Fresh, and it will be thrown away when the process ends. That is right
      // for a command: the memo bounds a check that answers *no* without
      // writing anything, and what bounds this command is a person deciding to
      // type it again. The daemon's is the one that has to survive a tick.
      memo: createWatchMemo(),
      acting,
      report: (line) => process.stdout.write(`${line}\n`),
    },
    keys,
  );

  logger.info("watch-once.done", {
    ...outcome,
    maxRetriage,
    writing: writes,
    // What a dry run *would* have spent, and what a writing one did. Both are
    // reported rather than one or the other, so the two runs of this command an
    // operator makes back to back can be compared line for line.
    wouldSpend: `${outcome.retriage} re-triage run(s)`,
  });
}

await withConfigErrors(main);
