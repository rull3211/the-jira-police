/**
 * The edit `@Bencebot start` and `@Bencebot clear` make, for one thread named at a terminal, where
 * being at the terminal is the authority and the start list does not apply.
 *
 *   pnpm slack:start <thread-link> [--clear] [--write]
 *
 * Dry by default: reads the thread's top message, the ticket's jira-police.slack record and its
 * labels, and writes the edit to <OUTPUT_DIR>/slack/<KEY>.labels.json. `--write` sends it to the
 * ticket and reads it back.
 */

import { join } from "node:path";

import { createLogger } from "../logger.ts";
import { readSettings, withConfigErrors } from "../settings.ts";
import {
  type ThreadOutcome,
  describeThreadOutcome,
  parseThreadLink,
  runThreadCommand,
} from "../slack/start.ts";
import { writeJson } from "../slack/store.ts";
import { threadCommandDeps } from "../wiring.ts";

const log = createLogger("slack-start");

const EXIT = { ok: 0, declined: 1, usage: 2, threw: 3, unverified: 4 } as const;

function usage(): never {
  process.stderr.write(
    "usage: pnpm slack:start <thread-link> [--clear] [--write]\n" +
      "  The link is Slack's Copy link on a ticket's audit thread or any reply in it. Adds\n" +
      "  agent:start to that ticket, or with --clear takes agent:failed off it, once the bot's\n" +
      "  own top message and the ticket's jira-police.slack record both name the thread.\n" +
      "  Dry by default: writes the edit to <OUTPUT_DIR>/slack/<KEY>.labels.json and changes\n" +
      "  nothing remote. --write sends it to the ticket and reads it back. Every run writes its\n" +
      "  outcome to <OUTPUT_DIR>/slack/<channel>-<ts>.thread.json.\n" +
      "  Exit: 0 written or already so, 1 declined (the thread or the ticket, and why), 2 this\n" +
      "  usage, 3 the run threw, 4 written but the read-back disagrees, 78 a setting missing, a\n" +
      "  token that is not a bot token, or a keychain dialog denied.\n",
  );
  process.exit(EXIT.usage);
}

const EXIT_FOR: Readonly<Record<ThreadOutcome["kind"], number>> = {
  "no-ticket": EXIT.declined,
  refused: EXIT.declined,
  unchanged: EXIT.ok,
  dry: EXIT.ok,
  written: EXIT.ok,
  unverified: EXIT.unverified,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const links = args.filter((argument) => !argument.startsWith("--"));
  const flags = args.filter((argument) => argument.startsWith("--"));
  const link = links[0];
  if (
    link === undefined ||
    links.length > 1 ||
    flags.some((flag) => flag !== "--clear" && flag !== "--write")
  ) {
    usage();
  }
  const thread = parseThreadLink(link);
  if (thread === null) {
    usage();
  }
  const verb = flags.includes("--clear") ? "clear" : "start";
  const write = flags.includes("--write");

  const settings = readSettings();
  const deps = threadCommandDeps(settings, write ? "live" : "dry");
  const outcome = await runThreadCommand(deps, { verb, ...thread });

  const directory = join(settings.OUTPUT_DIR, "slack");
  await writeJson(directory, `${thread.channel}-${thread.threadTs}.thread.json`, {
    link,
    ...thread,
    verb,
    dry: !write,
    outcome,
  });
  const prefix = write ? "" : "(dry run, nothing written) ";
  const edited =
    outcome.kind === "dry" ? ` See ${join(directory, `${outcome.key}.labels.json`)}.` : "";
  process.stdout.write(`\n${prefix}${describeThreadOutcome(verb, outcome)}${edited}\n`);
  process.exitCode = EXIT_FOR[outcome.kind];
}

try {
  await withConfigErrors(main);
} catch (error) {
  log.error("slack-start.failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = EXIT.threw;
}
