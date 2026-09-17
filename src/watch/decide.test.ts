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
 * A triage comment of ours, at a given time. `updated` defaults to `created`
 * (a ticket triaged exactly once); tests needing the rewritten shape pass it
 * explicitly.
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
    // Spelled out per fixture rather than shared, so tsc fails every one if
    // `WatchContent` grows a field.
    content: { summary: "", description: "", environment: "", attachments: [] },
    ...overrides,
  };
}

describe("isOurComment", () => {
  it("keys on the sentinel rather than on an author", () => {
    // No author to key on: the poster shares a human's Atlassian account, so
    // authorship can't distinguish the two.
    expect(isOurComment(ourComment("2026-09-01T10:00:00.000+0200"))).toBe(true);
    expect(isOurComment(theirComment("2026-09-01T10:00:00.000+0200"))).toBe(false);
  });
});

describe("the self-trigger, which is the whole point of the function", () => {
  it("does not re-triage a ticket whose only activity is our own comment", () => {
    expect(decideWatch(signals(), 3)).toEqual({ kind: "quiet" });
  });

  it("does not re-triage on the label write that follows our own comment", () => {
    // Posting sets `updated`, and our own follow-up label write sets it again —
    // a naive rule would fire on that every cycle.
    const afterUs = signals({
      changes: [{ created: "2026-09-01T10:00:03.000+0200", fields: ["labels"] }],
    });

    expect(decideWatch(afterUs, 3)).toEqual({ kind: "quiet" });
  });

  it.each(["labels", "Component", "Link", "priority", "assignee", "Sprint", "Rank"])(
    "ignores a change to %s, which cannot clear a blocker",
    (field) => {
      // Board grooming must not read as "the reporter responded", or it burns
      // the retriage budget on noise before the reporter actually answers.
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
    // A reporter appending an answer to an earlier comment moves no `created`.
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
    // A reporter filling in a placeholder field produces no comment at all, so
    // a comments-only watch would miss it.
    const edited = signals({
      changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: [field] }],
    });

    expect(decideWatch(edited, 3)).toMatchObject({
      kind: "retriage",
      trigger: `${field} was edited`,
    });
  });

  it("matches the field name case-insensitively", () => {
    // Jira's changelog is inconsistent about capitalisation across field types.
    const edited = signals({
      changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: ["Description"] }],
    });

    expect(decideWatch(edited, 3)).toMatchObject({ kind: "retriage" });
  });

  it("reads a mixed changelog entry, not just its first field", () => {
    // One Jira edit produces one entry with several items; checking only
    // `fields[0]` would miss a description edit bundled with a label change.
    const bundled = signals({
      changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: ["labels", "description"] }],
    });

    expect(decideWatch(bundled, 3)).toMatchObject({ kind: "retriage" });
  });

  it("counts a comment written in the same millisecond as ours", () => {
    // A tie goes to "somebody spoke" (`>=`), so the `isOurComment` skip — not
    // the clock — is what excludes our own activity.
    const collided = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        theirComment("2026-09-01T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(collided, 3)).toMatchObject({ kind: "retriage" });
  });

  it("counts a description edit made in the same millisecond as our comment", () => {
    // Same rule as the comment tie: a `description` change can never be ours,
    // so the tie must not be given away for a coincidence of clock.
    const collided = signals({
      changes: [{ created: "2026-09-01T10:00:00.000+0200", fields: ["description"] }],
    });

    expect(decideWatch(collided, 3)).toMatchObject({ kind: "retriage" });
  });

  it("ignores somebody else's activity from BEFORE we last spoke", () => {
    // Already accounted for: it was on the ticket when our comment was written.
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
    // The poster rewrites its own comment in place on a re-triage rather than
    // adding a new one; dating by `created` alone would pin the mark in the
    // past and re-triage the same unchanged activity forever (§7b).
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
    // A half-readable comment must not resolve to its readable (too-early,
    // overspending) half.
    const half = signals({
      comments: [ourComment("2026-09-01T10:00:00.000+0200", "not a date")],
    });

    expect(decideWatch(half, 3)).toMatchObject({ kind: "unsubscribe", reason: "uncountable" });
  });

  it("measures from our NEWEST comment when there are several", () => {
    // Taking the oldest would re-triage on activity the later comment already saw.
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
    // Reachable at all only because the query deliberately doesn't filter out
    // closed tickets — a ticket nothing can see is a ticket nothing can unsubscribe.
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
    // The poster rewrites its own comment in place, so counting our comments
    // would read a heavily re-triaged ticket as having spent nothing.
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
    // No counter is zero, not a refusal.
    const fresh = signals({
      comments: [
        ourComment("2026-09-01T10:00:00.000+0200"),
        theirComment("2026-09-02T10:00:00.000+0200"),
      ],
    });

    expect(decideWatch(fresh, 1)).toMatchObject({ kind: "retriage" });
  });

  it("counts the budget even when somebody is still talking", () => {
    // The bound must beat the trigger, or a ticket edited daily is re-triaged
    // daily and the limit never fires.
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
    // A count that will not read must not read as zero.
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
    // Perfectly countable, but still refused: with no high-water mark every
    // look reads as new.
    const handLabelled = signals({ comments: [theirComment("2026-09-02T08:00:00.000+0200")] });

    expect(decideWatch(handLabelled, 3)).toMatchObject({
      kind: "unsubscribe",
      reason: "uncountable",
    });
  });

  it("refuses when our own comment carries an unreadable timestamp", () => {
    // Without a high-water mark every look reads as new.
    const mangled = signals({
      comments: [{ created: "not a date", updated: "not a date", text: FOOTER_SENTINEL }],
    });

    expect(decideWatch(mangled, 3)).toMatchObject({
      kind: "unsubscribe",
      reason: "uncountable",
    });
  });

  it("treats a forged sentinel as ours, which is the safe direction", () => {
    // A forged sentinel ends the watch sooner rather than spending more.
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
    // `decideWatch` returns on its first trigger in list order, so reading
    // `WatchDecision.at` instead of calling this would remember Tuesday and
    // re-ask about Thursday forever.
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
    // Our own comment is always at or after the mark (it is the mark);
    // counting it would make the watch permanently deaf while reporting healthy sweeps.
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
    // Without the `BLOCKER_CLEARING_FIELDS` filter, a rank drag on Thursday
    // would advance the memo past a reporter's Tuesday answer and skip it forever.
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
    // Same rule as the decision, or the memo could remember an instant the
    // decision never saw.
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
    // No comment of ours means every look reads as new; remembering an instant
    // here would remember a judgement nobody made.
    expect(
      newestForeignAt(signals({ comments: [theirComment("2026-09-02T08:00:00.000+0200")] })),
    ).toBeNaN();
  });

  it("says nothing when nothing foreign has happened since", () => {
    expect(newestForeignAt(signals())).toBeNaN();
  });
});
