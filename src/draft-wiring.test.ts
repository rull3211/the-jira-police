import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type Settings, readSettings } from "./settings.ts";

// Stubs the session, so nothing here can start storecode or reach Jira.
const runDraftSession = vi.hoisted(() => vi.fn());
vi.mock("./draft/runner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./draft/runner.ts")>()),
  runDraftSession,
}));

const { threadDraftDeps } = await import("./wiring.ts");

afterEach(() => {
  runDraftSession.mockReset();
});

/** Every timeout distinct, so a setting read in place of its neighbour shows. */
function settingsAt(root: string): Settings {
  return readSettings({
    JIRA_EMAIL: "a@b.c",
    JIRA_AUTH: "placeholder",
    SLACK_BOT_TOKEN: "xoxb-placeholder",
    STORECODE_PATH: "/opt/storecode",
    VAULT_PATH: "/vault",
    DRAFT_TIMEOUT_MS: "1111111",
    TRIAGE_TIMEOUT_MS: "2222222",
    SESSION_IDLE_TIMEOUT_MS: "3333333",
    SOLVE_REPO_ROOT: root,
    SOLVE_REPOS: "commerce-rest",
  });
}

function checkoutRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "draft-deps-"));
  mkdirSync(join(root, "commerce-rest"));
  return root;
}

describe("threadDraftDeps", () => {
  it("runs the session with the draft's own timeout, the idle timeout, and the settings' paths", async () => {
    const root = checkoutRoot();
    runDraftSession.mockResolvedValue({});

    await threadDraftDeps(settingsAt(root)).draft("<@U1> at 1.1:\n> hi", "C1-1.1");

    expect(runDraftSession).toHaveBeenCalledOnce();
    expect(runDraftSession.mock.calls[0]?.[0]).toEqual({
      threadLabel: "C1-1.1",
      thread: "<@U1> at 1.1:\n> hi",
      executable: "/opt/storecode",
      workingDirectory: process.cwd(),
      idleMs: 3_333_333,
      maxRunMs: 1_111_111,
      readDirs: [join(root, "commerce-rest")],
      vaultPath: "/vault",
    });
  });

  it("hands the session the caller's signal, and none when the caller has none", async () => {
    const settings = settingsAt(checkoutRoot());
    const controller = new AbortController();
    runDraftSession.mockResolvedValue({});

    await threadDraftDeps(settings, controller.signal).draft("thread", "label");
    await threadDraftDeps(settings).draft("thread", "label");

    expect(runDraftSession.mock.calls[0]?.[0].signal).toBe(controller.signal);
    expect(runDraftSession.mock.calls[1]?.[0]).not.toHaveProperty("signal");
  });
});
