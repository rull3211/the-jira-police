/**
 * The claim — the one write that takes a ticket out of the solve queue — and the
 * release that puts it back.
 *
 * `poller.ts` plans this edit and cannot make it. This module makes it, and it
 * lives in its own file because it is the most dangerous write in the service
 * despite being much the smallest: the poster writes a comment nobody else was
 * competing for, this one writes a field the whole board shares.
 *
 * ## Why it is dangerous, and what stopped being dangerous
 *
 * ARCHITECTURE.md §14.11 described this module's central hazard, and the
 * description no longer holds. It is rewritten here rather than left standing,
 * because a comment explaining a risk that has been removed is worse than no
 * comment: it teaches the next reader to design around a constraint that is
 * gone.
 *
 * **What it used to say.** The only write path was MCP `editJiraIssue`, which
 * exposes `fields` — never Jira's own `update.labels.add` / `remove`. So there
 * was no way to touch one label: the whole field was replaced, set semantics,
 * every time. Claiming meant read all N, subtract `agent:start`, add
 * `agent:solving`, write all N back. Anything anybody added between the read and
 * the write was destroyed by the write, and destroyed *silently* — a PM adding
 * `next:to-trio` mid-claim lost the edit with nothing in either history
 * explaining it, because a full-field set is indistinguishable from a deliberate
 * removal. Invariant 5 reads *delta, never a replacement array*, and the claim
 * could not honour it.
 *
 * **What changed.** The constraint was never Jira's — it was the tool's. Jira's
 * REST API has supported `update.labels` with per-label operations all along, so
 * the claim now goes through `JiraClient.updateLabels` and this module sends a
 * `LabelEdit`, not a set. Jira applies the delta server-side. There is no
 * read-modify-write, therefore no window, therefore nothing to clobber. That is
 * an *elimination*, not a narrowing, and it is why `writeLabels` became
 * `applyLabels`: a capability that cannot express a replacement array cannot be
 * used to commit the old mistake.
 *
 * The cost is a documented amendment to the standing rule that the REST
 * credential is discovery-only. It is narrowed three ways at the credential
 * itself — labels only, `agent:` namespace only, comments still on the MCP path,
 * all mechanical — and the reasoning is in `jira/client.ts`.
 *
 * ## What is left, which is not nothing
 *
 * - **Still no compare-and-swap.** Two racers both succeed. The queue's dedupe
 *   is "`agent:solving` is on the ticket", which is a check, not a lock. A delta
 *   write is atomic per label; it is not conditional on the ticket's state.
 *   `MAX_CONCURRENT_SOLVES=1` on one host is what covers this.
 *
 * - **Re-read immediately before deciding.** `SolveCandidate.labels` came off a
 *   JQL search, and a whole cycle of sorting, allowlist checks and capacity
 *   arithmetic happened after it. So this module accepts no label snapshot from
 *   its caller at all: `ClaimRequest` has no labels field, which makes handing it
 *   a stale set a type error rather than a judgement call. This is no longer
 *   about the clobber — the delta does not care what else is on the ticket — but
 *   about *eligibility*: claiming a ticket somebody withdrew is still wrong.
 *
 * - **Re-check eligibility against what was just read.** If `agent:solving` has
 *   appeared since, somebody else claimed it; if `agent:solvable` has gone, the
 *   assessment the claim rests on has been withdrawn. Both answers are "refuse",
 *   and refusing before the write is the only refusal that costs nothing.
 *
 * - **Read back afterwards and verify.** Kept, and it now means what it always
 *   claimed to. The old read-back could not see an edit we had clobbered — the
 *   label was absent from the set we sent *and* from the set we read back, so it
 *   matched perfectly and was gone. With a delta there is no such blind spot:
 *   every difference between the intended state and the observed state is a real
 *   difference, caused by somebody else, and is reported as its own outcome.
 *
 * ## Injection
 *
 * Capabilities arrive the way `SolveDeps` takes them, for the same reason: every
 * rule above is then testable against fakes with no live board and no
 * credentials, including the races, which are otherwise untestable at all.
 * Nothing here imports the REST client; `wiring.ts` supplies the adapter.
 */

import { logger } from "../logger.ts";
import {
  AGENT_LABELS,
  type ClaimAuthority,
  type LabelEdit,
  applyEdit,
  claimTransition,
  eligibility,
  labelEdit,
} from "./labels.ts";

