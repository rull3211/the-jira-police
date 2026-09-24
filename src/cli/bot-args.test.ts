import { describe, expect, it } from "vitest";

import { USAGE, parseBotArgs } from "./bot-args.ts";
import { PHASES } from "./solve-args.ts";

/** Every rung flag, derived from the ladder so a new rung can't be added without these tests noticing. */
const RUNG_FLAGS = PHASES.filter((phase) => phase !== "plan").map((phase) => `--${phase}`);

/** The invocation, or a thrown assertion — so every test below reads as one line. */
function ok(argv: readonly string[]): { issueKey: string | null; phase: string } {
  const parsed = parseBotArgs(argv);
  if (!parsed.ok) {
    throw new Error(`expected a parse, got: ${parsed.error}`);
  }
  const { issueKey, phase } = parsed.invocation;
  return { issueKey, phase };
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

  it.each(RUNG_FLAGS)("reads %s as the rung it is named after", (flag) => {
    expect(ok(["SSX-3822", flag]).phase).toBe(flag.slice(2));
  });

  it("takes the highest rung when several are named", () => {
    expect(ok(["SSX-3822", "--claim", "--pr"]).phase).toBe("pr");
    expect(ok(["SSX-3822", "--pr", "--claim"]).phase).toBe("pr");
    expect(ok(["SSX-3822", "--review", "--solve"]).phase).toBe("review");
  });

  it("does not care where the key sits among the flags", () => {
    expect(ok(["--solve", "SSX-3822"])).toEqual({ issueKey: "SSX-3822", phase: "solve" });
  });

  describe("the issue key is required at every rung", () => {
    it.each([[], ...RUNG_FLAGS.map((flag) => [flag])])(
      "refuses %j",
      (...argv: readonly string[]) => {
        expect(error(argv)).toContain("an issue key is required");
      },
    );

    it("says so even at the free rung, where nothing would be written", () => {
      expect(error([])).toContain("one named ticket, not a queue");
    });

    it("does not blame a queue this command does not have", () => {
      expect(error(["--pr"])).not.toContain("queue in");
      expect(error(["--pr"])).toContain("an issue key is required");
    });

    it("reports the missing key ahead of an unknown flag", () => {
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

  describe("--advance is not one of this command's flags", () => {
    it("refuses it rather than ignoring it", () => {
      const reason = error(["SSX-3822", "--advance"]);
      expect(reason).toContain("not a bot:once flag");
      expect(reason).toContain("solve:once");
    });

    it("points at --review, which is what the operator almost always meant", () => {
      expect(error(["SSX-3822", "--advance"])).toContain("--review");
    });

    it("refuses it at every rung it could be combined with", () => {
      for (const flag of RUNG_FLAGS) {
        expect(error(["SSX-3822", flag, "--advance"])).not.toBe("");
      }
    });

    it("does not offer it in the usage text", () => {
      expect(USAGE).not.toContain("--advance");
    });
  });

  describe("--repair is not one of this command's flags", () => {
    it("refuses it on the rungs solve:once would accept it on, rather than dropping it", () => {
      // The shared parser accepts it there; passing the invocation on would read as armed and
      // then solve with it ignored.
      for (const flag of ["--pr", "--review"]) {
        const reason = error(["SSX-3822", flag, "--repair"]);
        expect(reason).toContain("--repair");
        expect(reason).toContain("solve:once");
      }
    });

    it("does not offer it in the usage text", () => {
      expect(USAGE).not.toContain("--repair");
    });
  });

  it("documents every rung it accepts", () => {
    for (const flag of RUNG_FLAGS) {
      expect(USAGE).toContain(flag);
    }
  });
});
