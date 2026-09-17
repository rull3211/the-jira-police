/**
 * The queries this service runs, and the validation all of them share.
 *
 * `buildNewIssuesJql` selects on time and carries the only cursor; the rest select on board state,
 * with labels as the dedupe, so a ticket triaged on Monday can re-enter any of them on Friday. The
 * new-issue query uses a relative minute offset (`created >= -90m`) rather than an absolute timestamp,
 * since JQL dates resolve in the server's timezone; Jira's date filters are minute-precision, so the
 * window overlaps deliberately and key-level dedupe in the poller is mandatory, not an optimisation.
 */

import type { SolveMode } from "../settings.ts";
import { AGENT_LABELS, SOLVE_QUEUE_EXCLUDED_LABELS } from "../solve/labels.ts";

export class JqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JqlError";
  }
}

/** JQL has no parameter binding; every interpolated project key or issue type id is checked against this instead. */
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
 * Jira resolves these differently and the quoting decides which: a bare number is looked up as an id,
 * anything quoted is looked up as a name, so `component = 12644` and `component = "12644"` are
 * different queries. Names are quoted rather than checked against `SAFE_IDENTIFIER` since real ones
 * contain spaces; the characters that could terminate the literal early are rejected rather than escaped.
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
   * Components to restrict the search to, by id or by name. Empty means no restriction.
   *
   * Also excludes issues with no component at all, which is intended: an unclassified ticket is not
   * demonstrably ours.
   */
  readonly components: readonly string[];
  /**
   * Statuses discovery may triage, by id or by name. Empty means no restriction beyond "not closed".
   *
   * Prefer ids: on this instance `status = "Mottatt"` matches zero issues while `status = 10165`
   * matches the same column's 51, so a name that resolves to nothing is a silent hole, not an error.
   */
  readonly statuses: readonly string[];
}

export function buildNewIssuesJql(options: NewIssuesJqlOptions): string {
  const project = assertSafe(options.project, "project");
  const minutes = lookbackMinutes(options);

  const clauses = [`project = ${project}`, `created >= -${minutes}m`];

  // Either the allowlist or the closed filter, never both: an allowlist naming a closed status would
  // be silently defeated by a `statusCategory != Done` sitting beside it.
  if (options.statuses.length > 0) {
    const values = options.statuses.map((entry) => jqlValue(entry, "status")).join(", ");
    clauses.push(`status IN (${values})`);
  } else {
    // Status names are per-board and this board's are Norwegian, so `status != "Done"` matches nothing.
    clauses.push("statusCategory != Done");
  }

  if (options.components.length > 0) {
    const values = options.components.map((entry) => jqlValue(entry, "component")).join(", ");
    clauses.push(`component IN (${values})`);
  }

  if (options.excludedTypeIds.length > 0) {
    const ids = options.excludedTypeIds.map((id) => assertSafe(id, "issue type id")).join(", ");
    clauses.push(`issuetype NOT IN (${ids})`);
  }

  // Ascending: `client.ts` truncates at `MAX_PAGES`, and this way the unfetched page holds the newest
  // issues, which come back next cycle rather than being lost past the cursor for good.
  return `${clauses.join(" AND ")} ORDER BY created ASC`;
}

export interface InFlightJqlOptions {
  readonly project: string;
  readonly components: readonly string[];
}

/**
 * Builds the JQL that counts solves already running.
 *
 * A separate query because the solve queue excludes `agent:solving` by design, so the tickets that
 * count against `MAX_CONCURRENT_SOLVES` are exactly the ones the queue cannot see. Unlike the queue it
 * does not filter `statusCategory != Done` — a solve whose ticket closed mid-run is still in flight,
 * and undercounting a concurrency limit is the failure that lets a second claim through.
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

export interface ReviewQueueJqlOptions {
  readonly project: string;
  readonly components: readonly string[];
}

/**
 * Builds the JQL that selects the pull requests still worth looking at.
 *
 * Both labels: watching `agent:reviewing` alone would mean an undraft silently ends the loop, which is
 * exactly the ending §6.1 of the plan was written to remove, reintroduced through a label instead of a
 * `return`. No `statusCategory != Done` either — a ticket closed while its pull request is open still
 * needs the look that writes `agent:done`/`agent:closed`; filtering it out would leave the label on it
 * forever, the leak §3c names, arriving through the query instead of the state machine.
 */