/**
 * The two things a claim needs from the outside world, and no third thing.
 *
 * Deliberately not `getJiraIssue` / `editJiraIssue`. A narrower interface is a
 * narrower privilege: an implementation of this cannot transition the issue,
 * comment on it, or edit any field other than labels, and a reviewer can see
 * that from the type without reading the implementation.
 *
 * `applyLabels` takes a `LabelEdit` and not an array, which is the type doing
 * the safety work. The old `writeLabels(key, labels)` could only ever mean
 * "replace the field with this", so every caller was obliged to compute a whole
 * set and every implementation was obliged to clobber. There is no way to pass
 * a replacement array through this signature, so the mistake is unavailable
 * rather than merely discouraged.
 */
export interface ClaimCapabilities {
  readLabels: (issueKey: string) => Promise<readonly string[]>;
  applyLabels: (issueKey: string, change: LabelEdit) => Promise<void>;
}

/**
 * What to claim, and on whose authority.
 *
 * Note what is missing: the ticket's labels. They are read here, once, at the
 * last possible moment. A `labels` field would be an invitation to pass the ones
 * the queue fetched, which are exactly the stale ones.
 *
 * The field was called `mode` and held a `SolveMode`, which was accurate while
 * the poller was the only caller. It is `authority` now because a CLI run
 * naming one ticket is not a mode the service is in — nothing is configured, no
 * loop is running, and the value cannot come from settings. Reading `mode:
 * "named"` at a call site would have suggested all three.
 */
export interface ClaimRequest {
  readonly issueKey: string;
  readonly authority: ClaimAuthority;
}

