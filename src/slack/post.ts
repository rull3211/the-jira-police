/**
 * A press on a draft's Post to Jira button: the person and the draft are checked, then the request
 * is written to a file as a rehearsal, and the person is told in the message's thread that nothing
 * was filed.
 */

import { fileability, type FileGateDeps } from "../draft/gate.ts";
import { type PendingDraft, type PendingStore } from "../draft/pending.ts";
import { createLogger } from "../logger.ts";
import { POST_ACTION_ID } from "./draft-blocks.ts";
import { SLACK_USER_ID_PATTERN, escape } from "./render.ts";
import type { Click } from "./socket.ts";

const log = createLogger("slack");

export interface PostClickDeps {
  /** `SLACK_DRAFT_USERS`: the people who may ask for a draft are the only ones who may post one. */
  readonly allowed: readonly string[];
  readonly pending: PendingStore;
  readonly gate: FileGateDeps;
  /** Writes the request a filing would make and resolves to where; files nothing. */
  rehearse(draft: PendingDraft): Promise<string>;
  /** In the thread of the message the button is on. */
  reply(click: Click, text: string): Promise<void>;
}

export interface PostHandler {
  /** Never throws. */
  handle(click: Click): Promise<void>;
}

export function createPostHandler(deps: PostClickDeps): PostHandler {
  const answer = async (click: Click, decision: string, text: string): Promise<void> => {
    log.info("slack.post_pressed", { user: click.userId, id: click.value, decision });
    try {
      await deps.reply(click, text);
    } catch (error) {
      log.warn("slack.post_reply_failed", {
        user: click.userId,
        decision,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    handle: async (click) => {
      if (click.actionId !== POST_ACTION_ID) {
        log.info("slack.click_ignored", { user: click.userId, actionId: click.actionId });
        return;
      }
      if (click.channel === "" || click.messageTs === "") {
        log.warn("slack.post_unplaced", {
          user: click.userId,
          note: "the press named no message, so there is nowhere to answer",
        });
        return;
      }
      if (!SLACK_USER_ID_PATTERN.test(click.userId) || !deps.allowed.includes(click.userId)) {
        await answer(
          click,
          "not-allowed",
          "Only the people on the draft list may post a draft, and you are not one of them, so nothing was read and nothing was filed.",
        );
        return;
      }
      let draft: PendingDraft | null;
      try {
        draft = await deps.pending.get(click.value);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await answer(
          click,
          "unreadable",
          `I could not read the record of this draft: ${escape(reason)}. Nothing was filed.`,
        );
        return;
      }
      if (draft === null) {
        await answer(
          click,
          "gone",
          "I no longer hold this draft, so nothing was filed. Mention `@Bencebot draft` in the thread again for a fresh one.",
        );
        return;
      }
      if (draft.asker !== click.userId) {
        await answer(
          click,
          "not-asker",
          `This draft was asked for by <@${draft.asker}>, and only they may post it, so nothing was filed.`,
        );
        return;
      }
      const verdict = await fileability(draft.ticket, deps.gate);
      if (!verdict.ok) {
        await answer(click, "refused", `Not posted: ${escape(verdict.reason)}. Nothing was filed.`);
        return;
      }
      let where: string;
      try {
        where = await deps.rehearse(draft);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await answer(
          click,
          "failed",
          `The request could not be written: ${escape(reason)}. Nothing was filed.`,
        );
        return;
      }
      await answer(
        click,
        "rehearsed",
        `Nothing was filed: filing is not built yet. The request it would make is written to \`${escape(where)}\`.`,
      );
    },
  };
}
