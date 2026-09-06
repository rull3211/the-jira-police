import { describe, expect, it } from "vitest";

import { FOOTER_SENTINEL } from "../triage/gate.ts";
import { BLOCKER_CLEARING_FIELDS, decideWatch, isOurComment, type WatchSignals } from "./decide.ts";

/**
 * A triage comment of ours, at a given time.
 *
 * `updated` defaults to `created`, which is what Jira returns for a comment
 * nobody has edited — and the default is where this file was wrong for a day.
 * The poster rewrites its own comment in place on every re-triage, so the real
 * ticket this feature watches has one comment of ours whose two timestamps
 * differ by however long the watch has been running. Every fixture below that
 * leaves them equal is describing a ticket triaged exactly once, and the tests
 * that need the other shape say so explicitly.
 */
function ourComment(created: string, updated: string = created) {
  return {
    created,
    updated,
    text: `# ↩ SEND BACK · SSX-1234\n\nFill in the baseline.\n\n${FOOTER_SENTINEL}`,
  };
}

function theirComment(created: string, text = "Baseline is 42%.", updated: string = created) {
  return { created, updated, text };
}

function signals(overrides: Partial<WatchSignals> = {}): WatchSignals {
  return {
    key: "SSX-1234",
    closed: false,
    comments: [ourComment("2026-09-01T10:00:00.000+0200")],
    changes: [],
    ...overrides,
  };
}

describe("isOurComment", () => {
  it("keys on the sentinel rather than on an author", () => {
    // There is no author to key on: the poster writes through an MCP session on
    // a human's Atlassian account, so our comment and that human's own are
    // indistinguishable by authorship. Same finding as `reviewerComments` on
    // GitHub, same answer.
    expect(isOurComment(ourComment("2026-09-01T10:00:00.000+0200"))).toBe(true);
    expect(isOurComment(theirComment("2026-09-01T10:00:00.000+0200"))).toBe(false);
  });
});

describe("the self-trigger, which is the whole point of the function", () => {
  it("does not re-triage a ticket whose only activity is our own comment", () => {
    // THE mutation named in the plan: unplug the author check and a test must
    // fail with a re-triage on a ticket nobody touched. Its absence is
    // invisible in review and obvious on the invoice.
    expect(decideWatch(signals(), 3)).toEqual({ kind: "quiet" });
  });

  it("does not re-triage on the label write that follows our own comment", () => {
    // The precise shape of the runaway. Posting the comment sets `updated`, and
    // the labels written a moment later set it again — so a rule reading
    // `updated > ourLastComment` is true the instant we stop typing, and every
    // watched ticket becomes one paid run per cycle forever.
    const afterUs = signals({
      changes: [{ created: "2026-09-01T10:00:03.000+0200", fields: ["labels"] }],
    });

    expect(decideWatch(afterUs, 3)).toEqual({ kind: "quiet" });
  });

  it.each(["labels", "Component", "Link", "priority", "assignee", "Sprint", "Rank"])(
    "ignores a change to %s, which cannot clear a blocker",
    (field) => {
      // Board grooming must not read as "the reporter responded". Over-
      // triggering does not merely cost a run, it spends the ticket's whole
      // re-triage budget on noise, so the watch is exhausted by the time the
      // reporter actually answers.
      const groomed = signals({
        changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: [field] }],
      });

      expect(decideWatch(groomed, 3)).toEqual({ kind: "quiet" });
    },
  );
});

