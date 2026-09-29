import { describe, expect, it, vi } from "vitest";

import { type Settings, SettingsError, readSettings } from "./settings.ts";
import { createSlackListener } from "./slack-loop.ts";
import type { ListenDeps, ListenSummary } from "./slack/socket.ts";

const ENV = { JIRA_EMAIL: "a@b.c", JIRA_AUTH: "placeholder" };

function settingsWith(overrides: Partial<Record<string, string>>): Settings {
  return readSettings({ ...ENV, ...overrides });
}

/** Never called while the listener is off; a call means something was built that should not be. */
const UNUSED = vi.fn<(deps: ListenDeps) => Promise<ListenSummary>>();

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
      return { connections: 1, commands: 2 };
    });

    const listener = createSlackListener(
      settingsWith({ SLACK_LISTEN: "live", SLACK_APP_TOKEN: "xapp-1-abc" }),
      controller.signal,
      run,
    );

    expect(await listener?.()).toEqual({ connections: 1, commands: 2 });
    expect(run).toHaveBeenCalledTimes(1);
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
