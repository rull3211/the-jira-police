/**
 * Holds a Socket Mode connection and answers `/bencebot`, and `@Bencebot start|clear` in a ticket's
 * thread from someone on SLACK_START_USERS, until Ctrl-C.
 *
 *   pnpm slack:listen [--write]
 *
 * Dry by default: reads the real subscriber list and tickets, writes what a command or a mention
 * would make of them under <OUTPUT_DIR>/slack/, and says so in every reply. `--write` writes the
 * property and the labels.
 */

import { join } from "node:path";

import { createLogger } from "../logger.ts";
import { readSettings, withConfigErrors } from "../settings.ts";
import { listenerFor, rosterWhere, startUsers } from "../wiring.ts";

const log = createLogger("slack-listen");

const EXIT = { ok: 0, usage: 2, threw: 3 } as const;

function usage(): never {
  process.stderr.write(
    "usage: pnpm slack:listen [--write]\n" +
      "  Holds a Socket Mode connection and answers /bencebot subscribe, unsubscribe, status and help\n" +
      "  until Ctrl-C, and @Bencebot start and clear in a ticket's thread from the people on\n" +
      "  SLACK_START_USERS. Dry by default: reads the real jira-police.slack-subscribers list on\n" +
      "  JIRA_PROJECT and writes the would-be list to <OUTPUT_DIR>/slack/roster.json, and a\n" +
      "  mention's would-be label edit to <OUTPUT_DIR>/slack/<KEY>.labels.json; every reply says\n" +
      "  so. --write writes the property and the labels instead, and reads each back.\n" +
      "  Exit: 0 stopped, 2 this usage, 3 the run threw, 78 a setting missing, a token that is\n" +
      "  not an app-level or bot token, a malformed member ID, or a keychain dialog denied.\n",
  );
  process.exit(EXIT.usage);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--write")) {
    usage();
  }
  const write = args.includes("--write");
  const settings = readSettings();
  const where = rosterWhere(settings);
  const controller = new AbortController();
  const start = listenerFor(settings, write ? "live" : "dry", controller.signal);
  const stop = (): void => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const starters = startUsers(settings).length;
  const mentions =
    starters === 0
      ? "No mention is answered: SLACK_START_USERS is empty."
      : `${String(starters)} ${starters === 1 ? "person" : "people"} may start or clear a ticket from its thread${write ? "" : ", dry"}.`;
  process.stdout.write(
    write
      ? `Listening for /bencebot, writing ${where}. ${mentions} Ctrl-C stops.\n`
      : `Listening for /bencebot, dry: ${where} is read, and ${join(settings.OUTPUT_DIR, "slack", "roster.json")} written. ${mentions} Ctrl-C stops.\n`,
  );
  const summary = await start();
  process.stdout.write(
    `\nStopped after ${String(summary.commands)} command(s) and ${String(summary.mentions)} mention(s) over ${String(summary.connections)} connection(s).\n`,
  );
}

try {
  await withConfigErrors(main);
} catch (error) {
  log.error("slack-listen.failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = EXIT.threw;
}
