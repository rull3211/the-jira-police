import { describe, expect, it } from "vitest";

import {
  type ClaimCapabilities,
  type ClaimReceipt,
  type ClaimResult,
  ClaimWriteError,
  type ReleaseResult,
  claimTicket,
  releaseClaim,
} from "./claim.ts";
import { AGENT_LABELS, type ClaimAuthority, type LabelEdit, applyEdit } from "./labels.ts";

const KEY = "SSX-3822";

/** A real set, not a minimal one — `triaged`, `route:ours`, `dor:pass` are bystanders a mistake could still reach by naming them in a delta by accident. */
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
  /** The label field after each write, not the delta payload — `deltas` below covers the wire format itself. */
  readonly writes: (readonly string[])[];
  readonly deltas: LabelEdit[];
  readonly keys: string[];
  readonly capabilities: ClaimCapabilities;
}

interface BoardHooks {
  /** Runs while a read is in flight, so a racer's edit can land between two reads. */
  readonly onRead?: (call: number, live: Board) => void;
  /** Runs after a read but before the write lands — the window §14.11 is about; a delta narrows what can go wrong inside it to the two `agent:*` labels. */
  readonly onBeforeWrite?: (live: Board) => void;
  /** Runs after the field has been replaced, so a racer can overwrite our claim. */
  readonly onWrite?: (call: number, live: Board) => void;
}