/**
 * Proof that a claim landed, and the means of undoing it.
 *
 * `labelsBefore` is the whole point of this object. Release is not "remove
 * `agent:solving`" — that would leave the ticket missing the `agent:start` the
 * claim consumed, which is a different ticket from the one we found. It is
 * "restore precisely the set that was there", and that set exists nowhere on the
 * board once the claim is written, so it has to be carried.
 *
 * Only produced by a claim that was written *and* verified. An unverified claim
 * yields no receipt at all, which is what stops it being released mechanically —
 * see `ClaimResult`.
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
 * The outcome of a claim attempt, as three mutually exclusive things.
 *
 * A discriminated union rather than a boolean plus fields, and rather than a
 * throw, because the three outcomes want three different responses and only one
 * of them is an error:
 *
 * - `refused` is a **normal** outcome. The board moved between the queue reading
 *   it and this function reading it, which is precisely the condition the queue
 *   is stateless in order to tolerate. Nothing was written. Throwing here would
 *   make an ordinary race look like a fault.
 * - `unverified` is the dangerous one, and the shape is doing work. It carries no
 *   `ClaimReceipt`, so a caller cannot reach `labelsAfter` on it, cannot pass it
 *   to `releaseClaim`, and cannot narrow to the success branch without writing
 *   the literal `"claimed"`. "Read the result and hope the caller checks" is how
 *   §8's `agentFitness` got dropped on the floor for a run.
 * - `claimed` is the only branch carrying the receipt, and therefore the only one
 *   from which work can proceed.
 *
 * Genuine faults — the write rejecting, the read-back rejecting — throw
 * `ClaimWriteError`, because those leave the ticket in a state this function
 * cannot describe and an exception is the one return value nobody accidentally
 * ignores.
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
 * A fault, as opposed to a refusal: the ticket is in a state we cannot describe.
 *
 * Carries `restorePoint` — the label set that puts the ticket back where it was
 * found — because that set exists nowhere else once the write has been attempted,
 * and a human reaching for it is reaching for it at the worst possible moment.
 *
 * `phase` separates the two unlike disasters. `"write"` means the edit may or may
 * not have landed; the board is the only oracle. `"verify"` means it did land and
 * we could not check it, which is the same danger as an `unverified` result with
 * none of the detail.
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
 * Did the delta take? Asked of the delta, not of the whole field.
 *
 * This replaced a full-set comparison, and the reason is worth stating because
 * the full-set version looks stricter and was in fact wrong. Once the write is
 * a delta, the ticket's other labels are not something this service predicted,
 * so a bystander label appearing between the write and the read-back is a
 * colleague working — not a failed claim. Comparing whole sets reported every
 * one of those as `unverified`: a check that fires on innocent events, which is
 * how a check ends up switched off (§8).
 *
 * What is actually being verified is the only thing that was actually
 * requested: every label we added is there, and every label we removed is gone.
 *
 * The `LabelDiff` vocabulary survives intact and still means what it says.
 * `vanished` is "we wrote it and it is not there" — the claim did not take.
 * `appeared` is "we removed it and it is still there" — the removal did not
 * take. `mismatchNotes` reads both without knowing which comparison produced
 * them.
 *
 * The full-set comparator it replaced (`diffLabels`) was deleted rather than
 * left exported-but-unused. It read as the stricter of the two and every future
 * check would have been tempted by it, so leaving it in the file would have left
 * the wrong answer sitting next to the right one with nothing to distinguish
 * them but this comment.
 *
 * Order-insensitivity carries over from that one and is still deliberate: Jira
 * makes no promise about the order labels come back in, and a claim reported as
 * failed because two untouched labels swapped places would be a false positive
 * on every single write.
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
 * Validates a label read before anything is decided from it, or written back.
 *
 * The parameter is `unknown` rather than `readonly string[]` because the value
 * crossed a process boundary to get here — in production it is whatever an MCP
 * tool call parsed out of a Jira response — and the declared type of
 * `ClaimCapabilities.readLabels` is a promise the boundary is in no position to
 * keep. Everything that follows treats this array as the ticket's complete truth
 * and writes it straight back, so a garbled read is not a display problem: it is
 * a set of labels about to be deleted.
 *
 * Every unreadable answer refuses. An empty array is *not* unreadable — a ticket
 * genuinely can have no labels — and needs no special case, because eligibility
 * then refuses it for the honest reason that `agent:solvable` is missing.
 *
 * Duplicates are collapsed. Jira labels are a set, so a repeat is noise from the
 * transport rather than information, and sending it back would fail verification
 * for a difference that means nothing.
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
 * Turns a read-back difference into something an operator can act on.
 *
 * Two of the differences get named individually because they mean specific
 * things. `agent:solving` missing is the claim not taking at all — the ticket is
 * back in the queue and whatever we are about to do to it, somebody else may be
 * doing too. `agent:start` reappearing means the human authorisation was not
 * consumed, so the next cycle will treat it as freshly approved. Everything else
 * is printed as the raw diff, because the interesting cases there are the ones
 * nobody predicted.
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
 * Claims a ticket: `agent:solving` on, `agent:start` off, in one write.
 *
 * Exactly three capability calls, in exactly this order: read, write, read. The
 * middle one is bracketed as tightly as the interface allows, and the arithmetic
 * between the first two is pure `labels.ts` — the state machine is imported, never
 * restated, so there is one place where the transition is defined and this is not
 * it.
 *
 * `claimTransition` is called even though `eligibility` has just passed, and it
 * re-runs the same check. That is not waste. It is the function that owns the
 * definition of the claim, and letting it re-derive its own precondition means a
 * future edit to the state machine cannot be defeated by this call site holding a
 * stale opinion about when the transition is legal.
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
  // What the ticket should read afterwards, computed locally and used only to
  // check the read-back against. It is not what is sent — `change` is — and
  // conflating the two is the mistake this module used to be built around.
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

  logger.info("solve.claim.written", {
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
 * Puts a claimed ticket back exactly as it was found.
 *
 * The Phase B2 experiment this exists for is *claim one ticket, confirm a second
 * `solve:once` picks nothing up, release it, confirm the ticket ends where it
 * started* — so "exactly" is the requirement rather than a nicety. A release that
 * merely removed `agent:solving` would leave the ticket without the `agent:start`
 * the claim consumed, and the experiment would end with a ticket that is neither
 * claimed nor approved: the queue would ignore it, and the person who approved it
 * would have to approve it again without being told why.
 *
 * It is the same read-modify-write as the claim and carries the same hazard, so
 * it takes the same shape — read last, arithmetic only, verify after — with one
 * extra refusal on top. Before restoring, the live set must still be the set the
 * claim left behind. If it is not, somebody has edited the ticket while it was
 * claimed, and writing `labelsBefore` over that would destroy their edit to undo
 * ours. Fail closed: refuse, name the drift, and leave the ticket for a person.
 * The cost of refusing is an `agent:solving` a human removes by hand; the cost of
 * proceeding is the silent clobber §14.11 is about, committed deliberately.
 */
