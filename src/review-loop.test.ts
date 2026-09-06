import { describe, expect, it } from "vitest";

import type { JiraClient } from "./jira/client.ts";
import { createReviewLoop } from "./review-loop.ts";
import { type Settings, SettingsError, readSettings } from "./settings.ts";
import type { AttemptLedger } from "./solve/attempts.ts";

/** Minimum environment that satisfies the required settings. */
const ENV = { JIRA_EMAIL: "a@b.c", JIRA_AUTH: "placeholder" };

function settingsWith(overrides: Partial<Record<string, string>>): Settings {
  return readSettings({ ...ENV, ...overrides });
}

/**
 * Never called: nothing here starts a loop.
 *
 * `createReviewLoop` composes a schedule and returns it, so every assertion
 * below reads what it decided rather than watching it happen. A client that
 * throws on use is the cheapest way to keep it that way — if a future change
 * makes this function reach Jira, these tests fail rather than quietly
 * acquiring a network dependency.
 */
const CLIENT = new Proxy({} as JiraClient, {
  get() {
    throw new Error("createReviewLoop must not touch Jira");
  },
});

const ARMED = {
  SOLVE_ENABLED: "true",
  VAULT_PATH: "/vaults/insurance-knowledge-vault",
};

/** A ledger for the cases that never tick, and so never consult one. */
const UNUSED_LEDGER: AttemptLedger = {
  exhausted: () => false,
  attempted: () => {},
  countFor: () => 0,
  size: () => 0,
};

describe("createReviewLoop", () => {
  it("schedules nothing when SOLVE_ENABLED is off", () => {
    const loop = createReviewLoop(
      settingsWith({ ...ARMED, SOLVE_ENABLED: "false" }),
      CLIENT,
      new AbortController().signal,
      900_000,
      UNUSED_LEDGER,
    );
    expect(loop).toBeNull();
  });

  // The guard is the *order* rather than the switch. Build the dependencies
  // first and a grooming-only daemon — the configuration this service has run
  // in since before the solver existed — refuses to start, for want of a vault
  // path it would never read. The operator's fault report would be "it stopped
  // working", and the cause would be a feature they had switched off.
  it("does not need a vault path when the solve side is off", () => {
    expect(() =>
      createReviewLoop(
        settingsWith({ SOLVE_ENABLED: "false", VAULT_PATH: "" }),
        CLIENT,
        new AbortController().signal,
        900_000,
        UNUSED_LEDGER,
      ),
    ).not.toThrow();
  });

  // The other half of the same ordering, and the reason the dependencies are
  // built here at all: with the solve side armed, a missing vault path is a
  // startup error. Left to the tick, it is a cycle that throws identically
  // every two minutes, backs off to the cap, and reports itself only as
  // "loop.cycle_failed".
  it("refuses at startup when the solve side is armed with no vault path", () => {
    expect(() =>
      createReviewLoop(
        settingsWith({ SOLVE_ENABLED: "true", VAULT_PATH: "" }),
        CLIENT,
        new AbortController().signal,
        900_000,
        UNUSED_LEDGER,
      ),
    ).toThrow(SettingsError);
  });

  it("ticks on REVIEW_POLL_MS, not on the poll cadence", () => {
    const loop = createReviewLoop(
      settingsWith({ ...ARMED, REVIEW_POLL_MS: "45000", POLL_INTERVAL_MS: "300000" }),
      CLIENT,
      new AbortController().signal,
      900_000,
      UNUSED_LEDGER,
    );
    expect(loop?.intervalMs).toBe(45_000);
  });

  it("carries the caller's backoff cap and shutdown signal", () => {
    // Both are pass-throughs and both fail silently if dropped: a loop with no
    // signal ignores Ctrl-C until its own cycle ends, and one built with the
    // default cap would back off on a schedule nobody chose.
    const controller = new AbortController();
    const loop = createReviewLoop(
      settingsWith(ARMED),
      CLIENT,
      controller.signal,
      123_000,
      UNUSED_LEDGER,
    );
    expect(loop?.backoffCapMs).toBe(123_000);
    expect(loop?.signal).toBe(controller.signal);
  });

  it("accepts a per-tick bound of zero, which is the dry run", () => {
    // Zero is meaningful — look at everything, pay for nothing — so it must not
    // be treated as unset and floored up to the default of three.
    expect(() =>
      createReviewLoop(
        settingsWith({ ...ARMED, MAX_REVIEW_ROUNDS_PER_TICK: "0" }),
        CLIENT,
        new AbortController().signal,
        900_000,
        UNUSED_LEDGER,
      ),
    ).not.toThrow();
  });
});

/**
 * A client that answers every query with nothing and writes down what it was
 * asked, in order.
 *
 * Both halves of a tick start with a search and neither can act on an empty
 * board, so the pair of query strings is the whole tick made observable without
 * a repository, a `gh`, or a paid pass anywhere in it.
 */
function recordingClient(asked: string[]): JiraClient {
  return {
    search: async (jql: string) => {
      asked.push(jql);
      return [];
    },
  } as unknown as JiraClient;
}

