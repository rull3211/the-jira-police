import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../logger.ts";
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

/**
 * PR #2663, 2026-09-06, is the reason this block exists.
 *
 * A round ran for $2.02, returned an early non-success 144 ms after the pass,
 * and the daemon's whole record of it was `acted: ["SSX-3835"]`. Which arm it
 * returned — abandoned, refused, or failed at verification — is not recoverable
 * from any log, any file or any comment, because this one statement reduced the
 * outcome to a key, the settles to a count and the reasons to a count, and
 * `createReviewLoop` never reads the returned value.
 */
/** Every `review.cycle` payload the run emitted, in order. */
function captureCycleLines(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(logger, "info").mockImplementation((message, fields = {}) => {
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
    // The mutation: map `acted` back to `entry.issueKey`. It reproduces #2663
    // exactly — the log says a round ran and says nothing about what it did.
    const lines = captureCycleLines();
    const h = harness([ticket("SSX-3835", "2026-09-06T19:00:00.000+0000")], {
      "SSX-3835": round(2663),
    });

    await runReviewCycle({ ...h.deps, act: () => Promise.resolve(FAILED) });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.acted).toEqual(["SSX-3835 #2663 failed at verification: pnpm test exited 1"]);
  });

  it("names the arm a free settle reached, which used to be a count", async () => {
    // `waiting` on almost every tick is why this was a number, and is also why
    // the number was useless: the tick where a settle stops being `waiting` is
    // the tick somebody needs to see. Mutation: `settled: settled.length`.
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
    // A count of unlooked tickets says a read broke and withholds the only field
    // that distinguishes a renamed repository from a `gh` that timed out.
    // Mutation: `unlooked: unlooked.length`.
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
    // Ordering is the guard against starvation and a count cannot show it held.
    // Mutation: `deferred: deferred.length`.
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
    // `kind` alone is what the CLI renderer's headline gives, and for the three
    // arms a round can end early in it is not enough: "failed" without a stage
    // sends a reader to the wrong half of the pipeline, and "abandoned" without
    // a reason is the outcome that says nothing at all by construction.
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
    // Six rounds of `iterated pushed=false` is a loop arguing with itself, and it
    // is indistinguishable from six productive rounds if only `kind` is logged.
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
    // `quietMs: null` means the silence could not be measured, and rendering it
    // as `0ms` or `nullms` reads as a pull request touched this instant — the
    // opposite of what a null there means.
    expect(outcomeNote({ kind: "waiting", quietMs: null })).toBe("waiting quiet=unknown");
    expect(outcomeNote({ kind: "waiting", quietMs: 60_000 })).toBe("waiting quiet=60000ms");
  });

  it("carries `unresolved` off both of the arms that end a budget", () => {
    // The field the skill calls "what tells a human to stop the loop and look".
    // These two arms are where a human is being handed the pull request, so it
    // is the one moment the field is certain to matter.
    expect(
      outcomeNote({ kind: "reviewer-exhausted", rounds: 3, unresolved: "the null check" }),
    ).toBe("reviewer-exhausted rounds=3 unresolved=the null check");
    expect(outcomeNote({ kind: "capped", rounds: 20, unresolved: "the null check" })).toBe(
      "capped rounds=20 unresolved=the null check",
    );
  });

  it("names the cause of a stall, not just the count", () => {
    // A line reading only "stalled attempts=3" sends whoever is reading the log
    // to the pull request to find out what for. The reason is already carried on
    // the outcome, and this is the one place a daemon prints it.
    expect(
      outcomeNote({ kind: "stalled", attempts: 3, reason: "the worktree has uncommitted changes" }),
    ).toBe("stalled attempts=3: the worktree has uncommitted changes");
  });
});

/**
 * The ⏳/🔧 mark on the line this service writes most often.
 *
 * `review.cycle` fires every `REVIEW_POLL_MS` — two minutes — for every watched
 * pull request, and on a healthy queue it says the same thing every time. The
 * mark is what lets a person scroll past those and stop on the one that does
 * not, so getting it wrong in the quiet direction hides a verdict.
 */
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
    // The line the whole mark was added for: five pull requests read, none of
    // them had said anything, and it will say so again in two minutes.
    expect(isQuietCycle({ ...settle(WAITING), watched: 5 })).toBe(true);
    expect(isQuietCycle(settle(READY))).toBe(true);
  });

  it("does not read `watched`, because looking at things is not doing something", () => {
    // The mutation: add `outcome.watched === 0` to the conjunction. Every cycle
    // on a non-empty queue is then news, which is the mark meaning nothing.
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
    // Four terms in one conjunction, so four mutations. Drop any one and this
    // fails on exactly the row it belongs to.
    expect(
      isQuietCycle({ ...emptyCycle, ended: [{ issueKey: "SSX-1", number: 1, state: "MERGED" }] }),
    ).toBe(false);
    expect(
      isQuietCycle({ ...emptyCycle, unlooked: [{ issueKey: "SSX-1", reason: "no pull request" }] }),
    ).toBe(false);
    expect(isQuietCycle({ ...emptyCycle, deferred: ["SSX-1"] })).toBe(false);
  });

  it("calls a settled verdict news, which is the arm a count would have hidden", () => {
    // This is #2663's lesson as a mark rather than as a field. A settle is
    // `waiting` almost always, so it is tempting to treat the whole array as
    // background — and the arms that are not `waiting` are a round that reached
    // a verdict and will never say so again.
    for (const outcome of [
      { kind: "failed", stage: "verification", reason: "pnpm test exited 1" },
      { kind: "refused", stage: "diff-gate", reasons: ["a dependency change"] },
      { kind: "abandoned", reason: "the base build was already red" },
      { kind: "capped", rounds: 20, unresolved: "the ordering question" },
      { kind: "reviewer-exhausted", rounds: 3, unresolved: "the null check" },
      // The arm the recurrence rule above would file as quiet, and the one it
      // must not. A stall repeats every tick exactly as `waiting` does — which
      // is how #2663 went four days without anything saying so — and it is
      // news every one of those times, because the whole outcome exists to
      // break that silence.
      { kind: "stalled", attempts: 3, reason: "the worktree has uncommitted changes" },
    ] satisfies AdvanceOutcome[]) {
      expect(isQuietCycle(settle(outcome))).toBe(false);
    }
  });

  it("is news if any settle is a verdict, even among quiet ones", () => {
    // `every`, not "the first one". A verdict buried behind four waiting pull
    // requests is the case where a person most needs the mark to be honest.
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
  vi.spyOn(logger, "info").mockImplementation((message, _fields = {}, options = {}) => {
    if (message === "review.cycle") {
      marks.push(options.quiet);
    }
  });
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
    // The mark and the fields are built from one object, so this also pins that
    // they cannot disagree: the line below says `acted` and must not say ⏳.
    const marks = captureCycleMarks();
    const h = harness([ticket("SSX-3835", "2026-09-06T19:00:00.000+0000")], {
      "SSX-3835": round(2663),
    });

    await runReviewCycle({ ...h.deps, act: () => Promise.resolve(READY) });

    expect(marks).toEqual([false]);
  });
});
