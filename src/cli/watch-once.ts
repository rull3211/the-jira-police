/**
 * Reports what the sendback watch would do, and with `--write` does it.
 *
 *   node src/cli/watch-once.ts                 # every ticket carrying agent:watching
 *   node src/cli/watch-once.ts SSX-1234        # one named ticket, whatever its labels
 *   node src/cli/watch-once.ts --write         # ... and act: drop, or re-triage
 *
 * Unsubscribe and re-triage arrived in that order deliberately: unsubscribing only reduces what
 * the watcher can spend, so the engine could not be armed with spending power before the
 * terminals that stop a runaway (`decideWatch`'s `exhausted` and `uncountable`) were reachable.
 *
 * A re-triage here always posts — `WRITE_BACK` is forced, not left to `.env` — because a paid
 * run that analyses and posts nothing leaves the ticket triggered on identical content and buys
 * the same run again on the next sweep: §7b's infinite loop.
 *
 * A named key skips the query and does not need to carry the label, so a ticket can be examined
 * before it is subscribed; `unsubscribeEdit` refuses to write on a ticket without the label for
 * the same reason.
 *
 * `WATCH_ENABLED` is deliberately not read here: this is the command used to decide whether the
 * switch is safe to arm, and gating it on the switch would make arming the only way to find out.
 * What this command can spend is bounded by the label, `MAX_RETRIAGE_PER_TICKET`, and a person
 * typing it once — none of which bound a loop that types it again, which is what `WATCH_ENABLED` bounds.
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
 * Its own function rather than an inline override, so the one line that decides whether a paid
 * run reaches the ticket is greppable. See the header: a re-triage that does not post is a
 * charge that repeats.
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

  // Constructing these is how this command acquires the ability to write at all; a dry run
  // holds neither, making the refusal structural rather than a branch that could be got wrong.
  //
  // The groom is composed with posting forced on rather than the configured value — see the
  // header for why a re-triage must always post.
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
      // Fresh and thrown away when the process ends — right for a command, since what bounds
      // this run is a person deciding to type it again. The daemon's memo must survive a tick.
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
    // Reported whether or not `writes` is set, so a dry run and a writing run of this command
    // can be compared line for line.
    wouldSpend: `${outcome.retriage} re-triage run(s)`,
  });
}

await withConfigErrors(main);
