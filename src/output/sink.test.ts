import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentFitness } from "../triage/runner.ts";
import { FileSink, formatAgentFitness, type TriageResult } from "./sink.ts";

function fitness(overrides: Partial<AgentFitness> = {}): AgentFitness {
  return {
    solvable: false,
    plausible: false,
    confidence: "low",
    repo: "",
    rationale: "The baseline is unfilled, so there is nothing to verify against.",
    blockers: ["DoR placeholder [N] never filled"],
    ...overrides,
  };
}

function result(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    issueKey: "SSX-3822",
    issueUrl: "https://storebrand.atlassian.net/browse/SSX-3822",
    summary: "Favicon should differ per environment",
    verdict: "needs-info",
    labels: ["dor:gaps", "route:ours"],
    recommendedNextStep: "Send back to the reporter.",
    report: "## the report body",
    agentFitness: fitness(),
    ...overrides,
  };
}

async function writeToTemp(input: TriageResult): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jira-police-sink-"));
  await new FileSink(directory).write(input);
  return await readFile(join(directory, `${input.issueKey}.md`), "utf8");
}

describe("formatAgentFitness", () => {
  it("reports a negative call with its reasoning, not just the verdict", () => {
    // The point of shipping the assessment before anything acts on it is to
    // measure how often it is right. A bare "no" cannot be marked wrong.
    const lines = formatAgentFitness(fitness()).join("\n");

    expect(lines).toContain("— no");
    expect(lines).toContain("confidence: low");
    expect(lines).toContain("DoR placeholder [N] never filled");
    expect(lines).toContain("nothing to verify against");
  });

  it("reports a positive call with the repo the fix would land in", () => {
    const lines = formatAgentFitness(
      fitness({
        solvable: true,
        plausible: false,
        confidence: "high",
        repo: "buy-insurance-advisor-web",
        rationale: "Single-file build-time change with a testable AC.",
        blockers: [],
      }),
    ).join("\n");

    expect(lines).toContain("🤖 yes");
    expect(lines).toContain("confidence: high");
    expect(lines).toContain("`buy-insurance-advisor-web`");
  });

  it("omits the repo line when no repo was named", () => {
    // Routinely empty on a "no", where printing an empty field teaches nothing.
    expect(formatAgentFitness(fitness({ repo: "" })).join("\n")).not.toContain("**Repo:**");
  });

  it("renders empty blockers and rationale as a dash rather than blank", () => {
    const lines = formatAgentFitness(fitness({ rationale: "", blockers: [] })).join("\n");

    expect(lines).toContain("**Rationale:** —");
    expect(lines).toContain("**Blockers:** —");
  });

  it("joins multiple blockers readably", () => {
    const lines = formatAgentFitness(fitness({ blockers: ["no repo named", "AC not testable"] }));

    expect(lines.join("\n")).toContain("no repo named; AC not testable");
  });

  it("prints the watch on a no, whichever way it went", () => {
    // Both halves, for the reason the "no" is printed at all: the miss this
    // report exists to make visible is a ticket that was nearly solvable and
    // was never looked at again, and you cannot spot that pattern without the
    // declines beside the subscriptions.
    expect(formatAgentFitness(fitness({ plausible: true })).join("\n")).toContain(
      "**Nearly solvable:** 👀 yes — watching",
    );
    expect(formatAgentFitness(fitness({ plausible: false })).join("\n")).toContain(
      "**Nearly solvable:** — no",
    );
  });

  it("omits the watch line on a yes, where it could only ever say no", () => {
    // The gate forbids both being true, so the line would be a constant — and
    // a constant in a report is a line a reader learns to skip past.
    expect(formatAgentFitness(fitness({ solvable: true, blockers: [] })).join("\n")).not.toContain(
      "Nearly solvable",
    );
  });
});

describe("FileSink", () => {
  it("carries the fitness call all the way to disk", async () => {
    // REGRESSION. `TriageResult` stopped at `report`, so the assessment was
    // computed, gated, and then dropped before the artifact was written. The
    // only surviving trace was whether `agent:solvable` appeared in `labels` —
    // the conclusion with the reasoning stripped off, which makes a wrong call
    // and a right one indistinguishable after the fact.
    const body = await writeToTemp(result());

    expect(body).toContain("## Agent fitness");
    expect(body).toContain("DoR placeholder [N] never filled");
  });

  it("still writes the verdict, labels and report around it", async () => {
    const body = await writeToTemp(result());

    expect(body).toContain("# SSX-3822 — Favicon should differ per environment");
    expect(body).toContain("🟨 needs-info");
    expect(body).toContain("dor:gaps, route:ours");
    expect(body).toContain("## the report body");
  });

  it("keeps the fitness block out of the report body", async () => {
    // The report is the skill's own rendered comment and is posted verbatim to
    // Jira. Fitness is a local observation about that comment, so it belongs
    // above the rule, never spliced into the text that reaches the ticket.
    const body = await writeToTemp(result());
    const fitnessAt = body.indexOf("## Agent fitness");
    const reportAt = body.indexOf("## the report body");

    // Both asserted present first: `indexOf` returns -1 when missing, and -1 is
    // less than any real offset, so an ordering check on its own quietly passes
    // when the block it is ordering has been dropped entirely.
    expect(fitnessAt).toBeGreaterThan(-1);
    expect(reportAt).toBeGreaterThan(-1);
    expect(fitnessAt).toBeLessThan(reportAt);
  });
});
