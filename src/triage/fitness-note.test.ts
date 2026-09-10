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

  it("carries the deciding factor on a yes, not only the caveat", () => {
    // The branch used to emit a fixed sentence and drop `rationale` — the one
    // ticket-specific thing the payload holds, required by the schema and
    // already printed to the local report by `sink.ts`. The block said less
    // than the data behind it, and on four re-runs the model restored the
    // difference by hand, which is where the duplicate came from.
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

describe("the block owns its region, because a re-run hands its own output back", () => {
  // Measured on the real board before any of this was written: four re-runs,
  // four duplicates, across both verdicts; two first runs, both correct. The
  // model rebuilds the comment from its own previous one and carries this
  // block along as body text, so a splice that does not remove first posts a
  // second copy of a block whose whole purpose is to be the single account of
  // the call. The fixture is built by running the real thing twice rather than
  // by hand, so it cannot stop modelling what the renderer actually emits.

  it("posts one block on a re-run, not one per run", () => {
    const first = withFitnessNote(payload());
    const second = withFitnessNote(rerunOf(first));

    expect(blocks(first.mutation.commentBody)).toBe(1);
    expect(blocks(second.mutation.commentBody)).toBe(1);
  });

  it("does not ratchet: the fourth run still posts one", () => {
    // The observed ceiling on the board was two, which reads as harmless. It
    // is not a property anything guaranteed — it was the model collapsing
    // whatever it found. Nothing here relies on it.
    let run = withFitnessNote(payload());
    for (let index = 0; index < 3; index += 1) {
      run = withFitnessNote(rerunOf(run));
    }

    expect(blocks(run.mutation.commentBody)).toBe(1);
  });

  it("removes a block whose wording no longer matches what the renderer writes", () => {
    // The plausible wrong fix is deleting the exact string this run would
    // render. It fails on every re-run where anything moved — and something
    // usually has, which is why the ticket was re-triaged. Here the previous
    // pass called it `not yet`; this one calls it `looks automatable`.
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
    // Observed on SSX-3024, where the model wrote `🤖 **Agent fitness:
    // solvable**` against the renderer's `🤖 **Agent fitness:** looks
    // automatable`. Keying the strip on the whole rendered line would have
    // walked straight past it.
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
    // The state four tickets were actually in. Stripping only the first
    // occurrence leaves the ticket exactly as broken as it was.
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
    // Deleting forward from the marker is correct and looks broken: the
    // renderer opens with `---`, so the report ends under a rule with nothing
    // beneath it. Exactly one separator should survive — the one introducing
    // the block this run wrote.
    const body = withFitnessNote(rerunOf(withFitnessNote(payload()))).mutation.commentBody;

    expect(body.split("\n").filter((line) => line.trim() === "---")).toHaveLength(1);
    expect(body).toContain("The report.");
  });

  it("keeps a mention of the phrase that is not a block", () => {
    // Anchoring at column zero is the only thing separating the region this
    // module owns from the report talking about fitness. Match anywhere in the
    // line and the evidence blockquote goes with it.
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
    // `plausible` went false, so nothing is rendered this run. Returning early
    // on that — the shape this function had — strands the previous run's
    // blockers on the ticket permanently: a to-do list addressed to a reporter
    // nobody is waiting on any more.
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
    // **The mutation this exists for.** `plausible` is only ever true below
    // `ready-ish`, by the gate's own alternatives rule — so the original
    // verdict guard suppressed the block on exactly the tickets the watch was
    // built for. Restore the bare `return null` and F becomes a machine that
    // subscribes to a ticket and never asks the question it is waiting on an
    // answer to. Silent, paid for, and indistinguishable from working.
    const note = buildFitnessNote("needs-info", WATCHED);

    expect(note).not.toBeNull();
    expect(note).toContain("state the expected total for a cart of two items");
    expect(note).toContain("name the browser it fails in");
  });

  it("says an answer is enough, because nobody will answer a bot that promised nothing", () => {
    // The `ready-ish` block deliberately promises nothing — a solvable ticket
    // still waits for a human to opt it in. Here the opposite is true and it is
    // a fact about the queue rather than a promise: the sweep runs whether or
    // not the reporter was told. Copy the cautious wording across and the
    // reporter is left with a to-do list and no reason to do it.
    const note = buildFitnessNote("needs-info", WATCHED) ?? "";

    expect(note).toContain("looked at again");
    expect(note).not.toContain("Nothing picks this up on its own");
  });

  it("stays quiet on an ordinary send-back", () => {
    // The original judgement, untouched: below `ready-ish` the fitness answer
    // is the trivial "the ticket is not ready", which the verdict says louder,
    // and a second copy of it is noise on a ticket a colleague is reading.
    expect(buildFitnessNote("needs-info", fitness({ plausible: false }))).toBeNull();
  });

  it("is spliced above the footer like every other block", () => {
    // The sentinel is how the poster finds its own last comment to update in
    // place. A note appended after it starts posting duplicates on every
    // re-run — and the watch re-runs by design, so this path is the one where
    // that failure compounds rather than happening once.
    const posted = withFitnessNote(payload({ verdict: "needs-info", agentFitness: WATCHED }));
    const body = posted.mutation.commentBody;

    expect(body).toContain("state the expected total for a cart of two items");
    expect(body.indexOf("Agent fitness")).toBeLessThan(body.indexOf(FOOTER_SENTINEL));
    expect(body.trimEnd().endsWith(FOOTER_SENTINEL)).toBe(true);
  });
});
