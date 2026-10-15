/**
 * The draft a Post button files, one file per draft under `state/`. The file is the only record, so
 * a wiped `state/` is a press that refuses, never one that files twice.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SLACK_USER_ID_PATTERN } from "../slack/render.ts";
import type { DraftTicket } from "./runner.ts";
import type { ThreadRef } from "./thread.ts";

/** What a button's value carries: it becomes a file name, so nothing else is let through. */
export const PENDING_ID_PATTERN = /^d-[0-9a-f]{24}$/u;

export interface PendingDraft {
  readonly id: string;
  /** Who asked for the draft, and the only person whose click may file it. */
  readonly asker: string;
  readonly thread: ThreadRef;
  readonly ticket: DraftTicket;
  /** For a person pruning records, which never expire; nothing in the service reads it. */
  readonly createdAt: string;
  /** Written before the issue is created, and never cleared except by a create that provably did not happen. */
  readonly filing?: FilingMark;
  /** The issue this draft became; a press on a draft with one answers with it and creates nothing. */
  readonly filed?: FiledMark;
}

export interface FilingMark {
  readonly startedAt: string;
}

export interface FiledMark {
  readonly key: string;
  readonly at: string;
}

export type NewPendingDraft = Omit<PendingDraft, "id" | "createdAt" | "filing" | "filed">;

/** What `update` may change; `null` clears a mark. */
export interface PendingChange {
  readonly filing?: FilingMark | null;
  readonly filed?: FiledMark;
}

export class PendingDraftError extends Error {}

export interface PendingStore {
  create(draft: NewPendingDraft): Promise<PendingDraft>;
  /** `null` for an id that is not one of ours or names no file; throws for a file it cannot trust. */
  get(id: string): Promise<PendingDraft | null>;
  /** Reads the record, applies the change, writes it whole; throws for a record that is not there. */
  update(id: string, change: PendingChange): Promise<PendingDraft>;
  remove(id: string): Promise<void>;
}

/** The only key shape a record may name as the issue it became: it ends up in a link. */
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;

export function newPendingId(): string {
  return `d-${randomBytes(12).toString("hex")}`;
}

export function fileStore(
  directory: string,
  options: { readonly id?: () => string; readonly now?: () => Date } = {},
): PendingStore {
  const newId = options.id ?? newPendingId;
  const now = options.now ?? (() => new Date());
  const pathOf = (id: string): string => join(directory, `${id}.json`);
  const write = async (draft: PendingDraft): Promise<void> => {
    await mkdir(directory, { recursive: true });
    const temporary = `${pathOf(draft.id)}.${randomBytes(4).toString("hex")}.tmp`;
    // A crash between the two leaves a .tmp nobody reads, never a half-written record.
    await writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
    await rename(temporary, pathOf(draft.id));
  };
  const read = async (id: string): Promise<PendingDraft | null> => {
    if (!PENDING_ID_PATTERN.test(id)) {
      return null;
    }
    let raw: string;
    try {
      raw = await readFile(pathOf(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return parsePending(raw, id);
  };
  return {
    create: async (draft) => {
      const id = newId();
      if (!PENDING_ID_PATTERN.test(id)) {
        throw new PendingDraftError(`refusing to keep a draft under the id ${JSON.stringify(id)}`);
      }
      const kept: PendingDraft = { ...draft, id, createdAt: now().toISOString() };
      await write(kept);
      return kept;
    },
    get: read,
    update: async (id, change) => {
      const current = await read(id);
      if (current === null) {
        throw new PendingDraftError(`the record of ${id} is gone, so it cannot be marked`);
      }
      const { filing: _cleared, ...rest } = current;
      const filing = change.filing === undefined ? current.filing : change.filing;
      const updated: PendingDraft = {
        ...rest,
        ...(filing === null || filing === undefined ? {} : { filing }),
        ...(change.filed === undefined ? {} : { filed: change.filed }),
      };
      await write(updated);
      return updated;
    },
    remove: async (id) => {
      if (PENDING_ID_PATTERN.test(id)) {
        await rm(pathOf(id), { force: true });
      }
    },
  };
}

/** Keeps nothing, for a run that sends nothing: the draft it would offer has no message to be pressed on. */
export function discardingStore(newId: () => string = newPendingId): PendingStore {
  return {
    create: async (draft) => ({ ...draft, id: newId(), createdAt: new Date().toISOString() }),
    get: async () => null,
    update: async (id) => {
      throw new PendingDraftError(`a store that keeps nothing cannot mark ${id}`);
    },
    remove: async () => undefined,
  };
}

/** Fails closed: a record missing a field `create` writes, or naming another draft, is not one anyone may file. */
export function parsePending(raw: string, id: string): PendingDraft {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PendingDraftError(`the record of ${id} is not JSON`);
  }
  const record = object(value);
  const thread = object(record["thread"]);
  const ticket = object(record["ticket"]);
  const draft: PendingDraft = {
    id,
    asker: text(record["asker"]),
    thread: { channel: text(thread["channel"]), threadTs: text(thread["threadTs"]) },
    ticket: {
      summary: text(ticket["summary"]),
      project: text(ticket["project"]),
      component: text(ticket["component"]),
      issueType: text(ticket["issueType"]),
      description: text(ticket["description"]),
    },
    createdAt: text(record["createdAt"]),
  };
  // A project, component or type that is empty stays a draft, since the gate is what refuses it.
  const missing = [
    record["id"] === id ? "" : "id",
    SLACK_USER_ID_PATTERN.test(draft.asker) ? "" : "asker",
    draft.thread.channel === "" ? "thread.channel" : "",
    draft.thread.threadTs === "" ? "thread.threadTs" : "",
    draft.ticket.summary === "" ? "ticket.summary" : "",
    draft.ticket.description === "" ? "ticket.description" : "",
    draft.createdAt === "" ? "createdAt" : "",
  ].filter((name) => name !== "");
  if (missing.length > 0) {
    throw new PendingDraftError(
      `the record of ${id} is not one this service wrote: ${missing.join(", ")} missing or wrong`,
    );
  }
  return { ...draft, ...marks(record, id) };
}

/** A mark that is there and unreadable throws: reading it as absent would let a filed draft be filed again. */
function marks(
  record: Record<string, unknown>,
  id: string,
): { readonly filing?: FilingMark; readonly filed?: FiledMark } {
  const result: { filing?: FilingMark; filed?: FiledMark } = {};
  if (record["filing"] !== undefined) {
    const startedAt = text(object(record["filing"])["startedAt"]);
    if (startedAt === "") {
      throw new PendingDraftError(`the record of ${id} has a filing mark that cannot be read`);
    }
    result.filing = { startedAt };
  }
  if (record["filed"] !== undefined) {
    const filed = object(record["filed"]);
    const key = text(filed["key"]);
    const at = text(filed["at"]);
    if (!ISSUE_KEY_PATTERN.test(key) || at === "") {
      throw new PendingDraftError(`the record of ${id} has a filed mark that cannot be read`);
    }
    result.filed = { key, at };
  }
  return result;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
