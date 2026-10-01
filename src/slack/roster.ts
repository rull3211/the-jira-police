/**
 * Who is mentioned on each broadcast: one list for every ticket, kept as a property on the Jira
 * project so the daemon and a hand-run listener read the same one, and changed only by `/bencebot`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JiraClient } from "../jira/client.ts";
import { createLogger } from "../logger.ts";
import { SLACK_USER_ID_PATTERN, escape } from "./render.ts";
import { MENTION_USAGE } from "./start.ts";

const log = createLogger("slack");

export const ROSTER_PROPERTY = "jira-police.slack-subscribers";

/** Every one is a mention on every broadcast; past this the list is refused rather than grown. */
export const MAX_SUBSCRIBERS = 50;

export interface Roster {
  readonly subscribers: readonly string[];
}

export type RosterLoad =
  | { readonly kind: "found"; readonly roster: Roster }
  | { readonly kind: "unreadable"; readonly reason: string };

export interface RosterStore {
  load(): Promise<RosterLoad>;
  save(roster: Roster): Promise<void>;
}

/** `null` for anything this version did not write: the whole list is refused over one odd entry. */
export function parseRoster(value: unknown): Roster | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const subscribers: unknown = (value as Record<string, unknown>)["subscribers"];
  if (!Array.isArray(subscribers) || subscribers.length > MAX_SUBSCRIBERS) {
    return null;
  }
  const valid = subscribers.every(
    (id): id is string => typeof id === "string" && SLACK_USER_ID_PATTERN.test(id),
  );
  if (!valid || new Set(subscribers).size !== subscribers.length) {
    return null;
  }
  return { subscribers };
}

export type RosterCommand = "subscribe" | "unsubscribe" | "status";

/** A bare command asks where you stand; anything but one known word is `null`, answered with usage. */
export function parseCommand(text: string): RosterCommand | "help" | null {
  const words = text
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return "status";
  }
  const [word] = words;
  return words.length === 1 &&
    (word === "subscribe" || word === "unsubscribe" || word === "status" || word === "help")
    ? word
    : null;
}

export interface Applied {
  /** `null` when nothing is to be written. */
  readonly next: Roster | null;
  readonly reply: string;
}

export function applyCommand(command: RosterCommand, user: string, roster: Roster): Applied {
  const listed = roster.subscribers.includes(user);
  const count = roster.subscribers.length;
  if (command === "status") {
    return {
      next: null,
      reply: listed
        ? `You are subscribed, one of ${String(count)}: you are mentioned on each major event of every ticket. \`/bencebot unsubscribe\` stops it.`
        : `You are not subscribed; ${String(count)} ${count === 1 ? "person is" : "people are"}. \`/bencebot subscribe\` mentions you on each major event of every ticket.`,
    };
  }
  if (command === "subscribe") {
    if (listed) {
      return { next: null, reply: "You are already subscribed." };
    }
    if (count >= MAX_SUBSCRIBERS) {
      return {
        next: null,
        reply: `The list is full at ${String(MAX_SUBSCRIBERS)}, so you were not added.`,
      };
    }
    return {
      next: { subscribers: [...roster.subscribers, user] },
      reply: "Subscribed: you will be mentioned on each major event of every ticket.",
    };
  }
  if (!listed) {
    return { next: null, reply: "You were not subscribed, so nothing changed." };
  }
  return {
    next: { subscribers: roster.subscribers.filter((id) => id !== user) },
    reply: "Unsubscribed: you will not be mentioned again.",
  };
}

export interface SlashCommand {
  readonly userId: string;
  readonly text: string;
}

const SUBSCRIBE_USAGE =
  "`/bencebot subscribe` mentions you on each major event of every ticket, `/bencebot unsubscribe` stops it, and `/bencebot` says which you are.";

export const USAGE_REPLY = `${SUBSCRIBE_USAGE} \`/bencebot help\` lists everything the bot answers.`;

