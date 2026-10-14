import { describe, expect, it, vi } from "vitest";

import type { DraftResult } from "../draft/runner.ts";
import type { ThreadDraftOutcome } from "../draft/thread.ts";
import { SessionAbortedError } from "../triage/session.ts";
import { DRAFT_USAGE, type DraftMentionDeps, createDraftHandler, isDraftMention } from "./draft.ts";
import type { Mention } from "./start.ts";

const ASKER = "U0ASKER1";
const LINK = "https://acme.slack.com/archives/C0THREAD1/p1712345678000100";

function mention(overrides: Partial<Mention> = {}): Mention {
  return {
    userId: ASKER,
    text: "<@U0BENCEBOT> draft",
    channel: "C0THREAD1",
    ts: "1712345699.000200",
    threadTs: "1712345678.000100",
    ...overrides,
  };
}

function drafted(): ThreadDraftOutcome {
  const result: DraftResult = {
    ticket: {
      summary: "commerce-rest: raise the export timeout",
      project: "SSX",
      component: "SSX Advisor",
      issueType: "Oppgave",
      description: "## Where",
    },
    duplicate: null,
    reason: "One ask.",
    questions: [],
    reposRead: ["commerce-rest"],
    injectionNoticed: [],
  };
  return { kind: "drafted", ticket: result.ticket!, result };
}

function duplicate(): ThreadDraftOutcome {
  const found = { key: "SSX-3534", feedback: "Rådgiver ber om å åpne kunden." };
  return {
    kind: "duplicate",
    duplicate: found,
    result: {
      ticket: null,
      duplicate: found,
      reason: "Asks for what SSX-3534 asks.",
      questions: [],
      reposRead: [],
      injectionNoticed: [],
    },
  };
}

interface Harness {
  readonly deps: DraftMentionDeps;
  readonly replies: string[];
  readonly sent: { readonly userId: string; readonly label: string; readonly text: string }[];
  readonly draft: ReturnType<typeof vi.fn>;
  readonly permalink: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<DraftMentionDeps> = {}): Harness {
  const replies: string[] = [];
  const sent: { userId: string; label: string; text: string }[] = [];
  const draft = vi.fn(async () => drafted());
  const permalink = vi.fn(async () => LINK);
  const deps: DraftMentionDeps = {
    allowed: [ASKER],
    dry: false,
    draft,
    permalink,
    deliver: async (userId, label, text) => {
      sent.push({ userId, label, text });
      return "9.9";
    },
    reply: async (_mention, text) => {
      replies.push(text);
    },
    ...overrides,
  };
  // The spies the handler actually holds, overrides included.
  return {
    deps,
    replies,
    sent,
    draft: deps.draft as ReturnType<typeof vi.fn>,
    permalink: deps.permalink as ReturnType<typeof vi.fn>,
  };
}

/** A draft that runs until the test lets it finish. */
function held(): { readonly promise: Promise<ThreadDraftOutcome>; release(): void } {
  const { promise, resolve } = Promise.withResolvers<ThreadDraftOutcome>();
  return {
    promise,
    release: () => {
      resolve(drafted());
    },
  };
}

describe("isDraftMention", () => {
  it("takes a mention whose first word is draft, whatever follows", () => {
    expect(isDraftMention("<@U0BENCEBOT> draft")).toBe(true);
    expect(isDraftMention("<@U0BENCEBOT|bencebot>   Draft please")).toBe(true);
  });

  it("leaves every other mention to the start handler", () => {
    expect(isDraftMention("<@U0BENCEBOT> start")).toBe(false);
    expect(isDraftMention("<@U0BENCEBOT> please draft")).toBe(false);
    expect(isDraftMention("<@U0BENCEBOT>")).toBe(false);
  });
});

