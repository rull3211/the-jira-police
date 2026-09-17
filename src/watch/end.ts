/**
 * Performing an unsubscribe: the label off, then a comment if one is owed.
 * Its own module, not a function in the command file, so it stays importable
 * without triggering the command's top-level `await`.
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
 * The label comes off before the comment goes on: the label is what stops the
 * ticket being looked at again, so a failed label write must not leave a
 * ticket that already claims nobody is watching it. A failed comment does not
 * throw — the watch is already off and there's nothing left to retry.
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
