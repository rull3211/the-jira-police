/**
 * Whether a watched ticket is worth paying to re-triage. Pure, no I/O — the
 * one decision in this feature that spends money unasked.
 *
 * Re-triage compares against what somebody *else* did, not against what
 * changed, because posting our own triage comment (and its labels) bumps
 * `updated` too, and a raw "changed since we last spoke" rule would fire on
 * itself every cycle. Comments are keyed on `FOOTER_SENTINEL`, not on author —
 * the poster shares a human's Atlassian account, so authorship can't
 * distinguish it; a forged sentinel reads as ours, which only ends the watch
 * sooner. Field changes are keyed on the field itself (`BLOCKER_CLEARING_FIELDS`),
 * not the author, since that can't be defeated by whoever holds the credential.
 */

import { FOOTER_SENTINEL } from "../triage/gate.ts";
import { retriageCount, retriageLabels } from "./counter.ts";

/** One comment, with its ADF already rendered to text by the caller. */
export interface WatchComment {
  /** ISO-8601. */
  readonly created: string;
  /**
   * ISO-8601, equal to `created` on a comment nobody has edited. Required, not
   * optional, on our own comments — see `lastSpokeAt`.
   */
  readonly updated: string;
  /** The rendered body; attacker-controlled, searched for one fixed substring and never interpreted. */
  readonly text: string;
}

/** One changelog entry, flattened to the fields it touched. */
export interface WatchFieldChange {
  /** ISO-8601. */
  readonly created: string;
  /** Jira's `items[].field` values, as returned. Compared case-insensitively. */
  readonly fields: readonly string[];
}

export interface WatchSignals {
  readonly key: string;
  /** The ticket's labels, as Jira returned them; read only for the re-triage counter (see `counter.ts`). */
  readonly labels: readonly string[];
  /** True when the ticket has been closed — `statusCategory` is `Done`. */
  readonly closed: boolean;
  readonly comments: readonly WatchComment[];
  readonly changes: readonly WatchFieldChange[];
  /**
   * What the blocker-clearing fields hold now, keyed by the same names the
   * changelog uses, already rendered to text. `decideWatch` must not read
   * this — its decision is just "did somebody move" — it's carried here only
   * so `retriageContext` doesn't need a second, possibly-inconsistent fetch.
   */
  readonly content: WatchContent;
}

/** One attachment, as the check is shown it: what it is, never what is in it. */
export interface WatchAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface WatchContent {
  readonly summary: string;
  readonly description: string;
  readonly environment: string;
  readonly attachments: readonly WatchAttachment[];
}

export type WatchDecision =
  /** Somebody else moved. Worth paying for a re-triage. */
  | { readonly kind: "retriage"; readonly trigger: string; readonly at: string }
  /** Nothing has happened since we last spoke. The common case, and free. */
  | { readonly kind: "quiet" }
  /** Take the label off and stop looking. */
  | { readonly kind: "unsubscribe"; readonly reason: UnsubscribeReason; readonly note: string };

export type UnsubscribeReason = "closed" | "exhausted" | "uncountable";

/**
 * The fields whose change could plausibly clear a send-back blocker.
 *
 * Deliberately an allowlist, not "anything this service doesn't write":
 * board grooming (sprint, rank, priority, re-assign) would otherwise read as
 * "the reporter responded" and burn the retriage budget on noise. A missed
 * trigger is silent and recoverable via `triage:once`; a false one is not.
 *
 * `labels` must never be allowlisted — this service writes labels constantly
 * (`triaged`, `dor:*`, `agent:*`), so allowlisting it would let the service's
 * own writes re-trigger its own watch.
 */
export const BLOCKER_CLEARING_FIELDS: ReadonlySet<string> = new Set([
  "description",
  "summary",
  "attachment",
  "environment",
]);

/**
 * The footer's words, with the emphasis delimiters taken off both ends.
 *
 * Jira's ADF round-trip doesn't preserve the markdown delimiters (`_…_`
 * becomes `*…*`), so matching the sentinel whole would match nothing.
 * Derived from `FOOTER_SENTINEL` rather than duplicated, so the two can't
 * drift apart on which comments are ours.
 */
export const FOOTER_TEXT: string = FOOTER_SENTINEL.replace(/^[_*]+/, "").replace(/[_*]+$/, "");

/** True when a comment body is one this service wrote. */
export function isOurComment(comment: WatchComment): boolean {
  return comment.text.includes(FOOTER_TEXT);
}

