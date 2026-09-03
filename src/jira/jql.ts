/**
 * The two queries this service runs, and the validation both share.
 *
 * `buildNewIssuesJql` finds newly created issues; `buildSolveQueueJql` finds
 * issues whose labels say they are waiting to be fixed. They share nothing but
 * the helpers below, because they disagree about the one thing that matters:
 * the first selects on time and the second selects on state.
 *
 * On the new-issue query:
 *
 * Uses a relative minute offset (`created >= -90m`) rather than an absolute
 * timestamp. Absolute dates in JQL are interpreted in the *server's* timezone,
 * not the caller's, which makes them a persistent source of off-by-hours bugs.
 * A relative offset has no timezone to get wrong.
 *
 * Note that Jira's date filters are minute-precision: two issues created
 * seconds apart are indistinguishable to the query. That is why the window
 * deliberately overlaps and why key-level dedupe in the poller is mandatory
 * rather than an optimisation.
 */

import type { SolveMode } from "../settings.ts";
import { AGENT_LABELS, SOLVE_QUEUE_EXCLUDED_LABELS } from "../solve/labels.ts";

export class JqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JqlError";
  }
}

/**
 * JQL has no parameter binding, so every interpolated value is validated
 * against this instead. Project keys and issue type ids are both covered.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;

export function assertSafe(value: string, label: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new JqlError(`Unsafe ${label} for JQL interpolation: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Anything that would let a value escape its JQL string literal. */
const QUOTE_BREAKERS = /["'\\\r\n]/;

/**
 * Renders a value that may be either an entity id or an entity name.
 *
 * Jira resolves these differently and the quoting decides which: a bare number
 * is looked up as an id, anything quoted is looked up as a name. So
 * `component = 12644` finds the component by id, while `component = "12644"`
 * searches for a component *named* "12644" and finds nothing. Both forms are
 * worth supporting — ids are stable across renames, names are legible in a
 * config file — which makes the numeric check the deciding rule rather than a
 * shortcut.
 *
 * Names are quoted rather than validated against SAFE_IDENTIFIER because real
 * ones contain spaces ("SSX Advisor"). JQL has no parameter binding, so the
 * characters that could terminate the literal early are rejected outright
 * instead of escaped — no legitimate component name contains them, and
 * rejecting is easier to be sure of than escaping.
 */
export function jqlValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new JqlError(`Empty ${label} for JQL interpolation`);
  }
  if (QUOTE_BREAKERS.test(trimmed)) {
    throw new JqlError(`Unsafe ${label} for JQL interpolation: ${JSON.stringify(value)}`);
  }
  return /^[0-9]+$/.test(trimmed) ? trimmed : `"${trimmed}"`;
}

export interface WindowOptions {
  /** ISO-8601 timestamp of the newest issue already processed, or null. */
  readonly cursor: string | null;
  readonly now: Date;
  /** How far back to re-scan beyond the cursor. */
  readonly overlapMs: number;
  /** Window used when there is no cursor yet. */
  readonly firstRunMinutes: number;
}

/**
 * Minutes to look back, rounded up.
 *
 * Rounding up matters: rounding down could exclude the very issue the cursor
 * points at plus anything in the same minute.
 */
export function lookbackMinutes(options: WindowOptions): number {
  if (options.cursor === null) {
    return Math.max(1, Math.ceil(options.firstRunMinutes));
  }

  const cursorMs = Date.parse(options.cursor);
  if (Number.isNaN(cursorMs)) {
    throw new JqlError(`Cursor is not a valid timestamp: ${options.cursor}`);
  }

  const elapsed = options.now.getTime() - cursorMs + options.overlapMs;
  return Math.max(1, Math.ceil(elapsed / 60_000));
}

export interface NewIssuesJqlOptions extends WindowOptions {
  readonly project: string;
  /** Issue type ids to exclude, e.g. sub-tasks. */
  readonly excludedTypeIds: readonly string[];
  /**
   * Components to restrict the search to, by id or by name. Empty means no
   * restriction.
   *
   * The SSX board is shared by several teams, and triaging another team's
   * tickets is both noise and spend. Note that this also excludes issues with
   * no component at all, which is intended: an unclassified ticket is not
   * demonstrably ours.
   */
  readonly components: readonly string[];
}

