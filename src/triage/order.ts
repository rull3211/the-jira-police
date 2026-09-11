/**
 * What order triage works in, and where the cursor is allowed to stop.
 *
 * These are two different questions and this module exists because the poller
 * used to answer them with one mechanism. `runPollCycle` walked the issues
 * oldest-first and advanced the cursor as it went, so "the order we work in"
 * and "how far we have safely read" were the same loop variable. That is fine
 * while the only order is created-ascending and wrong the moment it is not:
 * re-sorting the loop would advance the cursor past an older ticket that had
 * not been triaged at all, which is precisely the permanent-strand failure
 * rule 2 of the poller's header exists to prevent.
 *
 * So the two are separated here:
 *
 *   `byStatusPriority` — the order to *spend* in. Leftmost column first.
 *   `settledCursor`    — how far we have read, derived from created-ascending
 *                        order and the set of issues that actually succeeded,
 *                        with no reference to the order they were attempted in.
 *
 * The second is a guard, and its property is worth stating plainly: **the
 * cursor never passes an issue that has not succeeded**, whatever order the
 * loop ran in and whatever it did afterwards. That is what makes re-ordering
 * safe, so it is tested by unplugging it — see `order.test.ts`.
 */

import type { TicketRef } from "../jira/types.ts";

/**
 * Fails loudly on a timestamp we cannot read.
 *
 * `Date.parse` returns NaN rather than throwing, and NaN from a comparator
 * leaves the order arbitrary — which would silently drop tickets. Everything in
 * the poll cycle is built to never lose an issue quietly, so a nonsensical
 * timestamp should stop the cycle instead.
 */
function instant(ticket: TicketRef): number {
  const parsed = Date.parse(ticket.created);
  if (Number.isNaN(parsed)) {
    throw new Error(`${ticket.key} has an unparseable created timestamp: ${ticket.created}`);
  }
  return parsed;
}

/**
 * Oldest first. The order the cursor is reasoned about in, always.
 *
 * Compares instants, not strings. Jira returns `created` with a numeric offset
 * rather than `Z` — `2026-09-02T09:55:34.178+0200` — and the offset changes at
 * the DST boundary. A lexicographic compare then orders `02:00+0100` (01:00Z)
 * before `02:30+0200` (00:30Z), which is backwards, and the cursor would
 * advance past the earlier ticket and drop it permanently.
 *
 * Ties break on key so the order is total: equal timestamps are common, and an
 * unstable order there would make the cursor's resume point non-deterministic.
 */
export function byCreatedAscending(a: TicketRef, b: TicketRef): number {
  const delta = instant(a) - instant(b);
  return delta === 0 ? a.key.localeCompare(b.key) : delta;
}

/**
 * Where a ticket's status sits in the configured priority list.
 *
 * Matches on **either** id or name, and that is not the usual "accept both for
 * convenience". `TRIAGE_ONLY_STATUS` learned the hard way that this board's
 * status *names* do not all resolve — `Mottatt` matched zero issues in JQL
 * while `10165` matched all 51 — so an operator who has been told to prefer ids
 * there would be baffled to find ids rejected here. The comparison in this
 * module is in JavaScript against what the API returned, not in JQL, so the
 * name half is sound here even where it is not there; supporting both is what
 * keeps one convention across the two settings.
 *
 * Unlisted sorts last, as does a ticket whose status Jira did not return.
 * `priority.length` rather than `Infinity` so the value stays a number that can
 * be logged and compared without special cases.
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
 * The order to spend model runs in: by column, then oldest first within a
 * column.
 *
 * An empty `priority` returns created-ascending unchanged, which is how the
 * setting stays off by default rather than by a flag somewhere else. See
 * `TRIAGE_STATUS_PRIORITY` in `settings.ts` for why blank reads as "today's
 * behaviour" here while blank reads as "no restriction" in `TRIAGE_ONLY_STATUS`.
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
 * How far the cursor may advance, given what succeeded.
 *
 * Takes the issues in **created-ascending** order and returns the timestamp of
 * the last one in an unbroken run of successes from the oldest forward, or
 * `null` when the oldest itself did not succeed. `null` means "do not move the
 * cursor", which `recordSeen` already reads as keeping the previous value.
 *
 * Everything that is not a success stops the run, and the three ways that
 * happens are deliberately not distinguished: a failure, an issue abandoned to
 * a shutdown, and an issue the loop has not reached yet are all "we cannot
 * prove this one was handled", and the cursor treats them identically. That is
 * what lets this be called after every issue rather than once at the end — the
 * answer only ever grows as the set of successes grows, so persisting it per
 * issue keeps the crash cost at one triage without ever moving the cursor
 * somewhere a later failure would have to take back.
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
