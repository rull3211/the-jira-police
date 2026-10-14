/**
 * `@Bencebot draft` in any thread the bot is in: the person checked against the draft list before
 * anything is read, the session started off the listener's chain, one at a time, and what came of
 * it sent to that person as a direct message. Nothing here writes to Jira.
 */

import {
  type ThreadDraftOutcome,
  type ThreadRef,
  renderDraftMessage,
  threadLabel,
  threadReference,
} from "../draft/thread.ts";
import { createLogger } from "../logger.ts";
import { SessionAbortedError } from "../triage/session.ts";
import { SLACK_USER_ID_PATTERN, escape } from "./render.ts";
import { type Mention, mentionWords } from "./start.ts";

const log = createLogger("slack");

/** On the first word, so `draft please` is answered here with usage rather than by the start handler. */
export function isDraftMention(text: string): boolean {
  return mentionWords(text)[0] === "draft";
}

export const DRAFT_USAGE =
  "In any thread I am in, `@Bencebot draft` reads the whole thread and sends you a drafted Jira ticket as a direct message, or, when an open ticket already asks for the same, the comment to add to it, or says why the thread makes neither. Nothing is filed.";

export interface DraftMentionDeps {
  readonly allowed: readonly string[];
  /** Whether `deliver` writes the message to a file rather than sending it. */
  readonly dry: boolean;
  draft(thread: ThreadRef): Promise<ThreadDraftOutcome>;
  permalink(channel: string, ts: string): Promise<string>;
  deliver(userId: string, threadLabel: string, text: string): Promise<string>;
  /** Seen only by the person, in the thread. */
  reply(mention: Mention, text: string): Promise<void>;
}

export interface DraftHandler {
  /** Never throws, and returns once the reply is sent, not once the draft is done. */
  handle(mention: Mention): Promise<void>;
  /** Resolves once no draft is running: what the listener waits for at shutdown. */
  settled(): Promise<void>;
}

export function createDraftHandler(deps: DraftMentionDeps): DraftHandler {
  const prefix = deps.dry ? "(dry run, nothing sent) " : "";
  let running: { readonly label: string; readonly done: Promise<void> } | null = null;

  const run = async (mention: Mention, thread: ThreadRef): Promise<void> => {
    const label = threadLabel(thread);
    const link = await deps.permalink(thread.channel, thread.threadTs).catch(() => null);
    const where = threadReference(link, thread.channel);
    let text: string;
    let outcome: string;
    try {
      const drafted = await deps.draft(thread);
      outcome = drafted.kind;
      text = renderDraftMessage(drafted, where);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const stopped = error instanceof SessionAbortedError;
      outcome = stopped ? "stopped" : "failed";
      text = stopped
        ? `Bencebot was stopped before the draft of ${where} finished, so nothing was drafted. Mention \`@Bencebot draft\` there again once it is back.`
        : `The draft of ${where} did not finish: ${escape(reason)}. Nothing was drafted; mention \`@Bencebot draft\` there again to retry.`;
      log.warn("slack.draft_failed", { user: mention.userId, thread: label, outcome, reason });
    }
    try {
      const ts = await deps.deliver(mention.userId, label, text);
      log.info("slack.draft_sent", {
        user: mention.userId,
        thread: label,
        outcome,
        ts,
        dry: deps.dry,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("slack.draft_unsent", { user: mention.userId, thread: label, outcome, reason });
      // The ephemeral reply promised a direct message, so the thread is where a lost one is admitted.
      await deps
        .reply(
          mention,
          `${prefix}The draft finished and I could not send it to you: ${escape(reason)}. Mention \`@Bencebot draft\` again to retry.`,
        )
        .catch(() => undefined);
    }
  };

  const answer = (mention: Mention): { readonly decision: string; readonly text: string } => {
    if (!SLACK_USER_ID_PATTERN.test(mention.userId)) {
      return { decision: "no-user", text: "Slack named no user, so nothing was drafted." };
    }
    if (mentionWords(mention.text).length !== 1) {
      return { decision: "usage", text: DRAFT_USAGE };
    }
    if (!deps.allowed.includes(mention.userId)) {
      return {
        decision: "not-allowed",
        text: "Only the people on the draft list may ask for a draft, and you are not one of them, so nothing was read.",
      };
    }
    if (mention.threadTs === null) {
      return {
        decision: "not-a-thread",
        text: `Nothing was drafted: this is not a thread. ${DRAFT_USAGE}`,
      };
    }
    if (running !== null) {
      return {
        decision: "busy",
        text: "I am already drafting another thread, and draft one at a time, so nothing was started. Ask again once that draft arrives.",
      };
    }
    const thread = { channel: mention.channel, threadTs: mention.threadTs };
    const done = run(mention, thread)
      .catch((error: unknown) => {
        log.error("slack.draft_crashed", {
          user: mention.userId,
          reason: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = null;
      });
    running = { label: threadLabel(thread), done };
    return {
      decision: "started",
      text: "Drafting a ticket from this thread. I will send it to you as a direct message when it is done, which takes minutes.",
    };
  };

  return {
    handle: async (mention) => {
      const { decision, text } = answer(mention);
      const reply = prefix + text;
      log.info("slack.draft_mention", {
        user: mention.userId,
        channel: mention.channel,
        threadTs: mention.threadTs,
        decision,
      });
      try {
        await deps.reply(mention, reply);
      } catch (error) {
        log.warn("slack.mention_reply_failed", {
          user: mention.userId,
          reply,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
    settled: async () => {
      await running?.done;
    },
  };
}
