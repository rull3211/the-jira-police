import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type Settings, SettingsError, readSettings } from "./settings.ts";
import type { Click } from "./slack/socket.ts";

// Stubs the session, so nothing here can start storecode or reach Jira.
const runDraftSession = vi.hoisted(() => vi.fn());
vi.mock("./draft/runner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./draft/runner.ts")>()),
  runDraftSession,
}));

const {
  buttonWithheld,
  clickHandlerFor,
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
  readonly method: string;
  readonly what: string;
  readonly form: URLSearchParams;
}

const ASKER = "U0ASKER1";

function press(id: string, userId = ASKER, threadTs: string | null = null): Click {
  return { userId, channel: "D0DM", messageTs: "9.9", threadTs, actionId: "draft_post", value: id };
}

function postedMessages(calls: readonly Call[]): Call[] {
  return calls.filter((call) => call.what === "chat.postMessage");
}

function reply(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** A ticket goes as its first paragraph and the rest in a reply in that message's thread. */
const TICKET_MESSAGES = 2;

/** What the asker was sent, in order: the message, then each reply in its thread. */
function draftMessages(
  calls: readonly Call[],
  count: number = TICKET_MESSAGES,
): readonly URLSearchParams[] {
  const sent = calls.filter((call) => call.what === "chat.postMessage").map((call) => call.form);
  expect(sent).toHaveLength(count);
  return sent;
}

function lastOf(forms: readonly URLSearchParams[]): URLSearchParams {
  return forms.at(-1) ?? new URLSearchParams();
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
  function wire(
    options: {
      readonly sendFails?: boolean;
      /** The 1-based message from which `chat.postMessage` is refused, the ones before it sent. */
      readonly refuseFrom?: number;
      readonly components?: readonly string[];
    } = {},
  ): { readonly calls: Call[] } {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        if (href.startsWith("https://slack.com/api/")) {
          const what = href.slice("https://slack.com/api/".length);
          calls.push({ host: "slack", method, what, form });
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
          if (what === "chat.postMessage") {
            const posted = calls.filter((call) => call.what === "chat.postMessage").length;
            if (options.refuseFrom !== undefined && posted >= options.refuseFrom) {
              return reply({ ok: false, error: "msg_blocks_too_long" });
            }
            // The first message is 9.9 and each later one is another, so a reply under the wrong parent shows.
            return reply({
              ok: true,
              ts: posted === 1 ? "9.9" : `7.${String(posted)}`,
              channel: "D0DM",
            });
          }
          return reply({ ok: true, ts: "9.9", channel: "D0DM" });
        }
        const what = new URL(href).pathname;
        calls.push({ host: "jira", method, what, form });
        if (what === "/rest/api/3/project/SSX/components") {
          return reply((options.components ?? ["SSX Advisor"]).map((name) => ({ name })));
        }
        if (what === "/rest/api/3/project/SSX") {
          return reply({ issueTypes: [{ name: "Oppgave", subtask: false }] });
        }
        throw new Error(`unexpected request to ${href}`);
      }),
    );
    return { calls };
  }

  /** The settings a listener for `ASKER` would hold, with its state and output under `root`. */
  function configured(root: string, extra: Record<string, string>): Settings {
    return settingsAt(root, {
      SLACK_DRAFT_USERS: ASKER,
      STATE_PATH: join(root, "state", "poll.json"),
      OUTPUT_DIR: join(root, "out"),
      ...extra,
    });
  }

  async function ask(
    root: string,
    extra: Record<string, string>,
    mode: "dry" | "live" = "live",
  ): Promise<void> {
    const handler = draftHandlerFor(configured(root, extra), mode, new AbortController().signal);
    await handler.handle(MENTION);
    await handler.settled();
  }

  it("sends a ticket in a listed project with a Post button, and keeps the record the button names", async () => {
    const root = checkoutRoot();
    const { calls } = wire();
    runDraftSession.mockResolvedValue(RESULT);

    await ask(root, { DRAFT_PROJECTS: "SSX" });

    const [message, inThread] = draftMessages(calls);
    expect(message?.get("channel")).toBe(ASKER);
    // The message is the first paragraph, with no button; the ticket's body and the button are in the thread.
    expect(message?.get("text")).toContain("*commerce-rest: raise the export timeout*");
    expect(message?.get("text")).not.toContain("## Where");
    expect(message?.get("blocks")).not.toContain('"actions"');
    expect(inThread?.get("text")).toContain("## Where");
    const id = buttonValue(inThread ?? new URLSearchParams());
    const kept: unknown = JSON.parse(
      readFileSync(join(root, "state", "pending-drafts", `${id}.json`), "utf8"),
    );
    expect(kept).toMatchObject({
      id,
      asker: ASKER,
      thread: { channel: "C0THREAD1", threadTs: "1712345678.000100" },
      ticket: RESULT.ticket,
    });
    expect(inThread?.get("blocks")).toContain("Pressing *Post to Jira* files nothing yet");
  });

  it("sends the draft it always sent while nothing is on DRAFT_PROJECTS, and asks Jira nothing", async () => {
    const root = checkoutRoot();
    const { calls } = wire();
    runDraftSession.mockResolvedValue(RESULT);

    await ask(root, {});

    const messages = draftMessages(calls);
    expect(messages.some((form) => form.has("blocks"))).toBe(false);
    expect(messages.some((form) => form.get("text")?.includes("Not offered for posting"))).toBe(
      false,
    );
    expect(messages[0]?.get("text")).not.toContain("## Where");
    expect(calls.filter((call) => call.host === "jira")).toEqual([]);
    expect(existsSync(join(root, "state", "pending-drafts"))).toBe(false);
  });

  it("says why a draft in a project that is not listed has no button, keeping nothing and asking Jira nothing", async () => {
    const root = checkoutRoot();
    const { calls } = wire();
    runDraftSession.mockResolvedValue(RESULT);

    await ask(root, { DRAFT_PROJECTS: "OPS" });

    const messages = draftMessages(calls);
    expect(messages.some((form) => form.has("blocks"))).toBe(false);
    // The reason is the last thing said, so it lands in the thread with the rest of the draft.
    expect(lastOf(messages).get("text")).toContain(
      "Not offered for posting: SSX is not on DRAFT_PROJECTS.",
    );
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

  describe("and a draft over one message", () => {
    const LONG = Array.from(
      { length: 2000 },
      (_, index) => `line ${String(index)} ${"w".repeat(40)}`,
    ).join("\n");
    const LONG_RESULT = { ...RESULT, ticket: { ...RESULT.ticket, description: LONG } };

    it("goes as a message and replies in its thread, each under the first, with the button under the last", async () => {
      const root = checkoutRoot();
      const { calls } = wire();
      runDraftSession.mockResolvedValue(LONG_RESULT);

      await ask(root, { DRAFT_PROJECTS: "SSX" });

      const messages = postedMessages(calls);
      expect(messages.length).toBeGreaterThan(2);
      const [first, ...replies] = messages;
      expect(first?.form.get("channel")).toBe(ASKER);
      expect(first?.form.has("thread_ts")).toBe(false);
      // The conversation Slack named for the first, and the first as the parent of every one.
      expect(replies.map((message) => message.form.get("channel"))).toEqual(
        replies.map(() => "D0DM"),
      );
      expect(replies.map((message) => message.form.get("thread_ts"))).toEqual(
        replies.map(() => "9.9"),
      );
      expect(
        messages.map((message) => message.form.get("blocks")?.includes('"actions"') ?? false),
      ).toEqual(messages.map((_, index) => index === messages.length - 1));
      const id = buttonValue(messages.at(-1)?.form ?? new URLSearchParams());
      expect(readdirSync(join(root, "state", "pending-drafts"))).toEqual([`${id}.json`]);
    });

    it("forgets the record, and says only the first message went, when a later one is refused", async () => {
      const root = checkoutRoot();
      const { calls } = wire({ refuseFrom: 2 });
      runDraftSession.mockResolvedValue(LONG_RESULT);

      await ask(root, { DRAFT_PROJECTS: "SSX" });

      expect(readdirSync(join(root, "state", "pending-drafts"))).toEqual([]);
      // The mention's own reply came first; the admission that the draft was lost is the last.
      const told = calls.findLast((call) => call.what === "chat.postEphemeral")?.form.get("text");
      expect(told).toMatch(/only the first of \d+ messages was sent, and message 2 failed/u);
      expect(told).toContain("msg_blocks_too_long");
      // The first went and nothing after the refused one was tried.
      expect(postedMessages(calls)).toHaveLength(2);
    });

    it("in a dry run writes the replies beside the first message and sends nothing", async () => {
      const root = checkoutRoot();
      const { calls } = wire();
      runDraftSession.mockResolvedValue(LONG_RESULT);

      await ask(root, { DRAFT_PROJECTS: "SSX" }, "dry");

      expect(postedMessages(calls)).toEqual([]);
      const written = JSON.parse(
        readFileSync(join(root, "out", "slack", "C0THREAD1-1712345678.000100.dm.json"), "utf8"),
      ) as {
        blocks: { type: string }[];
        replies: { thread_ts: string; blocks: { type: string }[] }[];
      };
      expect(written.blocks.every((block) => block.type === "section")).toBe(true);
      expect(written.replies.length).toBeGreaterThan(0);
      expect(written.replies.every((message) => message.thread_ts === "dry-run")).toBe(true);
      expect(written.replies.at(-1)?.blocks.at(-1)?.type).toBe("actions");
    });
  });

  it("in a dry run writes the message with its blocks, sends nothing, and keeps no record", async () => {
    const root = checkoutRoot();
    const { calls } = wire();
    runDraftSession.mockResolvedValue(RESULT);

    await ask(root, { DRAFT_PROJECTS: "SSX" }, "dry");

    expect(calls.filter((call) => call.what === "chat.postMessage")).toEqual([]);
    const written = JSON.parse(
      readFileSync(join(root, "out", "slack", "C0THREAD1-1712345678.000100.dm.json"), "utf8"),
    ) as {
      channel: string;
      blocks: { type: string }[];
      replies: { blocks: { type: string }[] }[];
    };
    expect(written.channel).toBe(ASKER);
    expect(written.blocks.every((block) => block.type === "section")).toBe(true);
    expect(written.replies.at(-1)?.blocks.at(-1)?.type).toBe("actions");
    expect(existsSync(join(root, "state", "pending-drafts"))).toBe(false);
  });

  describe("and a press on the button it sent", () => {
    /** The draft sent with its button, the id the button carries, and the calls so far. */
    async function sent(
      root: string,
      options: { readonly components?: readonly string[] } = {},
    ): Promise<{ readonly id: string; readonly calls: Call[] }> {
      const { calls } = wire(options);
      runDraftSession.mockResolvedValue(RESULT);
      await ask(root, { DRAFT_PROJECTS: "SSX" });
      return { id: buttonValue(lastOf(draftMessages(calls))), calls };
    }

    it("judges the draft again, writes the request a filing would make, and files nothing", async () => {
      const root = checkoutRoot();
      const { id, calls } = await sent(root);
      const jiraBefore = calls.filter((call) => call.host === "jira").length;

      await clickHandlerFor(configured(root, { DRAFT_PROJECTS: "SSX" }), "live")(press(id));

      expect(calls.filter((call) => call.host === "jira").length).toBeGreaterThan(jiraBefore);
      expect(
        calls.filter((call) => call.host === "jira").every((call) => call.method === "GET"),
      ).toBe(true);
      // The draft is a message and its reply; the one after them is the answer to the press.
      const answer = postedMessages(calls)[TICKET_MESSAGES];
      expect(postedMessages(calls)).toHaveLength(TICKET_MESSAGES + 1);
      expect(answer?.form.get("channel")).toBe("D0DM");
      expect(answer?.form.get("thread_ts")).toBe("9.9");
      expect(answer?.form.get("text")).toContain("Nothing was filed: filing is not built yet.");
      const written: unknown = JSON.parse(
        readFileSync(join(root, "out", "slack", `${id}.issue.json`), "utf8"),
      );
      expect(written).toEqual({
        method: "createJiraIssue",
        arguments: {
          cloudId: "storebrand.atlassian.net",
          projectKey: "SSX",
          issueTypeName: "Oppgave",
          summary: RESULT.ticket.summary,
          description: RESULT.ticket.description,
          contentFormat: "markdown",
          additional_fields: { components: [{ name: "SSX Advisor" }] },
        },
        draft: id,
        askedBy: ASKER,
        thread: { channel: "C0THREAD1", threadTs: "1712345678.000100" },
      });
    });

    it("answers in the thread of the first message when the button is on a reply in it", async () => {
      const root = checkoutRoot();
      const { id, calls } = await sent(root);

      await clickHandlerFor(
        configured(root, { DRAFT_PROJECTS: "SSX" }),
        "live",
      )(press(id, ASKER, "8.8"));

      expect(postedMessages(calls).at(-1)?.form.get("thread_ts")).toBe("8.8");
    });

    it("marks the answer as a dry run under a dry listener, and still writes the request", async () => {
      const root = checkoutRoot();
      const { id, calls } = await sent(root);

      await clickHandlerFor(configured(root, { DRAFT_PROJECTS: "SSX" }), "dry")(press(id));

      expect(postedMessages(calls)[TICKET_MESSAGES]?.form.get("text")).toMatch(
        /^\(dry run, nothing filed\) Nothing was filed: filing is not built yet\./u,
      );
      expect(existsSync(join(root, "out", "slack", `${id}.issue.json`))).toBe(true);
    });

    it("refuses once Jira no longer lists the component the draft chose", async () => {
      const root = checkoutRoot();
      const { id } = await sent(root);
      const later = wire({ components: ["SSX Customer"] });

      await clickHandlerFor(configured(root, { DRAFT_PROJECTS: "SSX" }), "live")(press(id));

      // `later` is a fresh log, so its one message is the answer to the press.
      expect(postedMessages(later.calls)).toHaveLength(1);
      expect(postedMessages(later.calls)[0]?.form.get("text")).toContain(
        "Not posted: SSX Advisor is not a component of SSX. Nothing was filed.",
      );
      expect(existsSync(join(root, "out", "slack", `${id}.issue.json`))).toBe(false);
    });

    it("refuses someone else on the draft list, writing nothing", async () => {
      const root = checkoutRoot();
      const { id, calls } = await sent(root);

      await clickHandlerFor(
        configured(root, { DRAFT_PROJECTS: "SSX", SLACK_DRAFT_USERS: `${ASKER},U0OTHER2` }),
        "live",
      )(press(id, "U0OTHER2"));

      expect(postedMessages(calls)[TICKET_MESSAGES]?.form.get("text")).toContain(
        `asked for by <@${ASKER}>`,
      );
      expect(existsSync(join(root, "out", "slack", `${id}.issue.json`))).toBe(false);
    });

    it("says it no longer holds a draft whose record is gone, as after a wiped state directory", async () => {
      const root = checkoutRoot();
      const { id, calls } = await sent(root);
      rmSync(join(root, "state"), { recursive: true });

      await clickHandlerFor(configured(root, { DRAFT_PROJECTS: "SSX" }), "live")(press(id));

      expect(postedMessages(calls)[TICKET_MESSAGES]?.form.get("text")).toContain(
        "I no longer hold this draft",
      );
      expect(existsSync(join(root, "out", "slack", `${id}.issue.json`))).toBe(false);
    });
  });
});

