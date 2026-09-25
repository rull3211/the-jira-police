import { describe, expect, it } from "vitest";

import { RETRIAGE_LABEL_PREFIX } from "../watch/counter.ts";
import { FOOTER_SENTINEL, UnpostableError, assertPostable } from "./gate.ts";
import {
  TriageContradictionError,
  type AgentFitness,
  type Mutation,
  type TriagePayload,
} from "./runner.ts";

/** Defaults to "no", matching what `parseAgentFitness` produces from silence. */
function fitness(overrides: Partial<AgentFitness> = {}): AgentFitness {
  return {
    solvable: false,
    plausible: false,
    confidence: "low",
    repo: "",
    rationale: "Needs a human.",
    blockers: ["no reproduction steps"],
    ...overrides,
  };
}

/** The other half: a fitness call that should sail through, for mutating in place. */
function solvable(overrides: Partial<AgentFitness> = {}): AgentFitness {
  return fitness({
    solvable: true,
    plausible: false,
    confidence: "med",
    repo: "buy-insurance-advisor-web",
    rationale: "One file, covered by tests.",
    blockers: [],
    ...overrides,
  });
}

function mutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    commentBody: `## Triage of SSX-1234\n\nLooks fine.\n\n${FOOTER_SENTINEL}`,
    labelsAdd: [],
    labelsRemove: [],
    component: "",
    links: [],
    commentAction: "create",
    ...overrides,
  };
}

function payload(overrides: Partial<TriagePayload> = {}): TriagePayload {
  return {
    verdict: "needs-info",
    labels: ["dor:gaps", "route:ours"],
    dorPlaceholders: [],
    recommendedNextStep: "Ask the reporter.",
    report: "## report",
    mutation: mutation(),
    agentFitness: fitness(),
    ...overrides,
  };
}

/** Convenience: the violation strings from a refusal, or [] if it allowed it. */
function violations(input: TriagePayload, issueKey = "SSX-1234"): readonly string[] {
  try {
    assertPostable(input, issueKey);
    return [];
  } catch (error) {
    if (error instanceof UnpostableError) {
      return error.violations;
    }
    throw error;
  }
}

describe("assertPostable", () => {
  it("allows a well-formed mutation", () => {
    expect(() => assertPostable(payload(), "SSX-1234")).not.toThrow();
  });

  it("still enforces the DoR coherence rule", () => {
    // Re-checks rather than assuming the parser did, since the gate is the last thing before a write.
    expect(() =>
      assertPostable(
        payload({
          verdict: "ready-ish",
          labels: ["dor:pass"],
          dorPlaceholders: [{ text: "[N]", row: 3 }],
        }),
        "SSX-3822",
      ),
    ).toThrow(TriageContradictionError);
  });
});

