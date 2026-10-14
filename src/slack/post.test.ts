import { describe, expect, it, vi } from "vitest";

import type { FileGateDeps } from "../draft/gate.ts";
import type { PendingDraft, PendingStore } from "../draft/pending.ts";
import { POST_ACTION_ID } from "./draft-blocks.ts";
import { type PostClickDeps, createPostHandler } from "./post.ts";
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

function click(overrides: Partial<Click> = {}): Click {
  return {
    userId: ASKER,
    channel: "D0DIRECT",
    messageTs: "1790779999.000100",
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

function harness(overrides: Partial<PostClickDeps> = {}): Harness {
  const replies: { click: Click; text: string }[] = [];
  const get = vi.fn<PendingStore["get"]>(async (id) => (id === ID ? DRAFT : null));
  const facts = vi.fn<FileGateDeps["facts"]>(async () => ({
    components: ["SSX Advisor"],
    issueTypes: ["Oppgave"],
  }));
  const rehearse = vi.fn<PostClickDeps["rehearse"]>(async (draft) => `/out/${draft.id}.issue.json`);
  const deps: PostClickDeps = {
    allowed: [ASKER],
    pending: {
      create: async () => DRAFT,
      get,
      remove: async () => undefined,
    },
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
        text: `Nothing was filed: filing is not built yet. The request it would make is written to \`/out/${ID}.issue.json\`.`,
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
