/**
 * What `@Bencebot draft` would send, for one thread named at a terminal.
 *
 *   pnpm slack:draft <thread-link>
 *
 * Reads the whole thread, runs the read-only `thread-draft` session, and writes the direct message it
 * would send to <OUTPUT_DIR>/slack/<channel>-<ts>.draft.md, with the outcome beside it as .draft.json.
 * Sends nothing and writes nothing to Jira.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ThreadDraftOutcome,
  draftThread,
  renderDraftMessage,
  threadLabel,
  threadReference,
} from "../draft/thread.ts";
import { createLogger } from "../logger.ts";
import { readSettings, withConfigErrors } from "../settings.ts";
import { parseThreadLink } from "../slack/start.ts";
import { writeJson } from "../slack/store.ts";
import { threadDraftDeps } from "../wiring.ts";

const log = createLogger("slack-draft");

const EXIT = { drafted: 0, notDrafted: 1, usage: 2, threw: 3 } as const;

function usage(): never {
  process.stderr.write(
    "usage: pnpm slack:draft <thread-link>\n" +
      "  The link is Slack's Copy link on any message in a thread the bot can read. Reads the whole\n" +
      "  thread, runs the read-only thread-draft session over it — Jira and Confluence through the\n" +
      "  Atlassian MCP, the vault, and every checkout SOLVE_REPOS and SOLVE_READ_DIRS name under\n" +
      "  SOLVE_REPO_ROOT — and writes the direct message @Bencebot draft would send to\n" +
      "  <OUTPUT_DIR>/slack/<channel>-<ts>.draft.md, the outcome beside it as .draft.json.\n" +
      "  Sends nothing, and writes nothing to Jira. A real run is paid for, like a triage.\n" +
      "  Exit: 0 drafted, 1 not drafted (the thread was empty, too long, or made no ticket, and\n" +
      "  why), 2 this usage, 3 the run threw, 78 a setting missing, a token that is not a bot\n" +
      "  token, or a keychain dialog denied.\n",
  );
  process.exit(EXIT.usage);
}

const EXIT_FOR: Readonly<Record<ThreadDraftOutcome["kind"], number>> = {
  drafted: EXIT.drafted,
  declined: EXIT.notDrafted,
  empty: EXIT.notDrafted,
  "too-long": EXIT.notDrafted,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [link] = args;
  if (link === undefined || args.length > 1) {
    usage();
  }
  const thread = parseThreadLink(link);
  if (thread === null) {
    usage();
  }

  const settings = readSettings();
  const deps = threadDraftDeps(settings);
  const directory = join(settings.OUTPUT_DIR, "slack");
  const name = threadLabel(thread);
  const run = { link, ...thread };

  let outcome: ThreadDraftOutcome;
  try {
    outcome = await draftThread(deps, thread);
  } catch (error) {
    await writeJson(directory, `${name}.draft.json`, {
      ...run,
      threw: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const message = renderDraftMessage(outcome, threadReference(link, thread.channel));
  await writeJson(directory, `${name}.draft.json`, { ...run, outcome, message });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.draft.md`), `${message}\n`, "utf8");
  log.info("slack-draft.done", { ...run, outcome: outcome.kind });

  process.stdout.write(
    `\n(dry run, nothing sent) ${message}\n\nWritten to ${join(directory, `${name}.draft.md`)}.\n`,
  );
  process.exitCode = EXIT_FOR[outcome.kind];
}

try {
  await withConfigErrors(main);
} catch (error) {
  log.error("slack-draft.failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = EXIT.threw;
}
