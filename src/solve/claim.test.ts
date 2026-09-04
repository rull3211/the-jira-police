import { describe, expect, it } from "vitest";

import type { SolveMode } from "../settings.ts";
import {
  type ClaimCapabilities,
  type ClaimReceipt,
  type ClaimResult,
  ClaimWriteError,
  type ReleaseResult,
  claimTicket,
  diffLabels,
  releaseClaim,
} from "./claim.ts";
import { AGENT_LABELS } from "./labels.ts";

const KEY = "SSX-3822";

/**
 * The labels SSX-3822 actually carries, plus the two the queue selects on.
 *
 * A real set rather than a minimal one on purpose. Every rule in `claim.ts` is
 * about the labels it is *not* interested in — the ones a full-field write
 * destroys if it gets the arithmetic wrong — and a fixture of two labels cannot
 * catch that. `triaged`, `route:ours` and `dor:pass` are the bystanders.
 */
const APPROVED: readonly string[] = [
  "triaged",
  "route:ours",
  "dor:pass",
  "svc:buy-insurance-advisor-web",
  AGENT_LABELS.solvable,
  AGENT_LABELS.start,
];

/** What `APPROVED` becomes after a claim: start off, solving on, bystanders untouched. */
const CLAIMED: readonly string[] = [
  "triaged",
  "route:ours",
  "dor:pass",
  "svc:buy-insurance-advisor-web",
  AGENT_LABELS.solvable,
  AGENT_LABELS.solving,
];

interface Board {
  /** The ticket's label field, as the fake Jira holds it. */
  labels: readonly string[];
  /** Every capability call in order, so the read/write/read bracket can be asserted. */
  readonly calls: string[];
  readonly writes: (readonly string[])[];
  readonly keys: string[];
  readonly capabilities: ClaimCapabilities;
}

interface BoardHooks {
  /** Runs while a read is in flight, so a racer's edit can land between two reads. */
  readonly onRead?: (call: number, live: Board) => void;
  /**
   * Runs after a read has returned but before the write replaces the field.
   *
   * This is the window §14.11 is about, and the only way to exercise it.
   */
  readonly onBeforeWrite?: (live: Board) => void;
  /** Runs after the field has been replaced, so a racer can overwrite our claim. */
  readonly onWrite?: (call: number, live: Board) => void;
}

/**
 * A fake Jira label field with hooks at each of the three moments that matter.
 *
 * Set semantics on write, exactly as `editJiraIssue` has: the whole field is
 * replaced by whatever is sent. A fake that merged a delta would be testing a
 * write path this service does not have, which is the whole thing the module
 * exists to survive.
 */
function board(initial: readonly string[], hooks: BoardHooks = {}): Board {
  let reads = 0;

  const state: Board = {
    labels: [...initial],
    calls: [],
    writes: [],
    keys: [],
    capabilities: {
      readLabels: async (issueKey) => {
        reads += 1;
        state.calls.push("read");
        state.keys.push(issueKey);
        hooks.onRead?.(reads, state);
        return [...state.labels];
      },
      writeLabels: async (issueKey, labels) => {
        hooks.onBeforeWrite?.(state);
        state.calls.push("write");
        state.keys.push(issueKey);
        state.writes.push([...labels]);
        state.labels = [...labels];
        hooks.onWrite?.(state.writes.length, state);
      },
    },
  };

  return state;
}

/** A board whose read returns something the `readonly string[]` type promised it would not. */
function unreadableBoard(raw: unknown): { capabilities: ClaimCapabilities; writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    writes,
    capabilities: {
      readLabels: async () => raw as readonly string[],
      writeLabels: async (_issueKey, labels) => {
        writes.push(labels);
      },
    },
  };
}

function refusal(result: ClaimResult | ReleaseResult): string {
  if (result.outcome !== "refused") {
    throw new Error(`expected a refusal, got "${result.outcome}"`);
  }
  return result.reason;
}

function receiptOf(result: ClaimResult): ClaimReceipt {
  if (result.outcome !== "claimed") {
    throw new Error(`expected a claim, got "${result.outcome}"`);
  }
  return result.receipt;
}

