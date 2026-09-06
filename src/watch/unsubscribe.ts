/**
 * Taking a ticket off the watch list, as a pure edit.
 *
 * The whole of an unsubscribe is removing `agent:watching`. That is one line,
 * and it is a function anyway for the two things wrapped around it: the no-op
 * case has to be distinguishable from the real one, and the note that goes on
 * the ticket has to be derived from the same reason the decision carried rather
 * than written again at the call site.
 */

import { AGENT_LABELS, labelEdit, type LabelEdit } from "../solve/labels.ts";
import type { UnsubscribeReason } from "./decide.ts";

/**
 * The edit that ends a watch, or `null` when there is nothing to end.
 *
 * **`null` is not the same as an empty edit, and the difference is a write.**
 * Jira accepts a removal of a label that is not present; it changes nothing and
 * still bumps `updated`. That field is what the solve queue orders by and what
 * a human reads as "somebody touched this ticket", so a run that unsubscribes a
 * ticket it was never subscribed to would leave a footprint reporting an event
 * that did not happen — on somebody else's ticket, for no reason.
 *
 * It is reachable rather than theoretical: `watch:once <KEY>` deliberately
 * accepts a ticket with no `agent:watching` label so one can be examined before
 * it is subscribed, and a closed ticket among those returns `unsubscribe`.
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
 * **Silence is the right answer for `closed`, and it is also the only one of
 * the three that is cheap to get wrong.** A comment costs a storecode session —
 * $0.40 measured — and closing is how nearly every watch will end, so
 * commenting on all three would put a recurring charge on the most common
 * outcome to tell a reporter something they just did themselves. Nobody is
 * waiting on a closed ticket.
 *
 * The other two are the watcher giving up while the ticket is still open, and
 * there the silence actively misleads. A reporter who answers afterwards gets
 * no response and reads it as the tool having seen the answer and rejected it,
 * which is worse than never having been watched — so those two pay for the
 * comment and say how to get another look.
 *
 * The rule lives here rather than as a condition at the call site because it is
 * a fact about the reasons, and a caller that has to remember it is a caller
 * that can forget it.
 *
 * Deliberately does not name the label. `agent:watching` is this service's
 * bookkeeping, and a reporter reading their own bug should not have to learn a
 * label taxonomy to find out that nothing is watching it any more.
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
