import { describe, expect, it, vi } from "vitest";

import type { SolveMode } from "../settings.ts";
import { AGENT_LABELS } from "./labels.ts";
import { type SolveCandidate, type SolveDeps, runSolveCycle } from "./poller.ts";

const PILOT_REPO = "buy-insurance-advisor-web";

/**
 * A ticket in the state the queue is looking for: assessed by triage, approved
 * by a human, unclaimed.
 *
 * The timestamp shape is copied from a real Jira response — a numeric offset,
 * not `Z`. Fixtures that agreed with each other and disagreed with Jira are how
 * the DST ordering bug in the first poller survived a green suite.
 */
function candidate(key: string, overrides: Partial<SolveCandidate> = {}): SolveCandidate {
  return {
    key,
    summary: `Summary for ${key}`,
    url: `https://example.invalid/browse/${key}`,
    labels: [AGENT_LABELS.solvable, AGENT_LABELS.start],
    updated: "2026-09-02T09:55:34.178+0200",
    repo: PILOT_REPO,
    ...overrides,
  };
}

function deps(overrides: Partial<SolveDeps> = {}): SolveDeps {
  return {
    enabled: true,
    mode: "manual",
    allowedRepos: [PILOT_REPO],
    maxConcurrent: 1,
    fetchQueue: async () => [],
    countInFlight: async () => 0,
    ...overrides,
  };
}

