/**
 * The claim and release — the single write that takes a ticket off the solve queue and its
 * inverse — sent as a label delta (`JiraClient.updateLabels`), not a full-field replace, which
 * is what closed the clobber hazard architecture/invariants.md §14.11 describes.
 * Still no compare-and-swap (`MAX_CONCURRENT_SOLVES=1` covers races); re-reads immediately
 * before writing and verifies the read-back, since a bystander edit is no longer at risk but
 * eligibility can still have changed underneath the queue's stale snapshot.
 */

import { createLogger } from "../logger.ts";
import {
  AGENT_LABELS,
  type ClaimAuthority,
  type LabelEdit,
  applyEdit,
  claimTransition,
  eligibility,
  labelEdit,
} from "./labels.ts";

const log = createLogger("solve");

/**
 * Deliberately not `getJiraIssue`/`editJiraIssue` — an implementation of this cannot transition,
 * comment, or edit any field but labels. `applyLabels` takes a `LabelEdit`, not an array, so a
 * caller has no way to pass a replacement set.
 */
export interface ClaimCapabilities {
  readLabels: (issueKey: string) => Promise<readonly string[]>;
  applyLabels: (issueKey: string, change: LabelEdit) => Promise<void>;
}

/**
 * What to claim, and on whose authority. No `labels` field on purpose: they're read fresh at
 * the last moment, so passing the queue's stale snapshot isn't possible.
 */
export interface ClaimRequest {
  readonly issueKey: string;
  readonly authority: ClaimAuthority;
}

/**
 * Proof a claim landed, and what release needs to undo it. `labelsBefore` is the restore point —
 * the only surviving record of the pre-claim set once the claim is written.
 * Produced only by a write that was verified; see `ClaimResult`.
 */
export interface ClaimReceipt {
  readonly issueKey: string;
  /** The exact set read immediately before the write. The restore point. */
  readonly labelsBefore: readonly string[];
  /** The set read back after the write, confirmed equal to what was sent. */
  readonly labelsAfter: readonly string[];
}

/** Which labels moved, in the only two directions that matter. */
export interface LabelDiff {
  /** On the ticket afterwards, absent from the set we sent. Somebody wrote after us. */
  readonly appeared: readonly string[];
  /** In the set we sent, absent from the ticket afterwards. Somebody overwrote us. */
  readonly vanished: readonly string[];
}

/**
 * Three mutually exclusive outcomes, not a boolean-plus-fields or a throw: `refused` is a normal
 * race (nothing written), `unverified` carries no `ClaimReceipt` so a caller can't reach
 * `labelsAfter` or pass it to `releaseClaim` without narrowing on the literal `"claimed"` —
 * "read the result and hope the caller checks" is how §8's `agentFitness` got dropped once —
 * and `claimed` is the only branch work can proceed from.
 * Genuine faults (write or read-back rejecting) throw `ClaimWriteError` instead.
 */
export type ClaimResult =
  | { readonly outcome: "claimed"; readonly receipt: ClaimReceipt }
  | { readonly outcome: "refused"; readonly issueKey: string; readonly reason: string }
  | {
      readonly outcome: "unverified";
      readonly issueKey: string;
      readonly reason: string;
      /** Still the restore point: the write landed, so somebody has to undo it. */
      readonly labelsBefore: readonly string[];
      /** What was sent to Jira. */
      readonly expected: readonly string[];
      /** What Jira had a moment later. */
      readonly observed: readonly string[];
      readonly appeared: readonly string[];
      readonly vanished: readonly string[];
    };

/** The outcome of a release, in the same three shapes and for the same reasons. */
export type ReleaseResult =
  | { readonly outcome: "released"; readonly issueKey: string; readonly labels: readonly string[] }
  | { readonly outcome: "refused"; readonly issueKey: string; readonly reason: string }
  | {
      readonly outcome: "unverified";
      readonly issueKey: string;
      readonly reason: string;
      readonly expected: readonly string[];
      readonly observed: readonly string[];
      readonly appeared: readonly string[];
      readonly vanished: readonly string[];
    };

