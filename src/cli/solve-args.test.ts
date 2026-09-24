import { describe, expect, it } from "vitest";

import {
  PHASES,
  includes,
  parseSolveArgs,
  rank,
  repairUnavailable,
  unavailable,
  writes,
} from "./solve-args.ts";

/**
 * The ladder invocation, or a failure that names what went wrong.
 *
 * `mode` is checked and dropped rather than asserted, so `parsed(["SSX-3822", "--advance"])`
 * throws instead of quietly returning a different shape.
 */
function parsed(argv: readonly string[]): { issueKey: string | null; phase: string } {
  const result = parseSolveArgs(argv);
  if (!result.ok) {
    throw new Error(`expected a parse, got: ${result.error}`);
  }
  if (result.invocation.mode !== "ladder") {
    throw new Error(`expected a ladder invocation, got ${result.invocation.mode}`);
  }
  const { issueKey, phase } = result.invocation;
  return { issueKey, phase };
}

/**
 * Every flag that names a rung, derived rather than typed out again — a hand-copied list stayed
 * green when `--review` was added while testing nothing about it. `plan` is dropped since it is
 * the absence of a flag, not one.
 */
const RUNG_FLAGS = PHASES.filter((phase) => phase !== "plan").map((phase) => `--${phase}`);

function error(argv: readonly string[]): string {
  const result = parseSolveArgs(argv);
  if (result.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(result.invocation)}`);
  }
  return result.error;
}

describe("parseSolveArgs", () => {
  it("defaults to the whole queue at the lowest phase", () => {
    expect(parsed([])).toEqual({ issueKey: null, phase: "plan" });
  });

  it("takes a bare issue key without escalating", () => {
    // The single-ticket dry run is still a dry run: naming a ticket narrows what's reported, it
    // must not by itself grant anything.
    expect(parsed(["SSX-3822"])).toEqual({ issueKey: "SSX-3822", phase: "plan" });
  });

  it.each(RUNG_FLAGS)("%s selects the phase it is named after", (flag) => {
    expect(parsed(["SSX-3822", flag]).phase).toBe(flag.slice(2));
  });

  it("takes the highest phase when several are given", () => {
    // `--claim --pr` has one coherent reading, and it is not "claim".
    expect(parsed(["SSX-3822", "--claim", "--pr"]).phase).toBe("pr");
    expect(parsed(["SSX-3822", "--pr", "--claim"]).phase).toBe("pr");
    // `--review` is a longer run than `--pr`, not a different one, which is why it ranks highest.
    expect(parsed(["SSX-3822", "--review", "--claim"]).phase).toBe("review");
  });

  it("does not care where the flag sits relative to the key", () => {
    expect(parsed(["--solve", "SSX-3822"])).toEqual({ issueKey: "SSX-3822", phase: "solve" });
  });

  it.each(RUNG_FLAGS)("refuses %s with no issue key", (flag) => {
    // Without this, `solve:once --pr` means "open a pull request for every ticket in the queue."
    expect(error([flag])).toContain("needs an issue key");
    expect(error([flag])).toContain("every ticket in the queue");
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    // Ignoring is tempting since it errs toward less privilege today, but it means a flag added
    // later is silently dropped with no way for the operator to tell.
    expect(error(["SSX-3822", "--yolo"])).toContain("unknown flag: --yolo");
  });

  it("rejects a near-miss rather than treating it as the real flag", () => {
    expect(error(["SSX-3822", "--claims"])).toContain("unknown flag");
  });

  it("rejects two issue keys rather than silently picking one", () => {
    // Which one it picked would decide which repository gets written to.
    expect(error(["SSX-1", "SSX-2", "--pr"])).toContain("at most one issue key");
  });

  it("does not treat --dry-run as a known flag", () => {
    // Accepting it would let someone believe they had asked for something.
    expect(error(["SSX-1", "--dry-run"])).toContain("unknown flag");
  });
});

/** The advance invocation, or a thrown assertion naming what came back instead. */
function advance(argv: readonly string[]): { issueKey: string } {
  const result = parseSolveArgs(argv);
  if (!result.ok) {
    throw new Error(`expected a parse, got: ${result.error}`);
  }
  if (result.invocation.mode !== "advance") {
    throw new Error(`expected an advance invocation, got ${result.invocation.mode}`);
  }
  return { issueKey: result.invocation.issueKey };
}

describe("--advance, the flag that is not a rung", () => {
  it("parses into its own mode rather than a phase", () => {
    expect(advance(["SSX-3822", "--advance"])).toEqual({ issueKey: "SSX-3822" });
  });

  it("does not care where the flag sits relative to the key", () => {
    expect(advance(["--advance", "SSX-3822"])).toEqual({ issueKey: "SSX-3822" });
  });

  it("leaves the ladder at its lowest rung when it is not asked for", () => {
    // The mode is a fork, not a default: a run without the flag must still be a ladder run.
    expect(parsed(["SSX-3822"])).toEqual({ issueKey: "SSX-3822", phase: "plan" });
  });

  it("needs an issue key", () => {
    // Different consequence from the rungs' refusal: a keyless advance would push a commit to
    // every open pull request the queue knows about.
    expect(error(["--advance"])).toContain("needs an issue key");
    expect(error(["--advance"])).toContain("every open pull request");
  });

  it.each(RUNG_FLAGS)("refuses to be combined with %s", (flag) => {
    // Refused rather than resolved: the two guesses (solve then advance, or drop the solve)
    // differ by a paid model pass and a push, so neither is the parser's to pick.
    const reason = error(["SSX-3822", flag, "--advance"]);
    expect(reason).toContain("cannot be combined");
    expect(reason).toContain(flag);
  });

  it("refuses the combination whichever order it is typed in", () => {
    expect(error(["SSX-3822", "--advance", "--pr"])).toContain("cannot be combined");
  });

  it("reports the missing key before the ladder's own keyless refusal", () => {
    // Breaks two rules at once; the combination is reported first, since "needs an issue key"
    // would only lead to hitting the real refusal on the next attempt.
    expect(error(["--pr", "--advance"])).toContain("cannot be combined");
  });
});

/** The watch invocation, or a thrown assertion naming what came back instead. */
function watch(argv: readonly string[]): { issueKey: string | null } {
  const result = parseSolveArgs(argv);
  if (!result.ok) {
    throw new Error(`expected a parse, got: ${result.error}`);
  }
  if (result.invocation.mode !== "watch") {
    throw new Error(`expected a watch invocation, got ${result.invocation.mode}`);
  }
  return { issueKey: result.invocation.issueKey };
}

describe("--watch, the flag that is not a rung and may run bare", () => {
  it("parses into its own mode rather than a phase", () => {
    expect(watch(["SSX-3822", "--watch"])).toEqual({ issueKey: "SSX-3822" });
  });

  it("does not care where the flag sits relative to the key", () => {
    expect(watch(["--watch", "SSX-3822"])).toEqual({ issueKey: "SSX-3822" });
  });

  it("runs bare, and that is the difference from --advance", () => {
    // The opposite of every other keyless test here: a keyless `--advance` is refused because it
    // would push to every open pull request, but a keyless `--watch` only surveys and pays for at
    // most `MAX_REVIEW_ROUNDS_PER_TICK` of them.
    expect(watch(["--watch"])).toEqual({ issueKey: null });
  });

  it("leaves the ladder at its lowest rung when it is not asked for", () => {
    expect(parsed(["SSX-3822"])).toEqual({ issueKey: "SSX-3822", phase: "plan" });
  });

  it.each(RUNG_FLAGS)("refuses to be combined with %s", (flag) => {
    const reason = error(["SSX-3822", flag, "--watch"]);
    expect(reason).toContain("cannot be combined");
    expect(reason).toContain(flag);
  });

  it("refuses to be combined with --advance, in either order", () => {
    // Not an ambiguity refusal — `--advance --watch` reads fine as "watch" — but the two differ
    // by whether the command ever returns.
    expect(error(["SSX-3822", "--advance", "--watch"])).toContain("cannot be combined");
    expect(error(["SSX-3822", "--watch", "--advance"])).toContain("cannot be combined");
  });

  it("reports the combination rather than the ladder's keyless refusal", () => {
    expect(error(["--pr", "--watch"])).toContain("cannot be combined");
  });
});

/** Whether a ladder parse carries `--repair`, or a thrown assertion naming what came back instead. */
function repairs(argv: readonly string[]): boolean {
  const result = parseSolveArgs(argv);
  if (!result.ok) {
    throw new Error(`expected a parse, got: ${result.error}`);
  }
  if (result.invocation.mode !== "ladder") {
    throw new Error(`expected a ladder invocation, got ${result.invocation.mode}`);
  }
  return result.invocation.repair;
}

/** Every rung that opens no pull request, `plan` included — the ones `--repair` has nothing to act through. */
const BELOW_PR = PHASES.filter((phase) => !includes(phase, "pr"));

describe("--repair, the modifier that is not a rung", () => {
  it.each(RUNG_FLAGS)("is off on %s unless it is typed", (flag) => {
    // The plausible wrong design — a rung between `--pr` and `--review` — would make `--review`
    // imply it, since a rung's index is its privilege.
    expect(repairs(["SSX-3822", flag])).toBe(false);
  });

  it.each(["--pr", "--review"])("arms %s without moving the rung", (flag) => {
    expect(repairs(["SSX-3822", flag, "--repair"])).toBe(true);
    expect(parsed(["SSX-3822", flag, "--repair"]).phase).toBe(flag.slice(2));
  });

  it("does not care where the flag sits", () => {
    expect(repairs(["--repair", "SSX-3822", "--pr"])).toBe(true);
  });

  it.each(BELOW_PR)("refuses to arm the %s rung, which opens no pull request", (phase) => {
    const argv =
      phase === "plan" ? ["SSX-3822", "--repair"] : ["SSX-3822", `--${phase}`, "--repair"];
    const reason = error(argv);
    expect(reason).toContain("--repair");
    expect(reason).toContain("--pr");
    // Found by running it: `plan` is the absence of a flag, and the refusal once named `--plan`.
    expect(reason).not.toContain("--plan");
  });

  it("refuses to be combined with --advance or --watch", () => {
    // Both act on a pull request an earlier run opened; there is no repair round in either.
    expect(error(["SSX-3822", "--advance", "--repair"])).toContain("--repair");
    expect(error(["SSX-3822", "--watch", "--repair"])).toContain("--repair");
  });
});

describe("repairUnavailable", () => {
  it("refuses when REPAIR_ROUND=false, since no round would run for it to act on", () => {
    // Otherwise the flag is accepted and silently does nothing — the run reads as armed.
    expect(repairUnavailable({ REPAIR_ROUND: "false" })).toContain("REPAIR_ROUND");
    expect(repairUnavailable({ REPAIR_ROUND: " FALSE " })).toContain("REPAIR_ROUND");
  });

  it("lets it through whenever the round runs, including on a typo", () => {
    // `REPAIR_ROUND` fails open, and this reads it through the same reader rather than a copy.
    for (const value of ["true", "", "fasle"]) {
      expect(repairUnavailable({ REPAIR_ROUND: value })).toBeNull();
    }
  });
});

describe("rank and writes", () => {
  it("orders the phases by privilege", () => {
    expect(rank("plan")).toBeLessThan(rank("claim"));
    expect(rank("claim")).toBeLessThan(rank("solve"));
    expect(rank("solve")).toBeLessThan(rank("pr"));
  });

  it("treats only the default phase as non-writing", () => {
    expect(writes("plan")).toBe(false);
    for (const phase of PHASES.filter((candidate) => candidate !== "plan")) {
      expect(writes(phase)).toBe(true);
    }
  });
});

describe("includes", () => {
  it("makes every rung include itself", () => {
    for (const phase of PHASES) {
      expect(includes(phase, phase)).toBe(true);
    }
  });

  it("makes the pull request rung do the claim and the solve", () => {
    // An equality check here would skip the claim on a `--pr` run, leaving the solver working on
    // a ticket the board shows as unclaimed.
    expect(includes("pr", "claim")).toBe(true);
    expect(includes("pr", "solve")).toBe(true);
  });

  it("does not reach upward", () => {
    expect(includes("claim", "solve")).toBe(false);
    expect(includes("claim", "pr")).toBe(false);
    expect(includes("solve", "pr")).toBe(false);
  });

  it("agrees with writes about the free rung", () => {
    for (const phase of PHASES) {
      expect(includes(phase, "claim")).toBe(writes(phase));
    }
  });
});

/** Settings with an owner configured, which is the only key this module reads. */
const OWNED = { SOLVE_GITHUB_OWNER: "storebrand-digital" };

describe("unavailable", () => {
  it("lets every rung through once the owner is configured", () => {
    for (const phase of PHASES) {
      expect(unavailable(phase, OWNED)).toBeNull();
    }
  });

  it("refuses the pull request rung when no GitHub owner is configured", () => {
    // The setting has no fallback on purpose: without this check, the failure would arrive from
    // `buildPublishRequest` after the ticket was claimed and the solver ran.
    expect(unavailable("pr", { SOLVE_GITHUB_OWNER: "" })).toContain("SOLVE_GITHUB_OWNER");
  });

  it("treats whitespace as unset", () => {
    expect(unavailable("pr", { SOLVE_GITHUB_OWNER: "   " })).toBeTruthy();
  });

  it("does not refuse the rungs that do not need an owner", () => {
    // A missing GitHub owner must not stop a claim or a solve — neither goes near GitHub.
    for (const phase of ["plan", "claim", "solve"] as const) {
      expect(unavailable(phase, { SOLVE_GITHUB_OWNER: "" })).toBeNull();
    }
  });

  it("says what the setting is for rather than only naming it", () => {
    // An operator who reads "SOLVE_GITHUB_OWNER is not set" still has to guess
    // whether it is an org, a user, or `owner/repo`.
    expect(unavailable("pr", { SOLVE_GITHUB_OWNER: "" })).toContain("GitHub account");
  });

  it("still demands an issue key for everything that can change anything", () => {
    // `unavailable` and `writes` no longer have to agree: `--solve` writes to a worktree and is
    // available, so only the parser's own property below still holds.
    for (const phase of PHASES) {
      expect(writes(phase)).toBe(phase !== "plan");
    }
    expect(parseSolveArgs(["--solve"]).ok).toBe(false);
  });
});
