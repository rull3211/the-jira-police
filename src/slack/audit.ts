/**
 * One ticket's audit record — the state its Slack message is drawn from — and the events that move
 * it. Pure: no clock, no I/O, so every transition is a test.
 *
 * The record is stored on the ticket as the `jira-police.slack` issue property and holds nothing the
 * message does not show (`architecture/invariants.md` invariant 18).
 */

import { oneLine, shorten } from "../text.ts";

export const AUDIT_PROPERTY = "jira-police.slack";

const RECORD_VERSION = 1;

/** Caps that keep a record under Jira's property limit however long a ticket runs; the probe wrote one this size. */
export const MAX_MAJOR_ENTRIES = 10;
export const MAX_TIMELINE_ENTRIES = 40;
export const MAX_ENTRY_CHARS = 200;

export type TriageState =
  | { readonly kind: "pending" }
  | {
      readonly kind: "verdict";
      readonly verdict: string;
      readonly solvable: boolean;
      readonly confidence: string | null;
      readonly posted: boolean;
    }
  | { readonly kind: "refused" }
  /** Triaged before this thread existed: what the ticket's labels say, never a verdict they cannot prove. */
  | ({ readonly kind: "labelled" } & LabelledTriage);

export interface LabelledTriage {
  readonly dor: "pass" | "gaps" | null;
  readonly solvable: boolean;
}

export type WorkState =
  | { readonly kind: "idle" }
  | { readonly kind: "claimed" }
  | { readonly kind: "solving"; readonly pass: string }
  | { readonly kind: "verified" }
  | { readonly kind: "ended"; readonly outcome: string };

export interface PullRequest {
  readonly url: string;
  readonly number: number;
  /** `reworking`: out of draft, but a round pushed since it was handed over, so it is not ready again yet. */
  readonly state: "draft" | "ready" | "reworking" | "merged" | "closed";
}

export interface Entry {
  /** ISO-8601, UTC. */
  readonly at: string;
  readonly icon: string;
  readonly text: string;
}

export interface AuditRecord {
  readonly version: typeof RECORD_VERSION;
  readonly key: string;
  readonly summary: string;
  readonly url: string;
  readonly repo: string | null;
  readonly slack: { readonly channel: string; readonly ts: string } | null;
  /** The `ts` of the one reply broadcast to the channel for this ticket, deleted when the next is posted. */
  readonly bump: string | null;
  readonly triage: TriageState;
  readonly work: WorkState;
  readonly pr: PullRequest | null;
  readonly crash: { readonly at: string; readonly where: string; readonly message: string } | null;
  /** Oldest first. */
  readonly major: readonly Entry[];
  /** Oldest first; the renderer reverses it. */
  readonly timeline: readonly Entry[];
  readonly dropped: { readonly major: number; readonly timeline: number };
}

export type AuditEvent =
  | { readonly kind: "triage-started" }
  | {
      readonly kind: "triage-verdict";
      readonly verdict: string;
      readonly solvable: boolean;
      readonly confidence: string | null;
      readonly posted: boolean;
    }
  | { readonly kind: "triage-refused"; readonly reason: string }
  | { readonly kind: "claimed"; readonly repo: string | null }
  | { readonly kind: "pass-started"; readonly pass: string }
  | { readonly kind: "pass-finished"; readonly pass: string }
  | { readonly kind: "verified" }
  | { readonly kind: "solve-ended"; readonly outcome: string; readonly reason: string }
  | {
      readonly kind: "pr-opened";
      readonly url: string;
      readonly number: number;
      readonly title: string;
    }
  | { readonly kind: "review-round"; readonly text: string }
  /** What a review look found, recorded before its outcome; fills in only what the record lacks. */
  | {
      readonly kind: "observed";
      readonly pr: { readonly url: string; readonly number: number; readonly draft: boolean };
      readonly triage: LabelledTriage | null;
    }
  | { readonly kind: "pr-ready" }
  | { readonly kind: "pr-reworking" }
  | { readonly kind: "pr-ended"; readonly state: "merged" | "closed" }
  | { readonly kind: "crashed"; readonly where: string; readonly message: string };

