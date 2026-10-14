/**
 * Whether a draft message carries a Post button: only a ticket the gate would let through, with its
 * record kept first so no button is ever sent that points at nothing.
 */

import { draftBlocks } from "../slack/draft-blocks.ts";
import { escape } from "../slack/render.ts";
import { type FileGateDeps, fileability } from "./gate.ts";
import type { PendingStore } from "./pending.ts";
import type { ThreadDraftOutcome, ThreadRef } from "./thread.ts";

export interface DraftOfferDeps {
  readonly gate: FileGateDeps;
  readonly pending: PendingStore;
}

export interface PreparedDraft {
  readonly text: string;
  /** `null` for a message with no button. */
  readonly blocks: readonly object[] | null;
  /** Forgets the record when the message that carried its button was never sent; never throws. */
  discard(): Promise<void>;
}

export interface DraftOffer {
  /** Never throws: a draft that finished reaches the person, with or without the button. */
  prepare(
    outcome: ThreadDraftOutcome,
    text: string,
    who: { readonly asker: string; readonly thread: ThreadRef },
  ): Promise<PreparedDraft>;
}

function plain(text: string, withheld: string | null): PreparedDraft {
  return {
    text: withheld === null ? text : `${text}\n_Not offered for posting: ${escape(withheld)}._`,
    blocks: null,
    discard: async () => undefined,
  };
}

export function createDraftOffer(deps: DraftOfferDeps): DraftOffer {
  return {
    prepare: async (outcome, text, who) => {
      if (outcome.kind !== "drafted") {
        return plain(text, null);
      }
      const { ticket } = outcome;
      const verdict = await fileability(ticket, deps.gate);
      if (!verdict.ok) {
        return plain(text, verdict.reason);
      }
      let id: string;
      try {
        id = (await deps.pending.create({ asker: who.asker, thread: who.thread, ticket })).id;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return plain(text, `the draft could not be kept (${why})`);
      }
      const discard = async (): Promise<void> => {
        await deps.pending.remove(id).catch(() => undefined);
      };
      const note = `Pressing *Post to Jira* does nothing yet. It is for filing exactly this draft as ${escape(ticket.issueType)} in the component ${escape(ticket.component)} of ${escape(ticket.project)}, and nothing else.`;
      const blocks = draftBlocks(`${text}\n\n${note}`, id);
      if (blocks === null) {
        await discard();
        return plain(text, "the draft is too long for a message that carries a button");
      }
      return { text, blocks, discard };
    },
  };
}