describe("the comment body", () => {
  it.each(["", "   ", "\n\n"])("refuses a blank body (%o)", (commentBody) => {
    expect(violations(payload({ mutation: mutation({ commentBody }) }))).toEqual([
      "the comment body is empty, so there is nothing to post",
    ]);
  });

  it("says only that, so the real problem is not buried", () => {
    // A blank body also fails the sentinel and issue-key checks; one complaint reads better than three.
    expect(violations(payload({ mutation: mutation({ commentBody: "" }) }))).toHaveLength(1);
  });

  it("refuses a body missing the idempotency sentinel", () => {
    const body = "## Triage of SSX-1234\n\nLooks fine.";

    expect(violations(payload({ mutation: mutation({ commentBody: body }) })).join(" ")).toContain(
      "footer sentinel",
    );
  });

  it("tolerates trailing whitespace after the sentinel", () => {
    const body = `## SSX-1234\n\n${FOOTER_SENTINEL}\n\n`;

    expect(violations(payload({ mutation: mutation({ commentBody: body }) }))).toEqual([]);
  });

  it("refuses a body carrying two agent-fitness blocks", () => {
    // Unreachable unless `withFitnessNote`'s strip missed a paraphrase of the marker it keys on.
    const body = [
      "## Triage of SSX-1234",
      "",
      "🤖 **Agent fitness:** looks automatable · confidence med",
      "",
      "🤖 **Agent fitness:** not yet · confidence low",
      "",
      FOOTER_SENTINEL,
    ].join("\n");

    expect(violations(payload({ mutation: mutation({ commentBody: body }) })).join(" ")).toContain(
      "2 agent-fitness blocks",
    );
  });

  it("accepts the one block a normal run posts", () => {
    const body = `## SSX-1234\n\n🤖 **Agent fitness:** looks automatable\n\n${FOOTER_SENTINEL}`;

    expect(violations(payload({ mutation: mutation({ commentBody: body }) }))).toEqual([]);
  });

  it("does not count the phrase where the report merely mentions it", () => {
    // Column-zero anchoring separates the region the renderer owns from a mere mention.
    const body = `## SSX-1234\n\n> the 🤖 **Agent fitness** call was withdrawn\n\n${FOOTER_SENTINEL}`;

    expect(violations(payload({ mutation: mutation({ commentBody: body }) }))).toEqual([]);
  });

  it("refuses a body that mentions a different issue", () => {
    // The only place body-to-key pairing is checked.
    const body = `## Triage of SSX-9999\n\nLooks fine.\n\n${FOOTER_SENTINEL}`;

    expect(violations(payload({ mutation: mutation({ commentBody: body }) })).join(" ")).toContain(
      "belongs to another issue",
    );
  });

  it("allows a send-back that names dor:pass in order to reverse it", () => {
    // Repudiating a label requires naming it, so the rule must read the delta, not the prose,
    // to tell applying `dor:pass` apart from reversing it.
    const body = [
      "# ↩ SEND BACK → needs info · SSX-1234",
      "",
      "**This reverses the previous intake comment** (it stamped `dor:pass`",
      "while noting the same unfilled `[N]` — AC-2 is still a placeholder, so",
      "row 3 fails).",
      "",
      "LABEL DELTA — remove: dor:pass · add: dor:gaps",
      "",
      FOOTER_SENTINEL,
    ].join("\n");

    expect(
      violations(
        payload({
          verdict: "needs-info",
          labels: ["dor:gaps", "next:to-reporter"],
          dorPlaceholders: [{ text: "[N]", row: 3 }],
          mutation: mutation({
            commentBody: body,
            labelsAdd: ["dor:gaps", "next:to-reporter"],
            labelsRemove: ["dor:pass"],
            commentAction: "update",
          }),
        }),
      ),
    ).toEqual([]);
  });

  it("refuses a delta that APPLIES dor:pass while placeholders remain", () => {
    // Verdict and labels are honest here, so assertDorCoherent sees nothing wrong; only the delta claims the pass.
    const input = payload({
      verdict: "needs-info",
      labels: ["dor:gaps"],
      dorPlaceholders: [{ text: "[N]", row: 3 }],
      mutation: mutation({ labelsAdd: ["dor:pass"] }),
    });

    expect(violations(input).join(" ")).toContain('still contains "[N]"');
  });

  it("allows a body that merely quotes the placeholder", () => {
    // Punishing this would push the model towards saying less.
    const body = `## SSX-1234\n\nDoR: gaps — baseline is still "[N]".\n\n${FOOTER_SENTINEL}`;

    expect(
      violations(
        payload({
          dorPlaceholders: [{ text: "[N]", row: 9 }],
          mutation: mutation({ commentBody: body }),
        }),
      ),
    ).toEqual([]);
  });
});

