/**
 * Turning what Jira returned into what the decision reads.
 *
 * A separate file from `decide.ts` for the reason that file gives for being
 * pure: the decision spends money and every one of its failure modes has to be
 * reachable from a plain object. So the two things that need Jira's vocabulary
 * — ADF, and the status-category taxonomy — happen here, once, where they can
 * be tested against literal payloads and where the decision cannot see them.
 */

import { renderAdf } from "../jira/adf.ts";
import type { IssueActivity } from "../jira/client.ts";
import type { WatchSignals } from "./decide.ts";

/**
 * Jira's category key for a ticket that is finished.
 *
 * The key rather than the status *name*: names are per-board, configurable, and
 * on this board Norwegian, so a comparison against `"Done"` would be a watch
 * that never ends on the only board this service runs against.
 */
const DONE_CATEGORY = "done";

/**
 * Flattens one ticket's activity into the four facts `decideWatch` reads.
 *
 * **Rendering the comment bodies is the whole of the work, and it is why the
 * sentinel survives the trip.** `isOurComment` looks for one fixed substring;
 * the wire carries ADF, where that substring is spread across text nodes with
 * emphasis marks on part of it. `renderAdf` is the same function the triage
 * poster's output went through, so the footer comes back out in the form it
 * went in — and a comparison made against the raw JSON would silently never
 * match, which is the failure that reads every ticket as unwatched and
 * re-triages the lot.
 */
export function toWatchSignals(activity: IssueActivity): WatchSignals {
  return {
    key: activity.key,
    closed: activity.statusCategoryKey.trim().toLowerCase() === DONE_CATEGORY,
    comments: activity.comments.map((comment) => ({
      created: comment.created,
      text: renderAdf(comment.body),
    })),
    changes: activity.changes.map((change) => ({
      created: change.created,
      fields: change.fields,
    })),
  };
}
