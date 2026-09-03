import { describe, expect, it } from "vitest";

import { buildFitnessNote, withFitnessNote } from "./fitness-note.ts";
import { FOOTER_SENTINEL } from "./gate.ts";
import type { AgentFitness, Mutation, TriagePayload } from "./runner.ts";

function fitness(overrides: Partial<AgentFitness> = {}): AgentFitness {
  return {
    solvable: false,
    confidence: "med",
    repo: "buy-insurance-advisor-web",
    rationale: "The deliverable is a brand asset.",
    blockers: ["needs a real .ico asset", "AC#4 is a visual check"],
    ...overrides,
  };
}

function mutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    commentBody: `# ACCEPT · SSX-3822\n\nThe report.\n\n${FOOTER_SENTINEL}`,
    labelsAdd: [],
    labelsRemove: [],
    component: "",
    links: [],
    commentAction: "update",
    ...overrides,
  } as Mutation;
}

function payload(overrides: Partial<TriagePayload> = {}): TriagePayload {
  return {
    verdict: "ready-ish",
    labels: ["dor:pass"],
    dorPlaceholders: [],
    recommendedNextStep: "Queue it.",
    report: "## report",
    mutation: mutation(),
    agentFitness: fitness(),
    ...overrides,
  };
}

describe("buildFitnessNote", () => {
  it("lists the blockers as the things to resolve", () => {
    // The point of putting this on the ticket at all: the blockers are a
    // to-do list, and a human can often clear one cheaply.
    const note = buildFitnessNote("ready-ish", fitness());

    expect(note).toContain("not yet");
    expect(note).toContain("To make this agent-solvable, resolve:");
    expect(note).toContain("* needs a real .ico asset");
    expect(note).toContain("* AC#4 is a visual check");
  });

  it("names the repo and the confidence", () => {
    const note = buildFitnessNote("ready-ish", fitness({ confidence: "high" }));

    expect(note).toContain("`buy-insurance-advisor-web`");
    expect(note).toContain("confidence high");
  });

  it("omits the repo when none was named", () => {
    expect(buildFitnessNote("ready-ish", fitness({ repo: "" }))).not.toContain("``");
  });

  it.each(["needs-info", "duplicate", "not-our-team", "out-of-scope"] as const)(
    "stays off a %s ticket entirely",
    (verdict) => {
      // Below ready-ish the answer is trivially "the ticket is not ready",
      // which the verdict already says — so the block would be pure noise on a
      // comment a colleague reads.
      expect(buildFitnessNote(verdict, fitness())).toBeNull();
    },
  );

  it("promises nothing when the call is positive", () => {
    // Nothing consumes the label yet, and manual mode keeps a human in the
    // loop even once something does.
    const note = buildFitnessNote("ready-ish", fitness({ solvable: true, blockers: [] })) ?? "";

    expect(note).toContain("looks automatable");
    expect(note).toContain("a human still has to opt the ticket in");
    expect(note).not.toContain("will");
  });

  it("falls back to the rationale when a no lists no blockers", () => {
    // Reachable: the gate enforces solvable ⇒ no blockers, not the reverse.
    const note = buildFitnessNote("ready-ish", fitness({ blockers: [] }));

    expect(note).toContain("The deliverable is a brand asset.");
  });

  it("never renders a bare refusal with no reason at all", () => {
    const note = buildFitnessNote("ready-ish", fitness({ blockers: [], rationale: "" })) ?? "";

    expect(note).toContain("No reason was given.");
  });
});

describe("withFitnessNote", () => {
  it("splices the note above the footer sentinel, never below it", () => {
    // The poster finds its own previous comment by matching that exact trailing
    // line. Anything after it breaks update-in-place and posts duplicates.
    const body = withFitnessNote(payload()).mutation.commentBody;

    expect(body.trimEnd().endsWith(FOOTER_SENTINEL)).toBe(true);
    expect(body.indexOf("Agent fitness")).toBeLessThan(body.indexOf(FOOTER_SENTINEL));
  });

  it("keeps the skill's own report text intact", () => {
    const body = withFitnessNote(payload()).mutation.commentBody;

    expect(body).toContain("# ACCEPT · SSX-3822");
    expect(body).toContain("The report.");
  });

  it("leaves a send-back comment completely untouched", () => {
    const original = payload({ verdict: "needs-info" });

    expect(withFitnessNote(original)).toBe(original);
  });

  it("leaves a body with no sentinel untouched, for the gate to refuse", () => {
    // Reporting it here too would only bury assertPostable's own message.
    const original = payload({ mutation: mutation({ commentBody: "no footer here" }) });

    expect(withFitnessNote(original)).toBe(original);
  });

  it("does not disturb the rest of the mutation", () => {
    const original = payload({
      mutation: mutation({ labelsAdd: ["dor:pass"], component: "SSX Advisor" }),
    });
    const result = withFitnessNote(original);

    expect(result.mutation.labelsAdd).toEqual(["dor:pass"]);
    expect(result.mutation.component).toBe("SSX Advisor");
    expect(result.verdict).toBe("ready-ish");
  });

  it("only ever adds one sentinel, so a re-run can still match it", () => {
    const body = withFitnessNote(payload()).mutation.commentBody;

    expect(body.split(FOOTER_SENTINEL)).toHaveLength(2);
  });
});
