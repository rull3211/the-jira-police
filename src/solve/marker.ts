/**
 * The loop's memory of a pull request, rendered as one comment on it.
 *
 * Two numbers have to survive between processes: how many rounds this pull
 * request has cost, and how far through the review the loop has already read.
 * Before this file existed, `buildAdvanceRequest` passed `round: 0` on every
 * invocation, because a fresh process had nothing to count from — so
 * `MAX_REVIEW_ITERATIONS` could not fire from the command line at all and the
 * person typing it was the only thing counting. Tolerable while a person *is*
 * the loop, and not for a second after a daemon drives it.
 *
 * ## Why the state is on the pull request and not in `state/`
 *
 * The same reason the solve queue's dedupe lives in Jira: it survives a
 * restart, a wiped `state/`, and a second instance, and a human can read it.
 * A cursor on disk would reintroduce every one of those failures into the loop
 * that spends the most money per mistake, and losing it *releases* a spend
 * brake — the wrong direction for the one number deciding whether to pay for
 * another round.
 *
 * ## One comment, edited in place
 *
 * Not one per round. A round answers by pushing a commit, which is not an entry
 * in `reviews` or `comments` and leaves no mark to measure from, and a comment
 * per round would leave a wall of bot chatter on every pull request a person
 * has to read past. So there is exactly one, rewritten each round, and it is
 * machine state that happens to be legible.
 *
 * The cost is that GitHub does not notify on an edit, so the marker itself
 * pings nobody. `reRequest` already asks the reviewer to look again every
 * round and that does notify, so the gap is narrower than it looks — but it is
 * why the marker keeps a per-round list rather than only a number.
 *
 * ## No I/O in this file
 *
 * Render and parse, and nothing else. The comment is located, posted and edited
 * in `pr.ts`; the decision about whether another round may run is made in
 * `delivery.ts`. Keeping the format pure is what lets the refuse-rather-than-
 * reset rule below be tested without a pull request.
 */

/**
 * What marks a comment as this service's own.
 *
 * `gh` is authenticated as the operator, so a comment this service posts is
 * authored by a human's GitHub account and is indistinguishable *by author*
 * from that human's own review. Ours is what carries this prefix, not what
 * carries a name — the same sentinel trick the triage poster already relies on.
 *
 * That matters in both directions. A pass handed its own previous answers as
 * though a reviewer had written them is a loop with no new information in it;
 * and a round that mistook the operator's comment for its own marker would
 * overwrite a person's words with machine state.
 */
export const BOT_PREFIX = "bot: ";

/** The marker's first line, and how it is found among the comments. */
export const MARKER_PREFIX = `${BOT_PREFIX}iteration count `;

const LAST_READ = "Last read: ";

export interface Marker {
  /** Rounds already spent on this pull request. Never decreases. */
  readonly count: number;
  /**
   * The high-water mark: the newest comment this loop has already handled.
   *
   * An ISO 8601 instant, written into the body and read back out of it. It
   * cannot be the marker comment's own timestamp — `gh pr view --json comments`
   * returns `createdAt` and nothing that moves on an edit, verified against the
   * live field list. Keeping it in the body has the side benefit that a human
   * can see what the loop thinks it has read.
   */
  readonly lastRead: string;
  /** One line per round, oldest first. What the edit gives up in notifications. */
  readonly rounds: readonly string[];
}

/**
 * The high-water mark to write when there is no date to write.
 *
 * Reached when a round's whole batch came back undated and there was no earlier
 * mark to keep — rare, since `dateOf` reads both of the two field names the API
 * uses, but not impossible. The obvious thing is to write the empty string, and
 * it is a trap: `parseMarker` would refuse the result on the next round, so the
 * pull request would be permanently unadvanceable by a marker this code wrote
 * itself. **A round must never render a marker it cannot read back.**
 *
 * An explicit "never" instead. `isNewer` treats every comment as newer than it,
 * so the next round behaves exactly as though there were no mark at all, which
 * is the honest reading and the safe direction — re-reading a comment costs a
 * round, dropping one loses a reviewer's request silently.
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
 * **An unreadable marker must never come back as zero.** That is the single
 * most important line in this file. Losing the count and starting again from
 * one is how a bounded loop becomes an unbounded one — silently, on the one
 * pull request whose marker got mangled, which is also the pull request nobody
 * is watching. Every failure here is `unreadable`, and the caller's job is to
 * stop the round rather than to pick a default.
 *
 * The instant is checked for parseability but kept as the string that was
 * written. Re-rendering a `Date` would rewrite the operator's own formatting on
 * every round and make the diff between two markers noise.
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

  const rounds = lines
    .slice(2)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));

  return { outcome: "parsed", marker: { count, lastRead, rounds } };
}

/**
 * The narrowest shape `findMarker` needs.
 *
 * Structural rather than `ReviewComment`, so this file keeps its promise not to
 * know about `pr.ts`. Importing the real type would make the pure half of the
 * cursor depend on the half that shells out to `gh`.
 */
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
 * **Two markers is a refusal, not a tie-break.** Picking the higher count, or
 * the later one, would quietly resume from one of them and leave the other to
 * be edited by nobody — and the reason there are two is that something already
 * went wrong, most likely a post that succeeded after its response was lost. A
 * loop that repairs that by choosing has stopped being able to report it. The
 * caller stops the round and a person deletes one comment.
 *
 * **A marker with no node id is a refusal for the same reason, one step
 * earlier.** It cannot be edited, so the round would have to post a second one
 * — which is the case above, created deliberately. Reading it as `absent` is
 * the tempting shortcut and is the worst of the three: it posts that second
 * marker immediately and reports nothing.
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
 * Strictly newer. A comment created at exactly the recorded instant was the
 * newest thing the previous round read, so treating it as fresh would re-handle
 * it every tick — which is the runaway the cursor exists to close, arriving
 * through an off-by-one rather than through a missing feature.
 */
export function isNewer(createdAt: string, lastRead: string): boolean {
  const at = Date.parse(createdAt);
  const mark = Date.parse(lastRead);
  // An unreadable timestamp on either side is treated as new. The failure
  // directions are not symmetric: reading a fresh comment twice costs a round,
  // and dropping one loses a reviewer's request with nothing saying so.
  if (Number.isNaN(at) || Number.isNaN(mark)) {
    return true;
  }
  return at > mark;
}