function parsed(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/**
 * The later of a comment's two timestamps, or `NaN` if either will not read.
 * `Math.max` propagates `NaN` deliberately — a partially-readable comment
 * must not resolve to its earlier (too-early, so overspending) timestamp.
 * Exported so `retriageContext` dates the same comments the same way.
 */
export function touchedAt(comment: WatchComment): number {
  return Math.max(parsed(comment.created), parsed(comment.updated));
}

/**
 * The high-water mark: when this service last spoke on the ticket, in epoch ms.
 *
 * Reads `updated`, not `created` — the triage poster rewrites its own comment
 * in place on a re-triage rather than adding a new one, so `created` would
 * stay pinned at the first triage forever (§7b's infinite paid loop). `NaN`
 * when no mark can be established, which propagates to a refusal rather than
 * a plausible-but-wrong (and chargeable) number.
 *
 * Exported so `retriageContext` slices the ticket at the same instant.
 */
export function lastSpokeAt(comments: readonly WatchComment[]): number {
  const ours = comments.filter(isOurComment);
  if (ours.length === 0) {
    return Number.NaN;
  }
  return Math.max(...ours.map(touchedAt));
}

/**
 * When the newest thing somebody else did happened, in epoch ms.
 *
 * `decideWatch` returns on its *first* trigger, so `WatchDecision.at` is not
 * necessarily the latest one — a memo keyed on it would re-ask forever on
 * activity it already judged. `NaN` when there's no mark or nothing foreign,
 * which costs a repeated cheap read rather than a missed answer. Lives here,
 * not beside its caller, so it shares the decision's own "foreign" predicates
 * rather than risking a second definition drifting from them.
 */
export function newestForeignAt(signals: WatchSignals): number {
  const spokeAt = lastSpokeAt(signals.comments);
  if (Number.isNaN(spokeAt)) {
    return Number.NaN;
  }

  const instants: number[] = [];
  for (const comment of signals.comments) {
    if (isOurComment(comment)) {
      continue;
    }
    const at = touchedAt(comment);
    if (!Number.isNaN(at) && at >= spokeAt) {
      instants.push(at);
    }
  }
  for (const change of signals.changes) {
    const at = parsed(change.created);
    if (Number.isNaN(at) || at < spokeAt) {
      continue;
    }
    if (change.fields.some((name) => BLOCKER_CLEARING_FIELDS.has(name.trim().toLowerCase()))) {
      instants.push(at);
    }
  }

  return instants.length === 0 ? Number.NaN : Math.max(...instants);
}

/**
 * Decides what to do about one watched ticket. `maxRetriage` is
 * `MAX_RETRIAGE_PER_TICKET`; the count it bounds is read off a label rather
 * than a comment (§7b) — see `counter.ts`.
 */
export function decideWatch(signals: WatchSignals, maxRetriage: number): WatchDecision {
  // Checked first because it's free and doesn't depend on anything else being
  // readable; the query deliberately still returns closed tickets so this can fire.
  if (signals.closed) {
    return {
      kind: "unsubscribe",
      reason: "closed",
      note: "the ticket is closed, so the watch has nothing left to wait for",
    };
  }

  // The count is read off a label (§7b), not off our own comments — see
  // `counter.ts`. `null` is not zero: a malformed counter refuses the ticket
  // rather than restarting it at zero.
  const retriages = retriageCount(signals.labels);
  if (retriages === null) {
    return {
      kind: "unsubscribe",
      reason: "uncountable",
      note: `${signals.key} carries a re-triage counter this service cannot read (${retriageLabels(signals.labels).join(", ")}), and a count that will not read must not read as zero — fix or remove the label before watching it again`,
    };
  }

  if (retriages >= maxRetriage) {
    return {
      kind: "unsubscribe",
      reason: "exhausted",
      note: `${retriages} re-triage${retriages === 1 ? "" : "s"} already, at a limit of ${maxRetriage} — a ticket edited this many times is a conversation rather than a signal`,
    };
  }

  // Refused, not started, when there's no comment of ours: with no high-water
  // mark the ticket's whole history reads as new. A human hand-labelling a
  // never-triaged ticket gets this refusal; `triage:once` is the remedy.
  const ours = signals.comments.filter(isOurComment);
  if (ours.length === 0) {
    return {
      kind: "unsubscribe",
      reason: "uncountable",
      note: `${signals.key} carries the watch label but no comment this service wrote, so there is no high-water mark and every look would read as new — run triage:once by hand first`,
    };
  }

  // The high-water mark: anything at or before it was already on the ticket
  // when our comment was written.
  const spokeAt = lastSpokeAt(signals.comments);
  if (Number.isNaN(spokeAt)) {
    return {
      kind: "unsubscribe",
      reason: "uncountable",
      note: `${signals.key} has a triage comment with an unreadable timestamp, so there is no high-water mark to compare against and every look would read as new`,
    };
  }

  // Dated by whichever of `created`/`updated` is later, so an edit-only answer
  // is seen. `>=` rather than `>`: a tie counts as somebody else, since our own
  // activity is already excluded by kind (the sentinel), not by clock — a
  // strict `>` would make that exclusion do no work.
  for (const comment of signals.comments) {
    if (isOurComment(comment)) {
      continue;
    }
    const at = touchedAt(comment);
    if (!Number.isNaN(at) && at >= spokeAt) {
      return { kind: "retriage", trigger: "a comment from somebody else", at: comment.created };
    }
  }

  for (const change of signals.changes) {
    const at = parsed(change.created);
    if (Number.isNaN(at) || at < spokeAt) {
      continue;
    }
    const field = change.fields.find((name) =>
      BLOCKER_CLEARING_FIELDS.has(name.trim().toLowerCase()),
    );
    if (field !== undefined) {
      return { kind: "retriage", trigger: `${field} was edited`, at: change.created };
    }
  }

  return { kind: "quiet" };
}
