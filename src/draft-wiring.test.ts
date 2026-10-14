import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type Settings, SettingsError, readSettings } from "./settings.ts";

// Stubs the session, so nothing here can start storecode or reach Jira.
const runDraftSession = vi.hoisted(() => vi.fn());
vi.mock("./draft/runner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./draft/runner.ts")>()),
  runDraftSession,
}));

const {
  buttonWithheld,
  draftDelivery,
  draftHandlerFor,
  draftOfferFor,
  draftProjects,
  pendingDirectory,
  threadDraftDeps,
} = await import("./wiring.ts");

afterEach(() => {
  runDraftSession.mockReset();
  vi.unstubAllGlobals();
});

/** Every timeout distinct, so a setting read in place of its neighbour shows. */
function settingsAt(root: string, extra: Record<string, string> = {}): Settings {
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
    ...extra,
  });
}

function checkoutRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "draft-deps-"));
  mkdirSync(join(root, "commerce-rest"));
  return root;
}

interface Call {
  readonly host: "slack" | "jira";
  readonly what: string;
  readonly form: URLSearchParams;
}

function reply(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function directMessage(calls: readonly Call[]): URLSearchParams {
  const sent = calls.filter((call) => call.what === "chat.postMessage");
  expect(sent).toHaveLength(1);
  return sent[0]?.form ?? new URLSearchParams();
}

function buttonValue(form: URLSearchParams): string {
  const blocks = JSON.parse(form.get("blocks") ?? "[]") as {
    type: string;
    elements?: { action_id: string; value: string }[];
  }[];
  const value = blocks.find((block) => block.type === "actions")?.elements?.[0]?.value;
  expect(value).toMatch(/^d-[0-9a-f]{24}$/u);
  return value ?? "";
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

describe("draftProjects", () => {
  const read = (value: string): readonly string[] =>
    draftProjects(settingsAt(checkoutRoot(), { DRAFT_PROJECTS: value }));

  it("lists nothing by default, so no project is allowed until one is typed", () => {
    expect(draftProjects(settingsAt(checkoutRoot()))).toEqual([]);
  });

  it("reads project keys, once each", () => {
    expect(read("SSX, OPS ,SSX")).toEqual(["SSX", "OPS"]);
  });

  it.each(["ssx", "SSX-1", "SSX/../x", "S S", "SSX,oops"])(
    "refuses the whole list at startup when one entry, %j, is not a project key",
    (value) => {
      expect(() => read(value)).toThrow(SettingsError);
      expect(() => read(value)).toThrow(/DRAFT_PROJECTS \(expected project keys such as SSX/u);
    },
  );
});

describe("buttonWithheld", () => {
  const on = { DRAFT_PROJECTS: "SSX", SLACK_DRAFT_USERS: "U0ME" };
  const withheld = (
    extra: Record<string, string>,
    recipient: string | null,
    sending: boolean,
  ): string | null => buttonWithheld(settingsAt(checkoutRoot(), extra), recipient, sending);

  it("withholds nothing from an operator who may press it", () => {
    expect(withheld(on, "U0ME", true)).toBeNull();
  });

  it("withholds the button from an operator off the draft list, and says so", () => {
    expect(withheld(on, "U0OTHER", true)).toMatch(
      /SLACK_OPERATOR_USER_ID is not on SLACK_DRAFT_USERS/u,
    );
    expect(withheld({ ...on, SLACK_DRAFT_USERS: "" }, "U0ME", true)).not.toBeNull();
  });

  it("withholds it when no operator is named, since nobody could press it", () => {
    expect(withheld(on, null, true)).not.toBeNull();
  });

  it("has nothing to withhold while nothing is sent, or while no project is listed", () => {
    expect(withheld(on, "U0OTHER", false)).toBeNull();
    expect(withheld({ SLACK_DRAFT_USERS: "U0ME" }, "U0OTHER", true)).toBeNull();
  });
});

describe("pendingDirectory", () => {
  it("sits beside the poll state, wherever STATE_PATH puts it", () => {
    expect(
      pendingDirectory(settingsAt(checkoutRoot(), { STATE_PATH: "/var/lib/jp/poll.json" })),
    ).toBe("/var/lib/jp/pending-drafts");
  });
});

describe("the Post button, from a mention to a direct message", () => {
  const ASKER = "U0ASKER1";
  const MENTION = {
    userId: ASKER,
    text: "<@U0BOT> draft",
    channel: "C0THREAD1",
    ts: "1712345699.000200",
    threadTs: "1712345678.000100",
  };
  const RESULT = {
    ticket: {
      summary: "commerce-rest: raise the export timeout",
      project: "SSX",
      component: "SSX Advisor",
      issueType: "Oppgave",
      description: "## Where\n\n- `Export.ts:12`",
    },
    duplicate: null,
    reason: "One ask.",
    questions: [],
    reposRead: ["commerce-rest"],
    injectionNoticed: [],
  };

  /** Slack and Jira at `fetch`, answering as each would for one thread and one project. */
  function wire(options: { readonly sendFails?: boolean } = {}): { readonly calls: Call[] } {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        const href = String(url);
        const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        if (href.startsWith("https://slack.com/api/")) {
          const what = href.slice("https://slack.com/api/".length);
          calls.push({ host: "slack", what, form });
          if (what === "conversations.replies") {
            return reply({
              ok: true,
              messages: [
                { ts: "1712345678.000100", user: ASKER, text: "raise the export timeout" },
              ],
            });
          }
          if (what === "chat.getPermalink") {
            return reply({
              ok: true,
              permalink: "https://acme.slack.com/archives/C0THREAD1/p1712345678000100",
            });
          }
          if (what === "chat.postMessage" && options.sendFails === true) {
            return reply({ ok: false, error: "account_inactive" });
          }
          return reply({ ok: true, ts: "9.9", channel: "D0DM" });
        }
        const what = new URL(href).pathname;
        calls.push({ host: "jira", what, form });
        if (what === "/rest/api/3/project/SSX/components") {
          return reply([{ name: "SSX Advisor" }]);
        }
        if (what === "/rest/api/3/project/SSX") {
          return reply({ issueTypes: [{ name: "Oppgave", subtask: false }] });
        }
        throw new Error(`unexpected request to ${href}`);
      }),
    );
    return { calls };
  }

  async function ask(
    root: string,
    extra: Record<string, string>,
    mode: "dry" | "live" = "live",
  ): Promise<void> {
    const handler = draftHandlerFor(
      settingsAt(root, {
        SLACK_DRAFT_USERS: ASKER,
        STATE_PATH: join(root, "state", "poll.json"),
        OUTPUT_DIR: join(root, "out"),
        ...extra,
      }),
      mode,
      new AbortController().signal,
    );
    await handler.handle(MENTION);
    await handler.settled();
  }

  it("sends a ticket in a listed project with a Post button, and keeps the record the button names", async () => {
    const root = checkoutRoot();
    const { calls } = wire();
    runDraftSession.mockResolvedValue(RESULT);

    await ask(root, { DRAFT_PROJECTS: "SSX" });

    const form = directMessage(calls);
    expect(form.get("channel")).toBe(ASKER);
    const id = buttonValue(form);
    const kept: unknown = JSON.parse(
      readFileSync(join(root, "state", "pending-drafts", `${id}.json`), "utf8"),
    );
    expect(kept).toMatchObject({
      id,
      asker: ASKER,
      thread: { channel: "C0THREAD1", threadTs: "1712345678.000100" },
      ticket: RESULT.ticket,
    });
    expect(form.get("blocks")).toContain("Pressing *Post to Jira* does nothing yet.");
  });

  it("sends the draft it always sent while nothing is on DRAFT_PROJECTS, and asks Jira nothing", async () => {
    const root = checkoutRoot();
    const { calls } = wire();
    runDraftSession.mockResolvedValue(RESULT);

    await ask(root, {});

    const form = directMessage(calls);
    expect(form.has("blocks")).toBe(false);
    expect(form.get("text")).not.toContain("Not offered for posting");
    expect(calls.filter((call) => call.host === "jira")).toEqual([]);
    expect(existsSync(join(root, "state", "pending-drafts"))).toBe(false);
  });

  it("says why a draft in a project that is not listed has no button, keeping nothing and asking Jira nothing", async () => {
    const root = checkoutRoot();
    const { calls } = wire();
    runDraftSession.mockResolvedValue(RESULT);

    await ask(root, { DRAFT_PROJECTS: "OPS" });

    const form = directMessage(calls);
    expect(form.has("blocks")).toBe(false);
    expect(form.get("text")).toContain("Not offered for posting: SSX is not on DRAFT_PROJECTS.");
    expect(calls.filter((call) => call.host === "jira")).toEqual([]);
    expect(existsSync(join(root, "state", "pending-drafts"))).toBe(false);
  });

  it("forgets the record when Slack refuses the message that carried its button", async () => {
    const root = checkoutRoot();
    wire({ sendFails: true });
    runDraftSession.mockResolvedValue(RESULT);

    await ask(root, { DRAFT_PROJECTS: "SSX" });

    expect(readdirSync(join(root, "state", "pending-drafts"))).toEqual([]);
  });

  it("in a dry run writes the message with its blocks, sends nothing, and keeps no record", async () => {
    const root = checkoutRoot();
    const { calls } = wire();
    runDraftSession.mockResolvedValue(RESULT);

    await ask(root, { DRAFT_PROJECTS: "SSX" }, "dry");

    expect(calls.filter((call) => call.what === "chat.postMessage")).toEqual([]);
    const written = JSON.parse(
      readFileSync(join(root, "out", "slack", "C0THREAD1-1712345678.000100.dm.json"), "utf8"),
    ) as { channel: string; blocks: { type: string }[] };
    expect(written.channel).toBe(ASKER);
    expect(written.blocks.at(-1)?.type).toBe("actions");
    expect(existsSync(join(root, "state", "pending-drafts"))).toBe(false);
  });
});

describe("draftOfferFor", () => {
  it("builds nothing while no project is listed, and so reaches no Jira", () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    expect(draftOfferFor(settingsAt(checkoutRoot()), true)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed project at startup rather than at the first draft", () => {
    expect(() =>
      draftOfferFor(settingsAt(checkoutRoot(), { DRAFT_PROJECTS: "ssx" }), true),
    ).toThrow(SettingsError);
  });
});

describe("draftDelivery", () => {
  it("writes a dry message's blocks only when it has any", async () => {
    const root = checkoutRoot();
    const settings = settingsAt(root, { OUTPUT_DIR: join(root, "out") });
    const deliver = draftDelivery(settings, "dry");

    await deliver("U0ASKER1", "with", "text", [{ type: "divider" }]);
    await deliver("U0ASKER1", "without", "text");

    const read = (name: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(root, "out", "slack", `${name}.dm.json`), "utf8"));
    expect(read("with")).toMatchObject({ blocks: [{ type: "divider" }] });
    expect(read("without")).not.toHaveProperty("blocks");
  });
});