export function newRecord(key: string, summary: string, url: string): AuditRecord {
  return {
    version: RECORD_VERSION,
    key,
    summary: bounded(summary),
    url,
    repo: null,
    slack: null,
    bump: null,
    triage: { kind: "pending" },
    work: { kind: "idle" },
    pr: null,
    crash: null,
    major: [],
    timeline: [],
    dropped: { major: 0, timeline: 0 },
  };
}

/** The major entry `after` gained over `before`, or `null`; only a major entry resurfaces a ticket. */
export function addedMajor(before: AuditRecord, after: AuditRecord): Entry | null {
  const entry = after.major.at(-1);
  return entry === undefined || entry === before.major.at(-1) ? null : entry;
}

/** `record` itself when the ticket's title and link are what it already holds. */
export function retitle(record: AuditRecord, summary: string, url: string): AuditRecord {
  const title = bounded(summary);
  return title === record.summary && url === record.url
    ? record
    : { ...record, summary: title, url };
}

/**
 * A crash describes the ticket only until the next event; its entry stays as history. An event that
 * changed nothing returns `record` itself, which is how the notifier knows to write nothing.
 */
export function applyEvent(record: AuditRecord, event: AuditEvent, now: Date): AuditRecord {
  return event.kind === "crashed" || record.crash === null
    ? transition(record, event, now)
    : transition({ ...record, crash: null }, event, now);
}

function transition(record: AuditRecord, event: AuditEvent, now: Date): AuditRecord {
  const at = now.toISOString();
  switch (event.kind) {
    case "triage-started":
      return minor(record, at, "🔎", "triage started");
    case "triage-verdict": {
      const solvable = event.solvable
        ? `solvable${event.confidence === null ? "" : ` (${event.confidence})`}`
        : "not solvable";
      const next: AuditRecord = {
        ...record,
        triage: {
          kind: "verdict",
          verdict: event.verdict,
          solvable: event.solvable,
          confidence: event.confidence,
          posted: event.posted,
        },
      };
      const text = `Triaged — ${event.verdict}, ${solvable}${event.posted ? "" : " (not posted)"}`;
      return major(next, at, "🔍", text);
    }
    case "triage-refused":
      return major(
        { ...record, triage: { kind: "refused" } },
        at,
        "⛔",
        `Triage refused by the gate — ${event.reason}`,
      );
    case "claimed":
      return minor(
        { ...record, work: { kind: "claimed" }, repo: event.repo ?? record.repo },
        at,
        "🙋",
        "claimed",
      );
    case "pass-started":
      return minor(
        { ...record, work: { kind: "solving", pass: event.pass } },
        at,
        "▶️",
        `${event.pass} started`,
      );
    case "pass-finished":
      return minor(record, at, "⏹️", `${event.pass} finished`);
    case "verified":
      return minor({ ...record, work: { kind: "verified" } }, at, "✅", "verified");
    case "solve-ended":
      return major(
        { ...record, work: { kind: "ended", outcome: event.outcome } },
        at,
        "🛑",
        `Solve ended without a pull request — ${event.outcome}: ${event.reason}`,
      );
    case "pr-opened":
      return major(
        { ...record, pr: { url: event.url, number: event.number, state: "draft" } },
        at,
        "🚀",
        `PR opened — #${String(event.number)} ${event.title}`,
      );
    case "review-round":
      return minor(record, at, "💬", event.text);
    case "observed":
      return observe(record, event, at);
    case "pr-ready":
      // A look at a PR already out of draft answers `ready` every tick; only the handover is news.
      if (record.pr?.state === "ready") {
        return record;
      }
      return major(withPrState(record, "ready"), at, "👀", "PR ready for review");
    case "pr-reworking":
      return record.pr?.state === "ready" ? withPrState(record, "reworking") : record;
    case "pr-ended":
      if (record.pr?.state === event.state) {
        return record;
      }
      return event.state === "merged"
        ? major(withPrState(record, "merged"), at, "🎉", "PR merged")
        : major(withPrState(record, "closed"), at, "🗑️", "PR closed without merging");
    case "crashed":
      // The same failure met again every tick is one crash, not a page of them.
      if (
        record.crash !== null &&
        record.crash.where === bounded(event.where) &&
        record.crash.message === bounded(event.message)
      ) {
        return record;
      }
      return major(
        { ...record, crash: { at, where: bounded(event.where), message: bounded(event.message) } },
        at,
        "💥",
        `Crashed in ${event.where} — ${event.message}`,
      );
  }
}