function unverifiedClaim(result: ClaimResult) {
  if (result.outcome !== "unverified") {
    throw new Error(`expected an unverified claim, got "${result.outcome}"`);
  }
  return result;
}

function unverifiedRelease(result: ReleaseResult) {
  if (result.outcome !== "unverified") {
    throw new Error(`expected an unverified release, got "${result.outcome}"`);
  }
  return result;
}

function request(mode: SolveMode = "manual"): { issueKey: string; mode: SolveMode } {
  return { issueKey: KEY, mode };
}

describe("diffLabels", () => {
  it("names what appeared and what vanished, in that vocabulary", () => {
    expect(diffLabels(["a", "b"], ["b", "c"])).toEqual({ appeared: ["c"], vanished: ["a"] });
  });

  it("compares as sets, because Jira promises nothing about label order", () => {
    // A claim reported as failed because two untouched labels swapped places
    // would be a false positive on every single write — and a check that fires
    // on every write is a check somebody switches off.
    expect(diffLabels(["a", "b", "c"], ["c", "a", "b"])).toEqual({ appeared: [], vanished: [] });
  });
});

describe("claimTicket", () => {
  describe("the write itself", () => {
    it("sends the whole field with agent:solving on and agent:start off", async () => {
      const jira = board(APPROVED);

      await claimTicket(jira.capabilities, request());

      // The bystanders are the assertion. `editJiraIssue` replaces the field, so
      // every label not named in the claim has to be carried through by hand.
      expect(jira.writes).toEqual([CLAIMED]);
    });

    it("writes exactly once", async () => {
      const jira = board(APPROVED);
      await claimTicket(jira.capabilities, request());
      expect(jira.writes).toHaveLength(1);
    });

    it("reads, writes, then reads again, and makes no other call", async () => {
      // The bracket is the whole mitigation: anything inserted between the first
      // read and the write widens the window in which a colleague's label edit
      // is lost, so the call sequence is asserted rather than assumed.
      const jira = board(APPROVED);

      await claimTicket(jira.capabilities, request());

      expect(jira.calls).toEqual(["read", "write", "read"]);
    });

    it("addresses every call to the ticket it was asked about", async () => {
      const jira = board(APPROVED);
      await claimTicket(jira.capabilities, request());
      expect(jira.keys).toEqual([KEY, KEY, KEY]);
    });

    it("collapses a duplicate in the read rather than writing it back", async () => {
      // Jira labels are a set, so a repeat is transport noise. Sending it back
      // would be this module inventing a field value nobody asked for.
      const jira = board([...APPROVED, "dor:pass"]);

      await claimTicket(jira.capabilities, request());

      expect(jira.writes[0]).toEqual(CLAIMED);
    });

    it("returns a receipt carrying the exact pre-claim set", async () => {
      // Nothing on the board holds this set once the claim is written, so if the
      // receipt does not carry it, release has nothing to restore.
      const jira = board(APPROVED);

      const receipt = receiptOf(await claimTicket(jira.capabilities, request()));

      expect(receipt).toEqual({ issueKey: KEY, labelsBefore: APPROVED, labelsAfter: CLAIMED });
    });
  });

  /**
   * The re-read is the mitigation, so these tests are about what it catches. The
   * queue's snapshot is old by the time a claim runs — a whole cycle of sorting,
   * allowlist checks and capacity arithmetic happens in between.
   */
  describe("re-reading immediately before the write", () => {
    it("takes no label snapshot from its caller at all", () => {
      // A type-level guarantee, asserted here so that adding a `labels` field to
      // `ClaimRequest` — the obvious "optimisation" — trips something.
      expect(Object.keys(request())).toEqual(["issueKey", "mode"]);
    });

    it("writes the labels it just read, not the ones the queue saw", async () => {
      // A PM adds next:to-trio after the queue fetched the ticket. It survives
      // the claim only if the write derives from this read.
      const jira = board(APPROVED, {
        onRead: (call, live) => {
          if (call === 1) {
            live.labels = [...live.labels, "next:to-trio"];
          }
        },
      });

      await claimTicket(jira.capabilities, request());

      expect(jira.writes[0]).toContain("next:to-trio");
    });

    it("refuses a ticket a racer claimed after the queue looked at it", async () => {
      // There is no compare-and-swap available, so this read is the only thing
      // standing between two instances and a double claim.
      const jira = board(APPROVED, {
        onRead: (call, live) => {
          if (call === 1) {
            live.labels = [...live.labels, AGENT_LABELS.solving];
          }
        },
      });

      const result = await claimTicket(jira.capabilities, request());

      expect(refusal(result)).toContain(AGENT_LABELS.solving);
      expect(jira.writes).toEqual([]);
    });

    it("refuses a ticket whose agent:solvable was withdrawn after the queue looked", async () => {
      const jira = board(APPROVED, {
        onRead: (call, live) => {
          if (call === 1) {
            live.labels = live.labels.filter((label) => label !== AGENT_LABELS.solvable);
          }
        },
      });

      const result = await claimTicket(jira.capabilities, request());

      expect(refusal(result)).toContain(AGENT_LABELS.solvable);
      expect(jira.writes).toEqual([]);
    });

    /**
     * The limit, written down as a test so it is not rediscovered as a bug.
     *
     * A label added between the read and the write is absent from the set we
     * send *and* absent from the set we read back, so it agrees perfectly and is
     * gone. Read-back verification catches a racer who wrote after us; it cannot
     * catch one we overwrote. `MAX_CONCURRENT_SOLVES=1` and a window of one round
     * trip are the whole of the mitigation for this half.
     */
    it("cannot detect an edit it clobbered, and reports success anyway", async () => {
      const jira = board(APPROVED, {
        onBeforeWrite: (live) => {
          live.labels = [...live.labels, "next:to-trio"];
        },
      });

      const result = await claimTicket(jira.capabilities, request());

      expect(result.outcome).toBe("claimed");
      expect(jira.labels).not.toContain("next:to-trio");
    });
  });

  /**
   * Every refusal asserts that nothing was written. The reason string matters
   * less than the absence of the write — a refusal that wrote anyway would be
   * the worst outcome in the module.
   */
  describe("refusing before the write", () => {
    it("refuses a ticket triage never marked solvable", async () => {
      const jira = board([AGENT_LABELS.start, "triaged"]);

      const result = await claimTicket(jira.capabilities, request());

      expect(refusal(result)).toContain(AGENT_LABELS.solvable);
      expect(jira.writes).toEqual([]);
    });

    it("refuses a solvable ticket nobody started, in manual mode", async () => {
      const jira = board([AGENT_LABELS.solvable, "triaged"]);

      const result = await claimTicket(jira.capabilities, request());

      expect(refusal(result)).toContain(AGENT_LABELS.start);
      expect(jira.writes).toEqual([]);
    });

    it("claims the same ticket in auto mode", async () => {
      const jira = board([AGENT_LABELS.solvable, "triaged"]);

      const result = await claimTicket(jira.capabilities, request("auto"));

      expect(result.outcome).toBe("claimed");
      expect(jira.writes).toEqual([[AGENT_LABELS.solvable, "triaged", AGENT_LABELS.solving]]);
    });

    it("treats an unrecognised mode as manual, never as auto", async () => {
      // Fail closed: the privilege `auto` grants is running without a human, so
      // only the exact value that grants it may.
      const jira = board([AGENT_LABELS.solvable, "triaged"]);

      const result = await claimTicket(jira.capabilities, request("AUTO" as SolveMode));

      expect(result.outcome).toBe("refused");
      expect(jira.writes).toEqual([]);
    });

    it.each([AGENT_LABELS.solving, AGENT_LABELS.reviewing, AGENT_LABELS.done, AGENT_LABELS.failed])(
      "refuses a ticket already carrying %s",
      async (blocker) => {
        const jira = board([...APPROVED, blocker]);

        const result = await claimTicket(jira.capabilities, request());

        expect(refusal(result)).toContain(blocker);
        expect(jira.writes).toEqual([]);
      },
    );

    it("refuses a ticket with no labels at all", async () => {
      const jira = board([]);

      const result = await claimTicket(jira.capabilities, request());

      expect(result.outcome).toBe("refused");
      expect(jira.writes).toEqual([]);
    });
  });

  /**
   * The read is about to be written straight back, so an unreadable one is not a
   * display problem — it is a set of labels about to be deleted. Fail closed.
   */
  describe("an unreadable label field", () => {
    it("refuses a read containing a non-string, rather than writing round it", async () => {
      const jira = unreadableBoard([AGENT_LABELS.solvable, AGENT_LABELS.start, 7]);

      const result = await claimTicket(jira.capabilities, request());

      expect(refusal(result)).toContain("non-string");
      expect(jira.writes).toEqual([]);
    });

    it("refuses a read containing a blank label", async () => {
      const jira = unreadableBoard([AGENT_LABELS.solvable, AGENT_LABELS.start, "   "]);

      const result = await claimTicket(jira.capabilities, request());

      expect(refusal(result)).toContain("blank");
      expect(jira.writes).toEqual([]);
    });

    it("refuses a read that is not an array", async () => {
      const jira = unreadableBoard({ labels: [AGENT_LABELS.solvable] });

      const result = await claimTicket(jira.capabilities, request());

      expect(refusal(result)).toContain("array");
      expect(jira.writes).toEqual([]);
    });
  });

  /**
   * `editJiraIssue` returning success says the request was accepted, not that the
   * ticket ended up as asked. Since two racers both succeed, the read-back is the
   * only thing that can say which of them the board kept.
   */
  describe("verifying the write", () => {
    it("reports failure when agent:solving is not there afterwards", async () => {
      // A second instance wrote its own full field a moment later, without ours.
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = live.labels.filter((label) => label !== AGENT_LABELS.solving);
        },
      });

      const result = unverifiedClaim(await claimTicket(jira.capabilities, request()));

      expect(result.vanished).toEqual([AGENT_LABELS.solving]);
      expect(result.reason).toContain("the claim did not take");
    });

    it("reports failure when agent:start survived the write", async () => {
      // The authorisation was not consumed, so the next cycle reads it as fresh.
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = [...live.labels, AGENT_LABELS.start];
        },
      });

      const result = unverifiedClaim(await claimTicket(jira.capabilities, request()));

      expect(result.appeared).toEqual([AGENT_LABELS.start]);
      expect(result.reason).toContain("authorisation was not consumed");
    });

    it("names an unrelated label that appeared after the write", async () => {
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = [...live.labels, "next:to-trio"];
        },
      });

      const result = unverifiedClaim(await claimTicket(jira.capabilities, request()));

      expect(result).toMatchObject({ appeared: ["next:to-trio"], vanished: [] });
      expect(result.reason).toContain("next:to-trio");
    });

    it("names an unrelated label that vanished under the write", async () => {
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = live.labels.filter((label) => label !== "dor:pass");
        },
      });

      const result = unverifiedClaim(await claimTicket(jira.capabilities, request()));

      expect(result).toMatchObject({ appeared: [], vanished: ["dor:pass"] });
    });

    it("carries no receipt, so an unverified claim cannot be released mechanically", async () => {
      // The shape is the guard. A caller cannot reach `labelsAfter`, cannot pass
      // this to `releaseClaim`, and cannot narrow to the success branch without
      // writing the literal "claimed".
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = live.labels.filter((label) => label !== AGENT_LABELS.solving);
        },
      });

      const result = await claimTicket(jira.capabilities, request());

      expect(result).not.toHaveProperty("receipt");
      expect(unverifiedClaim(result).labelsBefore).toEqual(APPROVED);
    });

    it("reports the whole set that was sent and the whole set that came back", async () => {
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = [...live.labels, "next:to-trio"];
        },
      });

      const result = unverifiedClaim(await claimTicket(jira.capabilities, request()));

      expect(result.expected).toEqual(CLAIMED);
      expect(result.observed).toEqual([...CLAIMED, "next:to-trio"]);
    });

    it("does not treat a reordered read-back as a failure", async () => {
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = live.labels.toReversed();
        },
      });

      expect((await claimTicket(jira.capabilities, request())).outcome).toBe("claimed");
    });

    it("does not treat a duplicated label in the read-back as a failure", async () => {
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = [...live.labels, "dor:pass"];
        },
      });

      expect((await claimTicket(jira.capabilities, request())).outcome).toBe("claimed");
    });
  });

  /**
   * A refusal is a normal outcome and returns. A fault leaves the ticket in a
   * state this function cannot describe, and throws — an exception being the one
   * return value nobody ignores by accident.
   */
  describe("faults", () => {
    it("throws when the write fails, carrying the restore point", async () => {
      const capabilities: ClaimCapabilities = {
        readLabels: async () => APPROVED,
        writeLabels: async () => {
          throw new Error("502 from Jira");
        },
      };

      const error = await claimTicket(capabilities, request()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ClaimWriteError);
      expect(error).toMatchObject({ issueKey: KEY, phase: "write", restorePoint: APPROVED });
      expect((error as ClaimWriteError).cause).toBeInstanceOf(Error);
    });

    it("throws when the read-back fails, because the write already landed", async () => {
      let reads = 0;
      const capabilities: ClaimCapabilities = {
        readLabels: async () => {
          reads += 1;
          if (reads > 1) {
            throw new Error("connection reset");
          }
          return APPROVED;
        },
        writeLabels: async () => {},
      };

      const error = await claimTicket(capabilities, request()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ClaimWriteError);
      expect(error).toMatchObject({ phase: "verify", restorePoint: APPROVED });
    });

    it("throws when the read-back is unreadable, rather than calling it a mismatch", async () => {
      // "Verification could not run" is not the same event as "verification ran
      // and disagreed", and an unverified result with an empty diff would be a
      // third meaning smuggled into the second.
      let reads = 0;
      const capabilities: ClaimCapabilities = {
        readLabels: async () => {
          reads += 1;
          return (reads > 1 ? [AGENT_LABELS.solving, null] : APPROVED) as readonly string[];
        },
        writeLabels: async () => {},
      };

      const error = await claimTicket(capabilities, request()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ClaimWriteError);
      expect(error).toMatchObject({ phase: "verify" });
    });

    it("lets a failing first read through untouched, since nothing was written", async () => {
      const capabilities: ClaimCapabilities = {
        readLabels: async () => {
          throw new Error("401 from Jira");
        },
        writeLabels: async () => {
          throw new Error("the write should not have been reached");
        },
      };

      await expect(claimTicket(capabilities, request())).rejects.toThrow("401 from Jira");
    });
  });
});

