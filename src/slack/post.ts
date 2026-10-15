/**
 * A press on a draft's Post to Jira button: the person and the draft are checked, and then a dry
 * listener writes the request a filing would make to a file, while a live one files the draft, reads
 * the issue back from Jira and says in the thread what it found.
 */

import { fileability, type FileGateDeps } from "../draft/gate.ts";
import type { FileOutcome } from "../draft/filer.ts";
import { type PendingDraft, type PendingStore } from "../draft/pending.ts";
import type { DraftTicket } from "../draft/runner.ts";
import { renderAdf } from "../jira/adf.ts";
import type { FiledIssue } from "../jira/client.ts";
import { createLogger } from "../logger.ts";
import { POST_ACTION_ID } from "./draft-blocks.ts";
import { SLACK_USER_ID_PATTERN, escape } from "./render.ts";
import type { Click } from "./socket.ts";

const log = createLogger("slack");

/** What only a listener that is live holds: a writer, and the means to check what it wrote. */
export interface FilingDeps {
  /** Makes the one call and says whether an issue exists; never throws. */
  file(draft: PendingDraft): Promise<FileOutcome>;
  /** The issue as Jira holds it, read over REST. */
  readBack(key: string): Promise<FiledIssue>;
  /** Where an issue is read, or `null` where no link can be made safely. */
  issueUrl(key: string): string | null;
  readonly now?: () => Date;
}

export interface PostClickDeps {
  /** `SLACK_DRAFT_USERS`: the people who may ask for a draft are the only ones who may post one. */
  readonly allowed: readonly string[];
  /** Whether every reply is marked as a dry run, as the listener's other handlers mark theirs. */
  readonly dry: boolean;
  readonly pending: PendingStore;
  readonly gate: FileGateDeps;
  /** Absent for a dry listener, which rehearses; present, a press files the draft. */
  readonly filing?: FilingDeps;
  /** Writes the request a filing would make and resolves to where; files nothing. */
  rehearse(draft: PendingDraft): Promise<string>;
  /** In the draft's thread: `click.threadTs` when the button is on a reply, else its own message. */
  reply(click: Click, text: string): Promise<void>;
}

/** Letters and digits only, so markdown the draft was written in and the form Jira keeps compare as the same words. */
function flat(text: string): string {
  return text.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, "");
}

/** How much of a filing came back as sent: every difference found, and how much of the body arrived. */
export function compareFiled(
  ticket: DraftTicket,
  issue: FiledIssue,
): { readonly differences: readonly string[]; readonly sent: number; readonly got: number } {
  const differences: string[] = [];
  if (issue.project !== ticket.project) {
    differences.push(
      `its project is ${issue.project === "" ? "unreadable" : issue.project}, not ${ticket.project}`,
    );
  }
  if (issue.issueType !== ticket.issueType) {
    differences.push(
      `its type is ${issue.issueType === "" ? "unreadable" : issue.issueType}, not ${ticket.issueType}`,
    );
  }
  if (issue.summary !== ticket.summary) {
    differences.push("its summary differs");
  }
  if (!issue.components.includes(ticket.component)) {
    differences.push(`it lacks the component ${ticket.component}`);
  }
  const sentBody = flat(ticket.description);
  const gotBody = flat(renderAdf(issue.description));
  if (gotBody.length < sentBody.length * 0.8) {
    differences.push(
      `its body is ${String(gotBody.length)} of ${String(sentBody.length)} characters`,
    );
  } else if (!gotBody.includes(sentBody.slice(0, 60))) {
    differences.push("its body does not begin as the draft's does");
  } else if (!gotBody.includes(sentBody.slice(-60))) {
    differences.push("its body does not end as the draft's does");
  }
  return { differences, sent: sentBody.length, got: gotBody.length };
}

export interface PostHandler {
  /** Never throws. */
  handle(click: Click): Promise<void>;
}

