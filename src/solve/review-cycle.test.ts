import { describe, expect, it } from "vitest";

import type { AdvanceOutcome, PendingRound } from "./delivery.ts";
import {
  type ReviewCycleDeps,
  type ReviewLook,
  type WatchedTicket,
  runReviewCycle,
} from "./review-cycle.ts";

const ticket = (key: string, updated: string): WatchedTicket => ({
  key,
  summary: `${key} summary`,
  url: `https://example.invalid/browse/${key}`,
  labels: ["agent:solvable", "agent:reviewing"],
  updated,
});

/** Enough of one to be handed back; nothing here reads inside it. */
const PENDING = { round: 1 } as unknown as PendingRound;

const WAITING: AdvanceOutcome = { kind: "waiting", quietMs: 60_000 };
const READY: AdvanceOutcome = { kind: "ready", rounds: 1 };
const endedAs = (number: number, state: "MERGED" | "CLOSED"): ReviewLook => ({
  outcome: "ended",
  number,
  state,
});

const round = (number: number): ReviewLook => ({ outcome: "round", number, pending: PENDING });
const settledAs = (number: number, result: AdvanceOutcome): ReviewLook => ({
  outcome: "settled",
  number,
  result,
});

interface Harness {
  readonly deps: ReviewCycleDeps;
  readonly looked: string[];
  readonly actedOn: string[];
}

function harness(
  tickets: readonly WatchedTicket[],
  looks: Readonly<Record<string, ReviewLook | (() => never)>>,
  overrides: Partial<ReviewCycleDeps> = {},
): Harness {
  const looked: string[] = [];
  const actedOn: string[] = [];

  return {
    looked,
    actedOn,
    deps: {
      enabled: true,
      maxRounds: 10,
      fetchWatched: () => Promise.resolve(tickets),
      look: (entry) => {
        looked.push(entry.key);
        const answer = looks[entry.key] ?? settledAs(1, WAITING);
        return typeof answer === "function" ? Promise.reject(answer()) : Promise.resolve(answer);
      },
      act: (entry) => {
        actedOn.push(entry.key);
        return Promise.resolve(READY);
      },
      ...overrides,
    },
  };
}

