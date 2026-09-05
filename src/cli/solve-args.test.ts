import { describe, expect, it } from "vitest";

import { PHASES, includes, parseSolveArgs, rank, unavailable, writes } from "./solve-args.ts";

/**
 * The ladder invocation, or a failure that names what went wrong.
 *
 * `mode` is dropped rather than asserted, so the tests below stay pairs of key
 * and phase. The mode itself is not unchecked — asking for it here and getting
 * `advance` throws, which is what makes `parsed(["SSX-3822", "--advance"])`
 * a failing test rather than a quietly different shape.
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
    // The single-ticket dry run is still a dry run. Naming a ticket narrows what
    // is reported; it must not by itself grant anything.
    expect(parsed(["SSX-3822"])).toEqual({ issueKey: "SSX-3822", phase: "plan" });
  });

  it.each([
    ["--claim", "claim"],
    ["--solve", "solve"],
    ["--pr", "pr"],
  ])("%s selects the %s phase", (flag, phase) => {
    expect(parsed(["SSX-3822", flag]).phase).toBe(phase);
  });

  it("takes the highest phase when several are given", () => {
    // `--claim --pr` has one coherent reading, and it is not "claim".
    expect(parsed(["SSX-3822", "--claim", "--pr"]).phase).toBe("pr");
    expect(parsed(["SSX-3822", "--pr", "--claim"]).phase).toBe("pr");
  });

  it("does not care where the flag sits relative to the key", () => {
    expect(parsed(["--solve", "SSX-3822"])).toEqual({ issueKey: "SSX-3822", phase: "solve" });
  });

  it.each(["--claim", "--solve", "--pr"])("refuses %s with no issue key", (flag) => {
    // THE ONE THAT MATTERS. Without this, `solve:once --pr` means "open a pull
    // request for every ticket in the queue" — an unbounded write, from a
    // command line one character shorter than the safe one, typed by someone
    // who is by definition still experimenting.
    expect(error([flag])).toContain("needs an issue key");
    expect(error([flag])).toContain("every ticket in the queue");
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    // Ignoring errs toward less privilege today, which is why it is tempting.
    // The failure it sets up is a flag added later that this parser silently
    // drops, leaving an operator watching it do nothing with no way to tell.
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
    // There is no such flag and there never was. Accepting it would let someone
    // believe they had asked for something.
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
    // The mode is a fork, not a default. A run without the flag must still be a
    // ladder run, or every existing caller changes meaning.
    expect(parsed(["SSX-3822"])).toEqual({ issueKey: "SSX-3822", phase: "plan" });
  });

  it("needs an issue key", () => {
    // Same shape of refusal as the rungs, different consequence: a keyless
    // advance would push a commit to every open pull request the queue knows
    // about, on pull requests people are in the middle of reading.
    expect(error(["--advance"])).toContain("needs an issue key");
    expect(error(["--advance"])).toContain("every open pull request");
  });

  it.each(["--claim", "--solve", "--pr"])("refuses to be combined with %s", (flag) => {
    // Refused rather than resolved. The two available guesses — solve then
    // advance, or advance and drop the solve — differ by a paid model pass and
    // a push, so neither is a reading the parser is entitled to pick.
    const reason = error(["SSX-3822", flag, "--advance"]);
    expect(reason).toContain("cannot be combined");
    expect(reason).toContain(flag);
  });

  it("refuses the combination whichever order it is typed in", () => {
    expect(error(["SSX-3822", "--advance", "--pr"])).toContain("cannot be combined");
  });

  it("reports the missing key before the ladder's own keyless refusal", () => {
    // `--pr --advance` with no key breaks two rules at once. The combination is
    // the one to report: an operator told "--pr needs an issue key" would supply
    // one and hit the real refusal on the next attempt, having learned nothing.
    expect(error(["--pr", "--advance"])).toContain("cannot be combined");
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
    // THE ONE THAT MATTERS on this function. An equality check here would skip
    // the claim on a `--pr` run and leave the solver working on a ticket the
    // board shows as unclaimed.
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
    // This block used to assert that the rungs above `plan` refused because
    // nothing had been wired, and it did its job twice: wiring phase C broke it,
    // then wiring B2 and D broke it again, each time forcing the header and the
    // usage text to be corrected in the same change.
    for (const phase of PHASES) {
      expect(unavailable(phase, OWNED)).toBeNull();
    }
  });

  it("refuses the pull request rung when no GitHub owner is configured", () => {
    // The setting has no fallback on purpose. Without this check the failure
    // arrives from `buildPublishRequest` — after the ticket has been claimed and
    // the solver has run.
    expect(unavailable("pr", { SOLVE_GITHUB_OWNER: "" })).toContain("SOLVE_GITHUB_OWNER");
  });

  it("treats whitespace as unset", () => {
    expect(unavailable("pr", { SOLVE_GITHUB_OWNER: "   " })).toBeTruthy();
  });

  it("does not refuse the rungs that do not need an owner", () => {
    // A missing GitHub owner must not stop a claim or a solve. Both are useful
    // on their own, and neither goes near GitHub.
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
    // `unavailable` and `writes` used to be required to agree, on the grounds
    // that every writing phase was also unwired. Wiring `--solve` separated
    // them: it writes — to a worktree — and is available. The property worth
    // keeping is the parser's, and it is unchanged.
    for (const phase of PHASES) {
      expect(writes(phase)).toBe(phase !== "plan");
    }
    expect(parseSolveArgs(["--solve"]).ok).toBe(false);
  });
});