describe("labels", () => {
  it.each(["route:ours", "dup:open", "dor:gaps", "tier:2", "intake:tech-reviewed", "next:to-trio"])(
    "allows removing the skill's own %s",
    (label) => {
      expect(violations(payload({ mutation: mutation({ labelsRemove: [label] }) }))).toEqual([]);
    },
  );

  it("clears a stale next:* while applying its replacement", () => {
    // §11 must allow retiring a previous next:* label when a verdict change replaces it.
    expect(
      violations(
        payload({
          labels: ["dor:gaps", "next:to-reporter"],
          dorPlaceholders: [{ text: "[N]", row: 9 }],
          mutation: mutation({
            labelsAdd: ["dor:gaps", "next:to-reporter"],
            labelsRemove: ["dor:pass", "next:to-trio"],
            commentAction: "update",
          }),
        }),
      ),
    ).toEqual([]);
  });

  it("refuses removing comp:advisor, which no part of the skill sets", () => {
    // Looks like one of the skill's namespaces; the allow-list tracks §11 exactly, not a superset.
    expect(
      violations(payload({ mutation: mutation({ labelsRemove: ["comp:advisor"] }) })).join(" "),
    ).toContain("not in a namespace the skill owns");
  });

  it.each(["blocked", "customer-escalation", "q3-roadmap"])(
    "refuses to remove the human label %o",
    (label) => {
      // §11: "never touch a human label".
      expect(
        violations(payload({ mutation: mutation({ labelsRemove: [label] }) })).join(" "),
      ).toContain(`"${label}"`);
    },
  );

  it("refuses to add a label the verdict never suggested", () => {
    const input = payload({
      labels: ["dor:gaps"],
      mutation: mutation({ labelsAdd: ["dor:pass"] }),
    });

    expect(violations(input).join(" ")).toContain("the delta and the verdict disagree");
  });

  it("allows adding a subset of the suggested labels", () => {
    const input = payload({
      labels: ["dor:gaps", "route:ours"],
      mutation: mutation({ labelsAdd: ["route:ours"] }),
    });

    expect(violations(input)).toEqual([]);
  });
});

describe("the taxonomy namespaces, revisable only as a swap", () => {
  /** Removing `old`, adding `next`, with the verdict's label list kept in step. */
  function swap(remove: readonly string[], add: readonly string[]): TriagePayload {
    return payload({
      labels: ["dor:gaps", "route:ours", ...add],
      mutation: mutation({ labelsAdd: [...add], labelsRemove: [...remove] }),
    });
  }

  it.each([
    ["team:advisor", "team:partner"],
    ["jira:ssx", "jira:edh"],
    ["domain:pricing", "domain:claims"],
    ["svc:old-web", "svc:buy-insurance-advisor-web"],
    ["value:low", "value:high"],
    ["effort:L", "effort:S"],
  ])("allows replacing %s with %s", (old, next) => {
    expect(violations(swap([old], [next]))).toEqual([]);
  });

  it.each(["team:advisor", "jira:ssx", "domain:pricing", "svc:old-web", "value:low", "effort:L"])(
    "refuses to remove %s with nothing taking its place",
    (label) => {
      // A fact deleted here is one no later re-triage will notice is gone.
      expect(violations(swap([label], [])).join(" ")).toContain("not emptying it");
    },
  );

  it("refuses a removal whose replacement is in a different namespace", () => {
    // The near miss: a rule counting only `labelsAdd.length` would pass this despite the ticket ending up with no `svc:` label.
    expect(violations(swap(["svc:old-web"], ["team:partner"])).join(" ")).toContain(
      "adds no other svc: label",
    );
  });

  it("names the namespace that was left empty, not just the label", () => {
    expect(violations(swap(["effort:L"], [])).join(" ")).toContain("no other effort: label");
  });

  it("allows one owner becoming two", () => {
    // `team:` is multi-valued on dual-owned repos, so the rule is "at least one add", not 1:1.
    expect(violations(swap(["team:advisor"], ["team:advisor-core", "team:partner"]))).toEqual([]);
  });

  it("still refuses a bare human label that merely sits beside a swap", () => {
    // A swap buys no amnesty for the rest of the removals; each is judged on its own namespace.
    expect(violations(swap(["team:advisor", "blocked"], ["team:partner"])).join(" ")).toContain(
      "not in a namespace the skill owns",
    );
  });

  it("keeps impl-uncertain unremovable, having no namespace to swap within", () => {
    // A bare label, so there's no namespace for a replacement to arrive in. See REVISABLE_LABEL_NAMESPACES.
    expect(
      violations(swap(["impl-uncertain"], ["svc:buy-insurance-advisor-web"])).join(" "),
    ).toContain("not in a namespace the skill owns");
  });
});