export function buildReviewQueueJql(options: ReviewQueueJqlOptions): string {
  const clauses = [`project = ${assertSafe(options.project, "project")}`];

  if (options.components.length > 0) {
    const values = options.components.map((entry) => jqlValue(entry, "component")).join(", ");
    clauses.push(`component IN (${values})`);
  }

  const watched = [AGENT_LABELS.reviewing, AGENT_LABELS.reviewDone]
    .map((label) => jqlValue(label, "label"))
    .join(", ");
  clauses.push(`labels IN (${watched})`);

  return `${clauses.join(" AND ")} ORDER BY updated ASC`;
}

export interface SendbackWatchJqlOptions {
  readonly project: string;
  readonly components: readonly string[];
}

/**
 * Builds the JQL that selects the sent-back tickets under watch.
 *
 * Deliberately does NOT filter `statusCategory != Done`, though §7c argued it should: a ticket the
 * query cannot see is one nothing can unsubscribe, so excluding closed tickets would leave
 * `agent:watching` on them forever — the same leak `buildReviewQueueJql` refuses above.
 */
export function buildSendbackWatchJql(options: SendbackWatchJqlOptions): string {
  const clauses = [`project = ${assertSafe(options.project, "project")}`];

  if (options.components.length > 0) {
    const values = options.components.map((entry) => jqlValue(entry, "component")).join(", ");
    clauses.push(`component IN (${values})`);
  }

  clauses.push(`labels = ${jqlValue(AGENT_LABELS.watching, "label")}`);

  return `${clauses.join(" AND ")} ORDER BY updated ASC`;
}

export interface SolveQueueJqlOptions {
  readonly project: string;
  /** Same restriction as the new-issue query, for the same reason. */
  readonly components: readonly string[];
  /**
   * `manual` additionally requires `agent:start`, the human go-ahead.
   *
   * Passed as a mode rather than a boolean: a `requireStartLabel: false` left at its default by a
   * careless caller is a silent promotion to unattended solving, where a mode must spell `"auto"`.
   */
  readonly mode: SolveMode;
  /**
   * Issue types eligible for *unattended* solving, by id or by name; only consulted, and mandatory, in
   * auto mode. Prefer the id: this board's bug type is `Feil`, not `Bug`, so a hardcoded English
   * default would match nothing and turn autosolve into a feature that never fires.
   */
  readonly autoIssueTypes: readonly string[];
}

/**
 * Builds the JQL that selects tickets waiting to be solved.
 *
 * Deliberately has no time or cursor clause: this asks "what is in the waiting state right now" and
 * dedupes on the ticket's own labels, so a ticket ineligible Monday must still be eligible the moment
 * a human labels it Friday. The exclusion clause below and the claim the solver writes must name
 * exactly the same labels — both come from `src/solve/labels.ts` rather than being spelled out here,
 * so the two cannot drift and double-claim a ticket. `labels NOT IN (...)` also excludes issues whose
 * `labels` field is empty; harmless here since the positive `labels = "agent:solvable"` clause already
 * guarantees a label, but dropping that positive clause would silently start missing unlabelled tickets.
 */
export function buildSolveQueueJql(options: SolveQueueJqlOptions): string {
  const project = assertSafe(options.project, "project");

  const clauses = [`project = ${project}`];

  if (options.components.length > 0) {
    const values = options.components.map((entry) => jqlValue(entry, "component")).join(", ");
    clauses.push(`component IN (${values})`);
  }

  // The solve queue has no cursor to carry a closed ticket out of range without this.
  clauses.push("statusCategory != Done");

  clauses.push(`labels = ${jqlValue(AGENT_LABELS.solvable, "label")}`);

  // Not `=== "manual"`: the test is for the one value that grants unattended running, so anything else,
  // including a value that slipped past validation, falls through to requiring a human's label.
  if (options.mode !== "auto") {
    clauses.push(`labels = ${jqlValue(AGENT_LABELS.start, "label")}`);
  } else {
    // Empty is a hard error even though `issuetype IN ()` already fails: omitting the clause instead,
    // the repair that looks consistent with the component filter above, would quietly promote auto
    // mode to solving every issue type unattended.
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

  // Oldest touched first, so a backlog drains in a fair order.
  return `${clauses.join(" AND ")} ORDER BY updated ASC`;
}