export async function releaseClaim(
  capabilities: ClaimCapabilities,
  receipt: ClaimReceipt,
): Promise<ReleaseResult> {
  const { issueKey, labelsBefore, labelsAfter } = receipt;

  // Checked before the read rather than after, because it is a fact about the
  // receipt and not about the board. A receipt whose restore point still carries
  // the claim would "release" the ticket into the state of being claimed, which
  // no sequence of real calls produces and a hand-built receipt easily does —
  // and hand-building one is the documented way to recover an unverified claim.
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

  // The exact inverse of the claim, derived from the receipt — the two label
  // sets this service itself observed either side of its own write — and not
  // from `live`.
  //
  // Deriving it from `live` reads as the more careful version, and is the
  // clobber back again by another route: a `next:to-trio` a PM added while the
  // ticket was claimed is present in `live` and absent from the restore point,
  // so "remove whatever `live` has that the restore point lacks" would delete
  // it. The receipt names the two labels this service actually wrote, and those
  // are the only two it is entitled to undo.
  //
  // `labelEdit` refuses a delta that both adds and removes the same label, which
  // cannot arise here — the two sets are compared by membership — but the
  // constructor is used anyway so that there is exactly one place in the
  // codebase where a delta comes into existence unchecked, and it is not this
  // one.
  const change = labelEdit(
    labelsBefore.filter((label) => !labelsAfter.includes(label)),
    labelsAfter.filter((label) => !labelsBefore.includes(label)),
  );

  // Drift, narrowed to the labels the release is about to touch.
  //
  // This used to compare the whole field against `labelsAfter`, and had to: the
  // release wrote the whole field, so *anything* that moved while the ticket was
  // claimed was about to be overwritten, and refusing was the only safe answer.
  // A delta cannot overwrite what it does not name, so a colleague's label
  // arriving mid-solve is no longer a reason to strand `agent:solving` on the
  // board and make a human clear it.
  //
  // What still refuses is the claim's own edit coming undone: `agent:start` back
  // on, or `agent:solving` off (the explicit check above catches that one first,
  // with a better sentence). Those two are what the claim asserted, so they are
  // what the release may assume before undoing it. Checking the inverse of the
  // inverse looks roundabout written down; it is the claim's edit, recovered
  // from the only record of it that survives into this function.
  const drift = diffEdit(labelEdit(change.remove, change.add), live);
  if (!agrees(drift)) {
    return refusedRelease(
      issueKey,
      `the claim this receipt describes is no longer on the ticket, so there is nothing here to undo — ${mismatchNotes(
        drift,
      ).join("; ")}`,
    );
  }

  // What the ticket should read afterwards: the live set with the release
  // applied, not the pre-claim set. The two differ by exactly the bystander
  // labels the paragraph above stopped refusing over, and predicting the
  // pre-claim set would mean reporting every one of them as a mismatch.
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

  logger.info("solve.claim.released", {
    issueKey,
    labels: observed,
    note: "released and verified — the ticket reads exactly as it did before the claim",
  });

  return { outcome: "released", issueKey, labels: observed };
}

/**
 * The read-back, with both ways of not getting one collapsed into a fault.
 *
 * A rejected read and an unreadable read differ only in how the transport
 * expressed itself; in both cases the write landed and there is no answer to the
 * question of what it landed as. That is not the same event as a read-back that
 * arrived and disagreed, and keeping them apart is what lets `unverified` mean
 * exactly one thing — *verification ran and the ticket is not what we wrote* —
 * with a populated diff every time. An `unverified` result whose `appeared` and
 * `vanished` were both empty would be a third meaning smuggled into the second.
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
  logger.info("solve.claim.refused", { issueKey, reason, note: "nothing was written" });
  return { outcome: "refused", issueKey, reason };
}

function refusedRelease(issueKey: string, reason: string): ReleaseResult {
  logger.info("solve.release.refused", { issueKey, reason, note: "nothing was written" });
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
  logger.error("solve.claim.unverified", {
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
  logger.error("solve.release.unverified", {
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
