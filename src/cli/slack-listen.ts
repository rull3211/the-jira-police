/**
 * Holds a Socket Mode connection and answers `/bencebot` until Ctrl-C.
 *
 *   pnpm slack:listen
 *
 * Dry: reads the real subscriber list from the project, writes what a command would make of it to
 * <OUTPUT_DIR>/slack/roster.json, and says so in every reply. Nothing in Jira changes.
 */

import { join } from "node:path";

import { createLogger } from "../logger.ts";
import { readSettings, withConfigErrors } from "../settings.ts";
import { createCommandHandler, ROSTER_PROPERTY } from "../slack/roster.ts";
import { listen, openWebSocket } from "../slack/socket.ts";
import { createListenClient, rosterStoreFor } from "../wiring.ts";

const log = createLogger("slack-listen");

const EXIT = { ok: 0, usage: 2, threw: 3 } as const;

function usage(): never {
  process.stderr.write(
    "usage: pnpm slack:listen\n" +
      "  Holds a Socket Mode connection and answers /bencebot subscribe, unsubscribe and status\n" +
      "  until Ctrl-C. Dry: reads the real jira-police.slack-subscribers list on JIRA_PROJECT and\n" +
      "  writes the would-be list to <OUTPUT_DIR>/slack/roster.json; every reply says so.\n" +
      "  Exit: 0 stopped, 2 this usage, 3 the run threw, 78 a setting missing, a token that is\n" +
      "  not an app-level token, or a keychain dialog denied.\n",
  );
  process.exit(EXIT.usage);
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    usage();
  }
  const settings = readSettings();
  const client = createListenClient(settings);
  const where = `${ROSTER_PROPERTY} on ${settings.JIRA_PROJECT}`;
  const handle = createCommandHandler(rosterStoreFor(settings, "dry"), { dry: true, where });

  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  process.stdout.write(
    `Listening for /bencebot, dry: ${where} is read, and ${join(settings.OUTPUT_DIR, "slack", "roster.json")} written. Ctrl-C stops.\n`,
  );
  const summary = await listen({
    open: () => client.openConnection(),
    connect: openWebSocket,
    handle,
    signal: controller.signal,
  });
  process.stdout.write(
    `\nStopped after ${String(summary.commands)} command(s) over ${String(summary.connections)} connection(s).\n`,
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
