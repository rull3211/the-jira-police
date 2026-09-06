import { describe, expect, it } from "vitest";

import type { TriagePayload } from "../triage/runner.ts";
import { syntheticTicket } from "../triage/single.ts";
import type { WatchDecision } from "../watch/decide.ts";
import { describeDecision, describeRetriage, watchKey, watchWrites } from "./watch-args.ts";

function retriagePayload(): TriagePayload {
  return {
    verdict: "ready-ish",
    labels: ["dor:pass"],
    dorPlaceholders: [],
    recommendedNextStep: "Solve it.",
    report: "# ✅ ACCEPT",
    mutation: {
      commentBody: "body",
      labelsAdd: [],
      labelsRemove: [],
      component: "",
      links: [],
      commentAction: "update",
    },
    agentFitness: {
      solvable: true,
      plausible: false,
      confidence: "high",
      repo: "buy-insurance-advisor-web",
      rationale: "the baseline arrived",
      blockers: [],
    },
  };
}

describe("watchKey", () => {
  it("reads one issue key", () => {
    expect(watchKey(["SSX-1234"])).toBe("SSX-1234");
  });

  it("reads no key as a sweep of the whole queue", () => {
    expect(watchKey([])).toBeNull();
  });

  it.each(["--write", "-v", "--dry-run"])("does not read %s as an issue key", (flag) => {
    // The one that matters on the day `--write` lands: read as a key, it would
    // look up a ticket called `--write`, find nothing, and report a clean sweep
    // — a typo that produces a plausible-looking success.
    expect(watchKey([flag])).toBeNull();
  });

  it("still finds the key beside a flag", () => {
    expect(watchKey(["--write", "SSX-1234"])).toBe("SSX-1234");
    expect(watchKey(["SSX-1234", "--write"])).toBe("SSX-1234");
  });

  it("refuses two keys rather than picking one", () => {
    // Taking the first and saying nothing would read as having looked at both,
    // which is the whole class of defect this repository is about.
    expect(() => watchKey(["SSX-1", "SSX-2"])).toThrow(/at most one issue key/);
  });
});

describe("watchWrites", () => {
  it("is off unless the flag is typed", () => {
    expect(watchWrites([])).toBe(false);
    expect(watchWrites(["SSX-1234"])).toBe(false);
  });

  it("is on with the flag, in either position", () => {
    expect(watchWrites(["--write"])).toBe(true);
    expect(watchWrites(["SSX-1234", "--write"])).toBe(true);
    expect(watchWrites(["--write", "SSX-1234"])).toBe(true);
  });

  it("refuses the name the flag used to have", () => {
    // The one an operator's fingers already know. Read as a dry run it would
    // report a clean sweep over tickets it declined to touch, which is the
    // divergence the rename was made to close arriving through the rename.
    expect(() => watchWrites(["--unsubscribe"])).toThrow(/--unsubscribe is now --write/);
  });

  it.each(["--wrote", "--Write", "-write", "--dry-run"])(
    "refuses %s rather than guessing",
    (flag) => {
      // Not "reads as the dry run": a near miss is a typo, and a typo that
      // silently picks the safe branch is indistinguishable from a run that had
      // nothing to do. Refusing says which of the two happened.
      expect(() => watchWrites([flag])).toThrow(/does not know/);
    },
  );

  it("still takes a bare key", () => {
    // The positional must not be read as an unknown flag; `write` without
    // dashes is a key-shaped argument and `watchKey` is what refuses it.
    expect(watchWrites(["SSX-1234"])).toBe(false);
    expect(watchWrites(["write"])).toBe(false);
  });
});

describe("describeRetriage", () => {
  it("names the attempt it spent, because that number is the brake", () => {
    const line = describeRetriage({
      kind: "retriaged",
      count: 2,
      reason: "the baseline is now stated",
      ticket: syntheticTicket("SSX-1234", "https://example.atlassian.net"),
      payload: retriagePayload(),
    });

    expect(line).toContain("attempt 2");
    expect(line).toContain("ready-ish");
    expect(line).toContain("the baseline is now stated");
  });

  it("gives each refusal its own words rather than one shared skip", () => {
    // The three are *nobody answered*, *the counter is broken* and *Jira would
    // not take the write*, and they are the difference between a watch working
    // as designed and one that has quietly stopped counting. Collapse them and
    // a sweep reads the same either way.
    const lines = [
      describeRetriage({ kind: "irrelevant", reason: "it only promises the logs" }),
      describeRetriage({ kind: "unreserved", error: "Jira said 403" }),
      describeRetriage({ kind: "uncountable" }),
      describeRetriage({ kind: "no-mark" }),
    ];

    expect(new Set(lines).size).toBe(4);
    expect(lines[0]).toContain("it only promises the logs");
    expect(lines[1]).toContain("Jira said 403");
  });

  it("says a refusal is a refusal on every one of them", () => {
    // The line sits under a `RETRIAGE` heading that says money was about to be
    // spent. A follow-up that does not say it was not spent reads as a receipt.
    for (const outcome of [
      { kind: "irrelevant", reason: "r" },
      { kind: "unreserved", error: "e" },
      { kind: "uncountable" },
      { kind: "no-mark" },
    ] as const) {
      expect(describeRetriage(outcome)).toContain("no re-triage");
    }
  });
});

describe("describeDecision", () => {
  it("names the trigger and its time on a re-triage", () => {
    const decision: WatchDecision = {
      kind: "retriage",
      trigger: "description was edited",
      at: "2026-09-02T09:00:00.000+0200",
    };

    expect(describeDecision("SSX-1234", decision)).toBe(
      "RETRIAGE  SSX-1234  description was edited at 2026-09-02T09:00:00.000+0200",
    );
  });

  it("carries the reason on a drop, since that is the line a human has to act on", () => {
    const decision: WatchDecision = {
      kind: "unsubscribe",
      reason: "uncountable",
      note: "no comment this service wrote",
    };

    expect(describeDecision("SSX-1234", decision)).toContain("uncountable");
    expect(describeDecision("SSX-1234", decision)).toContain("no comment this service wrote");
  });

  it("keeps a quiet ticket to one scannable line", () => {
    expect(describeDecision("SSX-1234", { kind: "quiet" })).toBe("quiet     SSX-1234");
  });

  it("lines up the three prefixes so a sweep reads as a table", () => {
    const widths = [
      describeDecision("SSX-1", { kind: "retriage", trigger: "t", at: "a" }),
      describeDecision("SSX-1", { kind: "unsubscribe", reason: "closed", note: "n" }),
      describeDecision("SSX-1", { kind: "quiet" }),
    ].map((line) => line.indexOf("SSX-1"));

    expect(new Set(widths).size).toBe(1);
  });
});