/** A fake Jira label field with hooks at the three moments that matter. Delta semantics on write — add unioned in, remove subtracted, against whatever's live — not a field replace. */
function board(initial: readonly string[], hooks: BoardHooks = {}): Board {
  let reads = 0;

  const state: Board = {
    labels: [...initial],
    calls: [],
    writes: [],
    deltas: [],
    keys: [],
    capabilities: {
      readLabels: async (issueKey) => {
        reads += 1;
        state.calls.push("read");
        state.keys.push(issueKey);
        hooks.onRead?.(reads, state);
        return [...state.labels];
      },
      applyLabels: async (issueKey, change) => {
        hooks.onBeforeWrite?.(state);
        state.calls.push("write");
        state.keys.push(issueKey);
        state.deltas.push(change);
        state.labels = applyEdit(state.labels, change);
        state.writes.push([...state.labels]);
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
      applyLabels: async (_issueKey, change) => {
        writes.push(change);
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

function request(authority: ClaimAuthority = "manual"): {
  issueKey: string;
  authority: ClaimAuthority;
} {
  return { issueKey: KEY, authority };
}

// `diffLabels`'s order-insensitivity is now asserted by "does not treat a reordered read-back as a failure" below, via `diffEdit`.

describe("claimTicket", () => {
  describe("the write itself", () => {
    it("leaves the ticket with agent:solving on and agent:start off", async () => {
      const jira = board(APPROVED);

      await claimTicket(jira.capabilities, request());

      // Bystanders are the assertion: untouched because the delta write cannot reach them.
      expect(jira.writes).toEqual([CLAIMED]);
    });

    it("writes exactly once", async () => {
      const jira = board(APPROVED);
      await claimTicket(jira.capabilities, request());
      expect(jira.writes).toHaveLength(1);
    });

    it("reads, writes, then reads again, and makes no other call", async () => {
      // The bracket is the mitigation, so the call sequence is asserted rather than assumed.
      const jira = board(APPROVED);

      await claimTicket(jira.capabilities, request());

      expect(jira.calls).toEqual(["read", "write", "read"]);
    });

    it("addresses every call to the ticket it was asked about", async () => {
      const jira = board(APPROVED);
      await claimTicket(jira.capabilities, request());
      expect(jira.keys).toEqual([KEY, KEY, KEY]);
    });

    it("is not confused by a duplicate in the read", async () => {
      // A repeat is transport noise; verification must not fail over it.
      const jira = board([...APPROVED, "dor:pass"]);

      const result = await claimTicket(jira.capabilities, request());

      expect(result.outcome).toBe("claimed");
      expect(receiptOf(result).labelsAfter).toEqual(CLAIMED);
    });

    it("returns a receipt carrying the exact pre-claim set", async () => {
      // Nothing on the board holds this set once written; release needs the receipt to restore it.
      const jira = board(APPROVED);

      const receipt = receiptOf(await claimTicket(jira.capabilities, request()));

      expect(receipt).toEqual({ issueKey: KEY, labelsBefore: APPROVED, labelsAfter: CLAIMED });
    });
  });

  /** The re-read is the mitigation; the queue's snapshot is stale by the time a claim runs. */
  describe("re-reading immediately before the write", () => {
    it("takes no label snapshot from its caller at all", () => {
      // A type-level guarantee: adding a `labels` field to `ClaimRequest` should trip this.
      expect(Object.keys(request())).toEqual(["issueKey", "authority"]);
    });

    it("writes the labels it just read, not the ones the queue saw", async () => {
      // A PM adds next:to-trio after the queue fetched the ticket; it survives only if the write derives from this read.
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
      // No compare-and-swap exists, so this read is the only thing standing between two instances and a double claim.
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

    // A delta applies `remove`/`add` to whatever is live when the request lands, so a label this service never mentioned cannot be destroyed.
    it("cannot clobber an edit that lands inside the write window", async () => {
      const jira = board(APPROVED, {
        onBeforeWrite: (live) => {
          live.labels = [...live.labels, "next:to-trio"];
        },
      });

      const result = await claimTicket(jira.capabilities, request());

      expect(result.outcome).toBe("claimed");
      expect(jira.labels).toContain("next:to-trio");
      expect(jira.labels).toContain(AGENT_LABELS.solving);
    });

    it("names only its own two labels on the wire, whatever else is on the ticket", async () => {
      // The payload is a delta over `agent:*` and mentions nothing else.
      const jira = board(APPROVED);

      await claimTicket(jira.capabilities, request());

      expect(jira.deltas).toEqual([{ add: [AGENT_LABELS.solving], remove: [AGENT_LABELS.start] }]);
    });
  });

  /** Every refusal asserts nothing was written — a refusal that wrote anyway would be the worst outcome here. */
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
      // Fail closed: only the exact value that grants the `auto` privilege may.
      const jira = board([AGENT_LABELS.solvable, "triaged"]);

      const result = await claimTicket(jira.capabilities, request("AUTO" as ClaimAuthority));

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

  /** The read is written straight back, so an unreadable one is a set of labels about to be deleted, not a display problem. */
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

  /** Success from the write means "accepted," not "landed as asked" — the read-back is the only way to know which of two racers the board kept. */
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

    // A colleague's label arriving mid-claim is a colleague working, not a failed verification.
    it("does not fail the claim when a bystander label appears mid-write", async () => {
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = [...live.labels, "next:to-trio"];
        },
      });

      const result = await claimTicket(jira.capabilities, request());

      expect(result.outcome).toBe("claimed");
    });

    it("does not fail the claim when someone else removes a label mid-write", async () => {
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = live.labels.filter((label) => label !== "dor:pass");
        },
      });

      const result = await claimTicket(jira.capabilities, request());

      // Genuinely gone, not restored by our write — the point of a delta over a field.
      expect(result.outcome).toBe("claimed");
      expect(jira.labels).not.toContain("dor:pass");
    });

    it("carries no receipt, so an unverified claim cannot be released mechanically", async () => {
      // The shape is the guard: no `labelsAfter`, can't pass to `releaseClaim`, can't narrow without the literal "claimed".
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = live.labels.filter((label) => label !== AGENT_LABELS.solving);
        },
      });

      const result = await claimTicket(jira.capabilities, request());

      expect(result).not.toHaveProperty("receipt");
      expect(unverifiedClaim(result).labelsBefore).toEqual(APPROVED);
    });

    // The verdict narrowed to the two labels asked for; the report still carries whole sets, so a human can see who else was writing.
    it("reports the whole set that was sent and the whole set that came back", async () => {
      const jira = board(APPROVED, {
        onWrite: (_call, live) => {
          live.labels = [
            ...live.labels.filter((label) => label !== AGENT_LABELS.solving),
            "next:to-trio",
          ];
        },
      });

      const result = unverifiedClaim(await claimTicket(jira.capabilities, request()));

      expect(result.expected).toEqual(CLAIMED);
      expect(result.observed).toEqual([
        ...CLAIMED.filter((label) => label !== AGENT_LABELS.solving),
        "next:to-trio",
      ]);
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

  /** A refusal is a normal outcome and returns; a fault leaves an indescribable state and throws instead. */
  describe("faults", () => {
    it("throws when the write fails, carrying the restore point", async () => {
      const capabilities: ClaimCapabilities = {
        readLabels: async () => APPROVED,
        applyLabels: async () => {
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
        applyLabels: async () => {},
      };

      const error = await claimTicket(capabilities, request()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ClaimWriteError);
      expect(error).toMatchObject({ phase: "verify", restorePoint: APPROVED });
    });

    it("throws when the read-back is unreadable, rather than calling it a mismatch", async () => {
      // "Could not run" is not the same event as "ran and disagreed".
      let reads = 0;
      const capabilities: ClaimCapabilities = {
        readLabels: async () => {
          reads += 1;
          return (reads > 1 ? [AGENT_LABELS.solving, null] : APPROVED) as readonly string[];
        },
        applyLabels: async () => {},
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
        applyLabels: async () => {
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

  /** Claims a ticket against a fake, confirms a second pass is refused, releases it, and confirms the ticket lands back where it started. */
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

    // A release naming only `agent:start`/`agent:solving` cannot reach a bystander label, so it need not refuse over one.
    it("releases even though somebody added a label while the ticket was claimed", async () => {
      const jira = board(APPROVED);
      const receipt = await claimFirst(jira);
      jira.labels = [...jira.labels, "next:to-trio"];
      jira.writes.length = 0;
      jira.deltas.length = 0;

      const result = await releaseClaim(jira.capabilities, receipt);

      expect(result.outcome).toBe("released");
      expect(jira.deltas).toEqual([{ add: [AGENT_LABELS.start], remove: [AGENT_LABELS.solving] }]);
      // Theirs survives; ours is undone. That is the whole of the change.
      expect(jira.labels).toContain("next:to-trio");
      expect(jira.labels).not.toContain(AGENT_LABELS.solving);
    });

    it("releases even though somebody removed a label while the ticket was claimed", async () => {
      const jira = board(APPROVED);
      const receipt = await claimFirst(jira);
      jira.labels = jira.labels.filter((label) => label !== "dor:pass");
      jira.writes.length = 0;

      const result = await releaseClaim(jira.capabilities, receipt);

      expect(result.outcome).toBe("released");
      // Not resurrected: the release restores its own two labels, not the whole ticket.
      expect(jira.labels).not.toContain("dor:pass");
    });

    it("refuses when the claim it describes has already been undone", async () => {
      // The receipt says this service consumed `agent:start`; undoing the claim would remove a label a person re-added deliberately.
      const jira = board(APPROVED);
      const receipt = await claimFirst(jira);
      jira.labels = [...jira.labels, AGENT_LABELS.start];
      jira.writes.length = 0;

      const result = await releaseClaim(jira.capabilities, receipt);

      expect(refusal(result)).toContain(AGENT_LABELS.start);
      expect(jira.writes).toEqual([]);
    });

    it("refuses a receipt whose restore point would leave the ticket claimed", async () => {
      // No real claim produces such a receipt; recovering an unverified claim by hand-building one does.
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
        applyLabels: async () => {
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
