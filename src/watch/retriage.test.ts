import { describe, expect, it, vi } from "vitest";

import { FOOTER_SENTINEL } from "../triage/gate.ts";
import type { TicketRef } from "../jira/types.ts";
import type { TriagePayload } from "../triage/runner.ts";
import { RETRIAGE_LABEL_PREFIX } from "./counter.ts";
import type { WatchSignals } from "./decide.ts";
import type { RelevanceInput } from "./relevance.ts";
import { runRetriage, type RetriageDeps } from "./retriage.ts";

function ourComment(created: string, text = "Fill in the baseline.") {
  return {
    created,
    updated: created,
    text: `# ↩ SEND BACK · SSX-1234\n\n${text}\n\n${FOOTER_SENTINEL}`,
  };
}

function theirComment(created: string, text = "Baseline is 42%.") {
  return { created, updated: created, text };
}

function signals(overrides: Partial<WatchSignals> = {}): WatchSignals {
  return {
    key: "SSX-1234",
    labels: ["agent:watching"],
    closed: false,
    comments: [
      ourComment("2026-09-01T10:00:00.000+0200"),
      theirComment("2026-09-02T08:00:00.000+0200"),
    ],
    changes: [],
    // Spelled out per fixture rather than shared, so tsc fails every one if
    // `WatchContent` grows a field.
    content: { summary: "", description: "", environment: "", attachments: [] },
    ...overrides,
  };
}

function payload(): TriagePayload {
  return {
    verdict: "ready-ish",
    labels: ["dor:pass", "agent:solvable"],
    dorPlaceholders: [],
    recommendedNextStep: "Solve it.",
    report: "# ✅ ACCEPT · SSX-1234",
    mutation: {
      commentBody: "body",
      labelsAdd: ["agent:solvable"],
      labelsRemove: ["agent:watching"],
      component: "",
      links: [],
      commentAction: "update",
    },
    agentFitness: {
      solvable: true,
      plausible: false,
      confidence: "high",
      repo: "buy-insurance-advisor-web",
      rationale: "the baseline arrived",
      blockers: [],
    },
  };
}

interface Options {
  readonly answers?: boolean;
  readonly labelsFail?: boolean;
  readonly groomFails?: boolean;
}

/** Records the order of the two expensive-or-irreversible steps, which is the thing under test. */
function deps(options: Options = {}) {
  const order: string[] = [];

  const updateLabels = vi.fn(async () => {
    order.push("reserve");
    if (options.labelsFail === true) {
      throw new Error("Jira said 403");
    }
  });
  // What each paid step was handed, captured rather than read back off the
  // mock: the calls are typed as an empty tuple otherwise, and asserting on
  // `mock.calls[0]?.[0]` would need a cast that hides the shape being asserted.
  const seen: { asked: RelevanceInput | null; ticket: TicketRef | null } = {
    asked: null,
    ticket: null,
  };

  const check = vi.fn(async (input: RelevanceInput) => {
    order.push("check");
    seen.asked = input;
    return {
      answers: options.answers ?? true,
      reason:
        options.answers === false ? "it only promises the logs" : "the baseline is now stated",
    };
  });
  const groom = vi.fn(async (ticket: TicketRef) => {
    order.push("groom");
    seen.ticket = ticket;
    if (options.groomFails === true) {
      throw new Error("the gate refused the verdict");
    }
    return payload();
  });

  const built: RetriageDeps = {
    client: { updateLabels },
    checker: { check },
    groom,
    baseUrl: "https://example.atlassian.net",
  };

  return { deps: built, order, seen, updateLabels, check, groom };
}

