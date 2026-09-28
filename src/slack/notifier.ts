/**
 * The one way the pipeline tells Slack what happened to a ticket: load its record, apply the event,
 * redraw the message, post or edit it, broadcast a major entry, save the record.
 *
 * Never throws. Slack is a reporting channel, and a Slack or property failure must not fail the paid
 * work it reports on; it is logged with the remote system's own reason, and returned.
 */

import { createLogger } from "../logger.ts";
import type { PassRunner } from "../solve/orchestrator.ts";
import {
  AUDIT_PROPERTY,
  type AuditEvent,
  type AuditRecord,
  type Entry,
  addedMajor,
  applyEvent,
  newRecord,
  retitle,
} from "./audit.ts";
import { renderBump, renderRecord } from "./render.ts";
import type { AuditStore, Publisher, Thread } from "./store.ts";

const log = createLogger("slack");

export interface TicketFacts {
  readonly summary: string;
  readonly url: string;
}

export type AuditOutcome =
  | { readonly kind: "posted" }
  | { readonly kind: "edited" }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface AuditNotifier {
  record(key: string, event: AuditEvent, ticket?: TicketFacts): Promise<AuditOutcome>;
  /**
   * Draws the record as it stands, creating the thread if it has none. `bump` broadcasts its latest
   * major entry again, so a person can resurface a ticket, and the broadcast can be driven by hand.
   */
  redraw(key: string, ticket?: TicketFacts, bump?: boolean): Promise<AuditOutcome>;
}

export interface NotifierDeps {
  readonly store: AuditStore;
  readonly publisher: Publisher;
  /** For the link a record gets before any event has named the ticket's URL. */
  readonly jiraBaseUrl: string;
  /** A title for a titleless record drawn without one; a typed key carries only a placeholder. */
  readonly lookup?: (key: string) => Promise<TicketFacts>;
  readonly now?: () => Date;
}

export function createAuditNotifier(deps: NotifierDeps): AuditNotifier {
  const now = deps.now ?? (() => new Date());
  /**
   * One ticket's updates run one at a time, each reading the record the last one wrote. Across two
   * processes nothing serialises them, and a timeline entry can be lost.
   */
  const queues = new Map<string, Promise<unknown>>();

  const enqueue = (
    key: string,
    label: string,
    work: () => Promise<AuditOutcome>,
  ): Promise<AuditOutcome> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(async (): Promise<AuditOutcome> => {
      try {
        return await work();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn("slack.audit_failed", { key, event: label, reason });
        return { kind: "failed", reason };
      }
    });
    queues.set(key, next);
    void next.then(() => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    });
    return next;
  };

  /** `undefined` when there is nothing better than the key: the event is still drawn, under the key. */
  const lookUp = async (key: string): Promise<TicketFacts | undefined> => {
    if (deps.lookup === undefined) {
      return undefined;
    }
    try {
      const found = await deps.lookup(key);
      return found.summary.trim() === "" ? undefined : found;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("slack.title_lookup_failed", { key, reason, note: "drawn under the key" });
      return undefined;
    }
  };

  /**
   * An edit never moves a message, so a major entry is also broadcast, and the ticket's previous
   * broadcast deleted. Failures cost only the bump: the record is saved either way.
   */
  const resurface = async (
    key: string,
    record: AuditRecord,
    thread: Thread,
    entry: Entry,
  ): Promise<AuditRecord> => {
    let bump: string;
    try {
      bump = await deps.publisher.broadcast(key, thread, renderBump(record, entry));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("slack.bump_failed", { key, reason, note: "the card was edited; not resurfaced" });
      return record;
    }
    if (record.bump !== null) {
      try {
        await deps.publisher.remove(key, thread, record.bump);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn("slack.unbump_failed", { key, ts: record.bump, reason });
      }
    }
    return { ...record, bump };
  };

  const apply = async (
    key: string,
    change: (record: AuditRecord) => AuditRecord,
    ticket: TicketFacts | undefined,
    draw: "always" | "if-changed",
    bump = false,
  ): Promise<AuditOutcome> => {
    const loaded = await deps.store.load(key);
    if (loaded.kind === "unreadable") {
      const reason = `${AUDIT_PROPERTY} on ${key} is not a record this version wrote; left as found — delete the property to start the thread afresh`;
      log.warn("slack.record_unreadable", { key, property: AUDIT_PROPERTY, reason });
      return { kind: "skipped", reason };
    }
    const base =
      loaded.kind === "found"
        ? loaded.record
        : newRecord(
            key,
            ticket?.summary ?? key,
            ticket?.url ?? `${deps.jiraBaseUrl}/browse/${key}`,
          );
    const named = ticket ?? (base.summary === key ? await lookUp(key) : undefined);
    const facts = named === undefined ? base : retitle(base, named.summary, named.url);
    const changed = change(facts);
    if (draw === "if-changed" && changed === base && changed.slack !== null) {
      return { kind: "skipped", reason: "the event changed nothing" };
    }
    const message = renderRecord(changed);

    if (changed.slack !== null) {
      const result = await deps.publisher.update(key, changed.slack, message);
      if (result === "updated") {
        const entry = addedMajor(facts, changed) ?? (bump ? (changed.major.at(-1) ?? null) : null);
        await deps.store.save(
          key,
          entry === null ? changed : await resurface(key, changed, changed.slack, entry),
        );
        return { kind: "edited" };
      }
      log.warn("slack.thread_gone", { key, ts: changed.slack.ts, note: "posting a fresh message" });
    }
    const thread = await deps.publisher.post(key, message);
    // Saved straight after the post: an event that cannot find this `ts` opens a duplicate thread.
    await deps.store.save(key, { ...changed, slack: thread });
    return { kind: "posted" };
  };

  return {
    record: (key, event, ticket) =>
      enqueue(key, event.kind, () =>
        apply(key, (record) => applyEvent(record, event, now()), ticket, "if-changed"),
      ),
    redraw: (key, ticket, bump) =>
      enqueue(key, "redraw", () => apply(key, (record) => record, ticket, "always", bump)),
  };
}

/** Every model pass, solve and review round alike, as a start and a finish on its ticket's timeline. */
export function auditPasses(passes: PassRunner, audit: AuditNotifier): PassRunner {
  return {
    run: async (pass, options, parse) => {
      await audit.record(options.issueKey, { kind: "pass-started", pass });
      const result = await passes.run(pass, options, parse);
      await audit.record(options.issueKey, { kind: "pass-finished", pass });
      return result;
    },
  };
}
