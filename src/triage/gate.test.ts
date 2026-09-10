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
    // The gate is documented as the last thing before a write, so it re-checks
    // rather than assuming the parser did. This is also the check that exists
    // because of SSX-3822.
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
    // A blank body also fails the sentinel check and the issue-key check. Three
    // complaints about one cause is worse reading than one.
    expect(violations(payload({ mutation: mutation({ commentBody: "" }) }))).toHaveLength(1);
  });

  it("refuses a body missing the idempotency sentinel", () => {
    // Without it the skill cannot recognise its own prior comment, so every
    // re-run stacks another copy instead of refreshing the last one.
    const body = "## Triage of SSX-1234\n\nLooks fine.";

    expect(violations(payload({ mutation: mutation({ commentBody: body }) })).join(" ")).toContain(
      "footer sentinel",
    );
  });

  it("tolerates trailing whitespace after the sentinel", () => {
    const body = `## SSX-1234\n\n${FOOTER_SENTINEL}\n\n`;

    expect(violations(payload({ mutation: mutation({ commentBody: body }) }))).toEqual([]);
  });

  it("refuses a body that mentions a different issue", () => {
    // The poster is handed text it did not write. This is the only place the
    // pairing of body to key is ever checked.
    const body = `## Triage of SSX-9999\n\nLooks fine.\n\n${FOOTER_SENTINEL}`;

    expect(violations(payload({ mutation: mutation({ commentBody: body }) })).join(" ")).toContain(
      "belongs to another issue",
    );
  });

  it("allows a send-back that names dor:pass in order to reverse it", () => {
    // REGRESSION, from the live SSX-3822 run of 2026-09-03.
    //
    // An earlier check refused any body containing the string "dor:pass" while
    // placeholders remained. It rejected this comment — a correct send-back,
    // verdict needs-info, whose whole purpose was to undo a `dor:pass` a prior
    // run had wrongly stamped. Repudiating a label requires naming it, so the
    // check fired hardest on the runs that were fixing things. The rule now
    // reads the delta instead, where applying and reversing are distinct.
    //
    // The placeholder is on row 3 rather than the row 9 of the original
    // incident, because row 9 no longer justifies a send-back at all — a
    // fixture reversing `dor:pass` over an advisory row would be teaching the
    // opposite of the current rule while testing something unrelated to it.
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
    // The surviving half of the SSX-3822 rule. Verdict and labels are honest,
    // so assertDorCoherent sees nothing wrong; only the delta claims the pass.
    const input = payload({
      verdict: "needs-info",
      labels: ["dor:gaps"],
      dorPlaceholders: [{ text: "[N]", row: 3 }],
      mutation: mutation({ labelsAdd: ["dor:pass"] }),
    });

    expect(violations(input).join(" ")).toContain('still contains "[N]"');
  });

  it("allows a body that merely quotes the placeholder", () => {
    // Reporting "baseline [N] left unfilled" is the correct behaviour, and
    // punishing it would push the model towards saying less.
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
    // REGRESSION, from the live SSX-3822 run of 2026-09-03. §11 originally
    // omitted `next:*` from the removal allow-list while the skill set it on
    // every verdict, so a verdict change could not retire the previous routing
    // label — leaving `next:to-trio` on a ticket alongside the
    // `next:to-reporter` that contradicts it. Refusing the removal refused the
    // whole mutation, so the correction could never post at all.
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
    // Looks like one of the skill's namespaces and is not one. The allow-list
    // tracks §11 exactly; anything else is somebody's label until §11 says so.
    expect(
      violations(payload({ mutation: mutation({ labelsRemove: ["comp:advisor"] }) })).join(" "),
    ).toContain("not in a namespace the skill owns");
  });

  it.each(["blocked", "customer-escalation", "q3-roadmap"])(
    "refuses to remove the human label %o",
    (label) => {
      // §11: "never touch a human label". This is the one field in the payload
      // whose misuse destroys somebody else's information.
      expect(
        violations(payload({ mutation: mutation({ labelsRemove: [label] }) })).join(" "),
      ).toContain(`"${label}"`);
    },
  );

  it("refuses to add a label the verdict never suggested", () => {
    // The delta and the label list are two renderings of one decision, made by
    // one run. Disagreement between them means something has come apart.
    const input = payload({
      labels: ["dor:gaps"],
      mutation: mutation({ labelsAdd: ["dor:pass"] }),
    });

    expect(violations(input).join(" ")).toContain("the delta and the verdict disagree");
  });

  it("allows adding a subset of the suggested labels", () => {
    // The rest are presumably already on the issue, which is what a delta means.
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
      // The whole point of the tier. These labels are facts about the ticket, and
      // a fact this skill deletes is one no later re-triage will notice is gone —
      // the ticket just reads as one that was never triaged.
      expect(violations(swap([label], [])).join(" ")).toContain("not emptying it");
    },
  );

  it("refuses a removal whose replacement is in a different namespace", () => {
    // The near miss: something *is* being added, so a rule that only counted
    // `labelsAdd.length` would pass this. The ticket still ends up with no
    // `svc:` label, and `repoFromLabels` still answers `null`.
    expect(violations(swap(["svc:old-web"], ["team:partner"])).join(" ")).toContain(
      "adds no other svc: label",
    );
  });

  it("names the namespace that was left empty, not just the label", () => {
    expect(violations(swap(["effort:L"], [])).join(" ")).toContain("no other effort: label");
  });

  it("allows one owner becoming two", () => {
    // `team:` is multi-valued on dual-owned repos, so the rule is "at least one
    // add in the namespace" rather than a 1:1 exchange. A stricter rule would
    // have blocked the honest case of a repo gaining a second owning squad.
    expect(violations(swap(["team:advisor"], ["team:advisor-core", "team:partner"]))).toEqual([]);
  });

  it("still refuses a bare human label that merely sits beside a swap", () => {
    // The swap does not buy amnesty for the rest of the removals: each is judged
    // on its own namespace, and `blocked` belongs to a person.
    expect(violations(swap(["team:advisor", "blocked"], ["team:partner"])).join(" ")).toContain(
      "not in a namespace the skill owns",
    );
  });

  it("keeps impl-uncertain unremovable, having no namespace to swap within", () => {
    // Recorded as a limitation rather than an oversight: it is a bare label, so
    // there is no namespace for a replacement to arrive in and nothing for the
    // swap rule to check. See REVISABLE_LABEL_NAMESPACES.
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
    // The one that matters. The analyst's whole input is a Jira ticket, and a
    // ticket is written by whoever felt like writing one. If the skill could
    // emit `agent:start`, a ticket body could ask it to — and the human
    // approval step in manual mode would be one the bot performs for itself.
    const input = payload({
      labels: ["dor:gaps", "route:ours", "agent:start"],
      mutation: mutation({ labelsAdd: ["agent:start"] }),
    });

    expect(violations(input).join(" ")).toContain("agent:start is a human's authorisation");
  });

  it.each(["agent:solving", "agent:done", "agent:failed"])(
    "refuses to remove the solver's own %s",
    (label) => {
      // The solve queue has no local cursor: its idempotency rests entirely on
      // these labels being written once, by one writer. A re-triage that
      // cleared `agent:solving` would unclaim a fix already in flight.
      expect(
        violations(payload({ mutation: mutation({ labelsRemove: [label] }) })).join(" "),
      ).toContain(`"${label}"`);
    },
  );

  it("refuses to touch the watch's re-triage counter, in either direction", () => {
    // **The whole reason the counter can live in a label.** It is a reservation
    // written before the run it authorises, and the run it authorises is a
    // re-triage — which §11 otherwise lets clear `agent:*`. A run that could
    // clear its own counter is a brake wired to the thing it is braking, so the
    // protection has to be mechanical and it has to be here. Add the counter
    // namespace to `TRIAGE_OWNED_AGENT_LABELS` and this fails.
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
  /** A coherent yes: ready-ish, labelled, no blockers, repo named. */
  function ok(overrides: Partial<TriagePayload> = {}): TriagePayload {
    return payload({
      verdict: "ready-ish",
      labels: ["dor:pass", "route:ours", "agent:solvable"],
      agentFitness: solvable(),
      ...overrides,
    });
  }

  it("allows a coherent solvable payload", () => {
    expect(violations(ok())).toEqual([]);
  });

  it("does not fire on a re-run that leaves the label out of the delta", () => {
    // The check reads `labels`, never `labelsAdd`, and this is why. §11's delta
    // holds only labels NOT already on the issue, so the second run over a
    // ticket already marked solvable legitimately omits it. A gate keyed on the
    // delta would fire hardest on the runs least deserving of it — the same
    // false-positive shape that got the old prose check withdrawn.
    expect(
      violations(ok({ mutation: mutation({ labelsAdd: [], commentAction: "update" }) })),
    ).toEqual([]);
  });

  it.each(["needs-info", "duplicate", "not-our-team", "out-of-scope"] as const)(
    "refuses solvable on a %s verdict",
    (verdict) => {
      // Only ready-ish has passed DoR, and without DoR there are no acceptance
      // criteria concrete enough for an agent to check its own work against.
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
    // The other direction, and the SSX-3822 shape exactly: prose and structured
    // field each defensible alone, disagreeing with each other. Here the label
    // would authorise work the assessment declined.
    expect(violations(ok({ agentFitness: fitness() })).join(" ")).toContain(
      "would authorise work the assessment declined",
    );
  });

  it("says nothing about a payload that simply declines", () => {
    // The common case by far, and it must stay free. Every default in
    // `parseAgentFitness` lands here.
    expect(violations(payload())).toEqual([]);
  });
});