export const HELP_REPLY = `${SUBSCRIBE_USAGE}\n${MENTION_USAGE} Only the people on the start list may use those two.`;

/**
 * Load, apply, write, read back. Never throws: the reply is the only place the person who typed the
 * command learns what happened, so a failure is said there as well as logged.
 */
export function createCommandHandler(
  store: RosterStore,
  options: { readonly dry: boolean; readonly where: string },
): (command: SlashCommand) => Promise<string> {
  const prefix = options.dry ? "(dry run, nothing written) " : "";
  const answer = async (command: SlashCommand, ms: Record<string, number>): Promise<string> => {
    const timed = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      try {
        return await work();
      } finally {
        ms[step] = Date.now() - started;
      }
    };
    if (!SLACK_USER_ID_PATTERN.test(command.userId)) {
      return "Slack named no user this list can hold, so nothing changed.";
    }
    const parsed = parseCommand(command.text);
    if (parsed === null) {
      return USAGE_REPLY;
    }
    // Before the list is read, so help still answers while the list cannot be.
    if (parsed === "help") {
      return prefix + HELP_REPLY;
    }
    const loaded = await timed("load", () => store.load());
    if (loaded.kind === "unreadable") {
      return `The subscriber list (${options.where}) cannot be read, so it was left as found: ${escape(loaded.reason)}`;
    }
    const { next, reply } = applyCommand(parsed, command.userId, loaded.roster);
    if (next === null) {
      return prefix + reply;
    }
    await timed("save", () => store.save(next));
    const back = await timed("readBack", () => store.load());
    const wanted = next.subscribers.includes(command.userId);
    if (back.kind !== "found" || back.roster.subscribers.includes(command.userId) !== wanted) {
      return `${prefix}The list was written, but reading it back does not show the change; \`/bencebot\` says where you stand.`;
    }
    return prefix + reply;
  };
  return async (command) => {
    const text = command.text.trim().slice(0, 40);
    // Per Jira step, so a reply that missed Slack's budget says which call was slow.
    const ms: Record<string, number> = {};
    try {
      const reply = await answer(command, ms);
      log.info("slack.command", { user: command.userId, text, dry: options.dry, reply, ms });
      return reply;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("slack.command_failed", { user: command.userId, text, reason, ms });
      return `${prefix}That did not go through: ${escape(reason)}. \`/bencebot\` says where you stand.`;
    }
  };
}

export type RosterReader = Pick<JiraClient, "getProjectProperty">;
export type RosterWriter = Pick<JiraClient, "setProjectProperty">;

/** An absent property is the empty list, which is how the first subscriber finds it. */
export async function loadRoster(jira: RosterReader, project: string): Promise<RosterLoad> {
  const value = await jira.getProjectProperty(project, ROSTER_PROPERTY);
  if (value === null) {
    return { kind: "found", roster: { subscribers: [] } };
  }
  const roster = parseRoster(value);
  return roster === null
    ? {
        kind: "unreadable",
        reason: `${ROSTER_PROPERTY} on ${project} is not a list this version wrote; delete the property to start it afresh`,
      }
    : { kind: "found", roster };
}

export function propertyRosterStore(
  jira: RosterReader & RosterWriter,
  project: string,
): RosterStore {
  return {
    load: () => loadRoster(jira, project),
    save: async (roster) => {
      await jira.setProjectProperty(project, ROSTER_PROPERTY, roster);
    },
  };
}

/** Reads the real list until the first write, then its own, so a dry session builds on itself. */
export function dryRosterStore(
  jira: RosterReader,
  project: string,
  directory: string,
): RosterStore {
  let written: Roster | null = null;
  return {
    load: async () =>
      written === null ? loadRoster(jira, project) : { kind: "found", roster: written },
    save: async (roster) => {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "roster.json"),
        `${JSON.stringify({ project, property: ROSTER_PROPERTY, value: roster }, null, 2)}\n`,
        "utf8",
      );
      written = roster;
    },
  };
}
