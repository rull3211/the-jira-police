/**
 * Collects everything foreign since we last spoke, sliced at the same instant
 * `decideWatch` made its decision, rather than reusing the decision's own
 * (first-trigger-only) trigger string.
 *
 * Pure, and separate from `relevance.ts` for the same reason `decide.ts` is
 * separate from `signals.ts`: the module that spawns a paid session should not
 * also decide what goes into its prompt.
 */

import { shorten } from "../text.ts";
import {
  BLOCKER_CLEARING_FIELDS,
  isOurComment,
  lastSpokeAt,
  touchedAt,
  type WatchContent,
  type WatchSignals,
} from "./decide.ts";
import type { EditedField, RelevanceInput } from "./relevance.ts";

/**
 * Bound on foreign comments shown to the check — attacker-controlled text into
 * a prompt needs a limit. Keeps the newest and reports how many were dropped.
 */
export const MAX_CONTEXT_COMMENTS = 10;

/** Bound on one edited field's length shown to the check; still attacker-controlled text into a prompt. */
export const MAX_FIELD_CHARS = 4000;

/** Bound on how many attachment names are shown. */
export const MAX_CONTEXT_ATTACHMENTS = 20;

function parsed(iso: string): number {
  return Date.parse(iso);
}

/** `12345` → `12.1 KB`, so a size reads as a size rather than as a number. */
function sizeOf(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** What one moved field now says. An empty field still gets an entry — a cleared description is a change, not nothing. */
function contentOf(name: string, content: WatchContent): string {
  switch (name) {
    case "description":
      return content.description;
    case "summary":
      return content.summary;
    case "environment":
      return content.environment;
    case "attachment":
      return content.attachments
        .slice(0, MAX_CONTEXT_ATTACHMENTS)
        .map(
          (file) => `${file.filename} (${file.mimeType || "unknown type"}, ${sizeOf(file.size)})`,
        )
        .join("\n");
    default:
      // Unreachable while the caller filters on `BLOCKER_CLEARING_FIELDS`; empty
      // string rather than a throw so one bad field can't abort the retriage.
      return "";
  }
}

/**
 * Everything foreign since we last spoke, or `null` with no readable
 * high-water mark (the same condition `decideWatch` unsubscribes on).
 *
 * Only blocker-clearing fields are named — the rest can't trigger a
 * re-triage, so listing them would offer grooming noise as evidence of a
 * response.
 */
export function retriageContext(signals: WatchSignals): RelevanceInput | null {
  const spokeAt = lastSpokeAt(signals.comments);
  if (Number.isNaN(spokeAt)) {
    return null;
  }

  // Dated with `touchedAt`, not `created` — the poster rewrites its own comment
  // in place on a re-triage, so `created` would stop matching after the first one.
  const ours = signals.comments.filter(isOurComment);
  const sendback = ours.find((comment) => touchedAt(comment) === spokeAt)?.text ?? "";

  const foreign = signals.comments
    .filter((comment) => !isOurComment(comment))
    .filter((comment) => {
      const at = touchedAt(comment);
      // A tie counts as foreign, matching the decision's own rule, so a comment
      // that triggered the look always appears in the prompt.
      return !Number.isNaN(at) && at >= spokeAt;
    })
    .toSorted((left, right) => touchedAt(left) - touchedAt(right));

  const kept = foreign.slice(-MAX_CONTEXT_COMMENTS);

  const moved = [
    ...new Set(
      signals.changes
        .filter((change) => {
          const at = parsed(change.created);
          return !Number.isNaN(at) && at >= spokeAt;
        })
        .flatMap((change) => change.fields)
        .map((name) => name.trim().toLowerCase())
        .filter((name) => BLOCKER_CLEARING_FIELDS.has(name)),
    ),
  ].toSorted();

  // Content only for fields that moved — an unchanged description isn't
  // evidence the reporter responded, and a check shown it will find the
  // sendback's own words already there.
  const fields: readonly EditedField[] = moved.map((name) => {
    const full = contentOf(name, signals.content).trim();
    return {
      name,
      content: shorten(full, MAX_FIELD_CHARS),
      truncated: full.length > MAX_FIELD_CHARS,
    };
  });

  return {
    key: signals.key,
    sendback,
    comments: kept.map((comment) => comment.text),
    omitted: foreign.length - kept.length,
    fields,
  };
}
