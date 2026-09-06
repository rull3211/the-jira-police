import { describe, expect, it } from "vitest";

import type { JiraClient } from "./jira/client.ts";
import { createReviewLoop } from "./review-loop.ts";
import { type Settings, SettingsError, readSettings } from "./settings.ts";

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

describe("createReviewLoop", () => {
  it("schedules nothing when SOLVE_ENABLED is off", () => {
    const loop = createReviewLoop(
      settingsWith({ ...ARMED, SOLVE_ENABLED: "false" }),
      CLIENT,
      new AbortController().signal,
      900_000,
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
      ),
    ).toThrow(SettingsError);
  });

  it("ticks on REVIEW_POLL_MS, not on the poll cadence", () => {
    const loop = createReviewLoop(
      settingsWith({ ...ARMED, REVIEW_POLL_MS: "45000", POLL_INTERVAL_MS: "300000" }),
      CLIENT,
      new AbortController().signal,
      900_000,
    );
    expect(loop?.intervalMs).toBe(45_000);
  });

  it("carries the caller's backoff cap and shutdown signal", () => {
    // Both are pass-throughs and both fail silently if dropped: a loop with no
    // signal ignores Ctrl-C until its own cycle ends, and one built with the
    // default cap would back off on a schedule nobody chose.
    const controller = new AbortController();
    const loop = createReviewLoop(settingsWith(ARMED), CLIENT, controller.signal, 123_000);
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
      ),
    ).not.toThrow();
  });
});
