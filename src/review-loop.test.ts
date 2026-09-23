import { describe, expect, it, vi } from "vitest";

import type { JiraClient } from "./jira/client.ts";
import { createReviewLoop } from "./review-loop.ts";
import { type Settings, SettingsError, readSettings } from "./settings.ts";
import type { AttemptLedger } from "./solve/attempts.ts";

/** Minimum environment that satisfies the required settings. */
const ENV = { JIRA_EMAIL: "a@b.c", JIRA_AUTH: "placeholder" };

function settingsWith(overrides: Partial<Record<string, string>>): Settings {
  return readSettings({ ...ENV, ...overrides });
}

/** Never called; throws so a future change that makes `createReviewLoop` touch Jira fails loudly. */
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

  // Building dependencies before the switch check would make a grooming-only daemon refuse to
  // start for want of a vault path it never reads.
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

  // With the solve side armed, a missing vault path must be a startup error, not a cycle that
  // fails identically forever.
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
    // Both fail silently if dropped: no signal means Ctrl-C is ignored until the cycle ends.
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
    // Zero is meaningful (look at everything, pay for nothing) and must not be floored to the default.
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

/** Every log line `createReviewLoop` wrote while starting, parsed, keyed on nothing but what it said. */
function startupLog(overrides: Partial<Record<string, string>>): Record<string, unknown>[] {
  const lines: string[] = [];
  const keep = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  // `vitest.config.ts` silences the logger for every test, which would make this assert on nothing.
  const level = process.env["LOG_LEVEL"];
  process.env["LOG_LEVEL"] = "info";
  vi.spyOn(process.stdout, "write").mockImplementation(keep);
  vi.spyOn(process.stderr, "write").mockImplementation(keep);
  try {
    createReviewLoop(
      settingsWith({ ...ARMED, ...overrides }),
      CLIENT,
      new AbortController().signal,
      900_000,
      UNUSED_LEDGER,
    );
  } finally {
    vi.restoreAllMocks();
    if (level === undefined) {
      delete process.env["LOG_LEVEL"];
    } else {
      process.env["LOG_LEVEL"] = level;
    }
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const said = (log: readonly Record<string, unknown>[], message: string) =>
  log.find((line) => line["message"] === message);

describe("what the daemon says about repair rounds when it starts", () => {
  it("reports that it promotes none unless REPAIR_PUBLISH is on", () => {
    // The loop's arming is not visible anywhere else an operator looks before the first tick.
    expect(said(startupLog({}), "review.loop.start")?.["promotesRepairs"]).toBe(false);
    expect(
      said(startupLog({ REPAIR_PUBLISH: "true" }), "review.loop.start")?.["promotesRepairs"],
    ).toBe(true);
  });

  it("warns when REPAIR_PUBLISH is on with no round for it to act on", () => {
    const inert = startupLog({ REPAIR_PUBLISH: "true", REPAIR_ROUND: "false" });
    expect(said(inert, "review.loop.repair_publish_inert")).toMatchObject({ level: "warn" });
    expect(said(inert, "review.loop.start")?.["promotesRepairs"]).toBe(false);
  });

  it("stays quiet about it when the two agree", () => {
    for (const overrides of [{}, { REPAIR_PUBLISH: "true" }, { REPAIR_ROUND: "false" }]) {
      expect(said(startupLog(overrides), "review.loop.repair_publish_inert")).toBeUndefined();
    }
  });
});

/** Answers every query with nothing and records what it was asked, in order. */
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
    // §6: advance, then claim. Swap the two `await`s in `runCycle` and nothing else in this
    // suite notices — the order is the behaviour under test here.
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
    // Delete the second `await` in `runCycle` and the assertion above still passes on its first half.
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
    // Read per candidate, not per tick: hoisted out, one exhausted ticket would stop the whole
    // queue rather than just itself.
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
    // The human gate: the daemon must claim under `solveMode(settings)`, never under `named`,
    // since `named` is self-authorising by a person typing the key — which nobody does here.
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
    // Dropping the human label without applying `SOLVE_AUTO_ISSUE_TYPES` would claim every
    // solvable ticket on the board.
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
    // Not a fallback to manual: a typo could as easily mean "auto", so an unrecognised mode
    // is a startup error rather than a guessed posture.
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