export function buildNewIssuesJql(options: NewIssuesJqlOptions): string {
  const project = assertSafe(options.project, "project");
  const minutes = lookbackMinutes(options);

  const clauses = [`project = ${project}`, `created >= -${minutes}m`];

  if (options.components.length > 0) {
    const values = options.components.map((entry) => jqlValue(entry, "component")).join(", ");
    clauses.push(`component IN (${values})`);
  }

  if (options.excludedTypeIds.length > 0) {
    const ids = options.excludedTypeIds.map((id) => assertSafe(id, "issue type id")).join(", ");
    clauses.push(`issuetype NOT IN (${ids})`);
  }

  // Ascending so the poller can advance its cursor monotonically.
  return `${clauses.join(" AND ")} ORDER BY created ASC`;
}

export interface InFlightJqlOptions {
  readonly project: string;
  readonly components: readonly string[];
}

/**
 * Builds the JQL that counts solves already running.
 *
 * A separate query because it has to be one. The solve queue excludes
 * `agent:solving` by design — a claimed ticket is not waiting to be claimed —
 * so the tickets that count against `MAX_CONCURRENT_SOLVES` are exactly the
 * ones the queue cannot see. A bound computed from the queue result would cap
 * claims *per cycle* and let the next tick start another, which is not a bound
 * at all.
 *
 * Two differences from `buildSolveQueueJql`, and only one of them is
 * arbitrary:
 *
 *   - **No `statusCategory != Done`.** The queue filters closed tickets out
 *     because working one is pointless; this query must not, because a solve
 *     whose ticket someone closed mid-run is still a solve in flight. Dropping
 *     it here would *undercount*, and undercounting a concurrency limit is the
 *     failure that lets a second claim through. Over-counting only means
 *     waiting, which is the direction to be wrong in.
 *   - **Same project and component scope as the queue.** Kept identical rather
 *     than widened, because this poller only ever writes `agent:solving` inside
 *     that scope, so a claim outside it was not made here and blocking on it
 *     forever would be a stall with no cause anyone could find.
 */
export function buildInFlightJql(options: InFlightJqlOptions): string {
  const clauses = [`project = ${assertSafe(options.project, "project")}`];

  if (options.components.length > 0) {
    const values = options.components.map((entry) => jqlValue(entry, "component")).join(", ");
    clauses.push(`component IN (${values})`);
  }

  clauses.push(`labels = ${jqlValue(AGENT_LABELS.solving, "label")}`);

  return clauses.join(" AND ");
}

export interface SolveQueueJqlOptions {
  readonly project: string;
  /** Same restriction as the new-issue query, for the same reason. */
  readonly components: readonly string[];
  /**
   * `manual` additionally requires `agent:start`, the human go-ahead.
   *
   * Passed as the mode rather than as a boolean on purpose. A
   * `requireStartLabel: false` left at its default by a careless caller is a
   * silent promotion to unattended solving; a mode has to be spelled `"auto"`
   * to mean it, and anything else is read below as manual.
   */
  readonly mode: SolveMode;
  /**
   * Issue types eligible for *unattended* solving, by id or by name.
   *
   * Only consulted in auto mode, and there it is mandatory — see the throw
   * below. Manual mode ignores it entirely, because a human typing `agent:start`
   * on an Epic has said something this list could only second-guess.
   *
   * Rendered through `jqlValue`, so `10004` is resolved as a type id and `Feil`
   * as a type name. Prefer the id: names are localised and renameable, and this
   * board's bug type is `Feil` rather than `Bug` — a hardcoded English default
   * would have matched nothing and turned autosolve into a feature that appeared
   * to be on and never fired.
   */
  readonly autoIssueTypes: readonly string[];
}

