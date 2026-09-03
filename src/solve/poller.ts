/**
 * One solve-queue cycle — **dry run only**.
 *
 * This is Phase B of the plan, and the whole of it: the cycle selects the
 * tickets that are waiting to be fixed, works out the exact label edit that
 * would claim each one, and reports it. It writes nothing. It does not write
 * code, it does not touch git, it does not shell out, and it does not label a
 * ticket. The phasing is the point — the fitness assessment that feeds this
 * queue is made by a model that cannot read source code, so it is worth
 * watching which tickets arrive here before anything acts on them.
 *
 * That property is structural rather than promised. `SolveDeps` below has two
 * dependencies and both are readers; there is no write function to call, so the
 * refusal cannot be undone by a moment of inattention in a later edit to this
 * file. Granting the write is a visible change to that interface, which is
 * where a reviewer would look.
 *
 * Dependencies are injected the way `PollDeps` injects them, for the same
 * reason: every rule below — ordering, the allowlist, the concurrency bound,
 * fail-closed on the master switch — is then testable against a fake with no
 * live board and no credentials.
 *
 * Where this differs from `runPollCycle`, and why:
 *
 *   - **No cursor, no state file.** The queue is a *state*, not a window. A
 *     ticket labelled for solving today must be picked up today even if it was
 *     triaged in March, and `isUnseen` would have ruled it out permanently.
 *   - **Dedupe lives in Jira.** The claim is a label on the ticket, so two
 *     instances cannot both take the same work, and neither can one instance
 *     after a restart with a wiped `state/`.
 *   - **Nothing is "failed" here.** A ticket that does not qualify is skipped
 *     with a reason and left exactly as it was, so widening `SOLVE_REPOS` or
 *     adding `agent:start` picks it up on the next tick with no reset.
 */

import { logger } from "../logger.ts";
import type { SolveMode } from "../settings.ts";
import { type LabelEdit, applyEdit, claimTransition, eligibility } from "./labels.ts";

/**
 * A ticket from the solve queue.
 *
 * Its own type rather than `TicketRef` because the two queues need different
 * facts. `TicketRef` carries `created`, which this queue has no use for, and
 * drops `labels`, which are the only thing this queue selects on.
 */
export interface SolveCandidate {
  readonly key: string;
  readonly summary: string;
  readonly url: string;
  /** Every label live on the ticket. The queue's entire state is in here. */
  readonly labels: readonly string[];
  /** ISO-8601 with offset, as Jira returns it: `2026-09-02T09:55:34.178+0200`. */
  readonly updated: string;
  /**
   * The repository triage named in `agentFitness.repo`, if it is known.
   *
   * Optional because the label on the board does not carry it — the assessment
   * that produced `agent:solvable` does, and reuniting the two is the caller's
   * job. Absent is read as "no repository named" and therefore as a skip, not
   * as "any repository".
   */
  readonly repo?: string;
}

export interface SolveDeps {
  /**
   * `SOLVE_ENABLED`, checked here as well as wherever the poller is composed.
   *
   * Twice on purpose. A poller that is safe only because its caller remembers
   * not to call it is one careless wiring change away from running unattended,
   * and the wiring is the part of this service most likely to be edited by
   * someone thinking about something else. The check costs a branch.
   */
  readonly enabled: boolean;
  readonly mode: SolveMode;
  /**
   * Repositories the solver may touch.
   *
   * Empty means **nothing is allowed**, which is the opposite of how
   * `JIRA_COMPONENTS` reads an empty list. The difference is deliberate: an
   * empty component filter widens a read, an empty repository filter would
   * widen a write. Anything granting privilege reads absence as "no".
   */
  readonly allowedRepos: readonly string[];
  /** `MAX_CONCURRENT_SOLVES`. */
  readonly maxConcurrent: number;
  /** The solve queue, oldest-updated first — though this module re-sorts anyway. */
  readonly fetchQueue: () => Promise<readonly SolveCandidate[]>;
  /**
   * How many solves are already running, counted from the board.
   *
   * A separate read because it has to be. The queue query excludes
   * `agent:solving` by design, so the tickets that count against the limit are
   * precisely the ones the queue cannot see, and a bound computed from the
   * queue alone would be no bound at all — it would cap claims *per cycle* and
   * let the next tick start another.
   */
  readonly countInFlight: () => Promise<number>;
  /** Aborted to request a graceful stop; checked between tickets. */
  readonly signal?: AbortSignal;
}

/** What the cycle would do to one ticket, had it been allowed to. */
export interface PlannedClaim {
  readonly issueKey: string;
  readonly repo: string;
  /** `agent:solving` added and `agent:start` removed, as a single edit. */
  readonly claim: LabelEdit;
  /** The resulting label set, so a dry run can be read without applying it. */
  readonly labelsAfter: readonly string[];
}

export interface SkippedTicket {
  readonly issueKey: string;
  readonly reason: string;
}

export interface SolveCycleOutcome {
  /**
   * Always true in Phase B.
   *
   * A field rather than a comment so that the day someone adds the write path,
   * every caller and every test that reads this has to be revisited rather than
   * quietly continuing to mean something else.
   */
  readonly dryRun: true;
  readonly found: number;
  readonly inFlight: number;
  /** How many new claims the concurrency bound left room for. */
  readonly capacity: number;
  readonly planned: readonly PlannedClaim[];
  readonly skipped: readonly SkippedTicket[];
  /** Eligible and allowed, but out of capacity or interrupted. Next tick takes them. */
  readonly deferred: readonly string[];
}

