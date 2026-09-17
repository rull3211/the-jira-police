import { describe, expect, it } from "vitest";

import type { Settings } from "../settings.ts";
import type { AgentFitness } from "../triage/runner.ts";
import { shouldPost } from "../wiring.ts";
import { fitnessRefusal, resolveSettings } from "./bot-once.ts";

/** A configuration that has been told to post — the dangerous starting point. */
const WRITE_ENABLED = { SKILL_NAME: "intake-triage", WRITE_BACK: "true" } as unknown as Settings;

function fitness(overrides: Partial<AgentFitness> = {}): AgentFitness {
  return {
    solvable: true,
    plausible: false,
    confidence: "high",
    repo: "buy-insurance-advisor-web",
    rationale: "one file, an existing test to extend",
    blockers: [],
    ...overrides,
  };
}

describe("resolveSettings", () => {
  it("does not post at the free rung, whatever .env says", () => {
    const settings = resolveSettings("plan", WRITE_ENABLED);

    expect(settings.WRITE_BACK).toBe("false");
    expect(shouldPost(settings)).toBe(false);
  });

  it.each(["claim", "solve", "pr"] as const)("posts at the %s rung", (phase) => {
    const settings = resolveSettings(phase, { ...WRITE_ENABLED, WRITE_BACK: "false" });

    expect(shouldPost(settings)).toBe(true);
  });

  it("changes nothing else about the settings", () => {
    const settings = resolveSettings("plan", WRITE_ENABLED);

    expect(settings.SKILL_NAME).toBe("intake-triage");
  });
});

describe("fitnessRefusal", () => {
  it("lets a solvable ticket through", () => {
    expect(fitnessRefusal(fitness())).toBeNull();
  });

  it("stops an unsolvable one and says who decided", () => {
    const refusal = fitnessRefusal(
      fitness({ solvable: false, confidence: "low", blockers: ["no acceptance criteria"] }),
    );

    expect(refusal).toContain("not agent-solvable");
    expect(refusal).toContain("confidence: low");
  });

  it("lists every blocker, because one of them is the thing to fix", () => {
    const refusal = fitnessRefusal(
      fitness({ solvable: false, blockers: ["no acceptance criteria", "repo unknown"] }),
    );

    expect(refusal).toContain("no acceptance criteria");
    expect(refusal).toContain("repo unknown");
  });

  it("carries the rationale, not just the verdict", () => {
    // Blockers say what's missing; the rationale says what the model made of the ticket.
    const refusal = fitnessRefusal(
      fitness({ solvable: false, rationale: "the ticket describes three separate faults" }),
    );

    expect(refusal).toContain("three separate faults");
  });

  it("names an empty blocker list as a gap rather than printing nothing", () => {
    const refusal = fitnessRefusal(fitness({ solvable: false, blockers: [] }));

    expect(refusal).toContain("none listed");
    expect(refusal).toContain("a refusal owes a reason");
  });
});
