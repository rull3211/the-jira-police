/**
 * `@Bencebot start` and `@Bencebot clear` in a ticket's audit thread: which ticket the thread is,
 * whether the edit is one the solve queue would act on, and the label write with its read-back.
 */

import { createLogger } from "../logger.ts";
import { diffEdit } from "../solve/claim.ts";
import { AGENT_LABELS, type LabelEdit, eligibility, labelEdit } from "../solve/labels.ts";
import { SLACK_USER_ID_PATTERN, escape } from "./render.ts";
import type { Loaded } from "./store.ts";

const log = createLogger("slack");

export type ThreadVerb = "start" | "clear";

const MENTION_MARKUP = /<@[A-Z0-9]+(?:\|[^>]*)?>/gu;

/** Every mention taken out, then exactly one known word; anything else is `null`, answered with usage. */
export function parseMentionVerb(text: string): ThreadVerb | null {
  const words = text
    .replace(MENTION_MARKUP, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "");
  const [word] = words;
  return words.length === 1 && (word === "start" || word === "clear") ? word : null;
}

const LINK_PATH = /^\/archives\/([CG][A-Z0-9]{2,})\/p(\d{16})$/u;
const SLACK_TS = /^\d{10}\.\d{6}$/u;

/**
 * A message link as Slack's "Copy link" writes it; the thread is its `thread_ts` when the link is a
 * reply, and the message itself otherwise. `null` for anything else, a direct message's included.
 */
export function parseThreadLink(link: string): { channel: string; threadTs: string } | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const path = LINK_PATH.exec(url.pathname);
  const [, channel, digits] = path ?? [];
  if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com") || !channel || !digits) {
    return null;
  }
  const reply = url.searchParams.get("thread_ts");
  if (reply !== null) {
    return SLACK_TS.test(reply) ? { channel, threadTs: reply } : null;
  }
  return { channel, threadTs: `${digits.slice(0, 10)}.${digits.slice(10)}` };
}

export interface RootMessage {
  readonly ts: string;
  readonly text: string;
  readonly botId: string | null;
}

/** The issue the bot's own top message opens with, as `renderRecord`'s fallback text writes it. */
const ROOT_ISSUE = /^([A-Z][A-Z0-9]*-\d+):/u;

export type ThreadTicket =
  | { readonly kind: "ticket"; readonly key: string }
  | { readonly kind: "none"; readonly reason: string };

/** Only a message the bot posted can name the ticket: anyone can start a thread that opens with a key. */
export function ticketOfRoot(
  root: RootMessage | null,
  threadTs: string,
  botId: string,
): ThreadTicket {
  if (root === null || root.ts !== threadTs) {
    return { kind: "none", reason: "Slack returned no top message for this thread" };
  }
  if (root.botId !== botId) {
    return { kind: "none", reason: "the thread's top message is not one the bot posted" };
  }
  const issue = ROOT_ISSUE.exec(root.text)?.[1];
  return issue === undefined
    ? { kind: "none", reason: "the bot's top message names no ticket" }
    : { kind: "ticket", key: issue };
}

/** `null` when the ticket's own record names this thread; otherwise why the two do not agree. */
export function recordNamesThread(
  loaded: Loaded,
  key: string,
  channel: string,
  threadTs: string,
): string | null {
  if (loaded.kind === "absent") {
    return `${key} has no jira-police.slack record, so nothing on the ticket ties it to this thread`;
  }
  if (loaded.kind === "unreadable") {
    return `${key}'s jira-police.slack record cannot be read, so nothing on the ticket ties it to this thread`;
  }
  const thread = loaded.record.slack;
  if (thread?.channel !== channel || thread.ts !== threadTs) {
    return `${key}'s jira-police.slack record names a different thread`;
  }
  return null;
}

