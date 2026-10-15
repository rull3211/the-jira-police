import { describe, expect, it, vi } from "vitest";

import { POST_ACTION_ID } from "../slack/draft-blocks.ts";
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
      update: base.update,
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
    // The draft is the message and the note under it, the note being a paragraph of its own.
    expect(prepared.pieces).toHaveLength(2);
    expect(prepared.pieces[0]?.text).toBe(TEXT);
    expect(JSON.stringify(prepared.pieces[0]?.blocks)).not.toContain("actions");
    expect(prepared.pieces[1]?.blocks?.at(-1)).toMatchObject({
      type: "actions",
      elements: [{ action_id: POST_ACTION_ID, value: ID }],
    });
  });

  it("says in the message exactly what the button files, and where", async () => {
    const { offer } = harness();

    const prepared = await offer.prepare(drafted(), TEXT, WHO);

    const shown = prepared.pieces
      .flatMap((piece) => piece.blocks ?? [])
      .map((block) => (block as { text?: { text?: string } }).text?.text ?? "")
      .join("\n");
    expect(shown).toContain(TEXT);
    expect(shown).toContain(
      "Pressing *Post to Jira* checks this draft again and, on a listener that is live, files it once as Oppgave in the component SSX Advisor of SSX; a dry listener only writes the request it would make.",
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

    const shown = JSON.stringify(prepared.pieces);
    expect(shown).toContain("&lt;!channel&gt; &amp; co");
    expect(shown).not.toContain("<!channel>");
    expect(shown).not.toContain("<@U0X>");
  });

  it.each(Object.entries(NOT_A_TICKET))(
    "sends the outcome %s unchanged, keeps no record and does not ask Jira anything",
    async (_kind, outcome) => {
      const { offer, facts, created } = harness();

      const prepared = await offer.prepare(outcome, TEXT, WHO);

      expect(prepared.pieces).toEqual([{ text: TEXT, blocks: null }]);
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

    expect(prepared.pieces).toEqual([
      {
        text: `${TEXT}\n_Not offered for posting: &lt;b&gt;Payments&lt;/b&gt; is not a component of SSX._`,
        blocks: null,
      },
    ]);
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

    expect(prepared.pieces.every((piece) => piece.blocks === null)).toBe(true);
    expect(prepared.pieces[0]?.text).toContain(
      "Not offered for posting: the draft could not be kept (ENOSPC: no space left on device).",
    );
  });

  it("keeps one record for a draft over a message, and puts the button only under the last piece", async () => {
    const { offer, created, removed } = harness();
    const long = Array.from(
      { length: 2000 },
      (_, index) => `line ${String(index)} ${"y".repeat(40)}`,
    ).join("\n");

    const prepared = await offer.prepare(drafted(), long, WHO);

    expect(prepared.pieces.length).toBeGreaterThan(1);
    expect(created).toHaveLength(1);
    expect(removed).toEqual([]);
    const buttons = prepared.pieces.map((piece) =>
      (piece.blocks ?? []).some((block) => (block as { type: string }).type === "actions"),
    );
    expect(buttons).toEqual(
      prepared.pieces.map((_, index) => index === prepared.pieces.length - 1),
    );
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
