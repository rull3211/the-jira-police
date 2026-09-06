import { describe, expect, it } from "vitest";

import { FOOTER_SENTINEL } from "../triage/gate.ts";
import {
  BLOCKER_CLEARING_FIELDS,
  decideWatch,
  isOurComment,
  newestForeignAt,
  type WatchSignals,
} from "./decide.ts";

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
    labels: ["agent:watching"],
    closed: false,
    comments: [ourComment("2026-09-01T10:00:00.000+0200")],
    changes: [],
    // Empty rather than absent, and spelled out in each fixture that needs it:
    // `tsc` fails every one of them if `WatchContent` grows a field, which is
    // what keeps four literals in step where a hand-copied *list* could not be.
    content: { summary: "", description: "", environment: "", attachments: [] },
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
    const spent = signals({
      labels: ["agent:watching", "agent:retriage-3"],
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        theirComment("2026-09-04T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(spent, 3)).toMatchObject({ kind: "unsubscribe", reason: "exhausted" });
  });

  it("counts re-triages and not comments of ours", () => {
    // **The mutation this whole counter exists for, and the version it replaced
    // failed it.** The poster rewrites its own comment in place, so a ticket
    // re-triaged three times still has one comment of ours: count the comments
    // and the brake reads zero forever on precisely the tickets that have spent
    // the most. Count the label and the two facts stop being related — three
    // comments of ours here, none of them re-triages, and the whole budget
    // intact.
    const chatty = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        ourComment("2026-09-02T10:00:00.000+0200"),
        ourComment("2026-09-03T10:00:00.000+0200"),
        theirComment("2026-09-04T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(chatty, 3)).toMatchObject({ kind: "retriage" });
  });

  it("gives an unlabelled ticket its whole budget", () => {
    // No counter is zero, not a refusal: a ticket nothing has spent on yet is
    // the ordinary case and the one the watch exists for.
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
      labels: ["agent:watching", "agent:retriage-4"],
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        theirComment("2026-09-05T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(busy, 3)).toMatchObject({ kind: "unsubscribe", reason: "exhausted" });
  });

  it("still has one attempt left at one below the limit", () => {
    const nearly = signals({
      labels: ["agent:watching", "agent:retriage-2"],
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        theirComment("2026-09-03T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(nearly, 3)).toMatchObject({ kind: "retriage" });
  });

  it("refuses a counter it cannot read rather than treating it as a fresh ticket", () => {
    // The marker rule from the review cursor, arriving in a second loop: a
    // count that will not read must not read as zero, because losing the count
    // and starting again from one is how a bounded loop quietly becomes an
    // unbounded one.
    const mangled = signals({
      labels: ["agent:watching", "agent:retriage-lots"],
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        theirComment("2026-09-03T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(mangled, 3)).toMatchObject({
      kind: "unsubscribe",
      reason: "uncountable",
    });
  });

  it("refuses a watch with no comment of ours, which is the missing mark and not the count", () => {
    // The counter is a label now, so this ticket is perfectly countable — and
    // it is still refused, because there is no high-water mark. Every look
    // would read as new and the first re-triage would judge the sendback
    // against the conversation that produced it.
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

function AT(iso: string): number {
  return Date.parse(iso);
}

describe("newestForeignAt, which is what the memo remembers", () => {
  it("reports the newest foreign comment, not the one the decision returned on", () => {
    // THE ONE THAT MATTERS, and the mutation is reading `WatchDecision.at`
    // instead of calling this. `decideWatch` returns on its *first* trigger in
    // list order, so on this ticket it names Tuesday and stops. A memo that
    // remembered Tuesday would see Thursday as unjudged on the very next sweep
    // and re-ask, forever — the loop the memo exists to close, restored by
    // reading a field that looks like it means this.
    const at = newestForeignAt(
      signals({
        comments: [
          ourComment("2026-09-01T10:00:00.000+0200"),
          theirComment("2026-09-02T08:00:00.000+0200", "first"),
          theirComment("2026-09-04T08:00:00.000+0200", "last"),
        ],
      }),
    );

    expect(at).toBe(AT("2026-09-04T08:00:00.000+0200"));
  });

  it("never lets our own comment be the newest", () => {
    // Our own comment is always at or after the high-water mark, by definition —
    // it *is* the mark. Counting it would set the memo to the latest instant on
    // the ticket every sweep, so nothing foreign could ever look new again and
    // the watch would go permanently deaf while reporting healthy sweeps.
    const at = newestForeignAt(
      signals({
        comments: [
          theirComment("2026-09-02T08:00:00.000+0200", "an answer"),
          ourComment("2026-09-03T10:00:00.000+0200"),
        ],
      }),
    );

    expect(at).toBeNaN();
  });

  it("counts an allowlisted field edit", () => {
    const at = newestForeignAt(
      signals({ changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: ["description"] }] }),
    );

    expect(at).toBe(AT("2026-09-02T09:00:00.000+0200"));
  });

  it("ignores a field edit the decision would not have triggered on", () => {
    // The mutation drops the `BLOCKER_CLEARING_FIELDS` filter, and it fails in
    // the silent direction: a rank drag on Thursday advances the memo past a
    // reporter's Tuesday answer, so the answer is skipped and never looked at
    // again. This service writes labels constantly, which is the same reason
    // `labels` must never join that set.
    const at = newestForeignAt(
      signals({
        comments: [
          ourComment("2026-09-01T10:00:00.000+0200"),
          theirComment("2026-09-02T08:00:00.000+0200", "an answer"),
        ],
        changes: [{ created: "2026-09-04T09:00:00.000+0200", fields: ["labels", "Rank"] }],
      }),
    );

    expect(at).toBe(AT("2026-09-02T08:00:00.000+0200"));
  });

  it("takes the later of a comment and a field edit", () => {
    const at = newestForeignAt(
      signals({
        comments: [
          ourComment("2026-09-01T10:00:00.000+0200"),
          theirComment("2026-09-02T08:00:00.000+0200", "an answer"),
        ],
        changes: [{ created: "2026-09-03T09:00:00.000+0200", fields: ["description"] }],
      }),
    );

    expect(at).toBe(AT("2026-09-03T09:00:00.000+0200"));
  });

  it("dates a comment by whichever timestamp is later", () => {
    // Same rule as the decision, because a reporter who answers by editing
    // their own earlier comment moves only `updated`. If the two dated
    // differently the memo could remember an instant the decision never saw.
    const at = newestForeignAt(
      signals({
        comments: [
          theirComment("2026-08-20T08:00:00.000+0200", "amended", "2026-09-05T08:00:00.000+0200"),
          ourComment("2026-09-01T10:00:00.000+0200"),
        ],
      }),
    );

    expect(at).toBe(AT("2026-09-05T08:00:00.000+0200"));
  });

  it("says nothing when there is no high-water mark", () => {
    // No comment of ours means every look reads as new, which the decision
    // unsubscribes on. Remembering an instant here would be remembering a
    // judgement nobody made.
    expect(
      newestForeignAt(signals({ comments: [theirComment("2026-09-02T08:00:00.000+0200")] })),
    ).toBeNaN();
  });

  it("says nothing when nothing foreign has happened since", () => {
    expect(newestForeignAt(signals())).toBeNaN();
  });
});