describe("the agent: namespace, which triage only partly owns", () => {
  it("allows retiring its own agent:solvable when it changes its mind", () => {
    expect(
      violations(payload({ mutation: mutation({ labelsRemove: ["agent:solvable"] }) })),
    ).toEqual([]);
  });

  it("refuses to grant agent:start, which is a human's authorisation", () => {
    // A ticket body could ask the skill to emit `agent:start`, since a ticket is data, not instruction.
    const input = payload({
      labels: ["dor:gaps", "route:ours", "agent:start"],
      mutation: mutation({ labelsAdd: ["agent:start"] }),
    });

    expect(violations(input).join(" ")).toContain("agent:start is a human's authorisation");
  });

  it.each(["agent:solving", "agent:done", "agent:failed"])(
    "refuses to remove the solver's own %s",
    (label) => {
      // A re-triage that cleared `agent:solving` would unclaim a fix already in flight.
      expect(
        violations(payload({ mutation: mutation({ labelsRemove: [label] }) })).join(" "),
      ).toContain(`"${label}"`);
    },
  );

  it("refuses to touch the watch's re-triage counter, in either direction", () => {
    // A run that could clear its own re-triage counter is a brake wired to the thing it brakes.
    const counter = `${RETRIAGE_LABEL_PREFIX}2`;

    expect(
      violations(payload({ mutation: mutation({ labelsRemove: [counter] }) })).join(" "),
    ).toContain(`"${counter}"`);
    expect(
      violations(
        payload({
          labels: ["dor:gaps", "route:ours", counter],
          mutation: mutation({ labelsAdd: [counter] }),
        }),
      ).join(" "),
    ).toContain(`"${counter}"`);
  });
});

describe("agent fitness", () => {
  /** A coherent yes: ready-ish, labelled, no blockers, repo named, the label in the delta too. */
  function ok(overrides: Partial<TriagePayload> = {}): TriagePayload {
    return payload({
      verdict: "ready-ish",
      labels: ["dor:pass", "route:ours", "agent:solvable"],
      agentFitness: solvable(),
      mutation: mutation({ labelsAdd: ["agent:solvable"] }),
      ...overrides,
    });
  }

  it("allows a coherent solvable payload", () => {
    expect(violations(ok())).toEqual([]);
  });

  it("does not fire on a re-run that leaves the label out of the delta", () => {
    // The check reads `labels`, never `labelsAdd`: §11's delta holds only labels not already on
    // the issue, so a re-run over a ticket already marked solvable legitimately omits it.
    expect(
      violations(ok({ mutation: mutation({ labelsAdd: [], commentAction: "update" }) })),
    ).toEqual([]);
  });

  it("refuses a first-run payload that lists the label but leaves it out of the delta", () => {
    // The SSX-3940 shape, 2026-09-24: `commentAction: "create"` means no prior triage comment
    // matched, so nothing already on the issue excuses `labelsAdd` omitting what `labels` asserts.
    expect(violations(ok({ mutation: mutation({ labelsAdd: [] }) })).join(" ")).toContain(
      'commentAction is "create"',
    );
  });

  it.each(["needs-info", "duplicate", "not-our-team", "out-of-scope"] as const)(
    "refuses solvable on a %s verdict",
    (verdict) => {
      expect(violations(ok({ verdict })).join(" ")).toContain(
        "only a ready-ish ticket has passed DoR",
      );
    },
  );

  it("refuses solvable while blockers remain", () => {
    expect(
      violations(ok({ agentFitness: solvable({ blockers: ["needs a product decision"] }) })).join(
        " ",
      ),
    ).toContain("needs a product decision");
  });

  it.each(["", "   "])("refuses solvable with repo %o", (repo) => {
    expect(violations(ok({ agentFitness: solvable({ repo }) })).join(" ")).toContain(
      "names no repo",
    );
  });

  it("refuses solvable that never reaches the board", () => {
    expect(violations(ok({ labels: ["dor:pass", "route:ours"] })).join(" ")).toContain(
      "the assessment would never reach the board",
    );
  });

  it("refuses a label the assessment does not stand behind", () => {
    // The other direction: the label would authorise work the assessment declined.
    expect(violations(ok({ agentFitness: fitness() })).join(" ")).toContain(
      "would authorise work the assessment declined",
    );
  });

  it("says nothing about a payload that simply declines", () => {
    // The common case; every default in `parseAgentFitness` lands here.
    expect(violations(payload())).toEqual([]);
  });
});

