/**
 * One Slack thread to one draft: read it, refuse what is too long before anything is paid for, run
 * the session, and say what came of it in the words the person will read.
 */

import type { ThreadMessage } from "../slack/client.ts";
import { escape } from "../slack/render.ts";
import type { DraftResult, DraftTicket } from "./runner.ts";

export const THREAD_MAX_MESSAGES = 500;
/** The thread travels in the prompt, and the prompt is one argv element. */
export const THREAD_MAX_CHARS = 100_000;

/**
 * Each message's body is quoted line by line, so a line of the thread can never stand where a
 * header does and put words in someone else's mouth.
 */
export function renderThread(messages: readonly ThreadMessage[]): string {
  return messages
    .map((message) => {
      const author =
        message.user !== null ? `<@${message.user}>` : `bot ${message.botId ?? "(no id given)"}`;
      const body = message.text.split("\n").map((line) => `> ${line}`);
      return [`${author} at ${message.ts}:`, ...body].join("\n");
    })
    .join("\n\n");
}

export interface ThreadDraftDeps {
  messages(
    channel: string,
    ts: string,
    max: number,
  ): Promise<{ readonly messages: readonly ThreadMessage[]; readonly complete: boolean }>;
  draft(thread: string, threadLabel: string): Promise<DraftResult>;
}

export interface ThreadRef {
  readonly channel: string;
  readonly threadTs: string;
}

export type ThreadDraftOutcome =
  | { readonly kind: "empty" }
  | { readonly kind: "too-long"; readonly reason: string }
  | {
      readonly kind: "drafted";
      readonly ticket: DraftTicket;
      readonly result: DraftResult;
    }
  | { readonly kind: "declined"; readonly result: DraftResult };

/** Throws what the session throws — a dropped MCP server, a timeout — for the caller to report. */
export async function draftThread(
  deps: ThreadDraftDeps,
  thread: ThreadRef,
): Promise<ThreadDraftOutcome> {
  const read = await deps.messages(thread.channel, thread.threadTs, THREAD_MAX_MESSAGES);
  if (read.messages.length === 0) {
    return { kind: "empty" };
  }
  if (!read.complete) {
    return {
      kind: "too-long",
      reason: `the thread has more than ${THREAD_MAX_MESSAGES} messages`,
    };
  }
  const rendered = renderThread(read.messages);
  if (rendered.length > THREAD_MAX_CHARS) {
    return {
      kind: "too-long",
      reason: `the thread runs to ${rendered.length} characters, over ${THREAD_MAX_CHARS}`,
    };
  }
  const result = await deps.draft(rendered, threadLabel(thread));
  return result.ticket === null
    ? { kind: "declined", result }
    : { kind: "drafted", ticket: result.ticket, result };
}

export function threadLabel(thread: ThreadRef): string {
  return `${thread.channel}-${thread.threadTs}`;
}

/** How a message names the thread: its link when one is known, its channel otherwise. */
export function threadReference(link: string | null, channel: string): string {
  return link !== null && /^https:\/\/[^\s<>|]+$/u.test(link)
    ? `<${link}|this thread>`
    : `a thread in <#${channel}>`;
}

/** Every string in it came from a stranger's thread or a model, so every one is escaped. */
export function renderDraftMessage(outcome: ThreadDraftOutcome, where: string): string {
  switch (outcome.kind) {
    case "empty":
      return `Slack returned no messages for ${where}, so nothing was drafted.`;
    case "too-long":
      return `Nothing was drafted from ${where}: ${escape(outcome.reason)}.`;
    case "declined":
      return [
        `*No ticket drafted* from ${where}: ${escape(outcome.result.reason)}`,
        ...questions(outcome.result),
        ...footer(outcome.result),
      ].join("\n");
    case "drafted": {
      const { ticket, result } = outcome;
      return [
        `*Draft ticket* from ${where}`,
        `*${escape(ticket.summary)}*`,
        `Project: ${chosen(ticket.project)} · Component: ${chosen(ticket.component)} · Type: ${chosen(ticket.issueType)}`,
        `_${escape(result.reason)}_`,
        ...questions(result),
        "",
        escape(ticket.description),
        "",
        ...footer(result),
        "Nothing has been filed in Jira.",
      ].join("\n");
    }
  }
}

function chosen(value: string): string {
  return value === "" ? "_not chosen_" : escape(value);
}

function questions(result: DraftResult): readonly string[] {
  return result.questions.length === 0
    ? []
    : ["", "*Open questions*", ...result.questions.map((question) => `• ${escape(question)}`)];
}

function footer(result: DraftResult): readonly string[] {
  const read =
    result.reposRead.length === 0
      ? "Read no checkout."
      : `Read: ${result.reposRead.map(escape).join(", ")}.`;
  const injected =
    result.injectionNoticed.length === 0
      ? []
      : [
          `:warning: The thread held text addressed to the bot, not acted on: ${result.injectionNoticed.map((quote) => `"${escape(quote)}"`).join("; ")}`,
        ];
  return [read, ...injected];
}
