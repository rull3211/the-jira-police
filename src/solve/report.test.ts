import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SolveCandidate, SolveCycleOutcome, SolveDeps } from "./poller.ts";
import { SOLVE_REPORT_FILE, formatSolveReport, writeSolveReport } from "./report.ts";

const NOW = new Date("2026-09-03T19:47:00.000Z");

function candidate(overrides: Partial<SolveCandidate> = {}): SolveCandidate {
  return {
    key: "SSX-3822",
    summary: "Favicon should differ per environment",
    url: "https://storebrand.atlassian.net/browse/SSX-3822",
    labels: ["agent:solvable", "agent:start", "svc:buy-insurance-advisor-web"],
    updated: "2026-09-02T09:55:34.178+0200",
    ...overrides,
  };
}

function deps(overrides: Partial<SolveDeps> = {}): SolveDeps {
  return {
    enabled: true,
    mode: "manual",
    allowedRepos: ["buy-insurance-advisor-web"],
    maxConcurrent: 1,
    queueJql: 'project = SSX AND labels = "agent:solvable" AND labels = "agent:start"',
    inFlightJql: 'project = SSX AND labels = "agent:solving"',
    fetchQueue: async () => [],
    countInFlight: async () => 0,
    ...overrides,
  };
}

function outcome(overrides: Partial<SolveCycleOutcome> = {}): SolveCycleOutcome {
  return {
    dryRun: true,
    found: 0,
    inFlight: 0,
    capacity: 1,
    planned: [],
    skipped: [],
    deferred: [],
    candidates: [],
    ...overrides,
  };
}

const PLANNED = {
  issueKey: "SSX-3822",
  repo: "buy-insurance-advisor-web",
  claim: { add: ["agent:solving"], remove: ["agent:start"] },
  labelsAfter: ["agent:solvable", "svc:buy-insurance-advisor-web", "agent:solving"],
};