describe("releaseClaim", () => {
  /** A receipt as a real claim produces one. */
  async function claimFirst(jira: Board): Promise<ClaimReceipt> {
    return receiptOf(await claimTicket(jira.capabilities, request()));
  }

  it("restores the exact pre-claim label set", async () => {
    const jira = board(APPROVED);
    const receipt = await claimFirst(jira);

    const result = await releaseClaim(jira.capabilities, receipt);

    expect(result).toEqual({ outcome: "released", issueKey: KEY, labels: APPROVED });
    expect(jira.labels).toEqual(APPROVED);
  });

  it("puts agent:start back, rather than merely taking agent:solving off", async () => {
    // Dropping the claim alone would leave a ticket that is neither claimed nor
    // approved: invisible to the queue, and its approver never told why.
    const jira = board(APPROVED);

    await releaseClaim(jira.capabilities, await claimFirst(jira));

    expect(jira.labels).toContain(AGENT_LABELS.start);
  });

  it("reads, writes, then reads again — the same bracket as the claim", async () => {
    const jira = board(APPROVED);
    const receipt = await claimFirst(jira);
    jira.calls.length = 0;

    await releaseClaim(jira.capabilities, receipt);

    expect(jira.calls).toEqual(["read", "write", "read"]);
  });

  /**
   * The Phase B2 verification experiment, run against a fake: claim one ticket,
   * confirm a second pass picks nothing up, release it, confirm the ticket ends
   * exactly where it started.
   */
  it("survives claim → a second attempt picks nothing up → release → unchanged", async () => {
    const jira = board(APPROVED);
    const start = [...jira.labels];

    const receipt = await claimFirst(jira);

    const second = await claimTicket(jira.capabilities, request());
    expect(second.outcome).toBe("refused");
    expect(jira.writes).toHaveLength(1); // the second attempt wrote nothing

    await releaseClaim(jira.capabilities, receipt);

    expect(jira.labels).toEqual(start);
  });

  describe("refusing before the write", () => {
    it("refuses when the claim is already gone", async () => {
      const jira = board(APPROVED);
      const receipt = await claimFirst(jira);
      jira.labels = jira.labels.filter((label) => label !== AGENT_LABELS.solving);
      jira.writes.length = 0;

      const result = await releaseClaim(jira.capabilities, receipt);

      expect(refusal(result)).toContain("already been released");
      expect(jira.writes).toEqual([]);
    });

    it("refuses when somebody added a label while the ticket was claimed", async () => {
      // Restoring the pre-claim set would undo their edit in order to undo ours,
      // which is the §14.11 clobber committed on purpose.
      const jira = board(APPROVED);
      const receipt = await claimFirst(jira);
      jira.labels = [...jira.labels, "next:to-trio"];
      jira.writes.length = 0;

      const result = await releaseClaim(jira.capabilities, receipt);

      expect(refusal(result)).toContain("next:to-trio");
      expect(jira.writes).toEqual([]);
    });

    it("refuses when somebody removed a label while the ticket was claimed", async () => {
      const jira = board(APPROVED);
      const receipt = await claimFirst(jira);
      jira.labels = jira.labels.filter((label) => label !== "dor:pass");
      jira.writes.length = 0;

      const result = await releaseClaim(jira.capabilities, receipt);

      expect(refusal(result)).toContain("dor:pass");
      expect(jira.writes).toEqual([]);
    });

    it("refuses a receipt whose restore point would leave the ticket claimed", async () => {
      // No real claim produces such a receipt; a hand-built one easily does, and
      // hand-building one is the documented way to recover an unverified claim.
      const jira = board(CLAIMED);

      const result = await releaseClaim(jira.capabilities, {
        issueKey: KEY,
        labelsBefore: [...APPROVED, AGENT_LABELS.solving],
        labelsAfter: CLAIMED,
      });

      expect(refusal(result)).toContain(AGENT_LABELS.solving);
      expect(jira.writes).toEqual([]);
    });

    it("refuses an unreadable restore point without even reading the board", async () => {
      const jira = board(CLAIMED);

      const result = await releaseClaim(jira.capabilities, {
        issueKey: KEY,
        labelsBefore: ["triaged", ""] as readonly string[],
        labelsAfter: CLAIMED,
      });

      expect(refusal(result)).toContain("blank");
      expect(jira.calls).toEqual([]);
    });

    it("refuses when the board read is unreadable", async () => {
      const jira = unreadableBoard([AGENT_LABELS.solving, 7]);

      const result = await releaseClaim(jira.capabilities, {
        issueKey: KEY,
        labelsBefore: APPROVED,
        labelsAfter: CLAIMED,
      });

      expect(refusal(result)).toContain("non-string");
      expect(jira.writes).toEqual([]);
    });
  });

  describe("verifying the write", () => {
    it("reports failure when the restored set is not what came back", async () => {
      const jira = board(CLAIMED, {
        onWrite: (_call, live) => {
          live.labels = [...live.labels, AGENT_LABELS.solving];
        },
      });

      const result = unverifiedRelease(
        await releaseClaim(jira.capabilities, {
          issueKey: KEY,
          labelsBefore: APPROVED,
          labelsAfter: CLAIMED,
        }),
      );

      expect(result.appeared).toEqual([AGENT_LABELS.solving]);
      expect(result.reason).toContain("release FAILED");
    });

    it("throws when the release write fails", async () => {
      const capabilities: ClaimCapabilities = {
        readLabels: async () => CLAIMED,
        writeLabels: async () => {
          throw new Error("502 from Jira");
        },
      };

      const error = await releaseClaim(capabilities, {
        issueKey: KEY,
        labelsBefore: APPROVED,
        labelsAfter: CLAIMED,
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ClaimWriteError);
      expect(error).toMatchObject({ phase: "write", restorePoint: APPROVED });
    });
  });
});