describe("running a re-triage", () => {
  it("reserves the attempt and hands the key to the groom", async () => {
    const { deps: d, seen } = deps();

    const outcome = await runRetriage(d, signals());

    expect(outcome.kind).toBe("retriaged");
    expect(outcome).toMatchObject({ count: 1, reason: "the baseline is now stated" });
    expect(d.client.updateLabels).toHaveBeenCalledWith("SSX-1234", {
      add: [`${RETRIAGE_LABEL_PREFIX}1`],
      remove: [],
      count: 1,
    });
    expect(seen.ticket).toMatchObject({
      key: "SSX-1234",
      url: "https://example.atlassian.net/browse/SSX-1234",
    });
  });

  it("writes the reservation BEFORE it pays for the triage", async () => {
    // Reversed, a failed write hands back a free run every sweep (§6.3's
    // receipt-versus-reservation rule).
    const { deps: d, order } = deps();

    await runRetriage(d, signals());

    expect(order).toEqual(["check", "reserve", "groom"]);
  });

  it("supersedes the count the ticket already carried", async () => {
    const { deps: d } = deps();

    const outcome = await runRetriage(
      d,
      signals({ labels: ["agent:watching", `${RETRIAGE_LABEL_PREFIX}2`] }),
    );

    expect(outcome).toMatchObject({ kind: "retriaged", count: 3 });
    expect(d.client.updateLabels).toHaveBeenCalledWith("SSX-1234", {
      add: [`${RETRIAGE_LABEL_PREFIX}3`],
      remove: [`${RETRIAGE_LABEL_PREFIX}2`],
      count: 3,
    });
  });

  it("hands the check what happened rather than the whole ticket", async () => {
    const { deps: d, seen } = deps();

    await runRetriage(
      d,
      signals({
        comments: [
          theirComment("2026-08-30T08:00:00.000+0200", "old news"),
          ourComment("2026-09-01T10:00:00.000+0200"),
          theirComment("2026-09-02T08:00:00.000+0200", "Baseline is 42%."),
        ],
      }),
    );

    expect(seen.asked).toMatchObject({ key: "SSX-1234", comments: ["Baseline is 42%."] });
    expect(seen.asked?.sendback).toContain("Fill in the baseline.");
  });
});

describe("the four refusals, which are the point of the ordering", () => {
  it("spends nothing when the activity does not answer the sendback", async () => {
    const { deps: d, updateLabels, groom } = deps({ answers: false });

    const outcome = await runRetriage(d, signals());

    expect(outcome).toEqual({ kind: "irrelevant", reason: "it only promises the logs" });
    expect(updateLabels).not.toHaveBeenCalled();
    expect(groom).not.toHaveBeenCalled();
  });

  it("does not run the triage when the reservation will not write", async () => {
    // Carrying on regardless would triage on a counter that never moved.
    const { deps: d, groom } = deps({ labelsFail: true });

    const outcome = await runRetriage(d, signals());

    expect(outcome).toMatchObject({ kind: "unreserved", error: "Jira said 403" });
    expect(groom).not.toHaveBeenCalled();
  });

  it("refuses a counter it cannot read, before paying for the check", async () => {
    // Refused on pure data, so the malformed label costs nothing.
    const { deps: d, check, updateLabels } = deps();

    const outcome = await runRetriage(
      d,
      signals({ labels: ["agent:watching", `${RETRIAGE_LABEL_PREFIX}lots`] }),
    );

    expect(outcome).toEqual({ kind: "uncountable" });
    expect(check).not.toHaveBeenCalled();
    expect(updateLabels).not.toHaveBeenCalled();
  });

  it("refuses a ticket with no comment of ours", async () => {
    // Reachable because a named key skips `decideWatch` entirely.
    const { deps: d, check } = deps();

    const outcome = await runRetriage(
      d,
      signals({ comments: [theirComment("2026-09-02T08:00:00.000+0200")] }),
    );

    expect(outcome).toEqual({ kind: "no-mark" });
    expect(check).not.toHaveBeenCalled();
  });
});

describe("when the triage itself fails", () => {
  it("propagates, with the attempt already spent", async () => {
    // The cost of failing closed; moving the write after the run to "refund" it is the runaway.
    const { deps: d, updateLabels } = deps({ groomFails: true });

    await expect(runRetriage(d, signals())).rejects.toThrow("the gate refused the verdict");
    expect(updateLabels).toHaveBeenCalledTimes(1);
  });
});
