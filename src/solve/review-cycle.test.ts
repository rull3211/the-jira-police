import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../logger.ts";
import type { AdvanceOutcome, PendingRound } from "./delivery.ts";
import {
  type ReviewCycleDeps,
  type ReviewCycleOutcome,
  type ReviewLook,
  type WatchedTicket,
  isQuietCycle,
  outcomeNote,
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
    // A fetch that runs anyway is a query against a live board the operator believes is off.
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
    // Ordering, not Jira's return order, is what stops a ticket from being deferred forever.
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
    // Deferred, not skipped: still actionable, taken in the same order next tick.
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
    // The bound applies to spend, not reads — a cycle at its limit still looks at every ticket.
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
    // One broken look must not cost the rest of the set their tick.
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
    // The reservation is written before the pass runs, so a round that threw has already spent; retrying would spend it twice.
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
    // Every available write here is wrong, so reporting is the correct response.
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
    // `ended` is separate from `settled`: the caller writes the terminal label, this module writes none.
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

/** Every `review.cycle` payload the run emitted, in order. */
function captureCycleLines(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(createLogger("review"), "info").mockImplementation((message, fields = {}) => {
    if (message === "review.cycle") {
      lines.push(fields);
    }
  });
  return lines;
}

describe("what the cycle writes down about itself", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const FAILED: AdvanceOutcome = {
    kind: "failed",
    stage: "verification",
    reason: "pnpm test exited 1",
  };

  it("names the arm a paid round returned, not just the ticket it was paid for", async () => {
    const lines = captureCycleLines();
    const h = harness([ticket("SSX-3835", "2026-09-06T19:00:00.000+0000")], {
      "SSX-3835": round(2663),
    });

    await runReviewCycle({ ...h.deps, act: () => Promise.resolve(FAILED) });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.acted).toEqual(["SSX-3835 #2663 failed at verification: pnpm test exited 1"]);
  });

  it("names the arm a free settle reached, which used to be a count", async () => {
    const lines = captureCycleLines();
    const h = harness(
      [
        ticket("SSX-1", "2026-09-06T19:00:00.000+0000"),
        ticket("SSX-2", "2026-09-06T19:01:00.000+0000"),
      ],
      { "SSX-1": settledAs(11, WAITING), "SSX-2": settledAs(22, READY) },
    );

    await runReviewCycle(h.deps);

    expect(lines[0]?.settled).toEqual([
      "SSX-1 #11 waiting quiet=60000ms",
      "SSX-2 #22 ready rounds=1",
    ]);
  });

  it("carries the reason a look failed, which is the whole content of an unlook", async () => {
    // A count would say a read broke but withhold what distinguishes the causes.
    const lines = captureCycleLines();
    const h = harness([ticket("SSX-9", "2026-09-06T19:00:00.000+0000")], {
      "SSX-9": (): never => {
        throw new Error("gh: could not resolve to a Repository");
      },
    });

    await runReviewCycle(h.deps);

    expect(lines[0]?.unlooked).toEqual(["SSX-9 gh: could not resolve to a Repository"]);
  });

  it("names the tickets it deferred, so a starved one is visible before it starves twice", async () => {
    const lines = captureCycleLines();
    const h = harness(
      [
        ticket("SSX-1", "2026-09-06T19:00:00.000+0000"),
        ticket("SSX-2", "2026-09-06T19:01:00.000+0000"),
      ],
      { "SSX-1": round(1), "SSX-2": round(2) },
      { maxRounds: 1 },
    );

    await runReviewCycle(h.deps);

    expect(lines[0]?.deferred).toEqual(["SSX-2"]);
  });
});

describe("outcomeNote", () => {
  it("keeps the field that discriminates within each arm", () => {
    expect(outcomeNote({ kind: "failed", stage: "worktree", reason: "dirty checkout" })).toBe(
      "failed at worktree: dirty checkout",
    );
    expect(outcomeNote({ kind: "abandoned", reason: "the ticket names an attachment" })).toBe(
      "abandoned: the ticket names an attachment",
    );
    expect(
      outcomeNote({ kind: "refused", stage: "diff-gate", reasons: ["pnpm-lock.yaml", "over cap"] }),
    ).toBe("refused at diff-gate: pnpm-lock.yaml; over cap");
  });

  it("says a round pushed nothing, which is how a stalled loop looks from outside", () => {
    expect(
      outcomeNote({
        kind: "iterated",
        round: 3,
        responses: ["a long argument about link ordering"],
        reviewerRequested: "unnecessary",
        pushed: false,
        spoken: { outcome: "posted" },
        undrafted: "undrafted",
        threads: { answered: 1, resolved: 0, failures: [] },
        unresolved: "the ordering question is not settled from this repository",
      }),
    ).toBe("iterated round=3 pushed=false spoken=posted undrafted=undrafted reviewer=unnecessary");
  });

  it("does not print a null quiet clock as a number", () => {
    // Null means the silence could not be measured, not zero — rendering it as `0ms` would say the opposite.
    expect(outcomeNote({ kind: "waiting", quietMs: null })).toBe("waiting quiet=unknown");
    expect(outcomeNote({ kind: "waiting", quietMs: 60_000 })).toBe("waiting quiet=60000ms");
  });

  it("carries `unresolved` off both of the arms that end a budget", () => {
    expect(
      outcomeNote({ kind: "reviewer-exhausted", rounds: 3, unresolved: "the null check" }),
    ).toBe("reviewer-exhausted rounds=3 unresolved=the null check");
    expect(outcomeNote({ kind: "capped", rounds: 20, unresolved: "the null check" })).toBe(
      "capped rounds=20 unresolved=the null check",
    );
  });

  it("names the cause of a stall, not just the count", () => {
    expect(
      outcomeNote({ kind: "stalled", attempts: 3, reason: "the worktree has uncommitted changes" }),
    ).toBe("stalled attempts=3: the worktree has uncommitted changes");
  });
});

