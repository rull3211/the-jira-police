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

/**
 * The labels SSX-3822 actually carries, plus the two the queue selects on.
 *
 * A real set rather than a minimal one on purpose. Every rule in `claim.ts` is
 * about the labels it is *not* interested in, and a fixture of two labels cannot
 * catch a mistake that reaches them. `triaged`, `route:ours` and `dor:pass` are
 * the bystanders. What "a mistake that reaches them" means has changed — it used
 * to be a full-field write destroying them, and is now a delta naming one by
 * accident, or a verification failing over one that was never ours — and the
 * fixture serves both.
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
  /**
   * The label field after each write, not the payload of each write.
   *
   * The payload is now a delta, and a delta read on its own says nothing about
   * whether the ticket ended up correct — which is the question every assertion
   * in this file is really asking. `deltas` is kept alongside for the handful
   * of tests that are about the wire format itself.
   */
  readonly writes: (readonly string[])[];
  readonly deltas: LabelEdit[];
  readonly keys: string[];
  readonly capabilities: ClaimCapabilities;
}

interface BoardHooks {
  /** Runs while a read is in flight, so a racer's edit can land between two reads. */
  readonly onRead?: (call: number, live: Board) => void;
  /**
   * Runs after a read has returned but before the write lands.
   *
   * This is the window §14.11 is about, and the only way to exercise it. The
   * window has not closed — a delta is not a compare-and-swap — but what can go
   * wrong inside it has narrowed to the two `agent:*` labels.
   */
  readonly onBeforeWrite?: (live: Board) => void;
  /** Runs after the field has been replaced, so a racer can overwrite our claim. */
  readonly onWrite?: (call: number, live: Board) => void;
}

/**
 * A fake Jira label field with hooks at each of the three moments that matter.
 *
 * **Delta semantics on write**, which is what `update.labels` has and what
 * `editJiraIssue` did not. The field is not replaced: the add list is unioned
 * in and the remove list subtracted, against whatever is live at the moment the
 * write arrives. That distinction is the entire point of the change this fake
 * was rewritten for — a fake that still replaced the field would keep passing
 * the tests that document a clobber the service can no longer commit.
 */
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

// `diffLabels` had two unit tests here and is gone with it — the comparison is
// now `diffEdit`, which is not exported, and is covered through `claimTicket`
// and `releaseClaim` where its answers actually decide something. Its
// order-insensitivity, the property those two tests existed for, is asserted by
// "does not treat a reordered read-back as a failure" below.

describe("claimTicket", () => {
  describe("the write itself", () => {
    it("leaves the ticket with agent:solving on and agent:start off", async () => {
      const jira = board(APPROVED);

      await claimTicket(jira.capabilities, request());

      // The bystanders are the assertion, and they used to be carried through by
      // hand because the write replaced the field. They are now untouched
      // because the write cannot reach them — same expectation, opposite reason,
      // and the test is kept precisely because both readings must hold.
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

    it("is not confused by a duplicate in the read", async () => {
      // Jira labels are a set, so a repeat is transport noise. It used to matter
      // because the deduplicated set was written straight back; now nothing is
      // written back, and what it must not do is fail *verification* over a
      // repeat that means nothing.
      const jira = board([...APPROVED, "dor:pass"]);

      const result = await claimTicket(jira.capabilities, request());

      expect(result.outcome).toBe("claimed");
      expect(receiptOf(result).labelsAfter).toEqual(CLAIMED);
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
      expect(Object.keys(request())).toEqual(["issueKey", "authority"]);
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
     * This test used to assert the opposite, and the inversion is the change.
     *
     * It read: *"cannot detect an edit it clobbered, and reports success
     * anyway"* — a label added between the read and the write was absent from
     * the set we sent *and* from the set we read back, so it agreed perfectly
     * and was gone. That was true of a full-field write and is false of a
     * delta: Jira applies `remove: agent:start` and `add: agent:solving` to
     * whatever is live when the request lands, and a label this service never
     * mentioned is a label it cannot destroy.
     *
     * Left in place, inverted, rather than deleted. A test that says "and this
     * is the bit that used to be broken" is the only durable record that it was.
     */
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
      // The mechanism behind the test above, asserted directly: the payload is
      // a delta over `agent:*` and mentions nothing else, so there is no
      // arithmetic for a bystander label to be lost in.
      const jira = board(APPROVED);

      await claimTicket(jira.capabilities, request());

      expect(jira.deltas).toEqual([{ add: [AGENT_LABELS.solving], remove: [AGENT_LABELS.start] }]);
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

    // The two tests below used to assert the opposite, and they were right to
    // when the write replaced the whole field: any label that moved between the
    // read and the read-back either was destroyed by us or would be by the next
    // write, so all of it was ours to answer for. The write is a delta now
    // (`updateLabels`), and the service no longer predicts what the rest of the
    // ticket says. A colleague's label arriving mid-claim is a colleague
    // working. Reporting it as `unverified` would fire this check on innocent
    // events several times a week, which is how a check ends up switched off.
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

      // And `dor:pass` is genuinely gone, rather than restored by our write —
      // which is the whole point of sending a delta instead of a field.
      expect(result.outcome).toBe("claimed");
      expect(jira.labels).not.toContain("dor:pass");
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

    // The *verdict* narrowed to the two labels this service asked for; the
    // *report* did not. A human reading "the claim did not take" needs the rest
    // of the ticket to work out who else was writing, so both whole sets are
    // still carried — including the bystander that is deliberately no longer
    // grounds for the failure.
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

  /**
   * A refusal is a normal outcome and returns. A fault leaves the ticket in a
   * state this function cannot describe, and throws — an exception being the one
   * return value nobody ignores by accident.
   */
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
      // "Verification could not run" is not the same event as "verification ran
      // and disagreed", and an unverified result with an empty diff would be a
      // third meaning smuggled into the second.
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

    // Both of these asserted a refusal until the write became a delta, and were
    // right to: restoring the pre-claim field would have undone the colleague's
    // edit in order to undo ours. A release that names only `agent:start` and
    // `agent:solving` cannot reach their label, so refusing would strand
    // `agent:solving` on the board over an edit that is none of its business —
    // and a human would have to clear it by hand every time a PM touched a
    // ticket mid-solve.
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
      // Not resurrected. The release restores its own two labels, not the
      // ticket, and "puts it back exactly as it was found" now means the part of
      // it this service moved.
      expect(jira.labels).not.toContain("dor:pass");
    });

    it("refuses when the claim it describes has already been undone", async () => {
      // Somebody put `agent:start` back by hand. The receipt still says this
      // service consumed it, so undoing the claim would remove a label a person
      // has since re-added deliberately.
      const jira = board(APPROVED);
      const receipt = await claimFirst(jira);
      jira.labels = [...jira.labels, AGENT_LABELS.start];
      jira.writes.length = 0;

      const result = await releaseClaim(jira.capabilities, receipt);

      expect(refusal(result)).toContain(AGENT_LABELS.start);
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