export function createPostHandler(deps: PostClickDeps): PostHandler {
  const answer = async (click: Click, decision: string, said: string): Promise<void> => {
    const text = deps.dry ? `(dry run, nothing filed) ${said}` : said;
    log.info("slack.post_pressed", {
      user: click.userId,
      id: click.value,
      messageTs: click.messageTs,
      threadTs: click.threadTs,
      decision,
      said,
    });
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

  const linked = (key: string): string => {
    const url = deps.filing?.issueUrl(key) ?? null;
    return url === null ? escape(key) : `<${url}|${escape(key)}>`;
  };

  /**
   * The mark is written before the writer runs, so a crash anywhere after it leaves a draft that
   * says it may have been filed, and the key is written before the read-back, so a read that fails
   * cannot lose it.
   */
  const fileIt = async (click: Click, draft: PendingDraft, filing: FilingDeps): Promise<void> => {
    const now = filing.now ?? (() => new Date());
    let marked: PendingDraft;
    try {
      marked = await deps.pending.update(draft.id, { filing: { startedAt: now().toISOString() } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await answer(
        click,
        "failed",
        `I could not mark this draft before filing it, so nothing was filed: ${escape(reason)}.`,
      );
      return;
    }
    let outcome: FileOutcome;
    try {
      outcome = await filing.file(marked);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcome = { kind: "unclear", reason: `the writer threw (${reason})` };
    }
    if (outcome.kind === "not-created") {
      let cleared = true;
      try {
        await deps.pending.update(draft.id, { filing: null });
      } catch (error) {
        cleared = false;
        log.error("slack.post_mark_not_cleared", {
          id: draft.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      await answer(
        click,
        "not-created",
        `Nothing was filed: ${escape(outcome.reason)}. ${cleared ? "The draft is still here, so pressing again retries it." : "I could not clear its mark, so it cannot be posted again."}`,
      );
      return;
    }
    if (outcome.kind === "unclear") {
      log.warn("slack.post_filing_unclear", { id: draft.id, reason: outcome.reason });
      await answer(
        click,
        "unclear",
        `Filing began and I cannot tell whether it finished: ${escape(outcome.reason)}. An issue may exist, so this draft cannot be posted again. Search ${escape(draft.ticket.project)} for "${escape(draft.ticket.summary)}" before drafting it again.`,
      );
      return;
    }
    try {
      await deps.pending.update(draft.id, {
        filed: { key: outcome.key, at: now().toISOString() },
      });
    } catch (error) {
      log.error("slack.post_filed_unrecorded", {
        id: draft.id,
        key: outcome.key,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    let checked: string;
    try {
      const { differences, sent, got } = compareFiled(
        draft.ticket,
        await filing.readBack(outcome.key),
      );
      checked =
        differences.length === 0
          ? `Read back from Jira: project, type, summary and component match, and the body arrived (${String(got)} of ${String(sent)} characters).`
          : `Jira's copy differs from the draft: ${escape(differences.join("; "))}. Check it before anyone relies on it.`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      checked = `Reading it back failed (${escape(reason)}), so check ${linked(outcome.key)} by hand.`;
    }
    log.info("slack.post_filed", { id: draft.id, key: outcome.key, user: click.userId });
    await answer(click, "filed", `Filed as ${linked(outcome.key)}. ${checked}`);
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
      if (draft.filed !== undefined) {
        await answer(
          click,
          "already-filed",
          `This draft was already posted as ${linked(draft.filed.key)}, so nothing was filed again.`,
        );
        return;
      }
      if (draft.filing !== undefined) {
        await answer(
          click,
          "may-be-filed",
          `Filing this draft began at ${escape(draft.filing.startedAt)} and I cannot tell whether it finished, so it cannot be posted again and nothing was filed now. Search ${escape(draft.ticket.project)} for "${escape(draft.ticket.summary)}" before drafting it again.`,
        );
        return;
      }
      const verdict = await fileability(draft.ticket, deps.gate);
      if (!verdict.ok) {
        await answer(click, "refused", `Not posted: ${escape(verdict.reason)}. Nothing was filed.`);
        return;
      }
      if (!deps.dry && deps.filing !== undefined) {
        await fileIt(click, draft, deps.filing);
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
        `The request a live listener would make is written to \`${escape(where)}\`, and nothing was filed.`,
      );
    },
  };
}
