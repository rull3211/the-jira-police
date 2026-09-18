/**
 * Order to work in (`byStatusPriority`) and how far the cursor may safely advance
 * (`settledCursor`) are kept separate: the cursor never passes an issue that has not succeeded,
 * regardless of the order tickets were attempted in.
 */

import type { TicketRef } from "../jira/types.ts";

/**
 * Throws on an unparseable timestamp — `Date.parse` returns NaN rather than throwing, and NaN in
 * a comparator would silently leave the order arbitrary.
 */
function instant(ticket: TicketRef): number {
  const parsed = Date.parse(ticket.created);
  if (Number.isNaN(parsed)) {
    throw new Error(`${ticket.key} has an unparseable created timestamp: ${ticket.created}`);
  }
  return parsed;
}

/**
 * Oldest first, comparing instants rather than strings — Jira's offset-suffixed timestamps
 * (`+0200`) sort backwards lexicographically across a DST boundary. Ties break on key so the
 * cursor's resume point is deterministic.
 */
export function byCreatedAscending(a: TicketRef, b: TicketRef): number {
  const delta = instant(a) - instant(b);
  return delta === 0 ? a.key.localeCompare(b.key) : delta;
}

/**
 * Where a ticket's status sits in the configured priority list. Matches by id or name — unlike
 * `TRIAGE_ONLY_STATUS`'s JQL matching, where some status names don't resolve, this compares in
 * JS against the API response, so name matching is safe here.
 *
 * Unlisted sorts last, at `priority.length` rather than `Infinity`, so the value stays a plain
 * comparable number.
 */
export function statusRank(priority: readonly string[], ticket: TicketRef): number {
  const index = priority.findIndex((entry) => matches(entry, ticket));
  return index === -1 ? priority.length : index;
}

function matches(entry: string, ticket: TicketRef): boolean {
  const wanted = entry.trim();
  if (wanted === "") {
    return false;
  }
  if (ticket.statusId !== "" && wanted === ticket.statusId) {
    return true;
  }
  // Names are compared case-insensitively; ids never are, because an id that
  // differs in case is a different id rather than the same one typed casually.
  return ticket.statusName !== "" && wanted.toLowerCase() === ticket.statusName.toLowerCase();
}

/**
 * The order to spend model runs in: by column, then oldest first within a column. An empty
 * `priority` returns created-ascending unchanged — see `TRIAGE_STATUS_PRIORITY` in `settings.ts`
 * for why blank means "today's behaviour" here but "no restriction" in `TRIAGE_ONLY_STATUS`.
 */
export function byStatusPriority(
  priority: readonly string[],
): (a: TicketRef, b: TicketRef) => number {
  if (priority.length === 0) {
    return byCreatedAscending;
  }

  return (a, b) => {
    const delta = statusRank(priority, a) - statusRank(priority, b);
    return delta === 0 ? byCreatedAscending(a, b) : delta;
  };
}

/**
 * How far the cursor may advance: the timestamp of the last success in an unbroken run from the
 * oldest (created-ascending), or `null` if the oldest itself didn't succeed. A failure, an
 * abandoned issue, and one not yet reached are all treated as "not proven handled" — which is
 * what makes it safe to call this after every issue rather than once at the end.
 */
export function settledCursor(
  createdAscending: readonly TicketRef[],
  succeeded: ReadonlySet<string>,
): string | null {
  let settled: string | null = null;
  for (const ticket of createdAscending) {
    if (!succeeded.has(ticket.key)) {
      break;
    }
    settled = ticket.created;
  }
  return settled;
}