describe("clickHandlerFor", () => {
  const PRESS = {
    userId: "U0ASKER1",
    channel: "D0DM",
    messageTs: "9.9",
    threadTs: null,
    actionId: "draft_post",
    value: "d-0123456789abcdef01234567",
  };

  it.each([
    ["nobody on SLACK_DRAFT_USERS", { DRAFT_PROJECTS: "SSX" }],
    ["nothing on DRAFT_PROJECTS", { SLACK_DRAFT_USERS: "U0ASKER1" }],
  ])("only logs a press with %s, reaching neither Slack nor Jira", async (_name, extra) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await clickHandlerFor(settingsAt(checkoutRoot(), extra), "live")(PRESS);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed project at startup even with nobody on the draft list", () => {
    expect(() =>
      clickHandlerFor(settingsAt(checkoutRoot(), { DRAFT_PROJECTS: "ssx" }), "live"),
    ).toThrow(SettingsError);
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
  it("writes a dry message's blocks only when it has any, and replies only when there are more pieces", async () => {
    const root = checkoutRoot();
    const settings = settingsAt(root, { OUTPUT_DIR: join(root, "out") });
    const deliver = draftDelivery(settings, "dry");

    await deliver("U0ASKER1", "with", [{ text: "text", blocks: [{ type: "divider" }] }]);
    await deliver("U0ASKER1", "without", [{ text: "text", blocks: null }]);

    const read = (name: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(root, "out", "slack", `${name}.dm.json`), "utf8"));
    expect(read("with")).toMatchObject({ blocks: [{ type: "divider" }] });
    expect(read("without")).not.toHaveProperty("blocks");
    expect(read("with")).not.toHaveProperty("replies");
  });

  it.each(["dry", "live"] as const)(
    "refuses a draft with no piece to send, in a %s run",
    async (mode) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      const root = checkoutRoot();

      await expect(
        draftDelivery(settingsAt(root, { OUTPUT_DIR: join(root, "out") }), mode)(
          "U0ASKER1",
          "x",
          [],
        ),
      ).rejects.toThrow("the draft has no message to send");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
