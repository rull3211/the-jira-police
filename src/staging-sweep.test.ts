import { describe, expect, it } from "vitest";

import { classify, planSweep, type StagingEntry } from "./staging-sweep.ts";

describe("classify", () => {
  it("recognises a skill root and each of the two named passes", () => {
    expect(classify("SSX-1234-skill-a1b2c3")).toBe("skill-root");
    expect(classify("SSX-1234-merge-skill-a1b2c3")).toBe("skill-root");
    expect(classify("SSX-1234-review-skill-a1b2c3")).toBe("skill-root");
  });

  it("recognises a staged-image directory", () => {
    expect(classify("SSX-1234-img-a1b2c3")).toBe("image-stage");
  });

  it("never matches a bare issue key, which is a live git worktree", () => {
    expect(classify("SSX-1234")).toBeNull();
    expect(classify("SSXADVISOR-99")).toBeNull();
  });

  it("never matches a salvaged worktree", () => {
    // `salvageWorktree` (`solve/worktree.ts`) names its output
    // `<issueKey>-salvaged-<ISO timestamp, colons and dots flattened>`.
    expect(classify("SSX-1234-salvaged-2026-09-18T12-00-00-000Z")).toBeNull();
  });

  it("never matches a name outside the two shapes this codebase produces", () => {
    expect(classify("notes")).toBeNull();
    expect(classify(".DS_Store")).toBeNull();
    expect(classify("ssx-1234-skill-a1b2c3")).toBeNull(); // lowercase issue key: not a real one
    expect(classify("SSX-1234-skill-")).toBeNull(); // no random suffix: not a real mkdtemp result
    expect(classify("SSX-1234-skill-a1/../b")).toBeNull();
  });
});

describe("planSweep", () => {
  const HOUR = 3_600_000;
  const NOW = 1_000_000_000_000;
  const MAX_AGE_MS = 24 * HOUR;

  function entry(name: string, ageMs: number): StagingEntry {
    return { name, mtimeMs: NOW - ageMs };
  }

  it("drops anything classify does not recognise, live worktrees included", () => {
    const verdicts = planSweep(
      [entry("SSX-1234", 1000 * HOUR), entry("notes", 1000 * HOUR)],
      NOW,
      MAX_AGE_MS,
    );
    expect(verdicts).toHaveLength(0);
  });

  it("keeps a matching entry younger than the threshold", () => {
    const [verdict] = planSweep([entry("SSX-1234-skill-a1b2c3", HOUR)], NOW, MAX_AGE_MS);
    expect(verdict?.sweep).toBe(false);
  });

  it("sweeps a matching entry at least as old as the threshold", () => {
    const [verdict] = planSweep([entry("SSX-1234-img-a1b2c3", MAX_AGE_MS)], NOW, MAX_AGE_MS);
    expect(verdict?.sweep).toBe(true);
    expect(verdict?.kind).toBe("image-stage");
  });

  it("draws the boundary at exactly maxAgeMs, not a millisecond either side", () => {
    const [justUnder] = planSweep(
      [entry("SSX-1234-skill-a1b2c3", MAX_AGE_MS - 1)],
      NOW,
      MAX_AGE_MS,
    );
    const [justOver] = planSweep([entry("SSX-1234-skill-a1b2c3", MAX_AGE_MS + 1)], NOW, MAX_AGE_MS);
    expect(justUnder?.sweep).toBe(false);
    expect(justOver?.sweep).toBe(true);
  });
});