/**
 * A stored record read back, or `null` when its top-level shape is not this version's. Only the shape
 * is checked: anyone who can edit the ticket can write any field, so the renderer escapes every one.
 */
export function parseRecord(value: unknown): AuditRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Partial<AuditRecord>;
  if (
    candidate.version !== RECORD_VERSION ||
    typeof candidate.key !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.url !== "string" ||
    !Array.isArray(candidate.major) ||
    !Array.isArray(candidate.timeline) ||
    typeof candidate.triage !== "object" ||
    typeof candidate.work !== "object" ||
    typeof candidate.dropped !== "object"
  ) {
    return null;
  }
  // Absent from every record written before broadcasts existed.
  return {
    ...(candidate as AuditRecord),
    bump: typeof candidate.bump === "string" ? candidate.bump : null,
  };
}

/**
 * Returns `record` itself when the look taught it nothing, so an unchanged tick writes nothing. A PR
 * it already knows is only ever moved back to draft: the move to ready is `pr-ready`'s entry to make.
 */
function observe(
  record: AuditRecord,
  event: Extract<AuditEvent, { kind: "observed" }>,
  at: string,
): AuditRecord {
  let next = record;
  if (next.triage.kind === "pending" && event.triage !== null) {
    next = { ...next, triage: { kind: "labelled", ...event.triage } };
  }
  if (next.work.kind === "idle") {
    // `runPublish` takes only a verified outcome, so a PR on the bot's branch means verified work.
    next = { ...next, work: { kind: "verified" } };
  }
  const { url, number, draft } = event.pr;
  if (next.pr === null || next.pr.number !== number) {
    const pr: PullRequest = { url, number, state: draft ? "draft" : "ready" };
    return minor({ ...next, pr }, at, "🔗", `PR #${String(number)} found`);
  }
  if (draft && next.pr.state !== "draft") {
    const pr: PullRequest = { ...next.pr, state: "draft" };
    return minor({ ...next, pr }, at, "↩️", `PR #${String(number)} moved back to draft`);
  }
  return next;
}

function withPrState(record: AuditRecord, state: PullRequest["state"]): AuditRecord {
  return record.pr === null ? record : { ...record, pr: { ...record.pr, state } };
}

function minor(record: AuditRecord, at: string, icon: string, text: string): AuditRecord {
  const timeline = [...record.timeline, { at, icon, text: bounded(text) }];
  const over = Math.max(0, timeline.length - MAX_TIMELINE_ENTRIES);
  return {
    ...record,
    timeline: timeline.slice(over),
    dropped: { ...record.dropped, timeline: record.dropped.timeline + over },
  };
}

function major(record: AuditRecord, at: string, icon: string, text: string): AuditRecord {
  const entries = [...record.major, { at, icon, text: bounded(text) }];
  const over = Math.max(0, entries.length - MAX_MAJOR_ENTRIES);
  return {
    ...record,
    major: entries.slice(over),
    dropped: { ...record.dropped, major: record.dropped.major + over },
  };
}

/** Every string a record holds may come from a ticket, a model or an error, so all of it is bounded. */
function bounded(text: string): string {
  return shorten(oneLine(text), MAX_ENTRY_CHARS);
}
