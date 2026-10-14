/**
 * `pnpm slack:draft <thread-link> [--dm]`: what `@Bencebot draft` would send for one thread. `usage()`
 * below says what it reads, writes and exits with.
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
import { SettingsError, readSettings, withConfigErrors } from "../settings.ts";
import { parseThreadLink } from "../slack/start.ts";
import { writeJson } from "../slack/store.ts";
import {
  buttonWithheld,
  draftDelivery,
  draftOfferFor,
  operatorUserId,
  threadDraftDeps,
} from "../wiring.ts";

const log = createLogger("slack-draft");

const EXIT = { drafted: 0, notDrafted: 1, usage: 2, threw: 3, unsent: 4 } as const;

function usage(): never {
  process.stderr.write(
    "usage: pnpm slack:draft <thread-link> [--dm]\n" +
      "  The link is Slack's Copy link on any message in a thread the bot can read. Reads the whole\n" +
      "  thread, runs the read-only thread-draft session over it — Jira and Confluence through the\n" +
      "  Atlassian MCP, the vault, and every checkout SOLVE_REPOS and SOLVE_READ_DIRS name under\n" +
      "  SOLVE_REPO_ROOT — and writes the direct message @Bencebot draft would send to\n" +
      "  <OUTPUT_DIR>/slack/<channel>-<ts>.draft.md, the outcome beside it as .draft.json.\n" +
      "  Dry by default: sends nothing. --dm also sends that message to SLACK_OPERATOR_USER_ID.\n" +
      "  With DRAFT_PROJECTS set, a ticket draft in a listed project whose component and issue type\n" +
      "  Jira lists for it carries a Post to Jira button — in the message --dm sends, and in the\n" +
      "  blocks written to .draft.json — and one that does not says why. With --dm the button is\n" +
      "  sent only if SLACK_OPERATOR_USER_ID is on SLACK_DRAFT_USERS, and its record is kept under\n" +
      "  the state directory. A press does nothing yet.\n" +
      "  Nothing is ever written to Jira. A real run is paid for, like a triage.\n" +
      "  Exit: 0 drafted (a ticket, or the comment a thread that duplicates an open issue adds to\n" +
      "  it), 1 not drafted (the thread was empty, too long, or made neither, and why), 2 this\n" +
      "  usage, 3 the run threw, 4 written but --dm could not send it, 78 a setting missing, a\n" +
      "  token that is not a bot token, or a keychain dialog denied.\n",
  );
  process.exit(EXIT.usage);
}

const EXIT_FOR: Readonly<Record<ThreadDraftOutcome["kind"], number>> = {
  drafted: EXIT.drafted,
  // The comment is a draft a person acts on, the same as a ticket; `.draft.json` says which it was.
  duplicate: EXIT.drafted,
  declined: EXIT.notDrafted,
  empty: EXIT.notDrafted,
  "too-long": EXIT.notDrafted,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const links = args.filter((argument) => !argument.startsWith("--"));
  const flags = args.filter((argument) => argument.startsWith("--"));
  const [link] = links;
  if (link === undefined || links.length > 1 || flags.some((flag) => flag !== "--dm")) {
    usage();
  }
  const thread = parseThreadLink(link);
  if (thread === null) {
    usage();
  }
  const dm = flags.includes("--dm");

  const settings = readSettings();
  // Before the session, so a missing recipient costs nothing.
  const recipient = dm ? operatorUserId(settings) : null;
  if (dm && recipient === null) {
    throw new SettingsError(["SLACK_OPERATOR_USER_ID (who --dm sends the draft to)"]);
  }
  const deliver = dm ? draftDelivery(settings, "live") : null;
  const deps = threadDraftDeps(settings);
  const withheld = buttonWithheld(settings, recipient, dm);
  const offer = withheld === null ? draftOfferFor(settings, dm) : null;
  const directory = join(settings.OUTPUT_DIR, "slack");
  const name = threadLabel(thread);
  const run = { link, ...thread, dm };

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
  const plain = renderDraftMessage(outcome, threadReference(link, thread.channel));
  const prepared =
    offer === null
      ? { text: plain, blocks: null, discard: async () => undefined }
      : await offer.prepare(outcome, plain, {
          asker: recipient ?? "(dry run)",
          thread,
        });
  const message =
    withheld === null ? prepared.text : `${prepared.text}\n_No Post button: ${withheld}._`;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.draft.md`), `${message}\n`, "utf8");

  let sent: { readonly to: string; readonly ts: string } | { readonly failed: string } | null =
    null;
  if (deliver !== null && recipient !== null) {
    try {
      sent = {
        to: recipient,
        ts:
          prepared.blocks === null
            ? await deliver(recipient, name, message)
            : await deliver(recipient, name, message, prepared.blocks),
      };
    } catch (error) {
      await prepared.discard();
      sent = { failed: error instanceof Error ? error.message : String(error) };
    }
  }
  await writeJson(directory, `${name}.draft.json`, {
    ...run,
    outcome,
    message,
    blocks: prepared.blocks,
    sent,
  });
  log.info("slack-draft.done", {
    ...run,
    outcome: outcome.kind,
    sent,
    button: prepared.blocks !== null,
  });

  const said =
    sent === null
      ? "(dry run, nothing sent)"
      : "failed" in sent
        ? `(written, and NOT sent: ${sent.failed})`
        : `(sent to ${sent.to})`;
  process.stdout.write(
    `\n${said} ${message}\n\nWritten to ${join(directory, `${name}.draft.md`)}.\n`,
  );
  process.exitCode = sent !== null && "failed" in sent ? EXIT.unsent : EXIT_FOR[outcome.kind];
}

try {
  await withConfigErrors(main);
} catch (error) {
  log.error("slack-draft.failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = EXIT.threw;
}
