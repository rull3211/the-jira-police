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
    // Spelled out per fixture rather than shared, so tsc fails every one if
    // `WatchContent` grows a field.
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
    // The older comment is the conversation that produced the newer one.
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
    // Our own sendback must never appear as a foreign answer, or the check is
    // asked whether we answered ourselves.
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
    // A re-triage rewrites our existing comment, so `updated` (not `created`)
    // names the ask actually outstanding.
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
    // The decision and this function must slice at the same instant, or a
    // comment already seen before the current ask gets shown again.
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
    // Mirrors the decision's own rule: the edit that triggers the look must
    // also make the comment appear in the prompt, ordered by the same clock.
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
    // appear in the prompt.
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
    // Attacker-controlled text going into a prompt is bounded; the newest are
    // kept since an answer to a sendback is written most recently.
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
    // An unfiltered list would offer a sprint assignment or rank drag as
    // evidence the reporter responded; only the debug log skips this filter.
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
    // The check needs the field's actual content, not just its name, or it
    // correctly refuses to certify content it never saw.
    const context = edited({ description: "Observed baseline: 42% of carts." });

    expect(context?.fields[0]?.content).toBe("Observed baseline: 42% of carts.");
  });

  it("shows content only for the fields that actually moved", () => {
    // A description unchanged since triage is not evidence anybody responded.
    const context = edited({ description: "the new answer", summary: "untouched summary" }, [
      "description",
    ]);

    expect(context?.fields.map((field) => field.name)).toEqual(["description"]);
    expect(JSON.stringify(context?.fields)).not.toContain("untouched summary");
  });

  it("names an attachment without offering its bytes", () => {
    // A filename answers "attach the HAR"; fetching contents would be a new
    // untrusted-bytes path into a prompt.
    const context = edited(
      {
        attachments: [{ filename: "network.har", mimeType: "application/json", size: 20480 }],
      },
      ["attachment"],
    );

    expect(context?.fields[0]?.content).toBe("network.har (application/json, 20.0 KB)");
  });

  it("keeps an entry for a field that was emptied", () => {
    // A cleared description still moved; dropping the entry would look like
    // nothing changed.
    const context = edited({ description: "" });

    expect(context?.fields).toHaveLength(1);
    expect(context?.fields[0]?.content).toBe("");
  });

  it("caps a long field and says that it capped it", () => {
    // The truncation flag is separate from content so the notice sits outside
    // the fence, where a hostile description can't imitate it.
    const context = edited({ description: "x".repeat(MAX_FIELD_CHARS + 500) });

    expect(context?.fields[0]?.truncated).toBe(true);
    expect(context?.fields[0]?.content.length).toBeLessThanOrEqual(MAX_FIELD_CHARS + 1);
  });

  it("does not flag a field that fitted", () => {
    // An off-by-one here would tell the check to distrust a complete answer.
    const context = edited({ description: "x".repeat(MAX_FIELD_CHARS) });

    expect(context?.fields[0]?.truncated).toBe(false);
  });
});

describe("when there is nothing to slice at", () => {
  it("refuses a ticket with no comment of ours", () => {
    // Same condition the decision unsubscribes on: with no high-water mark
    // everything reads as new.
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
