import { describe, expect, it, vi } from "vitest";

import type { FileOutcome } from "../draft/filer.ts";
import type { FileGateDeps } from "../draft/gate.ts";
import type { PendingDraft, PendingStore } from "../draft/pending.ts";
import type { DraftTicket } from "../draft/runner.ts";
import type { FiledIssue } from "../jira/client.ts";
import { POST_ACTION_ID } from "./draft-blocks.ts";
import { type FilingDeps, type PostClickDeps, compareFiled, createPostHandler } from "./post.ts";
import type { Click } from "./socket.ts";

const ID = "d-0123456789abcdef01234567";
const ASKER = "U0ASKER1";

const DRAFT: PendingDraft = {
  id: ID,
  asker: ASKER,
  thread: { channel: "C0THREAD1", threadTs: "1712345678.000100" },
  ticket: {
    summary: "commerce-rest: raise the export timeout",
    project: "SSX",
    component: "SSX Advisor",
    issueType: "Oppgave",
    description: "## Where",
  },
  createdAt: "2026-10-14T12:00:00.000Z",
};

/** Every log line written while `run` runs; `vitest.config.ts` silences the logger otherwise. */
async function logged(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const keep = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  const level = process.env["LOG_LEVEL"];
  process.env["LOG_LEVEL"] = "info";
  vi.spyOn(process.stdout, "write").mockImplementation(keep);
  vi.spyOn(process.stderr, "write").mockImplementation(keep);
  try {
    await run();
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

function click(overrides: Partial<Click> = {}): Click {
  return {
    userId: ASKER,
    channel: "D0DIRECT",
    messageTs: "1790779999.000100",
    threadTs: null,
    actionId: POST_ACTION_ID,
    value: ID,
    ...overrides,
  };
}

interface Harness {
  readonly deps: PostClickDeps;
  readonly get: ReturnType<typeof vi.fn<PendingStore["get"]>>;
  readonly facts: ReturnType<typeof vi.fn<FileGateDeps["facts"]>>;
  readonly rehearse: ReturnType<typeof vi.fn<PostClickDeps["rehearse"]>>;
  readonly replies: { readonly click: Click; readonly text: string }[];
}

/** A store that holds one record and applies `update` the way the file store does. */
function holding(record: PendingDraft = DRAFT): {
  readonly store: PendingStore;
  readonly get: ReturnType<typeof vi.fn<PendingStore["get"]>>;
  readonly update: ReturnType<typeof vi.fn<PendingStore["update"]>>;
  current(): PendingDraft;
} {
  let current = record;
  const get = vi.fn<PendingStore["get"]>(async (id) => (id === ID ? current : null));
  const update = vi.fn<PendingStore["update"]>(async (_id, change) => {
    const { filing: _was, ...rest } = current;
    const filing = change.filing === undefined ? current.filing : change.filing;
    current = {
      ...rest,
      ...(filing === null || filing === undefined ? {} : { filing }),
      ...(change.filed === undefined ? {} : { filed: change.filed }),
    };
    return current;
  });
  return {
    store: { create: async () => DRAFT, get, update, remove: async () => undefined },
    get,
    update,
    current: () => current,
  };
}

function harness(overrides: Partial<PostClickDeps> = {}): Harness {
  const replies: { click: Click; text: string }[] = [];
  const { get, store } = holding();
  const facts = vi.fn<FileGateDeps["facts"]>(async () => ({
    components: ["SSX Advisor"],
    issueTypes: ["Oppgave"],
  }));
  const rehearse = vi.fn<PostClickDeps["rehearse"]>(async (draft) => `/out/${draft.id}.issue.json`);
  const deps: PostClickDeps = {
    allowed: [ASKER],
    dry: false,
    pending: store,
    gate: { projects: ["SSX"], facts },
    rehearse,
    reply: async (pressed, text) => {
      replies.push({ click: pressed, text });
    },
    ...overrides,
  };
  return { deps, get, facts, rehearse, replies };
}

describe("createPostHandler", () => {
  it("rehearses a press by the asker: judges the draft, writes the request, and says in the thread that nothing was filed", async () => {
    const h = harness();

    await createPostHandler(h.deps).handle(click());

    expect(h.facts).toHaveBeenCalledExactlyOnceWith("SSX");
    expect(h.rehearse).toHaveBeenCalledExactlyOnceWith(DRAFT);
    expect(h.replies).toEqual([
      {
        click: click(),
        text: `The request a live listener would make is written to \`/out/${ID}.issue.json\`, and nothing was filed.`,
      },
    ]);
  });

  it("answers in the thread of the message the button is on", async () => {
    const h = harness();

    await createPostHandler(h.deps).handle(click({ channel: "D0OTHER", messageTs: "5.5" }));

    expect(h.replies[0]?.click).toMatchObject({ channel: "D0OTHER", messageTs: "5.5" });
  });

  it("leaves a press on any other action alone, reading nothing and answering nothing", async () => {
    const h = harness();

    await createPostHandler(h.deps).handle(click({ actionId: "something_else" }));

    expect(h.get).not.toHaveBeenCalled();
    expect(h.replies).toEqual([]);
  });

  it("refuses someone off the draft list before reading the record", async () => {
    const h = harness();

    await createPostHandler(h.deps).handle(click({ userId: "U0STRANGER" }));

    expect(h.get).not.toHaveBeenCalled();
    expect(h.facts).not.toHaveBeenCalled();
    expect(h.rehearse).not.toHaveBeenCalled();
    expect(h.replies[0]?.text).toMatch(/^Only the people on the draft list may post a draft/u);
  });

  it("refuses the asker too once they have left the draft list", async () => {
    const h = harness({ allowed: ["U0SOMEONE"] });

    await createPostHandler(h.deps).handle(click());

    expect(h.get).not.toHaveBeenCalled();
    expect(h.rehearse).not.toHaveBeenCalled();
  });

  it("takes only a member id as a person, whatever the list holds", async () => {
    const h = harness({ allowed: ["someone"] });

    await createPostHandler(h.deps).handle(click({ userId: "someone" }));

    expect(h.get).not.toHaveBeenCalled();
    expect(h.rehearse).not.toHaveBeenCalled();
  });

  it("says it no longer holds a draft the store does not know, and judges and writes nothing", async () => {
    const h = harness();

    await createPostHandler(h.deps).handle(click({ value: "d-ffffffffffffffffffffffff" }));

    expect(h.replies[0]?.text).toMatch(/^I no longer hold this draft/u);
    expect(h.facts).not.toHaveBeenCalled();
    expect(h.rehearse).not.toHaveBeenCalled();
  });

  it("says it could not read a record it cannot trust, escaped, and writes nothing", async () => {
    const h = harness();
    h.get.mockRejectedValue(new Error("the record of d-1 is <!channel> & wrong"));

    await createPostHandler(h.deps).handle(click());

    expect(h.replies[0]?.text).toBe(
      "I could not read the record of this draft: the record of d-1 is &lt;!channel&gt; &amp; wrong. Nothing was filed.",
    );
    expect(h.rehearse).not.toHaveBeenCalled();
  });

  it("refuses someone else on the list, naming who asked, and judges and writes nothing", async () => {
    const h = harness({ allowed: [ASKER, "U0OTHER2"] });

    await createPostHandler(h.deps).handle(click({ userId: "U0OTHER2" }));

    expect(h.replies[0]?.text).toBe(
      `This draft was asked for by <@${ASKER}>, and only they may post it, so nothing was filed.`,
    );
    expect(h.facts).not.toHaveBeenCalled();
    expect(h.rehearse).not.toHaveBeenCalled();
  });

  it("judges the draft again at the press, by what Jira lists now", async () => {
    const h = harness();
    h.facts.mockResolvedValue({ components: ["SSX Customer"], issueTypes: ["Oppgave"] });

    await createPostHandler(h.deps).handle(click());

    expect(h.replies[0]?.text).toBe(
      "Not posted: SSX Advisor is not a component of SSX. Nothing was filed.",
    );
    expect(h.rehearse).not.toHaveBeenCalled();
  });

  it("reads a Jira that cannot be asked as a refusal, never as a go-ahead", async () => {
    const h = harness();
    h.facts.mockRejectedValue(new Error("fetch failed"));

    await createPostHandler(h.deps).handle(click());

    expect(h.replies[0]?.text).toBe(
      "Not posted: Jira could not be asked what SSX lists (fetch failed). Nothing was filed.",
    );
    expect(h.rehearse).not.toHaveBeenCalled();
  });

  it("refuses a draft whose project has left DRAFT_PROJECTS since it was sent", async () => {
    const h = harness({ gate: { projects: ["OPS"], facts: vi.fn() } });

    await createPostHandler(h.deps).handle(click());

    expect(h.replies[0]?.text).toBe("Not posted: SSX is not on DRAFT_PROJECTS. Nothing was filed.");
    expect(h.rehearse).not.toHaveBeenCalled();
  });

  it("escapes what the draft chose when it quotes it in a refusal", async () => {
    const h = harness();
    h.get.mockResolvedValue({
      ...DRAFT,
      ticket: { ...DRAFT.ticket, component: "<!channel>" },
    });

    await createPostHandler(h.deps).handle(click());

    expect(h.replies[0]?.text).toContain("&lt;!channel&gt; is not a component of SSX");
    expect(h.replies[0]?.text).not.toContain("<!channel>");
  });

  it("says when the request could not be written, escaped, and that nothing was filed", async () => {
    const h = harness();
    h.rehearse.mockRejectedValue(new Error("EACCES: <denied>"));

    await createPostHandler(h.deps).handle(click());

    expect(h.replies[0]?.text).toBe(
      "The request could not be written: EACCES: &lt;denied&gt;. Nothing was filed.",
    );
  });

  it("never throws when Slack refuses the reply", async () => {
    const h = harness({
      reply: async () => {
        throw new Error("channel_not_found");
      },
    });

    await expect(createPostHandler(h.deps).handle(click())).resolves.toBeUndefined();
    expect(h.rehearse).toHaveBeenCalledOnce();
  });

  it.each([
    ["channel", { channel: "" }],
    ["message", { messageTs: "" }],
  ])(
    "answers nobody when the press names no %s, since there is nowhere to answer",
    async (_name, change) => {
      const h = harness();

      await createPostHandler(h.deps).handle(click(change));

      expect(h.replies).toEqual([]);
      expect(h.rehearse).not.toHaveBeenCalled();
    },
  );

  describe("marking a dry run", () => {
    /** One press per decision, so a reply built outside `answer` could not escape the mark. */
    const scenarios: [string, Partial<Click>, Partial<PostClickDeps>][] = [
      ["rehearsed", {}, {}],
      ["not-allowed", { userId: "U0STRANGER" }, {}],
      ["gone", { value: "d-ffffffffffffffffffffffff" }, {}],
      ["not-asker", { userId: "U0OTHER2" }, { allowed: [ASKER, "U0OTHER2"] }],
      ["refused", {}, { gate: { projects: [], facts: vi.fn() } }],
    ];

    it.each(scenarios)(
      "starts every reply with (dry run, nothing filed) when dry: %s",
      async (_decision, change, deps) => {
        const h = harness({ ...deps, dry: true });

        await createPostHandler(h.deps).handle(click(change));

        expect(h.replies).toHaveLength(1);
        expect(h.replies[0]?.text).toMatch(/^\(dry run, nothing filed\) /u);
      },
    );

    it.each(scenarios)("marks no reply when not dry: %s", async (_decision, change, deps) => {
      const h = harness({ ...deps, dry: false });

      await createPostHandler(h.deps).handle(click(change));

      expect(h.replies[0]?.text).not.toMatch(/dry run/u);
    });
  });

  // Whether Slack names the thread of a button on a reply is read from this line, not inferred from where the answer lands.
  it.each([
    ["a button on a reply", "1790779000.000050"],
    ["a button on a message that is no reply", null],
  ])("logs the message and the thread a press came from, for %s", async (_what, threadTs) => {
    const h = harness();
    h.facts.mockResolvedValue({ components: ["SSX Customer"], issueTypes: ["Oppgave"] });

    const lines = await logged(() =>
      createPostHandler(h.deps).handle(click({ messageTs: "1790779999.000100", threadTs })),
    );

    expect(lines.find((line) => line["message"] === "slack.post_pressed")).toMatchObject({
      messageTs: "1790779999.000100",
      threadTs,
    });
  });

  it("logs what it told the person, so a reply Slack refuses does not take the reason with it", async () => {
    const h = harness({
      reply: async () => {
        throw new Error("channel_not_found");
      },
    });
    h.facts.mockResolvedValue({ components: ["SSX Customer"], issueTypes: ["Oppgave"] });

    const lines = await logged(() => createPostHandler(h.deps).handle(click()));

    expect(lines.find((line) => line["message"] === "slack.post_pressed")).toMatchObject({
      decision: "refused",
      id: ID,
      said: "Not posted: SSX Advisor is not a component of SSX. Nothing was filed.",
    });
    expect(lines.find((line) => line["message"] === "slack.post_reply_failed")).toMatchObject({
      reason: "channel_not_found",
    });
  });

  it("says in every refusal that nothing was filed", async () => {
    const refusals: [Partial<Click>, Partial<PostClickDeps>][] = [
      [{ userId: "U0STRANGER" }, {}],
      [{ value: "d-ffffffffffffffffffffffff" }, {}],
      [{ userId: "U0OTHER2" }, { allowed: [ASKER, "U0OTHER2"] }],
      [{}, { gate: { projects: [], facts: vi.fn() } }],
    ];
    for (const [change, deps] of refusals) {
      const h = harness(deps);

      await createPostHandler(h.deps).handle(click(change));

      expect(h.replies).toHaveLength(1);
      expect(h.replies[0]?.text).toMatch(/nothing was filed/iu);
    }
  });
});

/** The issue as Jira would give it back for `ticket`: the body as the document form Jira keeps, one paragraph to a blank line. */
function readBack(ticket: DraftTicket, overrides: Partial<FiledIssue> = {}): FiledIssue {
  return {
    key: "SSX-4100",
    project: ticket.project,
    issueType: ticket.issueType,
    summary: ticket.summary,
    components: [ticket.component],
    description: {
      type: "doc",
      version: 1,
      content: ticket.description.split("\n\n").map((paragraph) => ({
        type: "paragraph",
        content: [{ type: "text", text: paragraph }],
      })),
    },
    url: "https://jira.example/browse/SSX-4100",
    ...overrides,
  };
}

const BODY = [
  "## Where",
  "The export lives in `ExportService.ts` and times out after thirty seconds on a large customer.",
  "## What to change",
  "Raise the timeout to ninety seconds and say so in the log line the service writes when it fires.",
].join("\n\n");

const TICKET: DraftTicket = { ...DRAFT.ticket, description: BODY };

describe("compareFiled", () => {
  it("finds nothing to say when Jira holds what was sent, markdown punctuation aside", () => {
    expect(compareFiled(TICKET, readBack(TICKET))).toMatchObject({ differences: [] });
  });

  it.each([
    ["the project", { project: "OPS" }, /its project is OPS, not SSX/u],
    ["the project, unreadable", { project: "" }, /its project is unreadable/u],
    ["the type", { issueType: "Feil" }, /its type is Feil, not Oppgave/u],
    ["the summary", { summary: "something else" }, /its summary differs/u],
    ["the component", { components: ["SSX Customer"] }, /it lacks the component SSX Advisor/u],
    ["no component at all", { components: [] }, /it lacks the component SSX Advisor/u],
    ["a body that did not arrive", { description: undefined }, /its body is 0 of \d+ characters/u],
  ])("reports %s", (_what, change, expected) => {
    const { differences } = compareFiled(TICKET, readBack(TICKET, change));

    expect(differences.join("; ")).toMatch(expected);
  });

  it("reports a body that begins or ends otherwise than the draft's, though it is as long", () => {
    const head = compareFiled(
      TICKET,
      readBack({ ...TICKET, description: BODY.replace("## Where", "## Wherever") }),
    );
    const tail = compareFiled(
      TICKET,
      readBack({ ...TICKET, description: `${BODY.slice(0, -40)}${"x".repeat(40)}` }),
    );

    expect(head.differences.join("; ")).toMatch(/does not begin as the draft's does/u);
    expect(tail.differences.join("; ")).toMatch(/does not end as the draft's does/u);
  });

  it("counts a body as arrived by the words in it, so a link's address does not make a difference", () => {
    const linked = { ...TICKET, description: `${BODY}\n\nSee [the ticket](https://x.example/1).` };

    expect(compareFiled(linked, readBack(TICKET)).differences.join("; ")).not.toMatch(/begin/u);
  });
});

describe("a press on a live listener", () => {
  function filing(overrides: Partial<FilingDeps> = {}): {
    readonly deps: FilingDeps;
    readonly file: ReturnType<typeof vi.fn<FilingDeps["file"]>>;
  } {
    const file = vi.fn<FilingDeps["file"]>(async () => ({ kind: "created", key: "SSX-4100" }));
    return {
      deps: {
        file,
        readBack: async () => readBack(TICKET),
        issueUrl: (key) => `https://jira.example/browse/${key}`,
        now: () => new Date("2026-10-15T09:00:00.000Z"),
        ...overrides,
      },
      file,
    };
  }

  function live(
    overrides: Partial<FilingDeps> = {},
    record: PendingDraft = { ...DRAFT, ticket: TICKET },
  ): {
    readonly h: Harness;
    readonly f: ReturnType<typeof filing>;
    readonly s: ReturnType<typeof holding>;
  } {
    const s = holding(record);
    const f = filing(overrides);
    return { h: harness({ pending: s.store, filing: f.deps }), f, s };
  }

  it("marks the draft before the writer runs, files it, records the key, and says what Jira holds", async () => {
    const { h, f, s } = live();

    await createPostHandler(h.deps).handle(click());

    expect(s.update.mock.calls[0]?.[1]).toEqual({
      filing: { startedAt: "2026-10-15T09:00:00.000Z" },
    });
    expect(s.update.mock.invocationCallOrder[0]).toBeLessThan(
      f.file.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.file.mock.calls[0]?.[0].filing).toEqual({ startedAt: "2026-10-15T09:00:00.000Z" });
    expect(s.current().filed).toEqual({ key: "SSX-4100", at: "2026-10-15T09:00:00.000Z" });
    expect(h.rehearse).not.toHaveBeenCalled();
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]?.text).toMatch(
      /^Filed as <https:\/\/jira\.example\/browse\/SSX-4100\|SSX-4100>\. Read back from Jira: project, type, summary and component match, and the body arrived \(\d+ of \d+ characters\)\.$/u,
    );
  });

  it("records the key before it reads the issue back, so a read that fails cannot lose it", async () => {
    const { h, s } = live({
      readBack: async () => {
        throw new Error("Jira is down");
      },
    });

    await createPostHandler(h.deps).handle(click());

    expect(s.current().filed?.key).toBe("SSX-4100");
    expect(h.replies[0]?.text).toContain(
      "Filed as <https://jira.example/browse/SSX-4100|SSX-4100>.",
    );
    expect(h.replies[0]?.text).toContain("Reading it back failed (Jira is down)");
  });

  it("says where Jira's copy differs, and still records the key", async () => {
    const { h, s } = live({ readBack: async () => readBack(TICKET, { components: [] }) });

    await createPostHandler(h.deps).handle(click());

    expect(s.current().filed?.key).toBe("SSX-4100");
    expect(h.replies[0]?.text).toContain(
      "Jira's copy differs from the draft: it lacks the component SSX Advisor.",
    );
    expect(h.replies[0]?.text).not.toContain("match");
  });

  it("answers a second press with the key and creates nothing", async () => {
    const { h, f } = live();
    const handler = createPostHandler(h.deps);

    await handler.handle(click());
    await handler.handle(click());

    expect(f.file).toHaveBeenCalledOnce();
    expect(h.replies[1]?.text).toBe(
      "This draft was already posted as <https://jira.example/browse/SSX-4100|SSX-4100>, so nothing was filed again.",
    );
  });

  it("does not ask the gate, Jira or the writer about a draft that is already filed", async () => {
    const { h, f } = live(
      {},
      { ...DRAFT, ticket: TICKET, filed: { key: "SSX-4000", at: "2026-10-14T13:00:00.000Z" } },
    );

    await createPostHandler(h.deps).handle(click());

    expect(h.facts).not.toHaveBeenCalled();
    expect(f.file).not.toHaveBeenCalled();
    expect(h.replies[0]?.text).toContain("SSX-4000");
  });

  it("will not file a draft whose mark says a filing began and nothing says how it ended", async () => {
    const { h, f } = live(
      {},
      { ...DRAFT, ticket: TICKET, filing: { startedAt: "2026-10-15T08:00:00.000Z" } },
    );

    await createPostHandler(h.deps).handle(click());

    expect(f.file).not.toHaveBeenCalled();
    expect(h.facts).not.toHaveBeenCalled();
    expect(h.replies[0]?.text).toContain("began at 2026-10-15T08:00:00.000Z");
    expect(h.replies[0]?.text).toContain(
      'Search SSX for "commerce-rest: raise the export timeout"',
    );
  });

  it("clears the mark when Jira provably refused, so pressing again retries", async () => {
    const outcomes: FileOutcome[] = [
      { kind: "not-created", reason: "Jira said the project is closed" },
      { kind: "created", key: "SSX-4100" },
    ];
    const file = vi.fn<FilingDeps["file"]>(
      async () => outcomes.shift() ?? { kind: "unclear", reason: "none left" },
    );
    const { h, s } = live({ file });
    const handler = createPostHandler(h.deps);

    await handler.handle(click());

    expect(s.current().filing).toBeUndefined();
    expect(h.replies[0]?.text).toBe(
      "Nothing was filed: Jira said the project is closed. The draft is still here, so pressing again retries it.",
    );

    await handler.handle(click());

    expect(file).toHaveBeenCalledTimes(2);
    expect(h.replies[1]?.text).toMatch(/^Filed as /u);
  });

  it("keeps the mark, and says so, when a refusal cannot be cleared", async () => {
    const s = holding({ ...DRAFT, ticket: TICKET });
    const apply = s.update.getMockImplementation();
    s.update.mockImplementation(async (id, change) => {
      if (change.filing === null) {
        throw new Error("EACCES");
      }
      return await (apply?.(id, change) ?? Promise.reject(new Error("no store")));
    });
    const f = filing({ file: async () => ({ kind: "not-created", reason: "refused" }) });
    const h = harness({ pending: s.store, filing: f.deps });

    await createPostHandler(h.deps).handle(click());

    expect(s.current().filing).toBeDefined();
    expect(h.replies[0]?.text).toContain(
      "I could not clear its mark, so it cannot be posted again.",
    );
  });

  it("keeps the mark, and says an issue may exist, when the outcome is unclear", async () => {
    const { h, s } = live({
      file: async () => ({
        kind: "unclear",
        reason: "the session called createJiraIssue 2 times",
      }),
    });

    await createPostHandler(h.deps).handle(click());

    expect(s.current().filing).toBeDefined();
    expect(s.current().filed).toBeUndefined();
    expect(h.replies[0]?.text).toContain(
      "An issue may exist, so this draft cannot be posted again.",
    );
    expect(h.replies[0]?.text).toContain(
      'Search SSX for "commerce-rest: raise the export timeout"',
    );
  });

  it("takes a writer that throws for an unclear outcome, never for a refusal", async () => {
    const { h, s } = live({
      file: async () => {
        throw new Error("socket hang up");
      },
    });

    await createPostHandler(h.deps).handle(click());

    expect(s.current().filing).toBeDefined();
    expect(h.replies[0]?.text).toContain("the writer threw (socket hang up)");
  });

  it("files nothing when the mark cannot be written, since a crash could not then be told from a fresh draft", async () => {
    const s = holding({ ...DRAFT, ticket: TICKET });
    s.update.mockRejectedValue(new Error("ENOSPC"));
    const f = filing();
    const h = harness({ pending: s.store, filing: f.deps });

    await createPostHandler(h.deps).handle(click());

    expect(f.file).not.toHaveBeenCalled();
    expect(h.replies[0]?.text).toContain("so nothing was filed: ENOSPC");
  });

  it("still says the issue was filed when the key cannot be written down, and logs that it could not", async () => {
    const s = holding({ ...DRAFT, ticket: TICKET });
    const apply = s.update.getMockImplementation();
    s.update.mockImplementation(async (id, change) => {
      if (change.filed !== undefined) {
        throw new Error("EACCES");
      }
      return await (apply?.(id, change) ?? Promise.reject(new Error("no store")));
    });
    const h = harness({ pending: s.store, filing: filing().deps });

    const lines = await logged(() => createPostHandler(h.deps).handle(click()));

    expect(h.replies[0]?.text).toMatch(/^Filed as /u);
    expect(lines.find((line) => line["message"] === "slack.post_filed_unrecorded")).toMatchObject({
      key: "SSX-4100",
      reason: "EACCES",
    });
  });

  it("does not write the mark or run the writer when the gate refuses", async () => {
    const { h, f, s } = live();
    h.facts.mockResolvedValue({ components: [], issueTypes: ["Oppgave"] });

    await createPostHandler(h.deps).handle(click());

    expect(s.update).not.toHaveBeenCalled();
    expect(f.file).not.toHaveBeenCalled();
    expect(h.replies[0]?.text).toContain("Not posted:");
  });

  it("escapes what the writer and Jira said, since neither is trusted with Slack's markup", async () => {
    const { h } = live({ file: async () => ({ kind: "unclear", reason: "<!channel> & co" }) });

    await createPostHandler(h.deps).handle(click());

    expect(h.replies[0]?.text).toContain("&lt;!channel&gt; &amp; co");
    expect(h.replies[0]?.text).not.toContain("<!channel>");
  });

  it("links the key only when a safe address can be made", async () => {
    const { h } = live({ issueUrl: () => null });

    await createPostHandler(h.deps).handle(click());

    expect(h.replies[0]?.text).toMatch(/^Filed as SSX-4100\./u);
  });

  it("is a rehearsal under a dry listener even when a writer was handed to it", async () => {
    const s = holding({ ...DRAFT, ticket: TICKET });
    const f = filing();
    const h = harness({ pending: s.store, filing: f.deps, dry: true });

    await createPostHandler(h.deps).handle(click());

    expect(f.file).not.toHaveBeenCalled();
    expect(s.update).not.toHaveBeenCalled();
    expect(h.rehearse).toHaveBeenCalledOnce();
    expect(h.replies[0]?.text).toMatch(/^\(dry run, nothing filed\) /u);
  });
});