const NOTHING: SolveCycleOutcome = {
  dryRun: true,
  found: 0,
  inFlight: 0,
  capacity: 0,
  planned: [],
  skipped: [],
  deferred: [],
};

/**
 * Oldest touched first.
 *
 * Compares instants rather than strings, for the reason recorded in
 * `src/poller.ts`: Jira returns a numeric offset, not `Z`, and that offset moves
 * at the DST boundary, so `02:00+0100` sorts before `02:30+0200` as text while
 * being half an hour later in fact. It matters less here than it does there —
 * nothing is dropped, only reordered — but with a concurrency bound of one the
 * order decides which ticket is worked on today and which waits, and a queue
 * that reverses itself twice a year for one night is a thing nobody will ever
 * successfully debug.
 */
function byUpdatedAscending(a: SolveCandidate, b: SolveCandidate): number {
  const delta = instant(a) - instant(b);
  return delta === 0 ? a.key.localeCompare(b.key) : delta;
}

/** A function rather than an inline check, so the two call sites stay independent. */
function stopRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function instant(candidate: SolveCandidate): number {
  const parsed = Date.parse(candidate.updated);
  if (Number.isNaN(parsed)) {
    throw new Error(`${candidate.key} has an unparseable updated timestamp: ${candidate.updated}`);
  }
  return parsed;
}

/**
 * How many new claims there is room for.
 *
 * Every unreadable answer is zero. A non-integer, a zero, a negative or a NaN
 * `MAX_CONCURRENT_SOLVES` is a misconfiguration, and the safe reading of a
 * misconfigured concurrency limit is not "unlimited".
 */
function capacityFor(maxConcurrent: number, inFlight: number): number {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    logger.error("solve.bad_concurrency_limit", {
      maxConcurrent,
      note: "claiming nothing until MAX_CONCURRENT_SOLVES is a positive integer",
    });
    return 0;
  }
  if (!Number.isInteger(inFlight) || inFlight < 0) {
    logger.error("solve.bad_in_flight_count", { inFlight, note: "claiming nothing this cycle" });
    return 0;
  }
  return Math.max(0, maxConcurrent - inFlight);
}

type RepoDecision =
  | { readonly ok: true; readonly repo: string }
  | {
      readonly ok: false;
      readonly reason: string;
    };

function checkRepo(candidate: SolveCandidate, allowed: ReadonlySet<string>): RepoDecision {
  const repo = candidate.repo?.trim() ?? "";

  if (repo === "") {
    return {
      ok: false,
      reason:
        "no repository named — agentFitness.repo is the only thing that says where a fix would go, and an unnamed one cannot be checked against SOLVE_REPOS",
    };
  }

  if (allowed.size === 0) {
    return {
      ok: false,
      reason: "SOLVE_REPOS is empty, and an empty allowlist allows nothing",
    };
  }

  if (!allowed.has(repo)) {
    return { ok: false, reason: `repository "${repo}" is not on SOLVE_REPOS` };
  }

  return { ok: true, repo };
}

/**
 * Runs one dry-run pass over the solve queue.
 *
 * Returns what it *would* do. Nothing in this function or anything it calls
 * mutates the candidates it was handed, which is worth stating because the
 * claim is computed by `applyEdit` against a ticket's live labels and the
 * temptation to write the result back into the object is real.
 */
export async function runSolveCycle(deps: SolveDeps): Promise<SolveCycleOutcome> {
  if (!deps.enabled) {
    // Not an error and not silent. An operator who expected the queue to be
    // running needs to see why it is not, and the answer is one setting.
    logger.info("solve.disabled", { note: "SOLVE_ENABLED is off; the queue was not read" });
    return NOTHING;
  }

  if (stopRequested(deps.signal)) {
    return NOTHING;
  }

  const inFlight = await deps.countInFlight();
  const capacity = capacityFor(deps.maxConcurrent, inFlight);

  const candidates = (await deps.fetchQueue()).toSorted(byUpdatedAscending);
  const allowed = new Set(deps.allowedRepos.map((entry) => entry.trim()).filter((e) => e !== ""));

  const planned: PlannedClaim[] = [];
  const skipped: SkippedTicket[] = [];
  const deferred: string[] = [];

  for (const candidate of candidates) {
    const verdict = eligibility(candidate.labels, deps.mode);
    if (!verdict.eligible) {
      skipped.push({ issueKey: candidate.key, reason: verdict.reason });
      continue;
    }

    const repo = checkRepo(candidate, allowed);
    if (!repo.ok) {
      skipped.push({ issueKey: candidate.key, reason: repo.reason });
      continue;
    }

    // Checked after the cheap decisions so a dry run still reports why the rest
    // of the queue would not have qualified, but before the claim is computed,
    // since a claim nobody may act on is the thing being withheld.
    if (planned.length >= capacity || stopRequested(deps.signal)) {
      deferred.push(candidate.key);
      continue;
    }

    const claim = claimTransition(candidate.labels, deps.mode);
    planned.push({
      issueKey: candidate.key,
      repo: repo.repo,
      claim,
      labelsAfter: applyEdit(candidate.labels, claim),
    });
  }

  logger.info("solve.dry_run", {
    found: candidates.length,
    inFlight,
    capacity,
    planned: planned.map((entry) => entry.issueKey),
    skipped: skipped.length,
    deferred: deferred.length,
    note: "dry run — no label was written",
  });

  return {
    dryRun: true,
    found: candidates.length,
    inFlight,
    capacity,
    planned,
    skipped,
    deferred,
  };
}