describe("plausible, the send-back watch", () => {
  /** A coherent watch: not solvable, blockers named, labelled on the board, the label in the delta too. */
  function watched(overrides: Partial<TriagePayload> = {}): TriagePayload {
    return payload({
      verdict: "needs-info",
      labels: ["dor:gaps", "route:ours", "agent:watching"],
      agentFitness: fitness({ plausible: true, blockers: ["no reproduction steps"] }),
      mutation: mutation({ labelsAdd: ["agent:watching"] }),
      ...overrides,
    });
  }

  it("allows a coherent watch", () => {
    expect(violations(watched())).toEqual([]);
  });

  it("allows a watch on a verdict other than needs-info", () => {
    // Deliberately not gated on the verdict the way `solvable` is: a watch needs only a gap, not DoR.
    expect(violations(watched({ verdict: "out-of-scope" }))).toEqual([]);
  });

  it("refuses a payload that claims both", () => {
    const both = payload({
      verdict: "ready-ish",
      labels: ["dor:pass", "route:ours", "agent:solvable", "agent:watching"],
      agentFitness: solvable({ plausible: true, blockers: [] }),
    });

    expect(violations(both).join(" ")).toContain("has not made the call");
  });

  it("refuses a watch with no blockers", () => {
    // The blockers are the exit condition, not the explanation.
    expect(
      violations(watched({ agentFitness: fitness({ plausible: true, blockers: [] }) })).join(" "),
    ).toContain("no condition that could ever clear it");
  });

  it("refuses a watch that never reaches the board", () => {
    expect(violations(watched({ labels: ["dor:gaps", "route:ours"] })).join(" ")).toContain(
      "nothing would subscribe to the ticket",
    );
  });

  it("refuses the label without the field behind it", () => {
    // A ticket body talking the skill into a recurring re-triage charge nobody asked for.
    expect(violations(watched({ agentFitness: fitness() })).join(" ")).toContain(
      "a paid watch list the assessment did not ask for",
    );
  });

  it("reads labels rather than the delta, like every other label check here", () => {
    // Same reason as `agent:solvable`: §11's delta legitimately omits a label already on the issue.
    expect(
      violations(watched({ mutation: mutation({ labelsAdd: [], commentAction: "update" }) })),
    ).toEqual([]);
  });

  it("refuses a first-run payload that lists the label but leaves it out of the delta", () => {
    // The `agent:watching` twin of the SSX-3940 shape: `commentAction: "create"` means nothing
    // already on the issue excuses `labelsAdd` omitting what `labels` asserts.
    expect(violations(watched({ mutation: mutation({ labelsAdd: [] }) })).join(" ")).toContain(
      'commentAction is "create"',
    );
  });

  it("lets triage retire its own agent:watching", () => {
    // The unsubscribe half of §7c.
    expect(
      violations(payload({ mutation: mutation({ labelsRemove: ["agent:watching"] }) })),
    ).toEqual([]);
  });
});

describe("component", () => {
  it.each(["SSX Advisor", "EDH", "SSX Partner", "SSX Nettsalg"])("allows %o", (component) => {
    expect(violations(payload({ mutation: mutation({ component }) }))).toEqual([]);
  });

  it("allows an empty component, which means 'uncertain, do not write'", () => {
    expect(violations(payload({ mutation: mutation({ component: "" }) }))).toEqual([]);
  });

  it.each(["SSX advisor", "Advisor", "SSX-Advisor", "Nettsalg"])(
    "refuses %o, which is not a policy stream",
    (component) => {
      expect(violations(payload({ mutation: mutation({ component }) })).join(" ")).toContain(
        "policy streams",
      );
    },
  );
});

describe("the refusal itself", () => {
  it("collects every violation rather than stopping at the first", () => {
    // A run costs real money; sending the operator round the loop once per problem is wasteful.
    const input = payload({
      labels: ["dor:gaps"],
      mutation: mutation({
        commentBody: "no sentinel here, and the wrong key: SSX-9999",
        labelsAdd: ["dor:pass"],
        labelsRemove: ["blocked"],
        component: "Nonsense",
      }),
    });

    expect(violations(input).length).toBeGreaterThanOrEqual(4);
  });

  it("reports the count and lists them, so the log explains itself", () => {
    const input = payload({ mutation: mutation({ component: "Nonsense" }) });

    try {
      assertPostable(input, "SSX-1234");
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("SSX-1234");
      expect(message).toContain("refusing to post");
      expect(message).toContain("Nonsense");
    }
  });
});
