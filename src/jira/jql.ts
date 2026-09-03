/**
 * Builds the JQL used to find newly created issues.
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