describe("runReviewCycle", () => {
  it("reads nothing at all when the master switch is off", async () => {
    // Checked here as well as at the wiring, and this is the test for the second
    // check: a fetch that runs anyway is a query against a live board from a
    // service an operator believes is switched off.
    let fetched = 0;
    const outcome = await runReviewCycle({
      enabled: false,
      maxRounds: 10,
      fetchWatched: () => {
        fetched += 1;
        return Promise.resolve([]);
      },
      look: () => Promise.reject(new Error("must not look")),
      act: () => Promise.reject(new Error("must not act")),
    });

    expect(fetched).toBe(0);
    expect(outcome).toMatchObject({ watched: 0, acted: [], deferred: [] });
  });

  it("looks at every watched ticket and spends nothing on the quiet ones", async () => {
    const h = harness(
      [ticket("SSX-1", "2026-09-01T00:00:00Z"), ticket("SSX-2", "2026-09-02T00:00:00Z")],
      { "SSX-1": settledAs(11, WAITING), "SSX-2": settledAs(22, WAITING) },
    );

    const outcome = await runReviewCycle(h.deps);

    expect(h.looked).toEqual(["SSX-1", "SSX-2"]);
    expect(h.actedOn).toEqual([]);
    expect(outcome.settled.map((entry) => entry.issueKey)).toEqual(["SSX-1", "SSX-2"]);
  });

  it("runs a round only for the tickets whose look found work", async () => {
    const h = harness(
      [
        ticket("SSX-1", "2026-09-01T00:00:00Z"),
        ticket("SSX-2", "2026-09-02T00:00:00Z"),
        ticket("SSX-3", "2026-09-03T00:00:00Z"),
      ],
      { "SSX-1": settledAs(11, WAITING), "SSX-2": round(22), "SSX-3": settledAs(33, READY) },
    );

    const outcome = await runReviewCycle(h.deps);

    expect(h.actedOn).toEqual(["SSX-2"]);
    expect(outcome.acted).toEqual([{ issueKey: "SSX-2", number: 22, outcome: READY }]);
  });

  it("takes the oldest-touched pull request first", async () => {
    // Ordering is the only thing standing between the bound below and a ticket
    // that is deferred every tick forever, so it is not left to whatever order
    // Jira happened to return.
    const h = harness(
      [ticket("SSX-new", "2026-09-05T00:00:00Z"), ticket("SSX-old", "2026-09-01T00:00:00Z")],
      { "SSX-new": round(1), "SSX-old": round(2) },
      { maxRounds: 1 },
    );

    const outcome = await runReviewCycle(h.deps);

    expect(h.actedOn).toEqual(["SSX-old"]);
    expect(outcome.deferred).toEqual(["SSX-new"]);
  });

  it("bounds the rounds one cycle may run, and defers rather than skips the rest", async () => {
    // The largest single spend this service can make: a reviewer that answered
    // every open pull request while the machine slept. Deferred, because they
    // are still actionable and the next tick takes them in the same order.
    const tickets = [1, 2, 3, 4].map((n) =>
      ticket(`SSX-${String(n)}`, `2026-09-0${String(n)}T00:00:00Z`),
    );
    const h = harness(
      tickets,
      Object.fromEntries(tickets.map((entry, index) => [entry.key, round(index + 1)])),
      { maxRounds: 2 },
    );

    const outcome = await runReviewCycle(h.deps);

    expect(h.actedOn).toEqual(["SSX-1", "SSX-2"]);
    expect(outcome.deferred).toEqual(["SSX-3", "SSX-4"]);
  });

  it("still looks at the whole set after the bound is reached", async () => {
    // The mutation this exists for: check the bound at the top of the loop and
    // a cycle at its limit stops looking — so a pull request that was merged in
    // the meantime is never noticed, keeps its label, stays in the query, and is
    // looked at forever. The bound is on the spend, not on the reads.
    const tickets = [1, 2, 3].map((n) =>
      ticket(`SSX-${String(n)}`, `2026-09-0${String(n)}T00:00:00Z`),
    );
    const h = harness(
      tickets,
      { "SSX-1": round(1), "SSX-2": round(2), "SSX-3": settledAs(3, READY) },
      { maxRounds: 1 },
    );

    const outcome = await runReviewCycle(h.deps);

    expect(h.looked).toEqual(["SSX-1", "SSX-2", "SSX-3"]);
    expect(outcome.settled.map((entry) => entry.issueKey)).toEqual(["SSX-3"]);
  });

  it("treats zero rounds as a dry run rather than as a reason not to look", async () => {
    const h = harness(
      [ticket("SSX-1", "2026-09-01T00:00:00Z")],
      { "SSX-1": round(11) },
      {
        maxRounds: 0,
      },
    );

    const outcome = await runReviewCycle(h.deps);

    expect(h.looked).toEqual(["SSX-1"]);
    expect(h.actedOn).toEqual([]);
    expect(outcome.deferred).toEqual(["SSX-1"]);
  });

  it("carries on past a look that threw, and names the ticket it failed on", async () => {
    // One renamed repository must not cost the other nineteen pull requests
    // their tick. The failure mode without this is silent: the cycle simply
    // does less work each time and nothing says so.
    const h = harness(
      [
        ticket("SSX-1", "2026-09-01T00:00:00Z"),
        ticket("SSX-2", "2026-09-02T00:00:00Z"),
        ticket("SSX-3", "2026-09-03T00:00:00Z"),
      ],
      {
        "SSX-1": settledAs(11, WAITING),
        "SSX-2": () => {
          throw new Error("gh timed out");
        },
        "SSX-3": round(33),
      },
    );

    const outcome = await runReviewCycle(h.deps);

    expect(h.looked).toEqual(["SSX-1", "SSX-2", "SSX-3"]);
    expect(h.actedOn).toEqual(["SSX-3"]);
    expect(outcome.unlooked).toEqual([{ issueKey: "SSX-2", reason: "gh timed out" }]);
  });

  it("carries on past a round that threw, and does not retry it in the same cycle", async () => {
    // The reservation is written before the pass runs, so a round that threw has
    // already spent whatever it spent. Retrying here would spend it twice on the
    // one loop where that is most expensive.
    let attempts = 0;
    const h = harness(
      [ticket("SSX-1", "2026-09-01T00:00:00Z"), ticket("SSX-2", "2026-09-02T00:00:00Z")],
      { "SSX-1": round(11), "SSX-2": round(22) },
      {
        act: (entry) => {
          attempts += 1;
          return entry.key === "SSX-1"
            ? Promise.reject(new Error("the pass crashed"))
            : Promise.resolve(READY);
        },
      },
    );

    const outcome = await runReviewCycle(h.deps);

    expect(attempts).toBe(2);
    expect(outcome.unlooked).toEqual([{ issueKey: "SSX-1", reason: "the pass crashed" }]);
    expect(outcome.acted.map((entry) => entry.issueKey)).toEqual(["SSX-2"]);
  });

  it("reports a ticket with no pull request rather than writing anything about it", async () => {
    // Every available write is wrong here: agent:closed asserts a pull request
    // was declined, and clearing the label drops a ticket somebody put on the
    // list. Saying so once per cycle is the whole of the correct response.
    const h = harness([ticket("SSX-1", "2026-09-01T00:00:00Z")], {
      "SSX-1": { outcome: "no-pull-request", reason: "no pull request on the branch" },
    });

    const outcome = await runReviewCycle(h.deps);

    expect(h.actedOn).toEqual([]);
    expect(outcome.unlooked).toEqual([
      { issueKey: "SSX-1", reason: "no pull request on the branch" },
    ]);
    expect(outcome.settled).toEqual([]);
  });

  it("reports a merged or closed pull request separately, and writes nothing about it", async () => {
    // Two rules in one test. `ended` is its own list because the caller has to
    // write agent:done or agent:closed for it and this module writes nothing —
    // fold it into `settled` and the terminal is a label nobody applies, so the
    // ticket keeps agent:review-done, stays in the query, and is looked at
    // forever. And the state is carried through verbatim, because the two
    // terminals are two different numbers in a report.
    const h = harness(
      [ticket("SSX-1", "2026-09-01T00:00:00Z"), ticket("SSX-2", "2026-09-02T00:00:00Z")],
      { "SSX-1": endedAs(11, "MERGED"), "SSX-2": endedAs(22, "CLOSED") },
    );

    const outcome = await runReviewCycle(h.deps);

    expect(h.actedOn).toEqual([]);
    expect(outcome.ended).toEqual([
      { issueKey: "SSX-1", number: 11, state: "MERGED" },
      { issueKey: "SSX-2", number: 22, state: "CLOSED" },
    ]);
    expect(outcome.settled).toEqual([]);
    expect(outcome.unlooked).toEqual([]);
  });

  it("stops spending when the signal aborts, and defers what it did not reach", async () => {
    const controller = new AbortController();
    const tickets = [1, 2].map((n) =>
      ticket(`SSX-${String(n)}`, `2026-09-0${String(n)}T00:00:00Z`),
    );
    const h = harness(
      tickets,
      { "SSX-1": round(1), "SSX-2": round(2) },
      {
        signal: controller.signal,
        act: (entry) => {
          controller.abort();
          return entry.key === "SSX-1" ? Promise.resolve(READY) : Promise.reject(new Error("no"));
        },
      },
    );

    const outcome = await runReviewCycle(h.deps);

    expect(outcome.acted.map((entry) => entry.issueKey)).toEqual(["SSX-1"]);
    expect(outcome.deferred).toEqual(["SSX-2"]);
  });

  it("does not read the board at all when the signal is already aborted", async () => {
    let fetched = 0;
    const outcome = await runReviewCycle({
      enabled: true,
      maxRounds: 10,
      signal: AbortSignal.abort(),
      fetchWatched: () => {
        fetched += 1;
        return Promise.resolve([]);
      },
      look: () => Promise.reject(new Error("must not look")),
      act: () => Promise.reject(new Error("must not act")),
    });

    expect(fetched).toBe(0);
    expect(outcome.watched).toBe(0);
  });
});