/**
 * A fault, not a refusal: the ticket is in a state this function cannot describe. Carries
 * `restorePoint` since that set exists nowhere else once the write is attempted.
 * `phase` distinguishes "may not have landed" (`write`) from "landed but couldn't be verified" (`verify`).
 */
export class ClaimWriteError extends Error {
  readonly issueKey: string;
  readonly phase: "write" | "verify";
  readonly restorePoint: readonly string[];

  // Written out longhand rather than as parameter properties: Node strips types
  // rather than compiling them, and this project has no build step.
  constructor(
    message: string,
    details: {
      readonly issueKey: string;
      readonly phase: "write" | "verify";
      readonly restorePoint: readonly string[];
      readonly cause: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.name = "ClaimWriteError";
    this.issueKey = details.issueKey;
    this.phase = details.phase;
    this.restorePoint = details.restorePoint;
  }
}

function agrees(diff: LabelDiff): boolean {
  return diff.appeared.length === 0 && diff.vanished.length === 0;
}

/**
 * Did the delta take? Compares only what was requested — every added label present, every
 * removed label gone — not the whole field: a bystander label appearing mid-write is a
 * colleague working, not a failed claim, and a whole-set comparison used to flag it, which is
 * how a check ends up switched off (§8).
 * Order- and duplicate-insensitive, since Jira makes no promise about label order.
 */
function diffEdit(change: LabelEdit, observed: readonly string[]): LabelDiff {
  const live = new Set(observed);

  return {
    appeared: change.remove.filter((label) => live.has(label)),
    vanished: change.add.filter((label) => !live.has(label)),
  };
}

type LabelRead =
  | { readonly ok: true; readonly labels: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates a label read before it's trusted and written back. Takes `unknown` because the
 * value crossed a process boundary (an MCP tool's parse of a Jira response) that the declared
 * return type cannot actually guarantee, and a garbled read here is about to be written straight
 * back as the ticket's complete truth.
 * An empty array is valid; duplicates are collapsed as transport noise, not information.
 */
function readable(raw: unknown, source: string): LabelRead {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      reason: `${source} did not return an array of labels, so the ticket's real label set is unknown and writing anything would guess at it`,
    };
  }

  const labels: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string") {
      return {
        ok: false,
        reason: `${source} returned a non-string label at index ${String(index)}, so the read cannot be trusted as the complete set`,
      };
    }
    if (entry.trim() === "") {
      return {
        ok: false,
        reason: `${source} returned a blank label at index ${String(index)}, which Jira cannot hold — the read is not what is on the ticket`,
      };
    }
    if (!labels.includes(entry)) {
      labels.push(entry);
    }
  }

  return { ok: true, labels };
}

/**
 * Turns a read-back difference into something an operator can act on. `agent:solving` missing
 * means the claim didn't take; `agent:start` reappearing means the authorisation wasn't consumed.
 */
function mismatchNotes(diff: LabelDiff): readonly string[] {
  const notes: string[] = [];

  if (diff.vanished.includes(AGENT_LABELS.solving)) {
    notes.push(`${AGENT_LABELS.solving} is not on the ticket, so the claim did not take`);
  }
  if (diff.appeared.includes(AGENT_LABELS.start)) {
    notes.push(
      `${AGENT_LABELS.start} is still on the ticket, so the human authorisation was not consumed and the next cycle will read it as a fresh approval`,
    );
  }
  if (diff.vanished.length > 0) {
    notes.push(`written but absent afterwards: ${diff.vanished.join(", ")}`);
  }
  if (diff.appeared.length > 0) {
    notes.push(`present afterwards but never written: ${diff.appeared.join(", ")}`);
  }

  return notes;
}

/**
 * Claims a ticket: `agent:solving` on, `agent:start` off, in one write — exactly read, write,
 * read, with the transition owned by `labels.ts` and never restated here.
 * `claimTransition` re-runs the eligibility check `eligibility` just passed, so a future state
 * machine edit can't be defeated by this call site's stale opinion.
 */
