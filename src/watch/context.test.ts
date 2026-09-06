import { describe, expect, it } from "vitest";

import { FOOTER_SENTINEL } from "../triage/gate.ts";
import { MAX_CONTEXT_COMMENTS, MAX_FIELD_CHARS, retriageContext } from "./context.ts";
import type { WatchContent, WatchSignals } from "./decide.ts";

function ourComment(created: string, text = "Fill in the baseline.", updated: string = created) {
  return { created, updated, text: `# ↩ SEND BACK · SSX-1234\n\n${text}\n\n${FOOTER_SENTINEL}` };
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

describe("what the check is shown", () => {
  it("hands over our sendback and their answer", () => {
    const context = retriageContext(
      signals({
        comments: [
          ourComment("2026-09-01T10:00:00.000+0200"),
          theirComment("2026-09-02T08:30:00.000+0200"),
        ],
      }),
    );

    expect(context?.sendback).toContain("Fill in the baseline.");
    expect(context?.comments).toEqual(["Baseline is 42%."]);
    expect(context?.omitted).toBe(0);
  });

  it("takes the sendback from our NEWEST comment", () => {
    // The older one is the conversation that produced the newer one. Judging an
    // answer against a superseded ask is a question nobody wanted answered.
    const context = retriageContext(
      signals({
        comments: [
          ourComment("2026-09-01T10:00:00.000+0200", "Fill in the baseline."),
          ourComment("2026-09-03T10:00:00.000+0200", "Still no steps to reproduce."),
          theirComment("2026-09-04T08:00:00.000+0200"),
        ],
      }),
    );

    expect(context?.sendback).toContain("Still no steps to reproduce.");
    expect(context?.sendback).not.toContain("Fill in the baseline.");
  });

  it("never shows the check our own comments as somebody else's", () => {
    // The self-trigger guard again, one layer along: our own sendback arriving
    // in the answers section is a session asked whether we answered ourselves,
    // and the honest answer to that is yes.
    const context = retriageContext(
      signals({
        comments: [
          ourComment("2026-09-01T10:00:00.000+0200"),
          ourComment("2026-09-02T10:00:00.000+0200"),
        ],
      }),
    );

    expect(context?.comments).toEqual([]);
  });

  it("still finds the sendback after the poster has rewritten it in place", () => {
    // A re-triage edits our existing comment rather than adding one, so on any
    // ticket that has been round the loop once `created` names the first triage
    // and `updated` names the ask that is actually outstanding. Looking the
    // sendback up by `created` would find nothing here and hand the check an
    // empty ask — a paid session asked whether an unstated question was
    // answered, which it can only answer wrongly.
    const context = retriageContext(
      signals({
        comments: [
          ourComment(
            "2026-09-01T10:00:00.000+0200",
            "Still no steps to reproduce.",
            "2026-09-05T10:00:00.000+0200",
          ),
          theirComment("2026-09-06T08:00:00.000+0200", "Here they are."),
        ],
      }),
    );

    expect(context?.sendback).toContain("Still no steps to reproduce.");
    expect(context?.comments).toEqual(["Here they are."]);
  });

  it("dates the ticket where the decision dates it, so an edited comment is seen once", () => {
    // The two functions must slice at the same instant. With the mark at the
    // rewrite, a comment written before it was already in front of the triage
    // that produced the current ask, and showing it again is asking the check
    // to judge an answer the sendback was written in response to.
    const context = retriageContext(
      signals({
        comments: [
          ourComment(
            "2026-09-01T10:00:00.000+0200",
            "Fill in the baseline.",
            "2026-09-05T10:00:00.000+0200",
          ),
          theirComment("2026-09-03T08:00:00.000+0200", "seen already"),
          theirComment("2026-09-06T08:00:00.000+0200", "new"),
        ],
      }),
    );

    expect(context?.comments).toEqual(["new"]);
  });

  it("shows an old comment that was edited into an answer after we spoke", () => {
    // The mirror of the decision's own rule, and it has to be here too or the
    // two disagree in the expensive direction: the edit triggers the look and
    // then the comment carrying the answer is the one comment the check is not
    // shown. Ordering follows the same clock, so the amended comment is newest.
    const context = retriageContext(
      signals({
        comments: [
          theirComment("2026-09-01T08:00:00.000+0200", "amended", "2026-09-06T08:00:00.000+0200"),
          ourComment("2026-09-01T10:00:00.000+0200"),
          theirComment("2026-09-02T08:00:00.000+0200", "plain"),
        ],
      }),
    );

    expect(context?.comments).toEqual(["plain", "amended"]);
  });

  it("leaves out what happened before we last spoke", () => {
    const context = retriageContext(
      signals({
        comments: [
          theirComment("2026-09-01T08:00:00.000+0200", "old news"),
          ourComment("2026-09-01T10:00:00.000+0200"),
          theirComment("2026-09-02T08:00:00.000+0200", "new news"),
        ],
      }),
    );

    expect(context?.comments).toEqual(["new news"]);
  });

  it("counts a tie as new, exactly as the decision does", () => {
    // If the two disagreed, a comment could trigger the look and then not
    // appear in the prompt — a paid session asked to explain an empty page.
    const context = retriageContext(
      signals({
        comments: [
          ourComment("2026-09-01T10:00:00.000+0200"),
          theirComment("2026-09-01T10:00:00.000+0200", "same millisecond"),
        ],
      }),
    );

    expect(context?.comments).toEqual(["same millisecond"]);
  });

  it("orders the comments oldest first", () => {
    const context = retriageContext(
      signals({
        comments: [
          ourComment("2026-09-01T10:00:00.000+0200"),
          theirComment("2026-09-04T08:00:00.000+0200", "third"),
          theirComment("2026-09-02T08:00:00.000+0200", "first"),
          theirComment("2026-09-03T08:00:00.000+0200", "second"),
        ],
      }),
    );

    expect(context?.comments).toEqual(["first", "second", "third"]);
  });
});

describe("the bound on the prompt", () => {
  it("keeps the newest comments and says how many it dropped", () => {
    // Every one of these is attacker-controlled text going into a prompt, so
    // the count is bounded. The newest are kept because an answer to a sendback
    // is the thing somebody wrote most recently.
    const many = Array.from({ length: MAX_CONTEXT_COMMENTS + 3 }, (_, index) =>
      theirComment(`2026-09-0${index < 8 ? 2 : 3}T0${index % 8}:00:00.000+0200`, `c${index}`),
    );
    const context = retriageContext(
      signals({ comments: [ourComment("2026-09-01T10:00:00.000+0200"), ...many] }),
    );

    expect(context?.comments).toHaveLength(MAX_CONTEXT_COMMENTS);
    expect(context?.omitted).toBe(3);
    expect(context?.comments.at(-1)).toBe("c12");
  });
});

describe("the fields, which are filtered where the debug log is not", () => {
  it("names a blocker-clearing field that moved", () => {
    const context = retriageContext(
      signals({
        comments: [ourComment("2026-09-01T10:00:00.000+0200")],
        changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: ["Description"] }],
      }),
    );

    expect(context?.fields.map((field) => field.name)).toEqual(["description"]);
  });

  it("drops board grooming rather than offering it as evidence", () => {
    // An unfiltered list would hand the check a sprint assignment and a rank
    // drag as signs that the reporter responded. The calibration lesson cuts
    // the other way only for the debug log, which must not filter.
    const context = retriageContext(
      signals({
        changes: [
          { created: "2026-09-02T09:00:00.000+0200", fields: ["labels", "Sprint", "Rank"] },
        ],
      }),
    );

    expect(context?.fields).toEqual([]);
  });

  it("says nothing about fields edited before we spoke", () => {
    const context = retriageContext(
      signals({
        changes: [{ created: "2026-09-01T09:00:00.000+0200", fields: ["description"] }],
      }),
    );

    expect(context?.fields).toEqual([]);
  });

  it("reports each field once across several entries", () => {
    const context = retriageContext(
      signals({
        changes: [
          { created: "2026-09-02T09:00:00.000+0200", fields: ["description", "summary"] },
          { created: "2026-09-03T09:00:00.000+0200", fields: ["description"] },
        ],
      }),
    );

    expect(context?.fields.map((field) => field.name)).toEqual(["description", "summary"]);
  });
});