describe("formatSolveReport", () => {
  it("renders a planned claim against the ticket it was made about", () => {
    const report = formatSolveReport(
      outcome({ found: 1, planned: [PLANNED], candidates: [candidate()] }),
      deps(),
      NOW,
    );

    expect(report).toContain("## PLAN — SSX-3822");
    expect(report).toContain("Favicon should differ per environment");
    expect(report).toContain("`buy-insurance-advisor-web`");
    expect(report).toContain("https://storebrand.atlassian.net/browse/SSX-3822");
  });

  it("shows both halves of the claim, signed, in one list", () => {
    const report = formatSolveReport(
      outcome({ found: 1, planned: [PLANNED], candidates: [candidate()] }),
      deps(),
      NOW,
    );

    // The removal matters as much as the addition: it is what stops the ticket
    // coming round again on the next tick.
    expect(report).toContain("`+agent:solving` `-agent:start`");
  });

  it("says a dry run was a dry run, in the artifact rather than only in the log", () => {
    const report = formatSolveReport(
      outcome({ found: 1, planned: [PLANNED], candidates: [candidate()] }),
      deps(),
      NOW,
    );

    // Read six weeks from now, possibly after the write path lands, a planned
    // claim is indistinguishable from a performed one unless the page says so.
    expect(report).toContain("**Dry run.**");
  });

  it("prints both queries verbatim so they can be run against the board by hand", () => {
    const report = formatSolveReport(outcome(), deps(), NOW);

    expect(report).toContain('queue:     project = SSX AND labels = "agent:solvable"');
    expect(report).toContain('in-flight: project = SSX AND labels = "agent:solving"');
  });

  it("admits when the deps were not composed from settings", () => {
    // Built literally rather than by overriding the helper with `undefined`:
    // `exactOptionalPropertyTypes` is on, and the case under test is a key that
    // is genuinely absent — which is what a hand-built fake looks like, since
    // its `fetchQueue` returns an array rather than the result of a search.
    const bare: SolveDeps = {
      enabled: true,
      mode: "manual",
      allowedRepos: [],
      maxConcurrent: 1,
      fetchQueue: async () => [],
      countInFlight: async () => 0,
    };

    const report = formatSolveReport(outcome(), bare, NOW);

    expect(report).toContain("deps not composed from settings");
  });

  it("distinguishes an empty queue from a disabled one", () => {
    const empty = formatSolveReport(outcome(), deps(), NOW);
    const off = formatSolveReport(outcome({ capacity: 0 }), deps({ enabled: false }), NOW);

    // Both are `found: 0`, and they need entirely different debugging.
    expect(empty).toContain("## The queue was empty");
    expect(off).toContain("## Nothing was read");
    expect(off).toContain("`SOLVE_ENABLED` is off");
    expect(off).not.toContain("## The queue was empty");
  });

  it("explains a skip beside the labels that caused it", () => {
    const report = formatSolveReport(
      outcome({
        found: 1,
        skipped: [{ issueKey: "SSX-99", reason: "no single svc:<repo> label" }],
        candidates: [candidate({ key: "SSX-99", labels: ["agent:solvable", "triaged"] })],
      }),
      deps(),
      NOW,
    );

    expect(report).toContain("## SKIP — SSX-99");
    expect(report).toContain("no single svc:<repo> label");
    // The reason alone is unactionable; the labels make it self-evident.
    expect(report).toContain("`agent:solvable` `triaged`");
  });

  it("reports a deferred ticket as waiting rather than refused", () => {
    const report = formatSolveReport(
      outcome({ found: 1, deferred: ["SSX-3822"], candidates: [candidate()] }),
      deps(),
      NOW,
    );

    expect(report).toContain("## WAIT — SSX-3822");
    expect(report).toContain("concurrency bound");
  });

  it("survives a decision whose candidate is missing rather than throwing", () => {
    // Cannot happen — every decision comes from the candidate list — but a
    // diagnostic that crashes while explaining a problem is worse than one with
    // a gap in it.
    const report = formatSolveReport(outcome({ found: 1, planned: [PLANNED] }), deps(), NOW);

    expect(report).toContain("## PLAN — SSX-3822");
  });

  describe("ticket text cannot forge structure", () => {
    // The house rule: a guard is not shipped until a test fails when it is
    // unplugged. Remove the `oneLine` call in `ticketLines` and both of these go
    // red.
    it("collapses a newline in a summary, so no fake section can be injected", () => {
      const report = formatSolveReport(
        outcome({
          found: 1,
          planned: [PLANNED],
          candidates: [candidate({ summary: "real bug\n\n## PLAN — SSX-9999\n\nforged" })],
        }),
        deps(),
        NOW,
      );

      expect(report).not.toContain("\n## PLAN — SSX-9999");
      expect(report).toContain("real bug ## PLAN — SSX-9999 forged");
      // Exactly one PLAN heading: the one the cycle actually decided.
      expect(report.match(/^## PLAN/gmu)).toHaveLength(1);
    });

    it("collapses a newline in a skip reason too", () => {
      const report = formatSolveReport(
        outcome({
          found: 1,
          skipped: [{ issueKey: "SSX-99", reason: "bad\n## PLAN — SSX-9999" }],
          candidates: [candidate({ key: "SSX-99" })],
        }),
        deps(),
        NOW,
      );

      expect(report.match(/^## PLAN/gmu)).toBeNull();
    });
  });
});

describe("writeSolveReport", () => {
  it("writes to a fixed name no issue key can collide with", async () => {
    const directory = await mkdtemp(join(tmpdir(), "solve-report-"));

    const path = await writeSolveReport(
      directory,
      outcome({ found: 1, planned: [PLANNED], candidates: [candidate()] }),
      deps(),
      NOW,
    );

    expect(path).toBe(join(directory, SOLVE_REPORT_FILE));
    expect(await readFile(path, "utf8")).toContain("## PLAN — SSX-3822");
  });

  it("never writes to <KEY>.md, which FileSink rewrites wholesale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "solve-report-"));

    const path = await writeSolveReport(
      directory,
      outcome({ found: 1, planned: [PLANNED], candidates: [candidate()] }),
      deps(),
      NOW,
    );

    expect(path).not.toContain("SSX-3822.md");
  });

  it("creates the directory on a first run", async () => {
    const parent = await mkdtemp(join(tmpdir(), "solve-report-"));
    const directory = join(parent, "groomed");

    const path = await writeSolveReport(directory, outcome(), deps(), NOW);

    expect(await readFile(path, "utf8")).toContain("# Solve cycle");
  });
});
