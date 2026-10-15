import { describe, expect, it, vi } from "vitest";

import { BLOCKS_MAX, POST_ACTION_ID, SECTION_MAX } from "../slack/draft-blocks.ts";
import type { FileGateDeps } from "./gate.ts";
import { createDraftOffer } from "./offer.ts";
import { type PendingStore, discardingStore } from "./pending.ts";
import type { DraftResult, DraftTicket } from "./runner.ts";
import type { ThreadDraftOutcome } from "./thread.ts";

const ID = "d-0123456789abcdef01234567";
const WHO = { asker: "U0ASKER1", thread: { channel: "C0THREAD1", threadTs: "1712345678.000100" } };
const TEXT = "*Draft ticket* from this thread\nBody\nNothing has been filed in Jira.";

const TICKET: DraftTicket = {
  summary: "commerce-rest: raise the export timeout",
  project: "SSX",
  component: "SSX Advisor",
  issueType: "Oppgave",
  description: "## Where",
};

function result(overrides: Partial<DraftResult> = {}): DraftResult {
  return {
    ticket: null,
    duplicate: null,
    reason: "One ask.",
    questions: [],
    reposRead: [],
    injectionNoticed: [],
    ...overrides,
  };
}

function drafted(ticket: DraftTicket = TICKET): ThreadDraftOutcome {
  return { kind: "drafted", ticket, result: result({ ticket }) };
}

/** Keyed by every outcome kind but a ticket, so a new kind is a type error here until it is covered. */
const NOT_A_TICKET: Record<Exclude<ThreadDraftOutcome["kind"], "drafted">, ThreadDraftOutcome> = {
  declined: { kind: "declined", result: result() },
  empty: { kind: "empty" },
  "too-long": { kind: "too-long", reason: "the thread is long" },
  duplicate: {
    kind: "duplicate",
    duplicate: { key: "SSX-1", feedback: "More." },
    result: result(),
  },
};

function harness(
  options: { readonly gate?: Partial<FileGateDeps>; readonly pending?: Partial<PendingStore> } = {},
): {
  readonly offer: ReturnType<typeof createDraftOffer>;
  readonly facts: ReturnType<typeof vi.fn>;
  readonly created: unknown[];
  readonly removed: string[];
} {
  const created: unknown[] = [];
  const removed: string[] = [];
  const facts = vi.fn(async () => ({
    components: ["SSX Advisor"],
    issueTypes: ["Oppgave"],
  }));
  const base = discardingStore(() => ID);
  const offer = createDraftOffer({
    gate: { projects: ["SSX"], facts, ...options.gate },
    pending: {
      create: async (draft) => {
        created.push(draft);
        return await base.create(draft);
      },
      get: base.get,
      remove: async (id) => {
        removed.push(id);
      },
      ...options.pending,
    },
  });
  return { offer, facts, created, removed };
}

describe("createDraftOffer", () => {
  it("gives a ticket the gate allows a Post button carrying the id of the record kept for it", async () => {
    const { offer, created } = harness();

    const prepared = await offer.prepare(drafted(), TEXT, WHO);

    expect(created).toEqual([{ asker: "U0ASKER1", thread: WHO.thread, ticket: TICKET }]);
    expect(prepared.text).toBe(TEXT);
    expect(prepared.blocks?.at(-1)).toMatchObject({
      type: "actions",
      elements: [{ action_id: POST_ACTION_ID, value: ID }],
    });
  });

  it("says in the message exactly what the button files, and where", async () => {
    const { offer } = harness();

    const prepared = await offer.prepare(drafted(), TEXT, WHO);

    const shown = (prepared.blocks ?? [])
      .map((block) => (block as { text?: { text?: string } }).text?.text ?? "")
      .join("\n");
    expect(shown).toContain(TEXT);
    expect(shown).toContain(
      "Pressing *Post to Jira* files nothing yet: it checks this draft again and writes the request it would make, for Oppgave in the component SSX Advisor of SSX.",
    );
  });

  it("escapes the project, component and type in that sentence, since a model wrote them", async () => {
    const { offer } = harness({
      gate: {
        projects: ["SSX"],
        facts: async () => ({ components: ["<!channel> & co"], issueTypes: ["<@U0X>"] }),
      },
    });

    const prepared = await offer.prepare(
      drafted({ ...TICKET, component: "<!channel> & co", issueType: "<@U0X>" }),
      TEXT,
      WHO,
    );

    const shown = JSON.stringify(prepared.blocks);
    expect(shown).toContain("&lt;!channel&gt; &amp; co");
    expect(shown).not.toContain("<!channel>");
    expect(shown).not.toContain("<@U0X>");
  });

  it.each(Object.entries(NOT_A_TICKET))(
    "sends the outcome %s unchanged, keeps no record and does not ask Jira anything",
    async (_kind, outcome) => {
      const { offer, facts, created } = harness();

      const prepared = await offer.prepare(outcome, TEXT, WHO);

      expect(prepared).toMatchObject({ text: TEXT, blocks: null });
      expect(created).toEqual([]);
      expect(facts).not.toHaveBeenCalled();
    },
  );

  it("says why when the gate refuses, escaped, and keeps no record", async () => {
    const { offer, created } = harness();

    const prepared = await offer.prepare(
      drafted({ ...TICKET, component: "<b>Payments</b>" }),
      TEXT,
      WHO,
    );

    expect(prepared.blocks).toBeNull();
    expect(prepared.text).toBe(
      `${TEXT}\n_Not offered for posting: &lt;b&gt;Payments&lt;/b&gt; is not a component of SSX._`,
    );
    expect(created).toEqual([]);
  });

  it("sends the draft without a button, saying so, when the record cannot be kept", async () => {
    const { offer } = harness({
      pending: {
        create: async () => {
          throw new Error("ENOSPC: no space left on device");
        },
      },
    });

    const prepared = await offer.prepare(drafted(), TEXT, WHO);

    expect(prepared.blocks).toBeNull();
    expect(prepared.text).toContain(
      "Not offered for posting: the draft could not be kept (ENOSPC: no space left on device).",
    );
  });

  it("forgets the record, and says why, when the draft is too long for a message with a button", async () => {
    const { offer, removed } = harness();
    const long = Array.from({ length: BLOCKS_MAX }, () => "y".repeat(SECTION_MAX)).join("\n");

    const prepared = await offer.prepare(drafted(), long, WHO);

    expect(prepared.blocks).toBeNull();
    expect(prepared.text).toContain("too long for a message that carries a button");
    expect(removed).toEqual([ID]);
  });

  it("forgets the record when the message that carried its button was never sent", async () => {
    const { offer, removed } = harness();
    const prepared = await offer.prepare(drafted(), TEXT, WHO);
    expect(removed).toEqual([]);

    await prepared.discard();

    expect(removed).toEqual([ID]);
  });

  it("does not throw when forgetting the record fails", async () => {
    const { offer } = harness({
      pending: {
        remove: async () => {
          throw new Error("EACCES");
        },
      },
    });
    const prepared = await offer.prepare(drafted(), TEXT, WHO);

    await expect(prepared.discard()).resolves.toBeUndefined();
  });

  it("has nothing to forget for a message it gave no button", async () => {
    const { offer, removed } = harness();
    const prepared = await offer.prepare({ kind: "empty" }, TEXT, WHO);

    await prepared.discard();

    expect(removed).toEqual([]);
  });
});
