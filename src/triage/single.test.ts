import { describe, expect, it } from "vitest";

import type { TriagePayload } from "./runner.ts";
import { syntheticTicket, toTriageResult } from "./single.ts";

function payload(overrides: Partial<TriagePayload> = {}): TriagePayload {
  return {
    verdict: "needs-info",
    labels: ["dor:gaps", "route:ours"],
    dorPlaceholders: [],
    recommendedNextStep: "Ask the reporter for a baseline.",
    report: "# ↩ SEND BACK · SSX-1234",
    mutation: {
      commentBody: "body",
      labelsAdd: [],
      labelsRemove: [],
      component: "",
      links: [],
      commentAction: "create",
    },
    agentFitness: {
      solvable: false,
      plausible: true,
      confidence: "med",
      repo: "buy-insurance-advisor-web",
      rationale: "one blocker away",
      blockers: ["no baseline"],
    },
    ...overrides,
  };
}

describe("the ticket a named key stands in for", () => {
  it("builds the browse URL from the configured base", () => {
    expect(syntheticTicket("SSX-1234", "https://example.atlassian.net").url).toBe(
      "https://example.atlassian.net/browse/SSX-1234",
    );
  });

  it("leaves what discovery would have fetched empty rather than plausible", () => {
    // `updated` and `labels` are read by the solve queue and by anything that
    // sorts on recency. A stand-in value here would be indistinguishable from a
    // fetched one, which is the failure `TicketRef.updated`'s own comment
    // refuses: an absent value normalises to absent.
    const ticket = syntheticTicket("SSX-1234", "https://example.atlassian.net");

    expect(ticket.updated).toBe("");
    expect(ticket.labels).toEqual([]);
    expect(ticket.issueTypeId).toBe("");
    expect(ticket.issueTypeName).toBe("");
  });

  it("says in the summary that the summary was never fetched", () => {
    expect(syntheticTicket("SSX-1234", "https://example.atlassian.net").summary).toContain(
      "not fetched",
    );
  });
});

describe("the payload as an artifact", () => {
  it("carries the fitness call and not only its conclusion", () => {
    // The first live run's fitness call existed in memory and nowhere else, so
    // a wrong one and a right one looked identical on disk. Dropping the field
    // here would restore that silently, since `labels` would still hold the
    // label the call produced.
    const ticket = syntheticTicket("SSX-1234", "https://example.atlassian.net");

    expect(toTriageResult(ticket, payload()).agentFitness.blockers).toEqual(["no baseline"]);
  });

  it("takes the key and URL from the ticket, so the artifact names what was triaged", () => {
    const result = toTriageResult(
      syntheticTicket("SSX-1234", "https://example.atlassian.net"),
      payload(),
    );

    expect(result.issueKey).toBe("SSX-1234");
    expect(result.issueUrl).toBe("https://example.atlassian.net/browse/SSX-1234");
    expect(result.verdict).toBe("needs-info");
    expect(result.recommendedNextStep).toBe("Ask the reporter for a baseline.");
  });
});