describe("runSolveCycle", () => {
  it("plans a claim for an authorised ticket on the allowlist", async () => {
    const outcome = await runSolveCycle(deps({ fetchQueue: async () => [candidate("SSX-1")] }));

    expect(outcome.planned).toEqual([
      {
        issueKey: "SSX-1",
        repo: PILOT_REPO,
        claim: { add: [AGENT_LABELS.solving], remove: [AGENT_LABELS.start] },
        labelsAfter: [AGENT_LABELS.solvable, AGENT_LABELS.solving],
      },
    ]);
  });

  it("does nothing when the queue is empty", async () => {
    const outcome = await runSolveCycle(deps());
    expect(outcome).toMatchObject({ found: 0, planned: [], skipped: [], deferred: [] });
  });

  /**
   * Phase B's defining property. The value of shipping this before the solver
   * is that it says which tickets would be picked up without picking any up.
   */
  describe("dry run", () => {
    it("reports itself as a dry run", async () => {
      const outcome = await runSolveCycle(deps({ fetchQueue: async () => [candidate("SSX-1")] }));
      expect(outcome.dryRun).toBe(true);
    });

    it("leaves the candidate's own labels untouched", async () => {
      // The claim is computed against the live labels; writing the result back
      // into the object would make a dry run indistinguishable from a real one
      // to everything downstream of it.
      const ticket = candidate("SSX-1");
      const before = [...ticket.labels];

      await runSolveCycle(deps({ fetchQueue: async () => [ticket] }));

      expect(ticket.labels).toEqual(before);
    });
  });

  /**
   * `SOLVE_ENABLED`, checked here as well as at the composition root. A poller
   * that is safe only because its caller remembers not to call it is one
   * careless wiring change away from running unattended.
   */
  describe("the master switch", () => {
    it("claims nothing when disabled", async () => {
      const outcome = await runSolveCycle(
        deps({ enabled: false, fetchQueue: async () => [candidate("SSX-1")] }),
      );
      expect(outcome.planned).toEqual([]);
    });

    it("does not even read the board when disabled", async () => {
      const fetchQueue = vi.fn(async () => [candidate("SSX-1")]);
      const countInFlight = vi.fn(async () => 0);

      await runSolveCycle(deps({ enabled: false, fetchQueue, countInFlight }));

      expect(fetchQueue).not.toHaveBeenCalled();
      expect(countInFlight).not.toHaveBeenCalled();
    });
  });

  describe("the human go-ahead", () => {
    it("skips a solvable ticket nobody started, in manual mode", async () => {
      const outcome = await runSolveCycle(
        deps({
          fetchQueue: async () => [candidate("SSX-1", { labels: [AGENT_LABELS.solvable] })],
        }),
      );

      expect(outcome.planned).toEqual([]);
      expect(outcome.skipped).toEqual([
        { issueKey: "SSX-1", reason: expect.stringContaining(AGENT_LABELS.start) },
      ]);
    });

    it("claims the same ticket in auto mode", async () => {
      const outcome = await runSolveCycle(
        deps({
          mode: "auto",
          fetchQueue: async () => [candidate("SSX-1", { labels: [AGENT_LABELS.solvable] })],
        }),
      );

      expect(outcome.planned.map((entry) => entry.issueKey)).toEqual(["SSX-1"]);
    });

    it("treats an unrecognised mode as manual, not as auto", async () => {
      const outcome = await runSolveCycle(
        deps({
          mode: "AUTO" as SolveMode,
          fetchQueue: async () => [candidate("SSX-1", { labels: [AGENT_LABELS.solvable] })],
        }),
      );

      expect(outcome.planned).toEqual([]);
    });

    it("never claims a ticket triage did not mark solvable", async () => {
      // `agent:start` alone is a human pointing at a ticket nobody assessed.
      const outcome = await runSolveCycle(
        deps({
          mode: "auto",
          fetchQueue: async () => [candidate("SSX-1", { labels: [AGENT_LABELS.start] })],
        }),
      );

      expect(outcome.planned).toEqual([]);
    });
  });

  /**
   * The dedupe. There is no cursor and no seen-keys file behind this queue, so
   * the labels on the ticket are the only thing preventing a second claim.
   */
  describe("claim idempotency", () => {
    it.each([AGENT_LABELS.solving, AGENT_LABELS.reviewing, AGENT_LABELS.done, AGENT_LABELS.failed])(
      "skips a ticket already carrying %s even if the query returned it",
      async (blocker) => {
        const outcome = await runSolveCycle(
          deps({
            fetchQueue: async () => [
              candidate("SSX-1", {
                labels: [AGENT_LABELS.solvable, AGENT_LABELS.start, blocker],
              }),
            ],
          }),
        );

        expect(outcome.planned).toEqual([]);
        expect(outcome.skipped[0]?.reason).toContain(blocker);
      },
    );

    it("picks nothing up for a second instance once the first has claimed", async () => {
      // The second instance sees the board as the first left it.
      const first = await runSolveCycle(deps({ fetchQueue: async () => [candidate("SSX-1")] }));
      const claimed = first.planned[0];
      expect(claimed).toBeDefined();

      const second = await runSolveCycle(
        deps({
          countInFlight: async () => 1,
          fetchQueue: async () => [candidate("SSX-1", { labels: claimed?.labelsAfter ?? [] })],
        }),
      );

      expect(second.planned).toEqual([]);
      expect(second.deferred).toEqual([]);
    });
  });

  /**
   * The allowlist is the only thing bounding which repository a future solver
   * may write to, so every unclear answer is "no".
   */
  describe("the repository allowlist", () => {
    it("skips a ticket naming a repo that is not on the list", async () => {
      const outcome = await runSolveCycle(
        deps({ fetchQueue: async () => [candidate("SSX-1", { repo: "some-other-repo" })] }),
      );

      expect(outcome.planned).toEqual([]);
      expect(outcome.skipped[0]?.reason).toContain("SOLVE_REPOS");
    });

    it("skips rather than fails, so widening the list later picks it up", async () => {
      // Nothing about a skipped ticket changes, so no manual reset is needed.
      const ticket = candidate("SSX-1", { repo: "some-other-repo" });

      const before = await runSolveCycle(deps({ fetchQueue: async () => [ticket] }));
      expect(before.planned).toEqual([]);

      const after = await runSolveCycle(
        deps({ allowedRepos: [PILOT_REPO, "some-other-repo"], fetchQueue: async () => [ticket] }),
      );
      expect(after.planned.map((entry) => entry.issueKey)).toEqual(["SSX-1"]);
    });

    it("allows nothing when the allowlist is empty", async () => {
      // The opposite of how an empty JIRA_COMPONENTS reads, and deliberately
      // so: an empty read filter widens a read, an empty write filter would
      // widen a write.
      const outcome = await runSolveCycle(
        deps({ allowedRepos: [], fetchQueue: async () => [candidate("SSX-1")] }),
      );

      expect(outcome.planned).toEqual([]);
      expect(outcome.skipped[0]?.reason).toContain("empty");
    });

    it("skips a ticket that names no repo at all", async () => {
      const { repo: _repo, ...withoutRepo } = candidate("SSX-1");
      const outcome = await runSolveCycle(deps({ fetchQueue: async () => [withoutRepo] }));

      expect(outcome.planned).toEqual([]);
      expect(outcome.skipped[0]?.reason).toContain("no repository named");
    });

    it("skips a ticket whose repo is blank", async () => {
      const outcome = await runSolveCycle(
        deps({ fetchQueue: async () => [candidate("SSX-1", { repo: "   " })] }),
      );

      expect(outcome.planned).toEqual([]);
    });

    it("matches the repo name exactly, not by prefix", async () => {
      const outcome = await runSolveCycle(
        deps({ fetchQueue: async () => [candidate("SSX-1", { repo: `${PILOT_REPO}-fork` })] }),
      );

      expect(outcome.planned).toEqual([]);
    });
  });

  /**
   * `MAX_CONCURRENT_SOLVES`. Counted from the board rather than from this
   * cycle: the queue query excludes claimed tickets, so the ones that count
   * against the limit are exactly the ones the queue cannot see.
   */
  describe("the concurrency bound", () => {
    const THREE = [candidate("SSX-1"), candidate("SSX-2"), candidate("SSX-3")];

    it("claims at most the configured number", async () => {
      const outcome = await runSolveCycle(deps({ fetchQueue: async () => THREE }));

      expect(outcome.planned).toHaveLength(1);
      expect(outcome.deferred).toEqual(["SSX-2", "SSX-3"]);
    });

    it("counts solves already in flight against the limit", async () => {
      // Without the second read, the limit would cap claims per cycle and let
      // the next tick start another — which is not a limit.
      const outcome = await runSolveCycle(
        deps({ maxConcurrent: 2, countInFlight: async () => 2, fetchQueue: async () => THREE }),
      );

      expect(outcome).toMatchObject({ inFlight: 2, capacity: 0 });
      expect(outcome.planned).toEqual([]);
      expect(outcome.deferred).toHaveLength(3);
    });

    it("leaves room for the difference, not for the whole limit", async () => {
      const outcome = await runSolveCycle(
        deps({ maxConcurrent: 3, countInFlight: async () => 1, fetchQueue: async () => THREE }),
      );

      expect(outcome.planned).toHaveLength(2);
    });

    it.each([0, -1, 1.5, Number.NaN])(
      "claims nothing when the limit reads as %s",
      async (maxConcurrent) => {
        // A misconfigured concurrency limit does not mean "unlimited".
        const outcome = await runSolveCycle(deps({ maxConcurrent, fetchQueue: async () => THREE }));

        expect(outcome.capacity).toBe(0);
        expect(outcome.planned).toEqual([]);
      },
    );

    it("claims nothing when the in-flight count is nonsense", async () => {
      const outcome = await runSolveCycle(
        deps({ countInFlight: async () => Number.NaN, fetchQueue: async () => THREE }),
      );

      expect(outcome.planned).toEqual([]);
    });

    it("still reports why the rest of the queue did not qualify", async () => {
      // A dry run whose output stopped at the cap would hide the interesting
      // half — the tickets that will never qualify however long you wait.
      const outcome = await runSolveCycle(
        deps({
          fetchQueue: async () => [
            candidate("SSX-1"),
            candidate("SSX-2", { repo: "elsewhere" }),
            candidate("SSX-3"),
          ],
        }),
      );

      expect(outcome.planned.map((entry) => entry.issueKey)).toEqual(["SSX-1"]);
      expect(outcome.skipped.map((entry) => entry.issueKey)).toEqual(["SSX-2"]);
      expect(outcome.deferred).toEqual(["SSX-3"]);
    });
  });

  /**
   * Jira returns `updated` with a numeric offset, not `Z`, and that offset
   * moves at the DST boundary. With a concurrency bound of one, the order
   * decides which ticket is worked today and which waits.
   */
  describe("ordering", () => {
    // 2026-10-25 is when Norway falls back from +0200 to +0100.
    const EARLIER = candidate("SSX-2", { updated: "2026-10-25T02:30:00.000+0200" }); // 00:30Z
    const LATER = candidate("SSX-1", { updated: "2026-10-25T02:00:00.000+0100" }); // 01:00Z

    it("orders by instant, not by the printed string", async () => {
      const outcome = await runSolveCycle(deps({ fetchQueue: async () => [LATER, EARLIER] }));

      // A string sort would put SSX-1 first. Chronologically SSX-2 is older.
      expect(outcome.planned.map((entry) => entry.issueKey)).toEqual(["SSX-2"]);
      expect(outcome.deferred).toEqual(["SSX-1"]);
    });

    it("breaks ties on key, so the queue is deterministic", async () => {
      const same = "2026-09-02T10:00:00.000+0200";
      const outcome = await runSolveCycle(
        deps({
          maxConcurrent: 3,
          fetchQueue: async () => [
            candidate("SSX-3", { updated: same }),
            candidate("SSX-1", { updated: same }),
            candidate("SSX-2", { updated: same }),
          ],
        }),
      );

      expect(outcome.planned.map((entry) => entry.issueKey)).toEqual(["SSX-1", "SSX-2", "SSX-3"]);
    });

    it("refuses to guess at an unparseable timestamp", async () => {
      // NaN out of a comparator leaves the order arbitrary, and with a bound of
      // one an arbitrary order silently decides which ticket gets solved.
      await expect(
        runSolveCycle(
          deps({
            fetchQueue: async () => [
              candidate("SSX-1", { updated: "recently" }),
              candidate("SSX-2"),
            ],
          }),
        ),
      ).rejects.toThrow(/SSX-1 has an unparseable updated timestamp/);
    });
  });

  describe("shutdown", () => {
    it("reads nothing when shutdown was requested before the cycle began", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchQueue = vi.fn(async () => [candidate("SSX-1")]);

      const outcome = await runSolveCycle(deps({ signal: controller.signal, fetchQueue }));

      expect(fetchQueue).not.toHaveBeenCalled();
      expect(outcome.planned).toEqual([]);
    });

    it("defers rather than claims once shutdown is requested mid-cycle", async () => {
      const controller = new AbortController();
      const fetchQueue = async () => {
        controller.abort();
        return [candidate("SSX-1")];
      };

      const outcome = await runSolveCycle(deps({ signal: controller.signal, fetchQueue }));

      expect(outcome.planned).toEqual([]);
      expect(outcome.deferred).toEqual(["SSX-1"]);
    });

    it("runs the whole queue when no signal is supplied", async () => {
      const outcome = await runSolveCycle(
        deps({
          maxConcurrent: 2,
          fetchQueue: async () => [candidate("SSX-1"), candidate("SSX-2")],
        }),
      );

      expect(outcome.planned).toHaveLength(2);
    });
  });
});
