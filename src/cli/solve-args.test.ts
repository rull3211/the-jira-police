import { describe, expect, it } from "vitest";

import { PHASES, parseSolveArgs, rank, unavailable, writes } from "./solve-args.ts";

/** The invocation, or a failure that names what went wrong. */
function parsed(argv: readonly string[]): { issueKey: string | null; phase: string } {
  const result = parseSolveArgs(argv);
  if (!result.ok) {
    throw new Error(`expected a parse, got: ${result.error}`);
  }
  return result.invocation;
}

function error(argv: readonly string[]): string {
  const result = parseSolveArgs(argv);
  if (result.ok) {
    throw new Error(`expected a refusal, got phase ${result.invocation.phase}`);
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

describe("unavailable", () => {
  it("lets the dry run through", () => {
    expect(unavailable("plan")).toBeNull();
  });

  it("blocks every phase that would write, so far", () => {
    // The inertness the plan promises, asserted rather than described. When a
    // phase is wired this test is what forces the claim in the header to be
    // updated in the same change — which is the whole habit this repo is built
    // around.
    for (const phase of PHASES.filter((candidate) => candidate !== "plan")) {
      expect(unavailable(phase)).toBeTruthy();
    }
  });

  it("names the missing wiring rather than saying no", () => {
    // An operator who types `--claim` and reads "refused" learns nothing. One
    // who reads which module is missing can check the claim themselves.
    expect(unavailable("claim")).toContain("B2");
    expect(unavailable("solve")).toContain("orchestrator.ts");
    expect(unavailable("pr")).toContain("delivery.ts");
  });

  it("agrees with `writes` about which phases are dangerous", () => {
    // Two lists that must stay in step: one decides what the parser demands an
    // issue key for, the other decides what refuses to run. They are derived
    // from the same ordering, and this is the assertion that keeps a future
    // phase from being added to one and forgotten in the other.
    for (const phase of PHASES) {
      expect(unavailable(phase) !== null).toBe(writes(phase));
    }
  });
});
