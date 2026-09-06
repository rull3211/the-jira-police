import { describe, expect, it } from "vitest";

import type { IssueActivity, JiraClient } from "./jira/client.ts";
import { type Settings, SettingsError, readSettings } from "./settings.ts";
import { createWatchLoop } from "./watch-loop.ts";
import { FOOTER_TEXT } from "./watch/decide.ts";
import type { WatchMemo } from "./watch/memo.ts";

/** Minimum environment that satisfies the required settings. */
const ENV = { JIRA_EMAIL: "a@b.c", JIRA_AUTH: "placeholder" };

function settingsWith(overrides: Partial<Record<string, string>>): Settings {
  return readSettings({ ...ENV, ...overrides });
}

/**
 * Never called by the tests that only read the schedule.
 *
 * `createWatchLoop` composes a loop and returns it without running it, so those
 * assertions read what it decided rather than watching it happen. A client that
 * throws on any use keeps it that way: if a future change makes construction
 * reach Jira, they fail instead of quietly acquiring a network dependency.
 */
const CLIENT = new Proxy({} as JiraClient, {
  get() {
    throw new Error("createWatchLoop must not touch Jira before it ticks");
  },
});

/**
 * A watch armed the way the daemon arms it.
 *
 * `SKILL_NAME` is named rather than left to default, and the two vault tests
 * below are worth nothing without it: the fallback is `mock-triage`, a stand-in
 * that needs no vault, so an armed loop built on the default would never have
 * reached the check they claim to be about.
 */
const ARMED = {
  WATCH_ENABLED: "true",
  SKILL_NAME: "intake-triage",
  VAULT_PATH: "/vaults/insurance-knowledge-vault",
};

/** A memo that never remembers anything, for the cases that never tick. */
const UNUSED_MEMO: WatchMemo = {
  seen: () => false,
  declined: () => {},
  size: () => 0,
};

describe("createWatchLoop", () => {
  it("schedules nothing when WATCH_ENABLED is off", () => {
    const loop = createWatchLoop(
      settingsWith({ ...ARMED, WATCH_ENABLED: "false" }),
      CLIENT,
      new AbortController().signal,
      900_000,
      UNUSED_MEMO,
    );
    expect(loop).toBeNull();
  });

  // The guard is the *order* rather than the switch, and it is the same one
  // `createReviewLoop` makes: build the dependencies first and a grooming-only
  // daemon refuses to start, for want of a vault path it would never read. The
  // operator's report would be "it stopped working" and the cause would be a
  // feature they had switched off.
  it("does not need a vault path when the watch is off", () => {
    expect(() =>
      createWatchLoop(
        settingsWith({ ...ARMED, WATCH_ENABLED: "false", VAULT_PATH: "" }),
        CLIENT,
        new AbortController().signal,
        900_000,
        UNUSED_MEMO,
      ),
    ).not.toThrow();
  });

  // The other half, and the reason the re-triage's groom is built here at all:
  // armed, a missing vault path is a startup error rather than a cycle that
  // throws identically every six hours, backs off to the cap, and reports
  // itself only as "loop.cycle_failed" — on the loop nobody is watching.
  it("refuses at startup when the watch is armed with no vault path", () => {
    expect(() =>
      createWatchLoop(
        settingsWith({ ...ARMED, VAULT_PATH: "" }),
        CLIENT,
        new AbortController().signal,
        900_000,
        UNUSED_MEMO,
      ),
    ).toThrow(SettingsError);
  });

  it("ticks on WATCH_POLL_MS, not on either of the other two cadences", () => {
    // Six hours by default and deliberately the slowest thing here: the trigger
    // is a person changing their mind. Reading the poll or review cadence would
    // buy nothing and spend on every ticket in the watched set, every time.
    const loop = createWatchLoop(
      settingsWith({
        ...ARMED,
        WATCH_POLL_MS: "21600000",
        REVIEW_POLL_MS: "120000",
        POLL_INTERVAL_MS: "300000",
      }),
      CLIENT,
      new AbortController().signal,
      900_000,
      UNUSED_MEMO,
    );
    expect(loop?.intervalMs).toBe(21_600_000);
  });

  it("carries the caller's backoff cap and shutdown signal", () => {
    const controller = new AbortController();
    const loop = createWatchLoop(
      settingsWith(ARMED),
      CLIENT,
      controller.signal,
      123_000,
      UNUSED_MEMO,
    );
    expect(loop?.backoffCapMs).toBe(123_000);
    expect(loop?.signal).toBe(controller.signal);
  });
});

/** When the service last spoke, and when somebody else answered. */
const OURS_AT = "2026-09-01T10:00:00.000+0200";
const THEIRS_AT = "2026-09-02T10:00:00.000+0200";

function adf(text: string): unknown {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

/**
 * One watched ticket with an unanswered trigger on it.
 *
 * Our own triage comment first, so there is a high-water mark, then a reply
 * after it, which is what makes `decideWatch` return `retriage` — the one
 * decision that reaches the memo.
 */
const ACTIVITY: IssueActivity = {
  key: "SSX-1234",
  statusCategoryKey: "new",
  labels: ["agent:watching"],
  comments: [
    {
      id: "1",
      author: "bot",
      created: OURS_AT,
      updated: OURS_AT,
      body: adf(`Send back: add a baseline. ${FOOTER_TEXT}`),
    },
    {
      id: "2",
      author: "reporter",
      created: THEIRS_AT,
      updated: THEIRS_AT,
      body: adf("Baseline added to the description."),
    },
  ],
  changes: [],
  content: {
    summary: "Carts fail",
    description: adf("now with a baseline"),
    environment: null,
    attachments: [],
  },
};

function tickingClient(): JiraClient {
  return {
    search: async () => [{ key: ACTIVITY.key }],
    fetchActivity: async () => ACTIVITY,
  } as unknown as JiraClient;
}

describe("the memo the watch loop was handed", () => {
  it("is the one every tick consults, so a refusal is not re-bought forever", async () => {
    // **The mutation this file exists for.** `relevance.ts` names the cost its
    // own design cannot pay: a `no` writes nothing to the ticket, so the
    // trigger is still there next sweep on identical content. The memo is the
    // only record that the answer was already bought — and constructed inside
    // `runCycle` it records nothing that outlives one tick, while every
    // assertion above still passes. Handed in, the mutation has to ignore an
    // argument, and two ticks see that.
    const consulted: { key: string; at: number }[] = [];
    const memo: WatchMemo = {
      seen: (key, at) => {
        consulted.push({ key, at });
        return true;
      },
      declined: () => {
        throw new Error("nothing should be declined: the memo answered `seen` first");
      },
      size: () => consulted.length,
    };

    const loop = createWatchLoop(
      settingsWith(ARMED),
      tickingClient(),
      new AbortController().signal,
      900_000,
      memo,
    );

    await loop?.runCycle();
    await loop?.runCycle();

    expect(consulted).toHaveLength(2);
    // Both ticks asked about the same trigger, which is the fact a per-tick
    // memo can never know and the reason the second look costs nothing.
    expect(consulted[0]).toEqual({ key: "SSX-1234", at: Date.parse(THEIRS_AT) });
    expect(consulted[1]).toEqual(consulted[0]);
  });

  // The *position* of that consultation — before the paid check rather than
  // after it — is not assertable from here: this file cannot reach the checker
  // to count it, and the sweep swallows a re-triage failure, so a late gate
  // would look identical from the outside. It is pinned in `sweep.test.ts`,
  // where the checker is an argument. Written down rather than left as a gap
  // somebody re-discovers by moving the line.
});
