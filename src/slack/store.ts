/**
 * Where an audit record lives, and where its messages go: the ticket's property and Slack when live,
 * and local files when dry — a dry run still reads the real record, so it shows what would happen.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JiraClient } from "../jira/client.ts";
import { AUDIT_PROPERTY, type AuditRecord, parseRecord } from "./audit.ts";
import type { SlackClient } from "./client.ts";
import { SlackError } from "./client.ts";
import type { RenderedMessage } from "./render.ts";

export type Loaded =
  | { readonly kind: "absent" }
  | { readonly kind: "found"; readonly record: AuditRecord }
  | { readonly kind: "unreadable" };

export interface AuditStore {
  load(key: string): Promise<Loaded>;
  save(key: string, record: AuditRecord): Promise<void>;
}

export interface Thread {
  readonly channel: string;
  readonly ts: string;
}

export interface Publisher {
  post(key: string, message: RenderedMessage): Promise<Thread>;
  /** `gone` when the message no longer exists, so the caller can post a fresh one. */
  update(key: string, thread: Thread, message: RenderedMessage): Promise<"updated" | "gone">;
  /** A reply in `thread` that also lands at the bottom of the channel; resolves to its `ts`. */
  broadcast(key: string, thread: Thread, message: RenderedMessage): Promise<string>;
  /** `gone` when the reply was already deleted, which is the same outcome. */
  remove(key: string, thread: Thread, ts: string): Promise<"removed" | "gone">;
}

export type PropertyReader = Pick<JiraClient, "getIssueProperty">;
export type PropertyWriter = Pick<JiraClient, "setIssueProperty">;

export async function loadFromProperty(jira: PropertyReader, key: string): Promise<Loaded> {
  const value = await jira.getIssueProperty(key, AUDIT_PROPERTY);
  if (value === null) {
    return { kind: "absent" };
  }
  const record = parseRecord(value);
  return record === null ? { kind: "unreadable" } : { kind: "found", record };
}

export function propertyStore(jira: PropertyReader & PropertyWriter): AuditStore {
  return {
    load: (key) => loadFromProperty(jira, key),
    save: async (key, record) => {
      await jira.setIssueProperty(key, AUDIT_PROPERTY, record);
    },
  };
}

/** Reads the real record and writes nothing remote: the dry run's store. */
export function dryStore(jira: PropertyReader, directory: string): AuditStore {
  return {
    load: (key) => loadFromProperty(jira, key),
    save: async (key, record) => {
      await writeJson(directory, `${key}.record.json`, record);
    },
  };
}

export function slackPublisher(
  slack: Pick<SlackClient, "post" | "update" | "deleteMessage">,
  channel: string,
): Publisher {
  return {
    post: async (_key, message) => {
      const posted = await slack.post({ channel, text: message.text, blocks: message.blocks });
      return { channel, ts: posted.ts };
    },
    update: async (_key, thread, message) => {
      try {
        await slack.update({
          channel: thread.channel,
          ts: thread.ts,
          text: message.text,
          blocks: message.blocks,
        });
        return "updated";
      } catch (error) {
        if (error instanceof SlackError && error.code === "message_not_found") {
          return "gone";
        }
        throw error;
      }
    },
    broadcast: async (_key, thread, message) => {
      const posted = await slack.post({
        channel: thread.channel,
        text: message.text,
        threadTs: thread.ts,
        broadcast: true,
      });
      return posted.ts;
    },
    remove: async (_key, thread, ts) => {
      try {
        await slack.deleteMessage({ channel: thread.channel, ts });
        return "removed";
      } catch (error) {
        if (error instanceof SlackError && error.code === "message_not_found") {
          return "gone";
        }
        throw error;
      }
    },
  };
}

/** The exact request a live run would send, one file per ticket, rewritten on each event. */
export function dryPublisher(directory: string): Publisher {
  const write = async (
    key: string,
    method: string,
    message: RenderedMessage,
    thread: Thread | null,
  ): Promise<void> => {
    await writeJson(directory, `${key}.message.json`, { method, thread, ...message });
  };
  return {
    post: async (key, message) => {
      await write(key, "chat.postMessage", message, null);
      return { channel: "dry-run", ts: "dry-run" };
    },
    update: async (key, thread, message) => {
      await write(key, "chat.update", message, thread);
      return "updated";
    },
    broadcast: async (key, thread, message) => {
      await writeJson(directory, `${key}.broadcast.json`, {
        method: "chat.postMessage",
        thread_ts: thread.ts,
        reply_broadcast: true,
        text: message.text,
      });
      return "dry-run";
    },
    remove: async (key, thread, ts) => {
      await writeJson(directory, `${key}.delete.json`, { method: "chat.delete", thread, ts });
      return "removed";
    },
  };
}

export async function writeJson(directory: string, name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
