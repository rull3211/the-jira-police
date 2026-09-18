/**
 * One solve-queue cycle — dry run only: it selects tickets, computes the label
 * edit that would claim each, and reports it, writing nothing.
 *
 * Unlike `runPollCycle`: no cursor (the queue is a state, not a window, so
 * `isUnseen` would wrongly rule out old tickets); dedupe lives in Jira's own
 * labels; a ticket that doesn't qualify is skipped, not failed, so widening
 * `SOLVE_REPOS` picks it up next tick with no reset.
 */

import { createLogger } from "../logger.ts";
import type { SolveMode } from "../settings.ts";
import {
  type LabelEdit,
  applyEdit,
  claimTransition,
  eligibility,
  repoFromLabels,
} from "./labels.ts";

const log = createLogger("solve");

/** A ticket from the solve queue; not `TicketRef` because this queue selects on `labels`, not `created`. */
export interface SolveCandidate {
  readonly key: string;
  readonly summary: string;
  readonly url: string;
  readonly labels: readonly string[];
  /** ISO-8601 with offset, as Jira returns it: `2026-09-02T09:55:34.178+0200`. */
  readonly updated: string;
}

export interface SolveDeps {
  /** `SOLVE_ENABLED`, checked here as well as at composition so unsafe wiring can't skip it. */
  readonly enabled: boolean;
  readonly mode: SolveMode;
  /** Repos the solver may touch; empty means nothing is allowed (opposite of `JIRA_COMPONENTS`'s empty-is-all). */
  readonly allowedRepos: readonly string[];
  /** `MAX_CONCURRENT_SOLVES`. */
  readonly maxConcurrent: number;
  readonly fetchQueue: () => Promise<readonly SolveCandidate[]>;
  /** Counted separately because the queue excludes `agent:solving`; a bound from the queue alone wouldn't bound anything. */
  readonly countInFlight: () => Promise<number>;
  /** Aborted to request a graceful stop; checked between tickets. */
  readonly signal?: AbortSignal;
  /** The JQL behind `fetchQueue`/`countInFlight`, for the report only; absent for hand-built fakes. */
  readonly queueJql?: string;
  readonly inFlightJql?: string;
}

/** What the cycle would do to one ticket, had it been allowed to. */
export interface PlannedClaim {
  readonly issueKey: string;
  readonly repo: string;
  readonly claim: LabelEdit;
  /** The resulting label set, so a dry run can be read without applying it. */
  readonly labelsAfter: readonly string[];
}

export interface SkippedTicket {
  readonly issueKey: string;
  readonly reason: string;
}

export interface SolveCycleOutcome {
  /** A field, not a comment, so a future write path forces every reader of it to be revisited. */
  readonly dryRun: true;
  readonly found: number;
  readonly inFlight: number;
  /** How many new claims the concurrency bound left room for. */
  readonly capacity: number;
  readonly planned: readonly PlannedClaim[];
  readonly skipped: readonly SkippedTicket[];
  /** Eligible and allowed, but out of capacity or interrupted. Next tick takes them. */
  readonly deferred: readonly string[];
  /** Every candidate the queue returned, oldest-updated first, so a skip reason can be checked against its ticket. */
  readonly candidates: readonly SolveCandidate[];
}

const NOTHING: SolveCycleOutcome = {
  dryRun: true,
  found: 0,
  inFlight: 0,
  capacity: 0,
  planned: [],
  skipped: [],
  deferred: [],
  candidates: [],
};

/**
 * Oldest touched first, by instant rather than string: Jira's numeric UTC offset
 * (not `Z`) sorts wrong as text across a DST boundary (see `src/poller.ts`).
 */
function byUpdatedAscending(a: SolveCandidate, b: SolveCandidate): number {
  const delta = instant(a) - instant(b);
  return delta === 0 ? a.key.localeCompare(b.key) : delta;
}

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

/** How many new claims there is room for; any unreadable input reads as zero, never "unlimited". */
function capacityFor(maxConcurrent: number, inFlight: number): number {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    log.error("solve.bad_concurrency_limit", {
      maxConcurrent,
      note: "claiming nothing until MAX_CONCURRENT_SOLVES is a positive integer",
    });
    return 0;
  }
  if (!Number.isInteger(inFlight) || inFlight < 0) {
    log.error("solve.bad_in_flight_count", { inFlight, note: "claiming nothing this cycle" });
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

/**
 * Which repository a ticket points at, and whether we may touch it, read from the
 * ticket's own `svc:<repo>` label — anyone can edit that label, so the allowlist
 * decides and the label only proposes.
 */
function checkRepo(candidate: SolveCandidate, allowed: ReadonlySet<string>): RepoDecision {
  const repo = repoFromLabels(candidate.labels);

  if (repo === null) {
    return {
      ok: false,
      reason:
        "no single svc:<repo> label — the ticket does not say which repository a fix would go to, or says more than one, and neither can be checked against SOLVE_REPOS",
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

/** Runs one dry-run pass over the solve queue; never mutates the candidates it was handed. */
export async function runSolveCycle(deps: SolveDeps): Promise<SolveCycleOutcome> {
  if (!deps.enabled) {
    // Logged, not silent: an operator expecting the queue to run needs to see why it didn't.
    log.info("solve.disabled", { note: "SOLVE_ENABLED is off; the queue was not read" });
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

    // Checked after eligibility/repo so a dry run still reports why the rest of the queue
    // wouldn't qualify, but before computing a claim nobody may act on.
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

  log.info("solve.dry_run", {
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
    candidates,
  };
}
