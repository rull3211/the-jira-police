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
}

export function buildNewIssuesJql(options: NewIssuesJqlOptions): string {
  const project = assertSafe(options.project, "project");
  const minutes = lookbackMinutes(options);

  const clauses = [`project = ${project}`, `created >= -${minutes}m`];

  if (options.excludedTypeIds.length > 0) {
    const ids = options.excludedTypeIds.map((id) => assertSafe(id, "issue type id")).join(", ");
    clauses.push(`issuetype NOT IN (${ids})`);
  }

  // Ascending so the poller can advance its cursor monotonically.
  return `${clauses.join(" AND ")} ORDER BY created ASC`;
}