/**
 * Builds the JQL that selects tickets waiting to be solved.
 *
 * Deliberately has **no time or cursor clause**, which is the one structural
 * difference from `buildNewIssuesJql` and the reason the two queries cannot be
 * merged. The new-issue poller asks "what appeared since I last looked" and
 * dedupes against a local `seenKeys` list; this one asks "what is in the
 * waiting state right now", and its dedupe is the ticket's own labels. A
 * ticket triaged on Monday is permanently ineligible for the first query and
 * must still be eligible for this one the moment a human labels it on Friday.
 *
 * Because the queue's state lives in Jira rather than on disk, it survives a
 * restart, a wiped `state/` and a second instance without a lock file — but
 * only for as long as the exclusion clause below and the claim written by the
 * solver name exactly the same labels. That is why both come from
 * `src/solve/labels.ts` rather than being spelled out here: two copies of this
 * vocabulary that drifted apart would mean a ticket claimed by one instance
 * and re-claimed by the next.
 *
 * Note the classic `labels NOT IN (...)` gotcha: in Jira that clause also
 * excludes issues whose `labels` field is *empty*, because the field has no
 * value to compare. It is harmless here — `labels = "agent:solvable"`
 * guarantees every candidate already carries at least one label — but the next
 * reader should not have to rediscover that, and any future rewrite that drops
 * the positive label clause would silently start missing unlabelled tickets.
 *
 * Measured against this board rather than taken on trust, 2026-09-03:
 *
 *   labels IS EMPTY                                    → 57 issues
 *   labels IS EMPTY AND labels NOT IN (the three)      →  0 issues
 *   labels = "triaged"                                 → 46 issues
 *   labels = "triaged" AND labels NOT IN (the three)   → 46 issues
 *   labels = "triaged" AND labels NOT IN ("triaged")   →  0 issues
 *
 * So the clause excludes on absence as well as on presence, it does not touch
 * a labelled ticket that simply lacks the named labels, and it does exclude one
 * that carries them. All three are load-bearing, and the first is the reason
 * the positive clause above cannot be removed as redundant.
 */
export function buildSolveQueueJql(options: SolveQueueJqlOptions): string {
  const project = assertSafe(options.project, "project");

  const clauses = [`project = ${project}`];

  if (options.components.length > 0) {
    const values = options.components.map((entry) => jqlValue(entry, "component")).join(", ");
    clauses.push(`component IN (${values})`);
  }

  // A closed ticket is not worth a code change, and the solve queue has no
  // cursor to carry it out of range — without this it would sit in the queue
  // forever.
  clauses.push("statusCategory != Done");

  clauses.push(`labels = ${jqlValue(AGENT_LABELS.solvable, "label")}`);

  // Not `=== "manual"`. The privilege here is running unattended, so the test
  // is for the one value that grants it; every other value, including one that
  // slipped past validation, falls through to requiring a human's label.
  if (options.mode !== "auto") {
    clauses.push(`labels = ${jqlValue(AGENT_LABELS.start, "label")}`);
  } else {
    // Auto mode drops the human's label, so it takes on a restriction in
    // exchange rather than simply being manual-minus-a-check. A bug has a
    // defined broken behaviour and a fix has a definition of done; a Story or an
    // Epic assessed as "solvable" is a judgement about scope, and that is the
    // one this service is least equipped to make without a person.
    //
    // Empty is a hard error, and the reason is not the obvious one. An empty
    // list does not render as "every type" — `issuetype IN ()` is malformed and
    // Jira rejects it — so the immediate behaviour is already a refusal.
    //
    // What this guards is the *fix*. Someone meeting a Jira 400 from a
    // poller cycle reads it as a query-building bug, and the natural repair is
    // to omit the clause when the list is empty, exactly as the component filter
    // legitimately does eight lines above. That repair is a one-line diff, looks
    // like consistency with its neighbour, and quietly promotes auto mode to
    // solving every issue type unattended. Failing here instead, with a message
    // naming the setting, makes the safe repair the obvious one.
    if (options.autoIssueTypes.length === 0) {
      throw new JqlError(
        "SOLVE_MODE=auto with no SOLVE_AUTO_ISSUE_TYPES: set it (the bug type on this board is Feil) rather than removing this restriction — auto mode has no human check, and the issue-type filter is the one it trades for that",
      );
    }
    const types = options.autoIssueTypes.map((entry) => jqlValue(entry, "issue type")).join(", ");
    clauses.push(`issuetype IN (${types})`);
  }

  const excluded = SOLVE_QUEUE_EXCLUDED_LABELS.map((label) => jqlValue(label, "label")).join(", ");
  clauses.push(`labels NOT IN (${excluded})`);

  // Oldest touched first, so a backlog drains in a fair order rather than
  // whichever ticket Jira happened to return first.
  return `${clauses.join(" AND ")} ORDER BY updated ASC`;
}