describe("what one review tick does, in order", () => {
  it("advances what is under review before it claims anything new", async () => {
    // **The mutation this exists for.** §6's rule is *advance, then claim*, and
    // it is not a preference: at `MAX_CONCURRENT_SOLVES=1` a tick that claims
    // first spends the only slot on a new ticket, and the pull request a human
    // is waiting on is not read until the tick after — every tick, for as long
    // as the queue has anything in it. Swap the two `await`s in `runCycle` and
    // nothing else in this suite notices, because both halves succeed either
    // way. The order is the behaviour.
    const asked: string[] = [];
    const loop = createReviewLoop(
      settingsWith(ARMED),
      recordingClient(asked),
      new AbortController().signal,
      900_000,
      UNUSED_LEDGER,
    );

    await loop?.runCycle();

    const reviewFirst = asked.findIndex((jql) => jql.includes("agent:reviewing"));
    const claimNext = asked.findIndex((jql) => jql.includes("agent:solvable"));
    expect(reviewFirst).toBeGreaterThanOrEqual(0);
    expect(claimNext).toBeGreaterThanOrEqual(0);
    expect(reviewFirst).toBeLessThan(claimNext);
  });

  it("claims at all, which is the whole of Phase E", async () => {
    // Before this change the tick was `runReviewSweep` alone, so the solve queue
    // was read by nothing on a timer: a ticket the watch handed back as
    // `agent:solvable` sat there until a person typed `solve:once`. Delete the
    // second `await` and the assertion above still passes on its first half.
    const asked: string[] = [];
    const loop = createReviewLoop(
      settingsWith(ARMED),
      recordingClient(asked),
      new AbortController().signal,
      900_000,
      UNUSED_LEDGER,
    );

    await loop?.runCycle();

    expect(asked.some((jql) => jql.includes("agent:solvable"))).toBe(true);
  });

  it("does not consult the ledger for a ticket the queue did not offer", async () => {
    // The ledger is read per candidate, not per tick. Hoisting it out — asking
    // once and skipping the sweep — would turn one exhausted ticket into a stop
    // on the whole queue, which looks from the board like an idle daemon rather
    // than like a brake.
    const ledger: AttemptLedger = {
      exhausted: () => {
        throw new Error("nothing was offered, so nothing should have been weighed");
      },
      attempted: () => {
        throw new Error("nothing was offered, so nothing should have been claimed");
      },
      countFor: () => 0,
      size: () => 0,
    };

    const loop = createReviewLoop(
      settingsWith(ARMED),
      recordingClient([]),
      new AbortController().signal,
      900_000,
      ledger,
    );

    await expect(loop?.runCycle()).resolves.toBeUndefined();
  });
});

describe("the mode the daemon claims under, which is the human gate", () => {
  it("asks for agent:start in manual mode, which is the default", async () => {
    // **The most security-relevant line in the daemon.** Manual mode is the
    // default posture and the only thing standing between "triage thinks this
    // is fixable" and a machine writing code unasked. The daemon claims under
    // `solveMode(settings)`, never under `named` — `named` is self-authorising
    // because a person typed the key, and there is nobody here to type one.
    // Hardcode the authority and the human gate is gone from the one path where
    // nobody is watching, silently, with every other test still green.
    const asked: string[] = [];
    const loop = createReviewLoop(
      settingsWith({ ...ARMED, SOLVE_MODE: "manual" }),
      recordingClient(asked),
      new AbortController().signal,
      900_000,
      UNUSED_LEDGER,
    );
    await loop?.runCycle();

    const queue = asked.find((jql) => jql.includes("agent:solvable")) ?? "";
    expect(queue).toContain("agent:start");
  });

  it("drops that clause in auto mode and takes an issue-type restriction instead", async () => {
    // Auto is not manual-minus-a-check: it gives up the human label and takes
    // on `SOLVE_AUTO_ISSUE_TYPES` in exchange. A daemon that dropped the first
    // without applying the second would claim every solvable ticket on the
    // board, which is the widest this service can be made to spend.
    const asked: string[] = [];
    const loop = createReviewLoop(
      settingsWith({ ...ARMED, SOLVE_MODE: "auto", SOLVE_AUTO_ISSUE_TYPES: "Feil" }),
      recordingClient(asked),
      new AbortController().signal,
      900_000,
      UNUSED_LEDGER,
    );
    await loop?.runCycle();

    const queue = asked.find((jql) => jql.includes("agent:solvable")) ?? "";
    expect(queue).not.toContain("agent:start");
    expect(queue).toContain("Feil");
  });

  it("refuses to start on a mode it does not recognise", () => {
    // Not a fallback to manual. Guessing here guesses in the direction of more
    // privilege on the reading that a typo is more likely to be a typo for
    // "auto" than a deliberate choice — so it is a startup error, beside the
    // setting it was read from, rather than a posture nobody chose.
    expect(() =>
      createReviewLoop(
        settingsWith({ ...ARMED, SOLVE_MODE: "automatic" }),
        CLIENT,
        new AbortController().signal,
        900_000,
        UNUSED_LEDGER,
      ),
    ).toThrow(SettingsError);
  });
});
