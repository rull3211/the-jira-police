/**
 * Holds a Socket Mode connection and answers `/bencebot` until Ctrl-C.
 *
 *   pnpm slack:listen [--write]
 *
 * Dry by default: reads the real subscriber list from the project, writes what a command would make
 * of it to <OUTPUT_DIR>/slack/roster.json, and says so in every reply. `--write` writes the property.
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
    "usage: pnpm slack:listen [--write]\n" +
      "  Holds a Socket Mode connection and answers /bencebot subscribe, unsubscribe and status\n" +
      "  until Ctrl-C. Dry by default: reads the real jira-police.slack-subscribers list on\n" +
      "  JIRA_PROJECT and writes the would-be list to <OUTPUT_DIR>/slack/roster.json; every\n" +
      "  reply says so. --write writes the property instead, and reads it back each time.\n" +
      "  Exit: 0 stopped, 2 this usage, 3 the run threw, 78 a setting missing, a token that is\n" +
      "  not an app-level token, or a keychain dialog denied.\n",
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
  const client = createListenClient(settings);
  const where = `${ROSTER_PROPERTY} on ${settings.JIRA_PROJECT}`;
  const handle = createCommandHandler(rosterStoreFor(settings, write ? "live" : "dry"), {
    dry: !write,
    where,
  });

  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  process.stdout.write(
    write
      ? `Listening for /bencebot, writing ${where}. Ctrl-C stops.\n`
      : `Listening for /bencebot, dry: ${where} is read, and ${join(settings.OUTPUT_DIR, "slack", "roster.json")} written. Ctrl-C stops.\n`,
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
