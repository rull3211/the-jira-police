/**
 * Turning what Jira returned into what the decision reads. Separate from
 * `decide.ts` so the two things that need Jira's vocabulary — ADF and the
 * status-category taxonomy — stay out of the pure decision.
 */

import { renderAdf } from "../jira/adf.ts";
import type { IssueActivity } from "../jira/client.ts";
import type { WatchSignals } from "./decide.ts";

/** Jira's category key for a finished ticket; the key, not the status name, since names are per-board and this board's are Norwegian. */
const DONE_CATEGORY = "done";

/**
 * Flattens one ticket's activity into the four facts `decideWatch` reads.
 * Renders comment bodies through `renderAdf` — the same function the triage
 * poster's output went through — so the sentinel comes back matchable.
 */
export function toWatchSignals(activity: IssueActivity): WatchSignals {
  return {
    key: activity.key,
    // Carried rather than filtered — a filter here would be a second place
    // that has to know which namespace the decision reads.
    labels: activity.labels,
    closed: activity.statusCategoryKey.trim().toLowerCase() === DONE_CATEGORY,
    comments: activity.comments.map((comment) => ({
      created: comment.created,
      updated: comment.updated,
      text: renderAdf(comment.body),
    })),
    changes: activity.changes.map((change) => ({
      created: change.created,
      fields: change.fields,
    })),
    // Attachments are copied field by field rather than passed through, so
    // adding their bytes to the prompt later would be a visible edit here.
    content: {
      summary: activity.content.summary,
      description: renderAdf(activity.content.description),
      environment: renderAdf(activity.content.environment),
      attachments: activity.content.attachments.map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
    },
  };
}
