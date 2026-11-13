/**
 * `pnpm slack:listen [--write]`: holds a Socket Mode connection and answers `/bencebot` and the
 * `@Bencebot` mentions until Ctrl-C. Dry by default; `usage()` below has the rest.
 */

import { join } from "node:path";

import { createLogger } from "../logger.ts";
import { readSettings, withConfigErrors } from "../settings.ts";
import { commandWhitelist, draftProjects, listenerFor, rosterWhere } from "../wiring.ts";

const log = createLogger("slack-listen");

const EXIT = { ok: 0, usage: 2, threw: 3 } as const;

function usage(): never {
  process.stderr.write(
    "usage: pnpm slack:listen [--write]\n" +
      "  Holds a Socket Mode connection and answers /bencebot subscribe, unsubscribe, status and help\n" +
      "  until Ctrl-C, and @Bencebot start and clear in a ticket's thread, and @Bencebot draft in\n" +
      "  any thread, from the people on SLACK_COMMAND_WHITELIST.\n" +
      "  With DRAFT_PROJECTS set it also answers a press on a draft's Post to Jira button: it checks\n" +
      "  the draft again, and then dry it writes <OUTPUT_DIR>/slack/<id>.issue.json and files nothing,\n" +
      "  while with --write it files the draft in Jira, reads it back and says what it found.\n" +
      "  Dry by default: reads the real jira-police.slack-subscribers list on JIRA_PROJECT and\n" +
      "  writes the would-be list to <OUTPUT_DIR>/slack/roster.json, a mention's would-be label edit\n" +
      "  to <OUTPUT_DIR>/slack/<KEY>.labels.json, and a draft's direct message to\n" +
      "  <OUTPUT_DIR>/slack/<channel>-<ts>.dm.json — a draft's session still runs, and is paid for;\n" +
      "  every reply says so. --write writes the property and the labels instead, reading each\n" +
      "  back, and sends a draft as a direct message.\n" +
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

  const people = commandWhitelist(settings).length;
  const mentions =
    people === 0
      ? "No mention is answered: SLACK_COMMAND_WHITELIST is empty."
      : `${String(people)} ${people === 1 ? "person" : "people"} may start, clear or draft${write ? "" : ", dry, though each draft's session is still paid for"}.${write && draftProjects(settings).length > 0 ? " A press on a draft's Post to Jira button files it." : ""}`;
  process.stdout.write(
    write
      ? `Listening for /bencebot, writing ${where}. ${mentions} Ctrl-C stops.\n`
      : `Listening for /bencebot, dry: ${where} is read, and ${join(settings.OUTPUT_DIR, "slack", "roster.json")} written. ${mentions} Ctrl-C stops.\n`,
  );
  const summary = await start();
  process.stdout.write(
    `\nStopped after ${String(summary.commands)} command(s), ${String(summary.mentions)} mention(s) and ${String(summary.clicks)} click(s) over ${String(summary.connections)} connection(s).\n`,
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
