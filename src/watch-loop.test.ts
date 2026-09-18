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

/** Never called by tests that only read the schedule; throws if a future change makes construction reach Jira. */
const CLIENT = new Proxy({} as JiraClient, {
  get() {
    throw new Error("createWatchLoop must not touch Jira before it ticks");
  },
});

/** A watch armed the way the daemon arms it. `SKILL_NAME` must be non-default, or the vault tests below never reach the check they claim to be about (the default `mock-triage` needs no vault). */
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

  // Same guard as `createReviewLoop`: building dependencies before the switch check would
  // refuse to start a watch-off daemon for want of a vault path it never reads.
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

  // Armed, a missing vault path must be a startup error, not a cycle failing identically forever.
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

/** One watched ticket with an unanswered trigger: our comment sets a high-water mark, then a reply after it, making `decideWatch` return `retriage`. */
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
    // A `no` writes nothing to the ticket, so the trigger persists; the memo must be the only
    // record that the answer was already bought, and must outlive a single tick.
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
    // Both ticks ask about the same trigger, which a per-tick memo could never know.
    expect(consulted[0]).toEqual({ key: "SSX-1234", at: Date.parse(THEIRS_AT) });
    expect(consulted[1]).toEqual(consulted[0]);
  });

  // The position of that consultation (before, not after, the paid check) isn't assertable
  // from here; it's pinned in `sweep.test.ts`, where the checker is an argument.
});