export type Decision =
  | { readonly kind: "write"; readonly edit: LabelEdit }
  | { readonly kind: "unchanged"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

export function decide(verb: ThreadVerb, labels: readonly string[]): Decision {
  if (verb === "clear") {
    return labels.includes(AGENT_LABELS.failed)
      ? { kind: "write", edit: labelEdit([], [AGENT_LABELS.failed]) }
      : { kind: "unchanged", reason: `it carries no ${AGENT_LABELS.failed}` };
  }
  // The queue's own question: a start it would not act on is a go-ahead left lying for later.
  const verdict = eligibility([...labels, AGENT_LABELS.start], "manual");
  if (!verdict.eligible) {
    const hint = labels.includes(AGENT_LABELS.failed)
      ? `; \`@Bencebot clear\` takes ${AGENT_LABELS.failed} off first`
      : "";
    return { kind: "refused", reason: `${verdict.reason}${hint}` };
  }
  return labels.includes(AGENT_LABELS.start)
    ? { kind: "unchanged", reason: `it already carries ${AGENT_LABELS.start}` }
    : { kind: "write", edit: labelEdit([AGENT_LABELS.start], []) };
}

/** `dry` writes the edit somewhere to be read and not to the ticket, so there is nothing to read back. */
export interface ThreadLabels {
  readonly dry: boolean;
  read(key: string): Promise<readonly string[]>;
  apply(key: string, edit: LabelEdit): Promise<void>;
}

export interface ThreadDeps {
  /** The bot's own ID, from `auth.test`. */
  botId(): Promise<string>;
  root(channel: string, ts: string): Promise<RootMessage | null>;
  record(key: string): Promise<Loaded>;
  readonly labels: ThreadLabels;
}

export interface ThreadRequest {
  readonly verb: ThreadVerb;
  readonly channel: string;
  readonly threadTs: string;
}

export type ThreadOutcome =
  | { readonly kind: "no-ticket"; readonly reason: string }
  | { readonly kind: "refused"; readonly key: string; readonly reason: string }
  | { readonly kind: "unchanged"; readonly key: string; readonly reason: string }
  | { readonly kind: "dry"; readonly key: string; readonly edit: LabelEdit }
  | { readonly kind: "written"; readonly key: string; readonly edit: LabelEdit }
  | {
      readonly kind: "unverified";
      readonly key: string;
      readonly edit: LabelEdit;
      readonly notes: readonly string[];
    };

/** Both halves of the tie must hold — the bot's top message and the ticket's record — before a label is read. */
export async function runThreadCommand(
  deps: ThreadDeps,
  request: ThreadRequest,
): Promise<ThreadOutcome> {
  const { verb, channel, threadTs } = request;
  const found = ticketOfRoot(await deps.root(channel, threadTs), threadTs, await deps.botId());
  if (found.kind === "none") {
    return { kind: "no-ticket", reason: found.reason };
  }
  const { key } = found;
  const unbound = recordNamesThread(await deps.record(key), key, channel, threadTs);
  if (unbound !== null) {
    return { kind: "no-ticket", reason: unbound };
  }

  const decision = decide(verb, await deps.labels.read(key));
  if (decision.kind !== "write") {
    return { kind: decision.kind, key, reason: decision.reason };
  }
  await deps.labels.apply(key, decision.edit);
  if (deps.labels.dry) {
    return { kind: "dry", key, edit: decision.edit };
  }

  const diff = diffEdit(decision.edit, await deps.labels.read(key));
  const notes = [
    ...diff.vanished.map((label) => `${label} was written and is not on the ticket`),
    ...diff.appeared.map((label) => `${label} was taken off and is still on the ticket`),
  ];
  return notes.length === 0
    ? { kind: "written", key, edit: decision.edit }
    : { kind: "unverified", key, edit: decision.edit, notes };
}

export const MENTION_USAGE = `In a ticket's thread, \`@Bencebot start\` adds ${AGENT_LABELS.start} so the solve queue offers it, and \`@Bencebot clear\` takes ${AGENT_LABELS.failed} off a ticket the solver already tried.`;

export function describeThreadOutcome(verb: ThreadVerb, outcome: ThreadOutcome): string {
  const label = verb === "start" ? AGENT_LABELS.start : AGENT_LABELS.failed;
  switch (outcome.kind) {
    case "no-ticket":
      return `This thread is not tied to one ticket, so nothing changed: ${escape(outcome.reason)}.`;
    case "refused":
    case "unchanged":
      return `${outcome.key} was left as found: ${escape(outcome.reason)}.`;
    case "dry":
      return verb === "start"
        ? `Would add ${label} to ${outcome.key}, so the solve queue would offer it.`
        : `Would take ${label} off ${outcome.key}, so \`@Bencebot start\` could start it again.`;
    case "written":
      return verb === "start"
        ? `Started ${outcome.key}: ${label} is on it, so the solve queue offers it.`
        : `Cleared ${outcome.key}: ${label} is off it, so \`@Bencebot start\` can start it again.`;
    case "unverified":
      return `The edit was sent to ${outcome.key}, and reading it back disagrees: ${escape(outcome.notes.join("; "))}. Look at the ticket before trying again.`;
  }
}

export interface Mention {
  readonly userId: string;
  readonly text: string;
  readonly channel: string;
  readonly ts: string;
  /** `null` for a mention that is not in a thread. */
  readonly threadTs: string | null;
}

/**
 * The person is the event's `user`, which Slack sets; nothing they typed can name someone else. Never
 * throws: the reply is where the person learns what happened, so a failure is said there and logged.
 */
export function createMentionHandler(options: {
  readonly allowed: readonly string[];
  readonly deps: ThreadDeps;
  readonly reply: (mention: Mention, text: string) => Promise<void>;
}): (mention: Mention) => Promise<void> {
  const prefix = options.deps.labels.dry ? "(dry run, nothing written) " : "";
  const answer = async (mention: Mention, verb: ThreadVerb | null): Promise<string> => {
    if (!SLACK_USER_ID_PATTERN.test(mention.userId)) {
      return "Slack named no user, so nothing changed.";
    }
    if (verb === null) {
      return MENTION_USAGE;
    }
    if (!options.allowed.includes(mention.userId)) {
      return "Only the people on the start list may start or clear a ticket from Slack, and you are not one of them, so nothing changed.";
    }
    if (mention.threadTs === null) {
      return `Nothing changed: this is not a thread. ${MENTION_USAGE}`;
    }
    const outcome = await runThreadCommand(options.deps, {
      verb,
      channel: mention.channel,
      threadTs: mention.threadTs,
    });
    log.info("slack.thread_command", {
      user: mention.userId,
      verb,
      channel: mention.channel,
      threadTs: mention.threadTs,
      outcome: outcome.kind,
      key: outcome.kind === "no-ticket" ? null : outcome.key,
      dry: options.deps.labels.dry,
    });
    return describeThreadOutcome(verb, outcome);
  };

  return async (mention) => {
    const verb = parseMentionVerb(mention.text);
    let reply: string;
    try {
      reply = prefix + (await answer(mention, verb));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("slack.thread_command_failed", { user: mention.userId, verb, reason });
      reply = `${prefix}That did not go through: ${escape(reason)}. Whether anything changed is unknown, so look at the ticket's labels before trying again.`;
    }
    try {
      await options.reply(mention, reply);
    } catch (error) {
      log.warn("slack.mention_reply_failed", {
        user: mention.userId,
        reply,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