export async function claimTicket(
  capabilities: ClaimCapabilities,
  request: ClaimRequest,
): Promise<ClaimResult> {
  const { issueKey, authority } = request;

  // ---- the window opens here -------------------------------------------------
  // Nothing below this line until `writeLabels` may do I/O, call a model, or log.
  const read = readable(await capabilities.readLabels(issueKey), `reading ${issueKey}'s labels`);
  if (!read.ok) {
    return refusedClaim(issueKey, read.reason);
  }

  const labelsBefore = read.labels;

  const verdict = eligibility(labelsBefore, authority);
  if (!verdict.eligible) {
    return refusedClaim(
      issueKey,
      `${verdict.reason} — read from the board immediately before the write, so this is what the ticket says now, not what the queue saw`,
    );
  }

  const change = claimTransition(labelsBefore, authority);
  // Computed locally to check the read-back against — not what is sent (`change` is).
  const expected = applyEdit(labelsBefore, change);

  try {
    await capabilities.applyLabels(issueKey, change);
  } catch (error) {
    // ---- the window closes here ---------------------------------------------
    throw new ClaimWriteError(
      `${issueKey}: the claim write failed, and whether it landed is unknown — read the ticket before retrying`,
      { issueKey, phase: "write", restorePoint: labelsBefore, cause: error },
    );
  }

  const observed = await verifiableRead(capabilities, issueKey, labelsBefore, "claim");

  const diff = diffEdit(change, observed);
  if (!agrees(diff)) {
    return unverifiedClaim(issueKey, labelsBefore, expected, observed, diff);
  }

  log.info("solve.claim.written", {
    issueKey,
    labelsBefore,
    labelsAfter: observed,
    note: "claimed and verified — agent:solving on, agent:start off, everything else unchanged",
  });

  return {
    outcome: "claimed",
    receipt: { issueKey, labelsBefore, labelsAfter: observed },
  };
}

/**
 * Puts a claimed ticket back exactly as it was found — `agent:start` restored, not just
 * `agent:solving` removed, or the ticket ends up neither claimed nor approved.
 * Same read-modify-write shape and hazard as the claim, plus one refusal: if the live set no
 * longer matches what the claim left behind, someone edited the ticket while claimed, and
 * overwriting that would be the clobber §14.11 is about, done deliberately. Fails closed instead.
 */
export async function releaseClaim(
  capabilities: ClaimCapabilities,
  receipt: ClaimReceipt,
): Promise<ReleaseResult> {
  const { issueKey, labelsBefore, labelsAfter } = receipt;

  // Checked before the board read since it's a fact about the receipt: a restore point still carrying the claim would "release" into a claimed state, which only a hand-built receipt can produce.
  const restorePoint = readable(labelsBefore, `the receipt for ${issueKey}`);
  if (!restorePoint.ok) {
    return refusedRelease(
      issueKey,
      `will not restore an unusable label set: ${restorePoint.reason}`,
    );
  }
  if (restorePoint.labels.includes(AGENT_LABELS.solving)) {
    return refusedRelease(
      issueKey,
      `the receipt's restore point contains ${AGENT_LABELS.solving}, so writing it would leave the ticket claimed rather than release it`,
    );
  }

  // ---- the window opens here -------------------------------------------------
  const read = readable(await capabilities.readLabels(issueKey), `reading ${issueKey}'s labels`);
  if (!read.ok) {
    return refusedRelease(issueKey, read.reason);
  }

  const live = read.labels;

  if (!live.includes(AGENT_LABELS.solving)) {
    return refusedRelease(
      issueKey,
      `the ticket does not carry ${AGENT_LABELS.solving}, so there is no claim of ours to release — it has already been released, completed, or taken over`,
    );
  }

  // Derived from the receipt, not `live`: deriving from `live` would delete a bystander label (e.g. a PM's `next:to-trio`) present in `live` but absent from the restore point.
  const change = labelEdit(
    labelsBefore.filter((label) => !labelsAfter.includes(label)),
    labelsAfter.filter((label) => !labelsBefore.includes(label)),
  );

  // Drift narrowed to the labels the release touches: what still refuses is the claim's own edit coming undone (`agent:start` back on, `agent:solving` off), not a bystander label moving.
  const drift = diffEdit(labelEdit(change.remove, change.add), live);
  if (!agrees(drift)) {
    return refusedRelease(
      issueKey,
      `the claim this receipt describes is no longer on the ticket, so there is nothing here to undo — ${mismatchNotes(
        drift,
      ).join("; ")}`,
    );
  }

  // Expected is `live` with the release applied, not the pre-claim set — they differ by bystander labels that no longer count as mismatches.
  const expected = applyEdit(live, change);

  try {
    await capabilities.applyLabels(issueKey, change);
  } catch (error) {
    // ---- the window closes here ---------------------------------------------
    throw new ClaimWriteError(
      `${issueKey}: the release write failed, and whether it landed is unknown — the ticket may still be claimed`,
      { issueKey, phase: "write", restorePoint: expected, cause: error },
    );
  }

  const observed = await verifiableRead(capabilities, issueKey, expected, "release");

  const diff = diffEdit(change, observed);
  if (!agrees(diff)) {
    return unverifiedRelease(issueKey, expected, observed, diff);
  }

  log.info("solve.claim.released", {
    issueKey,
    labels: observed,
    note: "released and verified — the ticket reads exactly as it did before the claim",
  });

  return { outcome: "released", issueKey, labels: observed };
}

