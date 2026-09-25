/**
 * The loop's memory of a pull request, rendered as one comment on it.
 *
 * The round count and read cursor live on the pull request rather than in
 * `state/` so they survive a restart, a wiped `state/`, or a second instance —
 * the same reason the solve queue's dedupe lives in Jira. There is exactly one
 * marker comment, edited in place each round rather than one per round, which
 * keeps a wall of bot chatter off the pull request at the cost of GitHub not
 * notifying on an edit (`reRequest` covers that gap).
 *
 * This file only renders and parses; the comment is located, posted and
 * edited in `pr.ts`, and whether another round may run is decided in
 * `delivery.ts`.
 */

/**
 * What marks a comment as this service's own.
 *
 * `gh` posts as the operator's own GitHub account, so authorship alone cannot
 * distinguish our comments from a human's — this prefix is the only signal.
 */
export const BOT_PREFIX = "bot: ";

/** The marker's first line, and how it is found among the comments. */
export const MARKER_PREFIX = `${BOT_PREFIX}iteration count `;

const LAST_READ = "Last read: ";

/** Appended after the high-water mark; the first two lines are read positionally, so inserting here would make older markers unreadable. */
const REVIEWER_ROUNDS = "Reviewer rounds: ";

/** Attempts that never became rounds; omitted when zero so a healthy pull request's marker carries no line saying nothing went wrong. */
const FAILED_STARTS = "Failed starts: ";

/** Always written, so an absent line can only mean a marker from before rounds were counted as landed. */
const LAST_LANDED = "Last landed: ";

export interface Marker {
  /** Rounds already spent on this pull request, whoever asked for them. Never decreases; what `MAX_PR_ROUNDS_TOTAL` reads. */
  readonly count: number;
  /**
   * Of those, the ones spent answering the requested reviewer.
   *
   * Split from `count` because `MAX_REVIEW_ITERATIONS` bounds a bot reviewer's
   * argument, not a human's request, so human rounds advance `count` but leave
   * this alone. Never greater than `count`; `parseMarker` refuses a marker
   * claiming otherwise rather than clamping it.
   */
  readonly reviewerCount: number;
  /**
   * Consecutive attempts that decided on a round and never reached one.
   *
   * `count` and `reviewerCount` only move once a round reserves, so a tick
   * that fails earlier is invisible to every other bound — this is what
   * caught the SSX-3835 stall, four days of a dirty worktree refusing every
   * tick with no cap firing. Reset to zero by any reservation, since a pull
   * request that starts a round has shown the obstacle is gone.
   *
   * Bounded by `MAX_FAILED_STARTS`. Absent from a marker means zero.
   */
  readonly failedStarts: number;
  /**
   * The newest round whose work reached the pull request. A reservation leaves it behind `count`
   * until that round lands, so a round that failed or died cannot be undrafted on top of.
   */
  readonly landed: number;
  /**
   * The high-water mark: the newest comment this loop has already handled.
   *
   * An ISO 8601 instant, written into the body and read back out — it cannot
   * be the marker comment's own timestamp, since `gh pr view --json comments`
   * returns `createdAt` and nothing that moves on an edit.
   */
  readonly lastRead: string;
  /** One line per round, oldest first. */
  readonly rounds: readonly string[];
}

/**
 * The high-water mark to write when there is no date to write.
 *
 * Writing the empty string would make `parseMarker` refuse the result on the
 * next round, permanently unadvanceable by a marker this code wrote itself.
 * This explicit "never" instead reads as older than every comment in `isNewer`.
 */
export const NEVER_READ = "1970-01-01T00:00:00.000Z";

export type ParseMarkerResult =
  | { readonly outcome: "parsed"; readonly marker: Marker }
  | { readonly outcome: "unreadable"; readonly reason: string };

/** Whether a comment body is one this service wrote. */
export function isOurs(body: string): boolean {
  return body.startsWith(BOT_PREFIX);
}

/** Whether a comment body is the marker specifically. */
export function isMarker(body: string): boolean {
  return body.startsWith(MARKER_PREFIX);
}

export function renderMarker(marker: Marker): string {
  const lines = [
    `${MARKER_PREFIX}${String(marker.count)}`,
    `${LAST_READ}${marker.lastRead}`,
    `${REVIEWER_ROUNDS}${String(marker.reviewerCount)}`,
    ...(marker.failedStarts === 0 ? [] : [`${FAILED_STARTS}${String(marker.failedStarts)}`]),
    `${LAST_LANDED}${String(marker.landed)}`,
    "",
    ...marker.rounds.map((round) => `- ${round}`),
  ];
  return lines.join("\n");
}

/** A whole non-negative integer, written out in full. No signs, no exponents. */
const COUNT = /^\d+$/u;

/**
 * Reads the marker back, and refuses anything it cannot read.
 *
 * An unreadable marker must never come back as zero: that would silently turn
 * a bounded loop into an unbounded one on the one pull request whose marker
 * got mangled. The caller's job on `unreadable` is to stop the round, not pick
 * a default. The instant is checked for parseability but kept as the string
 * that was written, so re-rendering it does not turn every diff into noise.
 */
