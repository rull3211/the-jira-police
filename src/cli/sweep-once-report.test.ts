import { describe, expect, it } from "vitest";

import type { SweepGroup } from "../sweep.ts";
import { formatReport } from "./sweep-once-report.ts";

const NOW = new Date("2026-09-18T08:30:00.000Z");

function group(overrides: Partial<SweepGroup> = {}): SweepGroup {
  return { parentDirectory: "/tmp/jira-police-solve", verdicts: [], ...overrides };
}

describe("formatReport", () => {
  it("says would remove in a dry run and removed once write is true", () => {
    const groups = [
      group({
        verdicts: [
          { name: "SSX-1-skill-a1b2c3", mtimeMs: 0, kind: "skill-root", ageMs: 90_000_000, sweep: true },
        ],
      }),
    ];

    expect(formatReport(groups, false, NOW)).toContain("would remove — skill-root");
    expect(formatReport(groups, true, NOW)).toContain("removed — skill-root");
  });

  it("says a young match is kept, not removed", () => {
    const groups = [
      group({
        verdicts: [
          { name: "SSX-1-img-a1b2c3", mtimeMs: 0, kind: "image-stage", ageMs: 1000, sweep: false },
        ],
      }),
    ];

    expect(formatReport(groups, false, NOW)).toContain("keeping (too young) — image-stage");
  });

  it("says a group has nothing to report rather than leaving it blank", () => {
    const report = formatReport([group()], false, NOW);
    expect(report).toContain("Nothing this sweep recognises.");
  });

  it("names the run and the mode", () => {
    const report = formatReport([group()], true, NOW);
    expect(report).toContain("- **Run:** 2026-09-18T08:30:00.000Z");
    expect(report).toContain("write — stale entries removed");
  });
});