/**
 * Collapses a rejected and an unreadable read-back into the same fault — both mean the write
 * landed with no way to know what it landed as, distinct from a read-back that arrived and disagreed.
 */
async function verifiableRead(
  capabilities: ClaimCapabilities,
  issueKey: string,
  restorePoint: readonly string[],
  operation: "claim" | "release",
): Promise<readonly string[]> {
  let raw: unknown;
  try {
    raw = await capabilities.readLabels(issueKey);
  } catch (error) {
    throw new ClaimWriteError(
      `${issueKey}: the ${operation} write landed but could not be read back, so what is on the ticket is unknown`,
      { issueKey, phase: "verify", restorePoint, cause: error },
    );
  }

  const read = readable(raw, `verifying ${issueKey}'s labels`);
  if (!read.ok) {
    throw new ClaimWriteError(
      `${issueKey}: the ${operation} write landed but could not be verified — ${read.reason}`,
      { issueKey, phase: "verify", restorePoint, cause: undefined },
    );
  }

  return read.labels;
}

function refusedClaim(issueKey: string, reason: string): ClaimResult {
  log.info("solve.claim.refused", { issueKey, reason, note: "nothing was written" });
  return { outcome: "refused", issueKey, reason };
}

function refusedRelease(issueKey: string, reason: string): ReleaseResult {
  log.info("solve.release.refused", { issueKey, reason, note: "nothing was written" });
  return { outcome: "refused", issueKey, reason };
}

function unverifiedClaim(
  issueKey: string,
  labelsBefore: readonly string[],
  expected: readonly string[],
  observed: readonly string[],
  diff: LabelDiff,
): ClaimResult {
  const reason = `${issueKey}: the claim write landed but the ticket does not read back as claimed — ${mismatchNotes(
    diff,
  ).join("; ")}. The claim FAILED even though the write succeeded.`;
  log.error("solve.claim.unverified", {
    issueKey,
    expected,
    observed,
    appeared: diff.appeared,
    vanished: diff.vanished,
    restorePoint: labelsBefore,
    reason,
  });
  return {
    outcome: "unverified",
    issueKey,
    reason,
    labelsBefore,
    expected,
    observed,
    appeared: diff.appeared,
    vanished: diff.vanished,
  };
}

function unverifiedRelease(
  issueKey: string,
  expected: readonly string[],
  observed: readonly string[],
  diff: LabelDiff,
): ReleaseResult {
  const reason = `${issueKey}: the release write landed but the ticket does not read back as it did before the claim — ${mismatchNotes(
    diff,
  ).join("; ")}. The release FAILED even though the write succeeded.`;
  log.error("solve.release.unverified", {
    issueKey,
    expected,
    observed,
    appeared: diff.appeared,
    vanished: diff.vanished,
    reason,
  });
  return {
    outcome: "unverified",
    issueKey,
    reason,
    expected,
    observed,
    appeared: diff.appeared,
    vanished: diff.vanished,
  };
}