export function parseMarker(body: string): ParseMarkerResult {
  if (!isMarker(body)) {
    return { outcome: "unreadable", reason: "the comment does not begin with the marker line" };
  }

  const lines = body.split("\n");
  const countText = (lines[0] ?? "").slice(MARKER_PREFIX.length).trim();
  if (!COUNT.test(countText)) {
    return {
      outcome: "unreadable",
      reason: `"${countText}" is not a whole number of rounds`,
    };
  }
  const count = Number.parseInt(countText, 10);
  if (!Number.isSafeInteger(count)) {
    return { outcome: "unreadable", reason: `${countText} is too large to be a round count` };
  }

  const readLine = lines[1] ?? "";
  if (!readLine.startsWith(LAST_READ)) {
    return {
      outcome: "unreadable",
      reason:
        "the marker has no high-water mark, so there is nothing to tell a new comment from an old one",
    };
  }
  const lastRead = readLine.slice(LAST_READ.length).trim();
  if (Number.isNaN(Date.parse(lastRead))) {
    return { outcome: "unreadable", reason: `"${lastRead}" is not a readable instant` };
  }

  // Found rather than read positionally: markers from before this line existed
  // lack it, and absent is read as "all of them" (= count), not zero — the
  // cap can only fire sooner, never hand back a whole budget on an old marker.
  const reviewerLine = lines.find((line) => line.startsWith(REVIEWER_ROUNDS));
  let reviewerCount = count;
  if (reviewerLine !== undefined) {
    const reviewerText = reviewerLine.slice(REVIEWER_ROUNDS.length).trim();
    if (!COUNT.test(reviewerText)) {
      return {
        outcome: "unreadable",
        reason: `"${reviewerText}" is not a whole number of reviewer rounds`,
      };
    }
    reviewerCount = Number.parseInt(reviewerText, 10);
    if (!Number.isSafeInteger(reviewerCount)) {
      return {
        outcome: "unreadable",
        reason: `${reviewerText} is too large to be a reviewer round count`,
      };
    }
    // Refused rather than clamped: a marker claiming more reviewer rounds than
    // rounds was edited by something that did not understand it.
    if (reviewerCount > count) {
      return {
        outcome: "unreadable",
        reason: `the marker claims ${String(reviewerCount)} reviewer rounds out of ${String(count)} rounds`,
      };
    }
  }

  // Absent means zero here, the opposite reading from `reviewerCount`'s:
  // guessing anything else would announce a stall on markers predating this
  // line, which genuinely recorded no failures because nothing counted them.
  const failedLine = lines.find((line) => line.startsWith(FAILED_STARTS));
  let failedStarts = 0;
  if (failedLine !== undefined) {
    const failedText = failedLine.slice(FAILED_STARTS.length).trim();
    if (!COUNT.test(failedText)) {
      return {
        outcome: "unreadable",
        reason: `"${failedText}" is not a whole number of failed starts`,
      };
    }
    failedStarts = Number.parseInt(failedText, 10);
    if (!Number.isSafeInteger(failedStarts)) {
      return {
        outcome: "unreadable",
        reason: `${failedText} is too large to be a failed-start count`,
      };
    }
  }

  // Absent means landed (= count), for `failedStarts`' reason: an older marker recorded no landing
  // because nothing did, and reading its rounds as failed would hold correct handovers in draft.
  const landedLine = lines.find((line) => line.startsWith(LAST_LANDED));
  let landed = count;
  if (landedLine !== undefined) {
    const landedText = landedLine.slice(LAST_LANDED.length).trim();
    if (!COUNT.test(landedText)) {
      return {
        outcome: "unreadable",
        reason: `"${landedText}" is not a whole round number for the last landed round`,
      };
    }
    landed = Number.parseInt(landedText, 10);
    if (!Number.isSafeInteger(landed)) {
      return {
        outcome: "unreadable",
        reason: `${landedText} is too large to be a round number`,
      };
    }
    // Refused rather than clamped, like `reviewerCount`: only an edit that misunderstood the marker writes this.
    if (landed > count) {
      return {
        outcome: "unreadable",
        reason: `the marker says round ${String(landed)} landed out of ${String(count)} rounds`,
      };
    }
  }

  const rounds = lines
    .slice(2)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));

  return {
    outcome: "parsed",
    marker: { count, reviewerCount, failedStarts, landed, lastRead, rounds },
  };
}

/** The narrowest shape `findMarker` needs; kept structural rather than importing `ReviewComment` so this file stays independent of `pr.ts`. */
export interface MarkerCandidate {
  readonly body: string;
  readonly id: string;
}

export type FindMarkerResult<T> =
  | { readonly outcome: "found"; readonly comment: T }
  /** No marker yet. The first round on this pull request posts one. */
  | { readonly outcome: "absent" }
  | { readonly outcome: "unusable"; readonly reason: string };

/**
 * Locates the marker among a pull request's comments.
 *
 * Two markers is a refusal, not a tie-break: choosing one to resume from would
 * leave the other orphaned and hide that something already went wrong. A
 * marker with no node id is refused the same way, since it cannot be edited in
 * place — reading it as `absent` would post a second marker immediately.
 */
export function findMarker<T extends MarkerCandidate>(comments: readonly T[]): FindMarkerResult<T> {
  const found = comments.filter((comment) => isMarker(comment.body));
  if (found.length > 1) {
    return {
      outcome: "unusable",
      reason: `${String(found.length)} marker comments on this pull request — a round would resume from one and orphan the other, so a person deletes the extras`,
    };
  }
  const only = found[0];
  if (only === undefined) {
    return { outcome: "absent" };
  }
  if (only.id === "") {
    return {
      outcome: "unusable",
      reason: "the marker comment came back without a node id, so it cannot be edited in place",
    };
  }
  return { outcome: "found", comment: only };
}

/**
 * Whether a comment is newer than the high-water mark.
 *
 * Strictly newer: a comment created at exactly the recorded instant was the
 * newest thing the previous round read, so treating it as fresh would
 * re-handle it every tick.
 */
export function isNewer(createdAt: string, lastRead: string): boolean {
  const at = Date.parse(createdAt);
  const mark = Date.parse(lastRead);
  // An unreadable timestamp on either side is treated as new: re-reading costs a round, dropping one loses a request silently.
  if (Number.isNaN(at) || Number.isNaN(mark)) {
    return true;
  }
  return at > mark;
}
