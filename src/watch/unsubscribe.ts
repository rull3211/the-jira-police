/**
 * Taking a ticket off the watch list, as a pure edit: removing
 * `agent:watching`, with the no-op case distinguished from the real one.
 */

import { AGENT_LABELS, labelEdit, type LabelEdit } from "../solve/labels.ts";
import type { UnsubscribeReason } from "./decide.ts";

/**
 * The edit that ends a watch, or `null` when there is nothing to end.
 *
 * `null` is not the same as an empty edit: Jira accepts a removal of an
 * absent label, changing nothing but still bumping `updated` — a footprint on
 * a ticket that was never subscribed. Reachable from `watch:once <KEY>`,
 * which accepts an unwatched ticket so one can be examined before subscribing.
 */
export function unsubscribeEdit(labels: readonly string[]): LabelEdit | null {
  if (!labels.includes(AGENT_LABELS.watching)) {
    return null;
  }
  return labelEdit([], [AGENT_LABELS.watching]);
}

/**
 * What to say on the ticket, or `null` to say nothing.
 *
 * `closed` stays silent — nobody is waiting on a closed ticket, and commenting
 * on the commonest outcome would be a recurring charge to state the obvious.
 * The other two end the watch while the ticket is still open, where silence
 * would read as the tool having seen a later answer and rejected it, so those
 * pay for a comment. Deliberately doesn't name the `agent:watching` label — a
 * reporter shouldn't need this service's label taxonomy to read the message.
 */
export function unsubscribeNote(reason: UnsubscribeReason): string | null {
  switch (reason) {
    case "closed":
      return null;
    case "exhausted":
      return "I have re-checked this ticket as many times as I am allowed to, so I have stopped watching it for updates. If it is ready now, ask for it to be triaged again.";
    case "uncountable":
      return "I have stopped watching this ticket for updates, because I cannot find my own earlier comment on it and so cannot tell how many times I have already looked. If it is ready now, ask for it to be triaged again.";
  }
}
