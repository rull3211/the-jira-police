import { describe, expect, it, vi } from "vitest";

import { type Settings, SettingsError, readSettings } from "./settings.ts";
import { createSlackListener } from "./slack-loop.ts";
import type { ListenDeps, ListenSummary } from "./slack/socket.ts";
import type { Mention } from "./slack/start.ts";

const ENV = { JIRA_EMAIL: "a@b.c", JIRA_AUTH: "placeholder" };

function settingsWith(overrides: Partial<Record<string, string>>): Settings {
  return readSettings({ ...ENV, ...overrides });
}

/** Never called while the listener is off; a call means something was built that should not be. */
const UNUSED = vi.fn<(deps: ListenDeps) => Promise<ListenSummary>>();

const MENTION: Mention = {
  userId: "U0ME",
  text: "<@U0BOT> start",
  channel: "C0CHAN",
  ts: "1790779745.218229",
  threadTs: "1790779480.401999",
};

describe("createSlackListener", () => {
  it("builds nothing while SLACK_LISTEN is off, the default, so no token is asked for", () => {
    expect(createSlackListener(settingsWith({}), new AbortController().signal, UNUSED)).toBeNull();
    expect(UNUSED).not.toHaveBeenCalled();
  });

  it("refuses at startup a mode it does not know, and a mode on with no app-level token", () => {
    const signal = new AbortController().signal;

    expect(() => createSlackListener(settingsWith({ SLACK_LISTEN: "yes" }), signal)).toThrow(
      /SLACK_LISTEN \(expected "off", "dry" or "live"/u,
    );
    expect(() => createSlackListener(settingsWith({ SLACK_LISTEN: "live" }), signal)).toThrow(
      SettingsError,
    );
    expect(() =>
      createSlackListener(
        settingsWith({ SLACK_LISTEN: "dry", SLACK_APP_TOKEN: "xoxb-1-bot" }),
        signal,
      ),
    ).toThrow(/expected an app-level token starting xapp-/u);
  });

  it("listens on the daemon's shutdown signal", async () => {
    const controller = new AbortController();
    const run = vi.fn(async (deps: ListenDeps) => {
      expect(deps.signal).toBe(controller.signal);
      return { connections: 1, commands: 2, mentions: 0 };
    });

    const listener = createSlackListener(
      settingsWith({ SLACK_LISTEN: "live", SLACK_APP_TOKEN: "xapp-1-abc" }),
      controller.signal,
      run,
    );

    expect(await listener?.()).toEqual({ connections: 1, commands: 2, mentions: 0 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("with nobody on SLACK_START_USERS, asks for no bot token and answers a mention by doing nothing", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    try {
      let heard: ListenDeps["mention"] | undefined;
      const listener = createSlackListener(
        settingsWith({ SLACK_LISTEN: "live", SLACK_APP_TOKEN: "xapp-1-abc" }),
        new AbortController().signal,
        async (deps) => {
          heard = deps.mention;
          return { connections: 0, commands: 0, mentions: 0 };
        },
      );
      await listener?.();

      await heard?.({ ...MENTION, userId: "U0ANYONE" });

      expect(heard).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("with someone on SLACK_START_USERS, refuses at startup a missing bot token and an entry that is not a member ID", () => {
    const signal = new AbortController().signal;
    const on = { SLACK_LISTEN: "dry", SLACK_APP_TOKEN: "xapp-1-abc" };

    expect(() =>
      createSlackListener(settingsWith({ ...on, SLACK_START_USERS: "U0ME" }), signal),
    ).toThrow(/SLACK_BOT_TOKEN \(the bot token/u);
    expect(() =>
      createSlackListener(
        settingsWith({ ...on, SLACK_START_USERS: "U0ME, @bence", SLACK_BOT_TOKEN: "xoxb-1-abc" }),
        signal,
      ),
    ).toThrow(/SLACK_START_USERS \(expected member IDs such as U0123ABCD, got "@bence"\)/u);
  });

  it("with someone on SLACK_START_USERS, refuses anyone else in the thread, reading nothing first", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      let heard: ListenDeps["mention"] | undefined;
      const listener = createSlackListener(
        settingsWith({
          SLACK_LISTEN: "live",
          SLACK_APP_TOKEN: "xapp-1-abc",
          SLACK_BOT_TOKEN: "xoxb-1-abc",
          SLACK_START_USERS: "U0ME",
        }),
        new AbortController().signal,
        async (deps) => {
          heard = deps.mention;
          return { connections: 0, commands: 0, mentions: 0 };
        },
      );
      await listener?.();

      await heard?.({ ...MENTION, userId: "U0STRANGER" });

      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(urls).toEqual(["https://slack.com/api/chat.postEphemeral"]);
      const form = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect([form.get("user"), form.get("channel"), form.get("thread_ts")]).toEqual([
        "U0STRANGER",
        MENTION.channel,
        MENTION.threadTs,
      ]);
      expect(form.get("text")).toContain("not one of them");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves instead of rejecting when the listener breaks, so the daemon's Promise.all survives it", async () => {
    const listener = createSlackListener(
      settingsWith({ SLACK_LISTEN: "dry", SLACK_APP_TOKEN: "xapp-1-abc" }),
      new AbortController().signal,
      async () => {
        throw new Error("socket exploded");
      },
    );

    await expect(listener?.()).resolves.toBeNull();
  });
});
