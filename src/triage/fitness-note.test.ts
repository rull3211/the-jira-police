import { describe, expect, it } from "vitest";

import { buildFitnessNote, withFitnessNote } from "./fitness-note.ts";
import { FITNESS_MARKER, FOOTER_SENTINEL } from "./gate.ts";
import type { AgentFitness, Mutation, TriagePayload } from "./runner.ts";

/** Blocks, counted by the line that opens one — never by mentions of the phrase. */
function blocks(body: string): number {
  return body.split("\n").filter((line) => line.startsWith(FITNESS_MARKER)).length;
}

/** What a re-run is handed: the body this module wrote on the previous pass. */
function rerunOf(previous: TriagePayload, overrides: Partial<TriagePayload> = {}): TriagePayload {
  return payload({
    ...overrides,
    mutation: mutation({ commentBody: previous.mutation.commentBody }),
  });
}

function fitness(overrides: Partial<AgentFitness> = {}): AgentFitness {
  return {
    solvable: false,
    plausible: false,
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
    // The blockers are a to-do list a human can often clear cheaply.
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
      // Below ready-ish the verdict already says "not ready"; the block would be noise.
      expect(buildFitnessNote(verdict, fitness())).toBeNull();
    },
  );

  it("promises nothing when the call is positive", () => {
    // Nothing consumes the label yet, and manual mode keeps a human in the loop regardless.
    const note = buildFitnessNote("ready-ish", fitness({ solvable: true, blockers: [] })) ?? "";

    expect(note).toContain("looks automatable");
    expect(note).toContain("a human still has to opt the ticket in");
    expect(note).not.toContain("will");
  });

  it("carries the deciding factor on a yes, not only the caveat", () => {
    // `rationale` is the one ticket-specific fact the payload carries, and the schema requires it.
    const note =
      buildFitnessNote(
        "ready-ish",
        fitness({
          solvable: true,
          blockers: [],
          rationale: "One repo, and AC-4 reads directly as the regression test.",
        }),
      ) ?? "";

    expect(note).toContain("One repo, and AC-4 reads directly as the regression test.");
    expect(note).toContain("a human still has to opt the ticket in");
  });

  it("still says something when a yes gave no reason at all", () => {
    const note =
      buildFitnessNote("ready-ish", fitness({ solvable: true, blockers: [], rationale: "" })) ?? "";

    expect(note).toContain("Assessed as safe for an autonomous fix.");
    expect(note).toContain("a human still has to opt the ticket in");
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
    // The poster matches that exact trailing line to find its previous comment.
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

describe("the block owns its region, because a re-run hands its own output back", () => {
  it("posts one block on a re-run, not one per run", () => {
    const first = withFitnessNote(payload());
    const second = withFitnessNote(rerunOf(first));

    expect(blocks(first.mutation.commentBody)).toBe(1);
    expect(blocks(second.mutation.commentBody)).toBe(1);
  });

  it("does not ratchet: the fourth run still posts one", () => {
    // The observed ceiling was two, but nothing here relies on that — it isn't a guaranteed bound.
    let run = withFitnessNote(payload());
    for (let index = 0; index < 3; index += 1) {
      run = withFitnessNote(rerunOf(run));
    }

    expect(blocks(run.mutation.commentBody)).toBe(1);
  });

  it("removes a block whose wording no longer matches what the renderer writes", () => {
    // Matching the exact string a run would render breaks on any re-run where the verdict
    // changed, as it does here.
    const previous = withFitnessNote(payload({ agentFitness: fitness({ solvable: false }) }));
    const now = withFitnessNote(
      rerunOf(previous, { agentFitness: fitness({ solvable: true, blockers: [] }) }),
    );
    const body = now.mutation.commentBody;

    expect(blocks(body)).toBe(1);
    expect(body).toContain("looks automatable");
    expect(body).not.toContain("To make this agent-solvable, resolve:");
  });

  it("removes a block the model re-typed in its own words", () => {
    // Keying the strip on the marker prefix, not the whole rendered line, catches a paraphrase too.
    const paraphrased = [
      "# ACCEPT · SSX-3822",
      "",
      "The report.",
      "",
      "---",
      "",
      "🤖 **Agent fitness: solvable** · `buy-insurance-advisor-web` · confidence med",
      "",
      "The watch set on 2026-09-06 is lifted.",
      "",
      FOOTER_SENTINEL,
    ].join("\n");
    const body = withFitnessNote(payload({ mutation: mutation({ commentBody: paraphrased }) }))
      .mutation.commentBody;

    expect(blocks(body)).toBe(1);
    expect(body).not.toContain("The watch set on 2026-09-06 is lifted.");
  });

  it("collapses a body that already carries two", () => {
    // Stripping only the first occurrence would leave the ticket as broken as before.
    const once = withFitnessNote(payload()).mutation.commentBody;
    const doubled = once.replace(
      FOOTER_SENTINEL,
      `---\n\n🤖 **Agent fitness:** not yet · confidence low\n\nA second account.\n\n${FOOTER_SENTINEL}`,
    );

    const body = withFitnessNote(payload({ mutation: mutation({ commentBody: doubled }) })).mutation
      .commentBody;

    expect(blocks(body)).toBe(1);
    expect(body).not.toContain("A second account.");
  });

  it("leaves no horizontal rule hanging where the old block was", () => {
    // Deleting only forward from the marker leaves a dangling `---`; the backward scan avoids that.
    const body = withFitnessNote(rerunOf(withFitnessNote(payload()))).mutation.commentBody;

    expect(body.split("\n").filter((line) => line.trim() === "---")).toHaveLength(1);
    expect(body).toContain("The report.");
  });

  it("keeps a mention of the phrase that is not a block", () => {
    // Column-zero anchoring is what distinguishes this module's block from a report merely
    // discussing fitness.
    const quoting = [
      "# ACCEPT · SSX-3822",
      "",
      "> Evidence: the previous 🤖 **Agent fitness** call was withdrawn.",
      "",
      FOOTER_SENTINEL,
    ].join("\n");
    const body = withFitnessNote(payload({ mutation: mutation({ commentBody: quoting }) })).mutation
      .commentBody;

    expect(body).toContain("> Evidence: the previous 🤖 **Agent fitness** call was withdrawn.");
    expect(blocks(body)).toBe(1);
  });

  it("clears a watch note the ticket has stopped qualifying for", () => {
    // Returning early when nothing renders would strand the previous run's blockers permanently.
    const watched = withFitnessNote(
      payload({ verdict: "needs-info", agentFitness: fitness({ plausible: true }) }),
    );
    const body = withFitnessNote(
      payload({
        verdict: "needs-info",
        agentFitness: fitness({ plausible: false }),
        mutation: mutation({ commentBody: watched.mutation.commentBody }),
      }),
    ).mutation.commentBody;

    expect(blocks(body)).toBe(0);
    expect(body).not.toContain("needs a real .ico asset");
    expect(body).toContain("The report.");
    expect(body.trimEnd().endsWith(FOOTER_SENTINEL)).toBe(true);
  });
});

describe("the send-back block, which is the whole of the watch a reporter can see", () => {
  const WATCHED = fitness({
    plausible: true,
    blockers: ["state the expected total for a cart of two items", "name the browser it fails in"],
  });

  it("appears on a send-back that is being watched", () => {
    // `plausible` is only ever true below `ready-ish`, by the gate's own
    // alternatives rule, so this is the watch's only rendering path.
    const note = buildFitnessNote("needs-info", WATCHED);

    expect(note).not.toBeNull();
    expect(note).toContain("state the expected total for a cart of two items");
    expect(note).toContain("name the browser it fails in");
  });

  it("says an answer is enough, because nobody will answer a bot that promised nothing", () => {
    // Unlike the `ready-ish` block, which promises nothing, the sweep here
    // runs whether or not the reporter was told.
    const note = buildFitnessNote("needs-info", WATCHED) ?? "";

    expect(note).toContain("looked at again");
    expect(note).not.toContain("Nothing picks this up on its own");
  });

  it("stays quiet on an ordinary send-back", () => {
    // Below `ready-ish` the verdict already says "not ready"; a second copy is noise.
    expect(buildFitnessNote("needs-info", fitness({ plausible: false }))).toBeNull();
  });

  it("is spliced above the footer like every other block", () => {
    // The watch re-runs by design, so this is the path where posting after
    // the sentinel would compound duplicates rather than happening once.
    const posted = withFitnessNote(payload({ verdict: "needs-info", agentFitness: WATCHED }));
    const body = posted.mutation.commentBody;

    expect(body).toContain("state the expected total for a cart of two items");
    expect(body.indexOf("Agent fitness")).toBeLessThan(body.indexOf(FOOTER_SENTINEL));
    expect(body.trimEnd().endsWith(FOOTER_SENTINEL)).toBe(true);
  });
});