describe("createDraftHandler", () => {
  it("answers once in the thread, then sends the draft to the person who asked, once", async () => {
    const h = harness();
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention());
    await handler.settled();

    expect(h.replies).toEqual([expect.stringMatching(/^Drafting a ticket from this thread/u)]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.userId).toBe(ASKER);
    expect(h.sent[0]?.label).toBe("C0THREAD1-1712345678.000100");
    expect(h.sent[0]?.text).toContain("*commerce-rest: raise the export timeout*");
    expect(h.sent[0]?.text).toContain(`<${LINK}|this thread>`);
    expect(h.draft).toHaveBeenCalledWith({ channel: "C0THREAD1", threadTs: "1712345678.000100" });
  });

  it("sends the comment a duplicate thread adds to an open issue the way it sends a ticket", async () => {
    const h = harness({ draft: vi.fn(async () => duplicate()) });
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention());
    await handler.settled();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toContain("*Duplicate of SSX-3534*");
    expect(h.sent[0]?.text).toContain("*Comment to add to SSX-3534*\nRådgiver ber om å åpne kunden.");
  });

  it("returns once it has answered, while the draft is still running", async () => {
    const run = held();
    const h = harness({ draft: vi.fn(async () => await run.promise) });
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention());

    expect(h.replies).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    run.release();
    await handler.settled();
    expect(h.sent).toHaveLength(1);
  });

  it.each<[string, Partial<Mention>, RegExp]>([
    ["someone not on the draft list", { userId: "U0STRANGER" }, /not one of them/u],
    ["a mention outside a thread", { threadTs: null }, /this is not a thread/u],
    ["draft with another word", { text: "<@U0BENCEBOT> draft now" }, /^In any thread/u],
    ["a mention Slack named no user for", { userId: "" }, /Slack named no user/u],
  ])("reads nothing and starts nothing for %s", async (_name, overrides, said) => {
    const h = harness();
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention(overrides));
    await handler.settled();

    expect(h.replies).toEqual([expect.stringMatching(said)]);
    expect(h.draft).not.toHaveBeenCalled();
    expect(h.permalink).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
  });

  it("refuses a second draft while one runs, and starts no second session", async () => {
    const run = held();
    const h = harness({ draft: vi.fn(async () => await run.promise) });
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention());
    await handler.handle(mention({ threadTs: "1712340000.000300" }));

    expect(h.replies[1]).toMatch(/already drafting another thread/u);
    run.release();
    await handler.settled();
    expect(h.draft).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(1);
  });

  it("takes a new draft once the last one has been sent", async () => {
    const h = harness();
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention());
    await handler.settled();
    await handler.handle(mention({ threadTs: "1712340000.000300" }));
    await handler.settled();

    expect(h.draft).toHaveBeenCalledTimes(2);
    expect(h.sent).toHaveLength(2);
  });

  it("tells the person when the service stopped the draft, rather than going quiet", async () => {
    const h = harness({
      draft: vi.fn(async () => {
        throw new SessionAbortedError("Draft of C0THREAD1-1712345678.000100");
      }),
    });
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention());
    await handler.settled();

    expect(h.sent[0]?.text).toMatch(/^Bencebot was stopped before the draft of/u);
    expect(h.sent[0]?.text).toContain("nothing was drafted");
  });

  it("tells the person why a draft failed, escaped", async () => {
    const h = harness({
      draft: vi.fn(async () => {
        throw new Error('MCP server "atlassian" reported status "failed" <!channel>');
      }),
    });
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention());
    await handler.settled();

    expect(h.sent[0]?.text).toMatch(/did not finish: MCP server "atlassian"/u);
    expect(h.sent[0]?.text).not.toContain("<!channel>");
  });

  it("admits in the thread a direct message it could not send, and never throws", async () => {
    const h = harness({
      deliver: async () => {
        throw new Error("Slack chat.postMessage failed: cannot_dm_bot");
      },
    });
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention());
    await handler.settled();

    expect(h.replies[1]).toMatch(/could not send it to you: Slack chat\.postMessage failed/u);
  });

  it("names the channel when Slack gives no link to the thread", async () => {
    const h = harness({
      permalink: vi.fn(async () => {
        throw new Error("not_allowed");
      }),
    });
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention());
    await handler.settled();

    expect(h.sent[0]?.text).toContain("a thread in <#C0THREAD1>");
  });

  it("survives a reply Slack refuses", async () => {
    const h = harness({
      reply: async () => {
        throw new Error("Slack chat.postEphemeral failed: user_not_in_channel");
      },
    });
    const handler = createDraftHandler(h.deps);

    await expect(handler.handle(mention())).resolves.toBeUndefined();
    await handler.settled();
    expect(h.sent).toHaveLength(1);
  });

  it("marks every reply as a dry run when the message is written rather than sent", async () => {
    const h = harness({ dry: true });
    const handler = createDraftHandler(h.deps);

    await handler.handle(mention({ userId: "U0STRANGER" }));

    expect(h.replies[0]).toMatch(/^\(dry run, nothing sent\) /u);
  });

  it("is settled at once when nothing is running", async () => {
    await expect(createDraftHandler(harness().deps).settled()).resolves.toBeUndefined();
  });

  it("offers the usage it promises", () => {
    expect(DRAFT_USAGE).toContain("`@Bencebot draft`");
    expect(DRAFT_USAGE).toContain("Nothing is filed.");
    expect(DRAFT_USAGE).toContain("comment");
  });
});