describe("what does count as somebody else moving", () => {
  it("re-triages on a comment from somebody else", () => {
    const answered = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        theirComment("2026-09-02T08:30:00.000+0200"),
      ],
    });

    expect(decideWatch(answered, 3)).toMatchObject({
      kind: "retriage",
      at: "2026-09-02T08:30:00.000+0200",
    });
  });

  it("re-triages when somebody edits their own earlier comment to answer", () => {
    // The blind spot recorded when this file was written, closed by accident:
    // `updated` had to be fetched for our own comments, and once it is on the
    // wire withholding it from this side would be choosing to keep missing the
    // answers. A reporter appending the missing baseline to what they already
    // wrote moves no `created` anywhere.
    const amended = signals({
      comments: [
        theirComment(
          "2026-09-01T08:00:00.000+0200",
          "Baseline is 42%.",
          "2026-09-02T08:00:00.000+0200",
        ),
        ourComment("2026-09-01T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(amended, 3)).toMatchObject({ kind: "retriage" });
  });

  it.each([...BLOCKER_CLEARING_FIELDS])("re-triages when %s is edited", (field) => {
    // The description edit is the case the whole feature is built for: a
    // reporter filling in a placeholder produces no comment at all, so a
    // comments-only watch would miss the main trigger.
    const edited = signals({
      changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: [field] }],
    });

    expect(decideWatch(edited, 3)).toMatchObject({
      kind: "retriage",
      trigger: `${field} was edited`,
    });
  });

  it("matches the field name case-insensitively", () => {
    // Jira's changelog is inconsistent about capitalisation across field types,
    // and a miss here is silent.
    const edited = signals({
      changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: ["Description"] }],
    });

    expect(decideWatch(edited, 3)).toMatchObject({ kind: "retriage" });
  });

  it("reads a mixed changelog entry, not just its first field", () => {
    // One Jira edit produces one entry with several items. Checking only
    // `fields[0]` would miss a description edit bundled with a label change,
    // which is exactly what an edit made through the ticket form looks like.
    const bundled = signals({
      changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: ["labels", "description"] }],
    });

    expect(decideWatch(bundled, 3)).toMatchObject({ kind: "retriage" });
  });

  it("counts a comment written in the same millisecond as ours", () => {
    // A tie goes to "somebody spoke", and that is what keeps the self-trigger
    // guard alive. `spokeAt` is the maximum over our own comments, so under a
    // strict `>` nothing of ours could ever match and dropping the
    // `isOurComment` skip would change no answer — the guard the whole feature
    // rests on would be untestable. With `>=` the skip is the only thing
    // holding it, which is where a guard should be.
    const collided = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        theirComment("2026-09-01T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(collided, 3)).toMatchObject({ kind: "retriage" });
  });

  it("counts a description edit made in the same millisecond as our comment", () => {
    // Same rule as the comment tie, and it needs its own test because it is a
    // different comparison. This service writes labels and comments and
    // nothing else, so a `description` change can never be ours whatever its
    // clock says — the allowlist has already excluded our own writes, and
    // giving the tie away as well would drop a real edit for a coincidence.
    const collided = signals({
      changes: [{ created: "2026-09-01T10:00:00.000+0200", fields: ["description"] }],
    });

    expect(decideWatch(collided, 3)).toMatchObject({ kind: "retriage" });
  });

  it("ignores somebody else's activity from BEFORE we last spoke", () => {
    // Already accounted for: it was on the ticket when the comment was written,
    // so the triage that produced our comment had it in front of it.
    const stale = signals({
      comments: [
        theirComment("2026-09-01T08:00:00.000+0200"),
        ourComment("2026-09-01T10:00:00.000+0200"),
      ],
      changes: [{ created: "2026-09-01T09:00:00.000+0200", fields: ["description"] }],
    });

    expect(decideWatch(stale, 3)).toEqual({ kind: "quiet" });
  });

  it("measures from the last EDIT of our comment, not from when it was posted", () => {
    // THE mutation for the `updated` half, and the one no fixture in this file
    // could have caught before: the poster does not add a comment on a
    // re-triage, it finds its own by the sentinel and rewrites it in place. So
    // on the ticket this feature is built for there is exactly one comment of
    // ours, posted at the first triage and edited at every one since. Date it
    // by `created` and the mark sits days in the past, every foreign comment
    // since stays newer than it forever, and the watch pays to re-triage the
    // same unchanged activity on every sweep — §7b's infinite loop, arriving
    // through the one write path that does the considerate thing.
    const rewritten = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200", "2026-09-05T10:00:00.000+0200"),
        theirComment("2026-09-03T08:00:00.000+0200"),
      ],
      changes: [{ created: "2026-09-03T09:00:00.000+0200", fields: ["description"] }],
    });

    expect(decideWatch(rewritten, 3)).toEqual({ kind: "quiet" });
  });

  it("refuses when our comment's edit timestamp will not parse", () => {
    // `touchedAt` takes the later of the two, so a half-readable comment must
    // not quietly resolve to the readable half: that is a mark that is
    // plausibly too early, and too early is the direction that spends.
    const half = signals({
      comments: [ourComment("2026-09-01T10:00:00.000+0200", "not a date")],
    });

    expect(decideWatch(half, 3)).toMatchObject({ kind: "unsubscribe", reason: "uncountable" });
  });

  it("measures from our NEWEST comment when there are several", () => {
    // Taking the oldest would re-triage on everything that happened between the
    // two, all of which the later run already saw.
    const twice = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        ourComment("2026-09-03T10:00:00.000+0200"),
      ],
      changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: ["description"] }],
    });

    expect(decideWatch(twice, 3)).toEqual({ kind: "quiet" });
  });
});