describe("what a moved field is shown as saying", () => {
  function edited(content: Partial<WatchContent>, fields: readonly string[] = ["description"]) {
    return retriageContext(
      signals({
        changes: [{ created: "2026-09-02T09:00:00.000+0200", fields: [...fields] }],
        content: {
          summary: "",
          description: "",
          environment: "",
          attachments: [],
          ...content,
        },
      }),
    );
  }

  it("carries the field's current text, which is the whole point of the change", () => {
    // THE ONE THAT MATTERS. Before this, a description edit reached the check
    // as the word "description" and nothing else, so the check correctly
    // refused to certify content it had not seen — on the commonest way a
    // reporter answers a sendback. Unplug the content and every one of those
    // becomes a well-argued no.
    const context = edited({ description: "Observed baseline: 42% of carts." });

    expect(context?.fields[0]?.content).toBe("Observed baseline: 42% of carts.");
  });

  it("shows content only for the fields that actually moved", () => {
    // The ticket's whole state is on the signals and handing all of it over
    // would be cheaper to write and worse to answer: a description unchanged
    // since triage is not evidence anybody responded, and a check shown it will
    // find the sendback's own words in it and say yes.
    const context = edited({ description: "the new answer", summary: "untouched summary" }, [
      "description",
    ]);

    expect(context?.fields.map((field) => field.name)).toEqual(["description"]);
    expect(JSON.stringify(context?.fields)).not.toContain("untouched summary");
  });

  it("names an attachment without offering its bytes", () => {
    // "Attach the HAR" is an ordinary sendback and a filename answers it.
    // Fetching contents would be a new untrusted-bytes path into a prompt.
    const context = edited(
      {
        attachments: [{ filename: "network.har", mimeType: "application/json", size: 20480 }],
      },
      ["attachment"],
    );

    expect(context?.fields[0]?.content).toBe("network.har (application/json, 20.0 KB)");
  });

  it("keeps an entry for a field that was emptied", () => {
    // A reporter who cleared the description moved it. Dropping the section
    // would leave the check reading a ticket where nothing appeared to change —
    // the same blindness, arriving through an omission instead of a missing
    // fetch.
    const context = edited({ description: "" });

    expect(context?.fields).toHaveLength(1);
    expect(context?.fields[0]?.content).toBe("");
  });

  it("caps a long field and says that it capped it", () => {
    // Attacker-controlled text going into a prompt, so "however long the
    // reporter made it" is not a bound. The flag is separate from the content
    // because the prompt has to say so outside the fence, where a hostile
    // description cannot imitate the notice.
    const context = edited({ description: "x".repeat(MAX_FIELD_CHARS + 500) });

    expect(context?.fields[0]?.truncated).toBe(true);
    expect(context?.fields[0]?.content.length).toBeLessThanOrEqual(MAX_FIELD_CHARS + 1);
  });

  it("does not flag a field that fitted", () => {
    // An off-by-one here puts "this was cut" on a complete description, which
    // tells the check to distrust an answer that is all there.
    const context = edited({ description: "x".repeat(MAX_FIELD_CHARS) });

    expect(context?.fields[0]?.truncated).toBe(false);
  });
});

describe("when there is nothing to slice at", () => {
  it("refuses a ticket with no comment of ours", () => {
    // Same condition the decision unsubscribes on: with no high-water mark
    // everything reads as new, and the check would be judging the sendback
    // against the conversation that produced it.
    expect(
      retriageContext(signals({ comments: [theirComment("2026-09-02T08:00:00.000+0200")] })),
    ).toBeNull();
  });

  it("refuses when one of our timestamps will not parse", () => {
    const context = retriageContext(
      signals({
        comments: [
          ourComment("2026-09-01T10:00:00.000+0200"),
          { created: "not a date", updated: "not a date", text: FOOTER_SENTINEL },
        ],
      }),
    );

    expect(context).toBeNull();
  });
});