describe("plausible, the send-back watch", () => {
  /** A coherent watch: not solvable, blockers named, labelled on the board. */
  function watched(overrides: Partial<TriagePayload> = {}): TriagePayload {
    return payload({
      verdict: "needs-info",
      labels: ["dor:gaps", "route:ours", "agent:watching"],
      agentFitness: fitness({ plausible: true, blockers: ["no reproduction steps"] }),
      ...overrides,
    });
  }

  it("allows a coherent watch", () => {
    expect(violations(watched())).toEqual([]);
  });

  it("allows a watch on a verdict other than needs-info", () => {
    // Deliberately NOT gated on the verdict the way `solvable` is. `solvable`
    // needs ready-ish because it needs acceptance criteria to check work
    // against; a watch needs only a gap somebody can fill, and an out-of-scope
    // ticket can acquire one. Pinned so the two rules cannot be tidied into
    // looking alike.
    expect(violations(watched({ verdict: "out-of-scope" }))).toEqual([]);
  });

  it("refuses a payload that claims both", () => {
    // Two answers, not a strong opinion. Left unchecked the cheap field drifts
    // into being a hedge on the expensive one, and the ticket ends up both
    // queued for a solve and subscribed to a watch.
    const both = payload({
      verdict: "ready-ish",
      labels: ["dor:pass", "route:ours", "agent:solvable", "agent:watching"],
      agentFitness: solvable({ plausible: true, blockers: [] }),
    });

    expect(violations(both).join(" ")).toContain("has not made the call");
  });

  it("refuses a watch with no blockers", () => {
    // The blockers are the exit condition, not the explanation. Without them
    // there is nothing a reporter could do to end the subscription.
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
    // The direction that costs money: a ticket body talking the skill into a
    // recurring re-triage charge nobody asked for.
    expect(violations(watched({ agentFitness: fitness() })).join(" ")).toContain(
      "a paid watch list the assessment did not ask for",
    );
  });

  it("reads labels rather than the delta, like every other label check here", () => {
    // Same reason as `agent:solvable`: §11's delta holds only labels not
    // already on the issue, so the second run over a watched ticket omits it
    // legitimately. A gate keyed on the delta would fire hardest on the runs
    // least deserving of it.
    expect(
      violations(watched({ mutation: mutation({ labelsAdd: [], commentAction: "update" }) })),
    ).toEqual([]);
  });

  it("lets triage retire its own agent:watching", () => {
    // The unsubscribe half of §7c, and the reason `agent:watching` had to join
    // TRIAGE_OWNED_AGENT_LABELS rather than only be writable.
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
    // A run costs real money. Sending the operator round the loop once per
    // problem would be miserly with the wrong resource.
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