describe("the terminals", () => {
  it("unsubscribes a closed ticket before anything else is read", () => {
    // Checked first because it is free, and reachable at all only because the
    // query deliberately does not filter closed tickets out — a ticket nothing
    // can see is a ticket nothing can unsubscribe.
    const closed = signals({
      closed: true,
      comments: [],
      changes: [{ created: "2026-09-09T09:00:00.000+0200", fields: ["description"] }],
    });

    expect(decideWatch(closed, 3)).toMatchObject({ kind: "unsubscribe", reason: "closed" });
  });

  it("unsubscribes once the attempt budget is spent", () => {
    // Four comments at a limit of three: the sendback, then three re-triages.
    const spent = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        ourComment("2026-09-02T10:00:00.000+0200"),
        ourComment("2026-09-03T10:00:00.000+0200"),
        ourComment("2026-09-04T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(spent, 3)).toMatchObject({ kind: "unsubscribe", reason: "exhausted" });
  });

  it("does not count the sendback itself against the re-triage budget", () => {
    // The mutation: count `ours.length` instead of `ours.length - 1` and this
    // ticket is dropped one re-triage early — a setting whose own name promises
    // three attempts silently delivering two. The comment that starts a watch
    // is the reason it exists, not an attempt to end it.
    const threeRuns = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        ourComment("2026-09-02T10:00:00.000+0200"),
        ourComment("2026-09-03T10:00:00.000+0200"),
        theirComment("2026-09-04T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(threeRuns, 3)).toMatchObject({ kind: "retriage" });
  });

  it("gives a lone sendback its whole budget", () => {
    const fresh = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        theirComment("2026-09-02T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(fresh, 1)).toMatchObject({ kind: "retriage" });
  });

  it("counts the budget even when somebody is still talking", () => {
    // The bound has to beat the trigger, or a ticket somebody edits daily is
    // re-triaged daily and the limit never fires.
    const busy = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        ourComment("2026-09-02T10:00:00.000+0200"),
        ourComment("2026-09-03T10:00:00.000+0200"),
        ourComment("2026-09-04T10:00:00.000+0200"),
        theirComment("2026-09-05T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(busy, 3)).toMatchObject({ kind: "unsubscribe", reason: "exhausted" });
  });

  it("still has one attempt left at one below the limit", () => {
    const nearly = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        ourComment("2026-09-02T10:00:00.000+0200"),
        theirComment("2026-09-03T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(nearly, 3)).toMatchObject({ kind: "retriage" });
  });

  it("refuses a watch it cannot count, rather than starting one", () => {
    // The marker rule from the review cursor, arriving in a second loop: a
    // count that will not read must not read as zero. With no comment of ours
    // there is no bound, so a failed post would hand back a free run every tick
    // forever.
    const handLabelled = signals({ comments: [theirComment("2026-09-02T08:00:00.000+0200")] });

    expect(decideWatch(handLabelled, 3)).toMatchObject({
      kind: "unsubscribe",
      reason: "uncountable",
    });
  });

  it("refuses when our own comment carries an unreadable timestamp", () => {
    // Same rule one step along: without a high-water mark every look reads as
    // new, which is the unbounded loop with extra steps.
    const mangled = signals({
      comments: [{ created: "not a date", updated: "not a date", text: FOOTER_SENTINEL }],
    });

    expect(decideWatch(mangled, 3)).toMatchObject({
      kind: "unsubscribe",
      reason: "uncountable",
    });
  });

  it("treats a forged sentinel as ours, which is the safe direction", () => {
    // A human can paste the footer line into a comment. That makes it read as
    // ours, so it does not trigger a run and it does count against the bound —
    // both of which end the watch sooner rather than spending more.
    const forged = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        {
          created: "2026-09-02T08:00:00.000+0200",
          updated: "2026-09-02T08:00:00.000+0200",
          text: `nice bot\n\n${FOOTER_SENTINEL}`,
        },
      ],
    });

    expect(decideWatch(forged, 3)).toEqual({ kind: "quiet" });
  });
});
