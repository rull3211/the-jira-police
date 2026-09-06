/**
 * Performing an unsubscribe: the label off, then a comment if one is owed.
 *
 * Its own module rather than a function in `watch-once.ts` for the reason
 * `watch-args.ts` exists — the command ends in a top-level `await`, so anything
 * living there runs on import and cannot be tested. That is not a filing
 * preference here: the ordering below is the only guard in this slice that can
 * fail while every part of it succeeds, and D4e already recorded one predicate
 * that shipped unguarded because the only place it was used was a command file.
 */

import type { IssueActivity, JiraClient } from "../jira/client.ts";
import { logger } from "../logger.ts";
import type { TicketCommenter } from "../solve/feedback.ts";
import type { UnsubscribeReason } from "./decide.ts";
import { unsubscribeEdit, unsubscribeNote } from "./unsubscribe.ts";

export interface EndWatchDeps {
  readonly client: Pick<JiraClient, "updateLabels">;
  readonly commenter: TicketCommenter;
}

/**
 * Ends one watch. Returns what it actually did, so a caller can count it.
 *
 * **The label comes off before the comment goes on, and the order is the whole
 * design.** The label is what stops the ticket being looked at again; the
 * comment is a courtesy. Comment first and a failed label write leaves a ticket
 * that has been told nobody is watching it while it is still on the list — so
 * it gets told again, every sweep, indefinitely, which is a bot repeating a
 * goodbye on somebody's bug. This way round the worst case is a ticket
 * correctly unsubscribed and one person uninformed.
 *
 * That is the same argument the review cursor makes for reserving a round
 * before running the pass: **when two writes can fail independently, do the one
 * that stops the loop first.**
 *
 * A failed comment therefore does not throw. There is nothing left to retry —
 * the watch is already off, and a second attempt would need the label back —
 * so propagating it would report the unsubscribe as not having happened when
 * the half that matters did, and would abandon the rest of a sweep over a
 * courtesy message.
 */
export async function endWatch(
  deps: EndWatchDeps,
  key: string,
  activity: IssueActivity,
  reason: UnsubscribeReason,
): Promise<"unsubscribed" | "not-watched"> {
  const edit = unsubscribeEdit(activity.labels);
  if (edit === null) {
    logger.info("watch.unsubscribe.skipped", { key, reason, why: "not watched" });
    return "not-watched";
  }

  await deps.client.updateLabels(key, edit);
  logger.info("watch.unsubscribed", { key, reason });

  const note = unsubscribeNote(reason);
  if (note !== null) {
    try {
      await deps.commenter.comment(key, note);
      logger.info("watch.unsubscribe.commented", { key });
    } catch (error) {
      logger.warn("watch.unsubscribe.comment_failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return "unsubscribed";
}
