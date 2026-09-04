import { describe, expect, it } from "vitest";

import { USAGE, parseBotArgs } from "./bot-args.ts";

/** The invocation, or a thrown assertion — so every test below reads as one line. */
function ok(argv: readonly string[]): { issueKey: string | null; phase: string } {
  const parsed = parseBotArgs(argv);
  if (!parsed.ok) {
    throw new Error(`expected a parse, got: ${parsed.error}`);
  }
  return parsed.invocation;
}

function error(argv: readonly string[]): string {
  const parsed = parseBotArgs(argv);
  if (parsed.ok) {
    throw new Error(`expected a refusal, got phase "${parsed.invocation.phase}"`);
  }
  return parsed.error;
}

describe("parseBotArgs", () => {
  it("gives the free rung to a bare issue key", () => {
    expect(ok(["SSX-3822"])).toEqual({ issueKey: "SSX-3822", phase: "plan" });
  });

  it.each([
    ["--claim", "claim"],
    ["--solve", "solve"],
    ["--pr", "pr"],
  ])("reads %s as the %s rung", (flag, phase) => {
    expect(ok(["SSX-3822", flag]).phase).toBe(phase);
  });

  it("takes the highest rung when several are named", () => {
    expect(ok(["SSX-3822", "--claim", "--pr"]).phase).toBe("pr");
    expect(ok(["SSX-3822", "--pr", "--claim"]).phase).toBe("pr");
  });

  it("does not care where the key sits among the flags", () => {
    expect(ok(["--solve", "SSX-3822"])).toEqual({ issueKey: "SSX-3822", phase: "solve" });
  });

  describe("the issue key is required at every rung", () => {
    // The rule this module exists for. `solve:once` with no key runs the whole
    // queue, which is a reasonable thing for a queue command to do. Here the
    // free rung is a paid model call, so "no key" must never degrade into
    // "every ticket" — least of all at --pr, one character from the safe form.
    it.each([[[]], [["--claim"]], [["--solve"]], [["--pr"]]])(
      "refuses %j",
      (argv: readonly string[]) => {
        expect(error(argv)).toContain("an issue key is required");
      },
    );

    it("says so even at the free rung, where nothing would be written", () => {
      // The free rung writes nothing to Jira and still costs a triage run
      // against a ticket nobody named. Refusing only the writing rungs would
      // have made "bot:once" with a typo a silent charge.
      expect(error([])).toContain("one named ticket, not a queue");
    });

    it("does not blame a queue this command does not have", () => {
      // REGRESSION. Delegating to `parseSolveArgs` first meant a keyless --pr
      // was refused with "it would otherwise run against every ticket in the
      // queue" — accurate for `solve:once`, and nonsense printed above a usage
      // block for a command that only ever takes one ticket.
      expect(error(["--pr"])).not.toContain("queue in");
      expect(error(["--pr"])).toContain("an issue key is required");
    });

    it("reports the missing key ahead of an unknown flag", () => {
      // The documented trade in `parseBotArgs`: the precondition wins, and the
      // flag error arrives on the next attempt once a key is supplied.
      expect(error(["--yolo"])).toContain("an issue key is required");
      expect(error(["SSX-3822", "--yolo"])).toBe("unknown flag: --yolo");
    });
  });

  describe("what it inherits rather than redefines", () => {
    it("rejects an unknown flag", () => {
      expect(error(["SSX-3822", "--yolo"])).toBe("unknown flag: --yolo");
    });

    it("rejects a second positional", () => {
      expect(error(["SSX-3822", "SSX-9999"])).toContain("at most one issue key");
    });
  });

  it("documents every rung it accepts", () => {
    // Cheap, and it catches the failure mode where a rung is added to the
    // ladder and the help text keeps describing the old command.
    for (const flag of ["--claim", "--solve", "--pr"]) {
      expect(USAGE).toContain(flag);
    }
  });
});