describe("isQuietCycle", () => {
  const emptyCycle: ReviewCycleOutcome = {
    watched: 0,
    acted: [],
    settled: [],
    ended: [],
    unlooked: [],
    deferred: [],
  };

  const settle = (outcome: AdvanceOutcome): ReviewCycleOutcome => ({
    ...emptyCycle,
    watched: 1,
    settled: [{ issueKey: "SSX-3835", number: 2663, outcome }],
  });

  it("calls a cycle quiet when every pull request it watched is still waiting", () => {
    expect(isQuietCycle({ ...settle(WAITING), watched: 5 })).toBe(true);
    expect(isQuietCycle(settle(READY))).toBe(true);
  });

  it("does not read `watched`, because looking at things is not doing something", () => {
    expect(isQuietCycle({ ...emptyCycle, watched: 5 })).toBe(true);
  });

  it("calls a cycle news when a round ran, whatever the round returned", () => {
    const acted: ReviewCycleOutcome = {
      ...emptyCycle,
      watched: 1,
      acted: [{ issueKey: "SSX-3835", number: 2663, outcome: READY }],
    };

    expect(isQuietCycle(acted)).toBe(false);
  });

  it("calls a cycle news on each of the other three arms separately", () => {
    expect(
      isQuietCycle({ ...emptyCycle, ended: [{ issueKey: "SSX-1", number: 1, state: "MERGED" }] }),
    ).toBe(false);
    expect(
      isQuietCycle({ ...emptyCycle, unlooked: [{ issueKey: "SSX-1", reason: "no pull request" }] }),
    ).toBe(false);
    expect(isQuietCycle({ ...emptyCycle, deferred: ["SSX-1"] })).toBe(false);
  });

  it("calls a settled verdict news, which is the arm a count would have hidden", () => {
    for (const outcome of [
      { kind: "failed", stage: "verification", reason: "pnpm test exited 1" },
      { kind: "refused", stage: "diff-gate", reasons: ["a dependency change"] },
      { kind: "abandoned", reason: "the base build was already red" },
      { kind: "capped", rounds: 20, unresolved: "the ordering question" },
      { kind: "reviewer-exhausted", rounds: 3, unresolved: "the null check" },
      { kind: "stalled", attempts: 3, reason: "the worktree has uncommitted changes" },
      { kind: "synced", round: 4, behind: 7, conflicts: ["src/utils/DateUtils.ts"] },
    ] satisfies AdvanceOutcome[]) {
      expect(isQuietCycle(settle(outcome))).toBe(false);
    }
  });

  it("is news if any settle is a verdict, even among quiet ones", () => {
    const mixed: ReviewCycleOutcome = {
      ...emptyCycle,
      watched: 3,
      settled: [
        { issueKey: "SSX-1", number: 1, outcome: WAITING },
        { issueKey: "SSX-2", number: 2, outcome: { kind: "abandoned", reason: "no base" } },
        { issueKey: "SSX-3", number: 3, outcome: READY },
      ],
    };

    expect(isQuietCycle(mixed)).toBe(false);
  });
});

/** Every `review.cycle` mark the run emitted, in order. */
function captureCycleMarks(): (boolean | undefined)[] {
  const marks: (boolean | undefined)[] = [];
  vi.spyOn(createLogger("review"), "info").mockImplementation(
    (message, _fields = {}, options = {}) => {
      if (message === "review.cycle") {
        marks.push(options.quiet);
      }
    },
  );
  return marks;
}

describe("the mark on the cycle's own log line", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks a cycle that only waited as quiet", async () => {
    const marks = captureCycleMarks();
    const h = harness([ticket("SSX-3835", "2026-09-06T19:00:00.000+0000")], {
      "SSX-3835": settledAs(2663, WAITING),
    });

    await runReviewCycle(h.deps);

    expect(marks).toEqual([true]);
  });

  it("marks a cycle that ran a round as news", async () => {
    const marks = captureCycleMarks();
    const h = harness([ticket("SSX-3835", "2026-09-06T19:00:00.000+0000")], {
      "SSX-3835": round(2663),
    });

    await runReviewCycle({ ...h.deps, act: () => Promise.resolve(READY) });

    expect(marks).toEqual([false]);
  });
});
