/**
 * The write rungs of the ladder, as functions rather than as a script.
 *
 * Split out of `solve-once.ts` the moment a second command needed these four steps (claim,
 * solve, publish, release): that file calls `main()` at module scope, so importing anything from
 * it starts a run — the same hazard `solve-args.ts`'s header records.
 *
 * `runClaim` takes a `ClaimAuthority` and does not consult `SOLVE_MODE` itself — each caller
 * passes its own authority, so the query and the claim read the setting once, not twice, and
 * cannot disagree about the mode.
 *
 * `cycle` is nullable because the queue is optional: a named-ticket run has no queue to consult
 * and passes `null`, so the commentary can say the queue wasn't consulted rather than reporting
 * the ticket as absent from it.
 */

import type { IssueDetail, JiraClient } from "../jira/client.ts";
import { logger } from "../logger.ts";
import { type Settings, flag, numeric } from "../settings.ts";
import type { AttemptLedger } from "../solve/attempts.ts";
import { type ClaimReceipt, claimTicket, releaseClaim } from "../solve/claim.ts";
import {
  type AdvanceOutcome,
  type AdvanceRequest,
  type PendingRound,
  advance,
  publish,
  recordFailedStart,
  runMergeRound,
  runRound,
  surveyReview,
} from "../solve/delivery.ts";
import { reportOutcome } from "../solve/feedback.ts";
import {
  type ClaimAuthority,
  type LabelEdit,
  LabelStateError,
  type ReviewStage,
  type SolveOutcomeLabel,
  completionTransition,
  isNoopEdit,
  isTerminal,
  labelEdit,
  reviewStageTransition,
  reviewTransition,
} from "../solve/labels.ts";
import {
  type SolveDependencies,
  type SolveOutcome,
  type SolveRequest,
  solveWithRetry,
} from "../solve/orchestrator.ts";
import { type SolveCycleOutcome, type SolveDeps, runSolveCycle } from "../solve/poller.ts";
import { findPullRequest } from "../solve/pr.ts";
import {
  type ReviewCycleOutcome,
  type ReviewLook,
  type WatchedTicket,
  REVIEW_ROUND_USD,
  runReviewCycle,
} from "../solve/review-cycle.ts";
import { type SyncedAttachResult, attachSynced } from "../solve/base-sync.ts";
import { type Worktree, branchNameFor, removeWorktree } from "../solve/worktree.ts";
import {
  NotSolvableError,
  buildAdvanceRequest,
  buildFindPrRequest,
  buildPublishRequest,
  buildSolveRequest,
  createClaimCapabilities,
  createSolveCommenter,
  createReviewCycleDeps,
  createSolveDeps,
  createSolveRunDeps,
  botIdentityOf,
  createTicketReader,
} from "../wiring.ts";
import { type SolvePhase, includes } from "./solve-args.ts";
import {
  chainDecision,
  completionLabelFor,
  describeAdvanceOutcome,
  describeReviewSweep,
  describeSolveOutcome,
  endedState,
  isAdvanceFailureExit,
  isFailureExit,
  reportsToTicket,
  reviewStageAfter,
  terminalLabelAfter,
} from "./solve-outcome.ts";

/**
 * What the queue thinks of this ticket, or that there was no queue to ask.
 *
 * Three outcomes, not two: "not in the queue" is a fact about the board worth overriding out
 * loud, while "no queue was consulted" is a fact about the command — conflating them would tell
 * an operator their labels were wrong when nothing had looked at them.
 */
function queueNote(issueKey: string, cycle: SolveCycleOutcome | null): string {
  if (cycle === null) {
    return `\n${issueKey} was named directly; the queue was not consulted.\n`;
  }
  return cycle.planned.some((candidate) => candidate.issueKey === issueKey)
    ? `\n${issueKey} is in the queue; solving it.\n`
    : `\n${issueKey} is NOT in the queue right now — solving it anyway because you named it.\n`;
}

/**
 * The solve request, or `null` after saying why there is not one.
 *
 * `NotSolvableError` is caught and everything else rethrown: "this ticket names a repository the
 * operator has not allowed" is an answer with a fix (widen `SOLVE_REPOS`), and anything else is
 * a fault that must not be reported as a ticket problem.
 *
 * `rung` is a parameter because both callers ask the same question about a different privilege —
 * an operator told "refusing --solve" after typing `--advance` would go looking in the wrong
 * place.
 */
function requestOrRefusal(
  settings: Settings,
  detail: IssueDetail,
  ticket: string,
  rung: string,
): SolveRequest | null {
  try {
    return buildSolveRequest(settings, detail, ticket);
  } catch (error) {
    if (error instanceof NotSolvableError) {
      process.stderr.write(`refusing ${rung}: ${error.message}\n`);
      process.exitCode = 3;
      return null;
    }
    throw error;
  }
}

/**
 * Runs the four passes against one named ticket and reports what happened.
 *
 * Everything it does to code stays in a temporary worktree — no push, nothing opened. Returns
 * the outcome so the rung above can decide whether to publish; `null` means the request could
 * not be built, already reported, not a solve failure.
 *
 * The queue's own opinion is printed but not enforced: an operator who typed a key has already
 * made the decision the queue would make. What is enforced is `SOLVE_REPOS`, in
 * `buildSolveRequest`, since that answers which repository may be written to, not workflow.
 */
export async function runSolver(
  settings: Settings,
  client: JiraClient,
  issueKey: string,
  cycle: SolveCycleOutcome | null,
): Promise<SolveOutcome | null> {
  process.stdout.write(queueNote(issueKey, cycle));

  const read = createTicketReader(client);
  const { text, detail, inlined, omitted } = await read(issueKey);
  process.stdout.write(
    `Ticket: ${text.length} characters, ${detail.comments.length} comment(s)` +
      `${inlined.length > 0 ? `, inlined ${inlined.join(", ")}` : ""}` +
      `${omitted.length > 0 ? `, omitted ${omitted.length}` : ""}\n`,
  );

  const request = requestOrRefusal(settings, detail, text, "--solve");
  if (request === null) {
    return null;
  }

  process.stdout.write(`Repository: ${request.repoPath} @ ${request.baseRef}\n\n`);

  // `solveWithRetry`, not `solveTicket` — the difference only shows on one outcome: a fix pass
  // stopped by the machine rather than by the code gets one clean rerun.
  const { outcome, attempts, retryBlocked } = await solveWithRetry(
    createSolveRunDeps(settings),
    request,
  );
  process.stdout.write(`\n${describeSolveOutcome(outcome)}\n`);
  if (attempts > 1) {
    process.stdout.write(
      `This ran ${String(attempts)} times — the first attempt was stopped by the environment, not by the code.\n`,
    );
  }
  if (retryBlocked !== "") {
    // Said out loud rather than logged: "abandoned on an environment cause" means something
    // different depending on whether a retry was even attempted.
    process.stdout.write(`A retry was warranted and did not happen: ${retryBlocked}\n`);
  }

  // The calibration row: triage makes the `agent:solvable` call without reading source, so
  // recon's `devLensAccurate` reading is the only feedback that assessment ever gets.
  //
  // Every outcome but `verified` is said out loud on the ticket, gated on `reportsToTicket`
  // rather than `terminalLabelAfter` — the two were one predicate until SSX-3832 silenced a run
  // that had claimed, cut a worktree, verified the base, and was stopped by a policy hook: it
  // released every label and said nothing, leaving the board looking untouched.
  //
  // This line is not mutation-covered, measured rather than assumed: there is no
  // `solve-run.test.ts`, so putting `terminalLabelAfter` back here leaves the suite green. The
  // predicate itself is covered in `solve-outcome.test.ts`; the choice of predicate at this one
  // call site is the gap, recorded rather than fixed since a harness for this function is a
  // larger change than the feature it would guard.
  const commenter = reportsToTicket(outcome) ? createSolveCommenter(settings) : null;
  const feedback = await reportOutcome(
    {
      outputDirectory: settings.OUTPUT_DIR,
      ...(commenter === null ? {} : { commenter }),
    },
    issueKey,
    outcome,
    new Date(),
  );
  process.stdout.write(
    `\nCalibration row appended to ${feedback.recordPath}` +
      `${feedback.posted ? "" : ` — ${feedback.reason ?? "not posted"}`}\n`,
  );

  // Which outcomes count is `isFailureExit`, kept there so it can be tested without spawning
  // this command.
  if (isFailureExit(outcome)) {
    process.exitCode = 1;
  }

  return outcome;
}

/**
 * Moves a ticket's `agent:` labels, and says plainly when it could not.
 *
 * Every caller is after the fact — the pull request is already open, or the round already
 * pushed — so nothing here sets an exit code or throws; a bookkeeping failure must not read as a
 * command failure. A failed `reviewTransition` leaves `agent:solving` on (stalls the queue,
 * visible, doesn't become double-claimable); a failed stage move leaves the old stage on (both
 * excluded from the queue).
 *
 * `LabelStateError` is caught: `reviewStageTransition` throws when a person moved the ticket
 * while the round ran, which is not a fault, so their decision is left alone and reported.
 *
 * The read-back confirms the write landed — `updateLabels` sends one atomic REST call, so
 * there's no window to lose a label in, unlike the claim's read-back-and-verify.
 *
 * Every outcome is logged rather than printed: since Phase E one caller is the daemon, whose
 * stdout is its log, and a prose line there is unparseable in the stream an operator reads when
 * the board and the pull requests disagree. Repair instructions are in the `note` field.
 */
async function moveLabels(
  client: JiraClient,
  issueKey: string,
  plan: (labels: readonly string[]) => LabelEdit,
): Promise<void> {
  const capabilities = createClaimCapabilities(client);

  let change: LabelEdit;
  try {
    change = plan(await capabilities.readLabels(issueKey));
  } catch (error) {
    if (error instanceof LabelStateError) {
      logger.info("labels.left_alone", { issueKey, reason: error.message });
      return;
    }
    throw error;
  }

  if (isNoopEdit(change)) {
    return;
  }

  const wanted = `+${change.add.join(", +")}${change.remove.length === 0 ? "" : ` -${change.remove.join(", -")}`}`;
  try {
    await capabilities.applyLabels(issueKey, change);
  } catch (error) {
    logger.error("labels.write_failed", {
      issueKey,
      wanted,
      error,
      note: "move them by hand; the pull request is unaffected",
    });
    return;
  }

  const after = await capabilities.readLabels(issueKey);
  const missing = change.add.filter((label) => !after.includes(label));
  const lingering = change.remove.filter((label) => after.includes(label));
  if (missing.length > 0 || lingering.length > 0) {
    logger.error("labels.read_back_mismatch", {
      issueKey,
      wanted,
      labels: after,
      note: "fix them by hand — the queue reads these",
    });
    return;
  }

  logger.info("labels.moved", { issueKey, labels: after });
}

/** The label half of a finished round: mirror the pull request's draft flag. */
async function moveReviewStage(
  client: JiraClient,
  issueKey: string,
  stage: ReviewStage | null,
): Promise<void> {
  if (stage === null) {
    return;
  }
  await moveLabels(client, issueKey, (labels) => reviewStageTransition(labels, stage));
}

/**
 * Writes the claim, or explains why it did not.
 *
 * `null` means do not proceed, and the three routes differ: refused — the board moved between
 * the queue reading it and this reading it, nothing written, exit 3. unverified — the write
 * landed but couldn't be confirmed, so the restore point goes to stderr and the result carries
 * no receipt, so this branch can't mechanically undo a write it doesn't understand. A thrown
 * `ClaimWriteError` reaches `withConfigErrors` with its own restore point.
 */
export async function runClaim(
  client: JiraClient,
  issueKey: string,
  authority: ClaimAuthority,
): Promise<ClaimReceipt | null> {
  const result = await claimTicket(createClaimCapabilities(client), { issueKey, authority });

  if (result.outcome === "refused") {
    process.stdout.write(`\nNot claimed: ${result.reason}\n`);
    process.exitCode = 3;
    return null;
  }

  if (result.outcome === "unverified") {
    process.stderr.write(
      `\nThe claim was written to ${issueKey} and could not be confirmed: ${result.reason}\n` +
        `Nothing else will run. Put the labels back by hand if they are wrong; they were: ${result.labelsBefore.join(", ")}\n`,
    );
    process.exitCode = 1;
    return null;
  }

  process.stdout.write(
    `\nClaimed ${issueKey}. Labels are now: ${result.receipt.labelsAfter.join(", ")}\n`,
  );
  return result.receipt;
}

/**
 * Puts the labels back, and says so either way.
 *
 * Never throws for a refusal — this runs on the way out of a run that has often already failed,
 * and turning "the claim was gone before I could undo it" into an exception would replace the
 * operator's real error with a bookkeeping one.
 */
export async function runRelease(client: JiraClient, receipt: ClaimReceipt): Promise<void> {
  const result = await releaseClaim(createClaimCapabilities(client), receipt);

  if (result.outcome === "released") {
    process.stdout.write(`\nReleased ${receipt.issueKey}: ${result.labels.join(", ")}\n`);
    return;
  }

  process.stderr.write(
    `\nThe claim on ${receipt.issueKey} was NOT released (${result.outcome}): ${result.reason}\n` +
      `Check the ticket's labels; it may still read as claimed.\n`,
  );
}

/**
 * Commits, pushes and opens the draft pull request.
 *
 * Returns whether the pull request exists, since that decides whether the claim is released:
 * `published-unreviewed` counts as yes — the branch is public and a pull request is open, so
 * releasing would let a second solver duplicate solved work. The missing reviewer is a
 * `gh pr edit` away.
 */
export async function runPublish(
  settings: Settings,
  outcome: Extract<SolveOutcome, { kind: "verified" }>,
  issueKey: string,
): Promise<boolean> {
  const result = await publish(
    createSolveRunDeps(settings),
    buildPublishRequest(settings, outcome, issueKey),
  );

  switch (result.kind) {
    case "published": {
      process.stdout.write(`\nDraft pull request opened: ${result.url}\n`);
      return true;
    }
    case "published-unreviewed": {
      process.stdout.write(
        `\nDraft pull request opened: ${result.url}\n` +
          `The reviewer was not added: ${result.reason}\n` +
          `Add one with: gh pr edit ${String(result.number)} --add-reviewer @copilot\n`,
      );
      return true;
    }
    case "nothing-to-commit": {
      process.stderr.write(`\nNothing to commit — the verified worktree held no change.\n`);
      process.exitCode = 1;
      return false;
    }
    case "failed": {
      process.stderr.write(`\nNo pull request (${result.stage}): ${result.reason}\n`);
      process.exitCode = 1;
      return false;
    }
  }
}

/**
 * One review round against the pull request a previous run left open.
 *
 * Rebuilds the worktree rather than remembering one — there is no resume in this harness, and a
 * worktree registry on disk would be the first thing to break after a restart or a second host.
 * The worktree is removed on the way out for the same reason: `git worktree add -b` refuses when
 * the branch or path already exists, so a leftover checkout would block the next round. Kept
 * only when there's a diff a human would want to read.
 *
 * The branch name comes from the ticket (`branchNameFor`, the same function the solver used),
 * not from GitHub, so the lookup doesn't trust anything GitHub says about the name.
 */
export async function runAdvance(
  settings: Settings,
  client: JiraClient,
  issueKey: string,
): Promise<AdvanceOutcome | null> {
  const read = createTicketReader(client);
  const { text, detail } = await read(issueKey);

  const base = requestOrRefusal(settings, detail, text, "--advance");
  if (base === null) {
    return null;
  }

  const branch = branchNameFor(issueKey, detail.summary);
  if (branch === null) {
    process.stderr.write(
      `refusing --advance: ${issueKey}'s summary yields no usable branch name, so there is nothing to look for.\n`,
    );
    process.exitCode = 3;
    return null;
  }

  const deps = createSolveRunDeps(settings);
  const found = await findPullRequest(deps.commands, buildFindPrRequest(settings, base, branch));

  if (found.outcome === "failed") {
    process.stderr.write(`\nCould not tell whether a pull request exists: ${found.reason}\n`);
    process.exitCode = 1;
    return null;
  }
  if (found.outcome === "none") {
    process.stdout.write(
      `\nNo pull request on ${branch}. --advance acts on one that already exists; run --pr first.\n`,
    );
    process.exitCode = 3;
    return null;
  }
  if (found.state !== "OPEN") {
    // Reported, not an error — a merged pull request is the happy ending, a closed one is a
    // person's decision; neither is something to push to.
    process.stdout.write(
      `\n#${String(found.number)} on ${branch} is ${found.state}. Nothing to advance.\n`,
    );
    // §6.1's terminal, and it has to land with the label move rather than after it: without this,
    // the ticket would sit in `agent:review-done`, excluded from the queue, with nothing left to
    // ever clear it — a leak, not an unfinished feature.
    //
    // `MERGED` and `CLOSED` do not share a label: `agent:done` counts bugs this tool actually
    // fixed, and a pull request a person closed unmerged is a different, more interesting number
    // that folding them together would erase.
    await moveLabels(client, issueKey, (labels) =>
      isTerminal(labels)
        ? labelEdit([], [])
        : completionTransition(labels, completionLabelFor(endedState(found.state))),
    );
    return null;
  }

  // Held outside the callback so cleanup can see whether one was ever cut. `null` here is the
  // ordinary case on a quiet pull request — `advance` decided there's nothing to answer, so
  // there's no checkout to remove.
  let worktree: Worktree | null = null;
  const attach = async (): Promise<SyncedAttachResult> => {
    const attached = await attachSynced(deps.commands, {
      issueKey,
      branch,
      repoPath: base.repoPath,
      parentDirectory: base.parentDirectory,
      timeoutMs: base.gitTimeoutMs,
      baseRef: base.baseRef,
      identity: botIdentityOf(settings),
    });
    // A conflicted attach owns a checkout too, the same one the merge round is about to work in
    // — recording it here keeps the cleanup below the one owner of it.
    if (attached.outcome === "created" || attached.outcome === "conflicted") {
      worktree = attached.worktree;
      process.stdout.write(`\nAdvancing #${String(found.number)} in ${attached.worktree.path}\n`);
    }
    return attached;
  };

  const result = await advance(deps, buildAdvanceRequest(settings, base, attach, found.number));
  process.stdout.write(`\n${describeAdvanceOutcome(result)}\n`);
  if (isAdvanceFailureExit(result)) {
    process.exitCode = 1;
  }

  // Before the worktree is cleaned up, so a failure here is reported next to the round it
  // belongs to. The stage is `null` for every outcome that left the draft flag alone, which is
  // most of them.
  await moveReviewStage(client, issueKey, reviewStageAfter(result));

  // Kept when a human would want the diff: a refusal is a diff judged too large or too wide, and
  // reading it is how an operator decides whether the gate or the pass was wrong.
  if (worktree !== null) {
    const cleanup = await removeWorktree(
      deps.commands,
      worktree,
      result.kind === "refused" ? "keep-as-evidence" : "discard",
      base.gitTimeoutMs,
    );
    process.stdout.write(
      cleanup.outcome === "removed"
        ? `Worktree removed.\n`
        : `Worktree kept at ${cleanup.path} — ${cleanup.reason}\n`,
    );
  }

  return result;
}

/**
 * Sleep, as a named function so the loop below reads as a loop.
 *
 * Must not be `.unref()`'d: an unref'd timer let Node exit mid-wait the first time the chain
 * settled in to poll a silent reviewer (SSX-3789, exit code 13, 120ms into a 120s wait). The
 * "Ctrl-C is safe" banner elsewhere is unrelated to this timer — a signal terminates the process
 * regardless of pending timers, so the unref bought nothing and cost the feature.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `--review`: rounds against the reviewer until something ends it.
 *
 * The only unattended loop in this service — one ticket, named by hand, in the foreground, is
 * the weakest form of the capability that still tests it.
 *
 * `MAX_PR_ROUNDS_TOTAL` and `MAX_REVIEW_ITERATIONS` bound this loop from inside `advance`,
 * against the marker on the pull request, so they survive a restart where a counter here would
 * not. `REVIEW_SILENCE_MS` is the new bound: the other three count rounds, and a reviewer who
 * never produces one needs a different bound. It is read from settings each time rather than
 * counted on this stack, unlike its predecessor `MAX_REVIEW_WAITS` — see `silence.ts`.
 *
 * Reports the worst case in money before spending it, since the operator is the last bound and
 * can Ctrl-C before the first round. Round cost is the measured $0.94 from PR #2658.
 */
export async function runReviewChain(
  settings: Settings,
  client: JiraClient,
  issueKey: string,
): Promise<void> {
  const pollMs = numeric(settings, "REVIEW_POLL_MS", 1);
  const silenceMs = numeric(settings, "REVIEW_SILENCE_MS", 1);
  const maxRounds = numeric(settings, "MAX_PR_ROUNDS_TOTAL", 1);

  process.stdout.write(
    `\n── review chain ──────────────────────────────────────────\n` +
      `Polling every ${String(Math.round(pollMs / 1000))}s, giving up once the pull request ` +
      `has been quiet for ${String(Math.round(silenceMs / 60000))} minutes.\n` +
      `At most ${String(maxRounds)} rounds, roughly $${(maxRounds * 0.94).toFixed(2)} if it runs to the cap.\n` +
      `Ctrl-C is safe: nothing is held open between rounds.\n\n`,
  );

  let rounds = 0;

  for (;;) {
    const outcome = await runAdvance(settings, client, issueKey);
    if (outcome === null) {
      // `runAdvance` reached no round and already said why — no pull request, not open, no
      // worktree — and already set the exit code if that was an error.
      process.stdout.write(`\nChain stopped before a round could run.\n`);
      return;
    }

    const decision = chainDecision(outcome, silenceMs);
    if (!decision.silent) {
      rounds += 1;
    }

    if (decision.stop) {
      process.stdout.write(
        `\n── chain finished after ${String(rounds)} round${rounds === 1 ? "" : "s"} ──\n${decision.why}\n`,
      );
      // A chain ending on silence is warned rather than informed — the one ending nobody asked
      // for. Not an error exit: a quiet reviewer is not a malfunction.
      const record = decision.silent ? logger.warn : logger.info;
      record("solve.chain.finished", {
        issueKey,
        rounds,
        outcome: outcome.kind,
        why: decision.why,
      });
      return;
    }

    process.stdout.write(`\n${decision.why} — waiting ${String(Math.round(pollMs / 1000))}s\n`);
    await sleep(pollMs);
  }
}

/**
 * Everything a round needs, carried from the look that found it to the act that pays for it.
 *
 * Held in a map keyed by issue key rather than threaded through `ReviewLook`, since the cycle
 * has no use for it and a type carrying an unread `SolveRequest` would invite a future round to
 * use the cycle's copy instead of the caller's.
 */
interface ReviewTarget {
  readonly request: AdvanceRequest;
  /** Set by `request.attach`, read by the cleanup after the round. */
  readonly holder: { worktree: Worktree | null };
}

/**
 * The cheap half, for one watched ticket.
 *
 * Every read names its own repository, so none need a checkout — a ticket nobody has touched
 * costs one Jira read and two `gh` reads and stops.
 *
 * Throws rather than reporting most failures deliberately: the cycle catches a rejected look and
 * carries on, so a fourth "something went wrong" arm would make every `ReviewLook` call site
 * handle a case the cycle already handles once.
 */
function createReviewLook(
  settings: Settings,
  client: JiraClient,
  deps: SolveDependencies,
  targets: Map<string, ReviewTarget>,
): (ticket: WatchedTicket) => Promise<ReviewLook> {
  const read = createTicketReader(client);

  return async (ticket: WatchedTicket): Promise<ReviewLook> => {
    const { text, detail } = await read(ticket.key);
    // Throws `NotSolvableError` for a repository the operator has not allowed — not caught here,
    // since the cycle records it as a real answer about one ticket.
    const base = buildSolveRequest(settings, detail, text);

    const branch = branchNameFor(ticket.key, detail.summary);
    if (branch === null) {
      throw new Error(`${ticket.key}'s summary yields no usable branch name`);
    }

    const found = await findPullRequest(deps.commands, buildFindPrRequest(settings, base, branch));

    if (found.outcome === "failed") {
      throw new Error(found.reason);
    }
    if (found.outcome === "none") {
      return { outcome: "no-pull-request", reason: `no pull request on ${branch}` };
    }
    if (found.state !== "OPEN") {
      return { outcome: "ended", number: found.number, state: endedState(found.state) };
    }

    const holder: { worktree: Worktree | null } = { worktree: null };
    const attach = async (): Promise<SyncedAttachResult> => {
      const attached = await attachSynced(deps.commands, {
        issueKey: ticket.key,
        branch,
        repoPath: base.repoPath,
        parentDirectory: base.parentDirectory,
        timeoutMs: base.gitTimeoutMs,
        baseRef: base.baseRef,
        identity: botIdentityOf(settings),
      });
      // Both outcomes that carry a checkout, so `act`'s `finally` removes the one a merge round
      // worked in as well as the one a review round did.
      if (attached.outcome === "created" || attached.outcome === "conflicted") {
        holder.worktree = attached.worktree;
      }
      return attached;
    };

    // Built here and reused by `act` rather than rebuilt there: a `MAX_REVIEW_ITERATIONS` read
    // twice could differ across a long tick, recording a round the survey never authorised.
    const request = buildAdvanceRequest(settings, base, attach, found.number);
    targets.set(ticket.key, { request, holder });

    const surveyed = await surveyReview(deps.commands, request);
    return surveyed.outcome === "settled"
      ? { outcome: "settled", number: found.number, result: surveyed.result }
      : { outcome: "round", number: found.number, pending: surveyed.pending };
  };
}

/**
 * The expensive half: attach, run the round, put the checkout back.
 *
 * Spelled out here rather than by calling `advance`, which would survey again — a second survey
 * between the look and the round could read a comment posted in between and run against a batch
 * the cycle's bound never counted.
 *
 * Exported only so its refusal branch can be tested: this is the daemon's copy of `advance`'s
 * tail, and a duplicated branch nothing constructs is where the two copies drift.
 */
export function createReviewAct(
  deps: SolveDependencies,
  targets: Map<string, ReviewTarget>,
): (ticket: WatchedTicket, pending: PendingRound, number: number) => Promise<AdvanceOutcome> {
  return async (ticket, pending, number) => {
    const target = targets.get(ticket.key);
    if (target === undefined) {
      // Unreachable through the cycle, which only acts on a ticket it looked at — thrown rather
      // than defaulted, since the alternative is inventing a request and spending money against it.
      throw new Error(`no prepared round for ${ticket.key}`);
    }

    // Logged rather than printed: this function has two callers and one is a daemon whose stdout
    // is the log, and the watch sees it as JSON among the pass's own JSON.
    logger.info("review.round.started", { issueKey: ticket.key, number });

    const attached = await target.request.attach();
    if (attached.outcome === "refused") {
      // No round has been reserved, so the next tick decides the same thing again — right for a
      // checkout that failed locally, a wedge if it stays wrong, so the attempt is counted where
      // every round cap can see it: the marker comment.
      return await recordFailedStart(deps.commands, target.request, pending, attached.reason);
    }

    // The checkout's fate is decided in `finally`, since a round can also throw — `runRound`
    // raises on a parse refusal, and without this the worktree survived by accident and every
    // later tick refused to attach to it.
    //
    // Necessary and not sufficient: a `finally` runs for a throw, not for `kill -9`, an OOM, or a
    // slept laptop. Recovering from an untidied checkout is `attachWorktree`'s job.
    let result: AdvanceOutcome | undefined;
    try {
      // Which round runs is decided by the checkout, not the survey: a branch its base will not
      // merge into cannot be verified, so the merge is the round and reserves its own.
      result =
        attached.outcome === "conflicted"
          ? await runMergeRound(deps, target.request, attached, pending)
          : await runRound(deps, target.request, attached.worktree, pending);
      return result;
    } finally {
      if (target.holder.worktree !== null) {
        // A throw leaves no outcome to read, and its diff is the evidence an operator needs to
        // tell a bad gate from a bad pass, so it's kept on the same terms as a refusal.
        await removeWorktree(
          deps.commands,
          target.holder.worktree,
          result === undefined || result.kind === "refused" ? "keep-as-evidence" : "discard",
          target.request.gitTimeoutMs,
        );
      }
    }
  };
}

/**
 * One pass over the watched set, with the label writes the cycle refuses to make.
 *
 * `runReviewCycle` reads and decides and writes nothing, so the label transitions live here — a
 * write is a visible change that should be findable at a call site, not buried in a loop body.
 *
 * `runDeps` is a parameter rather than built here: `createSolveRunDeps` throws on a missing
 * `VAULT_PATH`, and both callers are loops — building it inside the loop would turn one
 * misconfiguration into a failure every tick forever instead of one message at startup.
 */
export async function runReviewSweep(
  settings: Settings,
  client: JiraClient,
  runDeps: SolveDependencies,
  issueKey: string | null,
  signal?: AbortSignal,
): Promise<ReviewCycleOutcome> {
  const targets = new Map<string, ReviewTarget>();
  const deps = createReviewCycleDeps(
    settings,
    client,
    createReviewLook(settings, client, runDeps, targets),
    createReviewAct(runDeps, targets),
    signal,
  );

  // Narrowed after the query rather than by a different one: a named ticket not carrying the
  // subscription labels is not under review, and saying so is more useful than silently
  // watching something nothing else would have looked at.
  const outcome = await runReviewCycle(
    issueKey === null
      ? deps
      : {
          ...deps,
          fetchWatched: async () =>
            (await deps.fetchWatched()).filter((ticket) => ticket.key === issueKey),
        },
  );

  for (const ended of outcome.ended) {
    // §6.1's terminal, through the same function `--advance` uses — a metric encoded twice is a
    // metric that will eventually be encoded two ways.
    await moveLabels(client, ended.issueKey, (labels) =>
      isTerminal(labels)
        ? labelEdit([], [])
        : completionTransition(labels, completionLabelFor(ended.state)),
    );
  }

  for (const entry of [...outcome.acted, ...outcome.settled]) {
    await moveReviewStage(client, entry.issueKey, reviewStageAfter(entry.outcome));
  }

  return outcome;
}

/**
 * `--watch`: keep looking at every pull request under review.
 *
 * Different from `--review`, not longer: that chain polls one pull request until it's done or
 * quiet, this one re-reads the query every tick, so a pull request opened elsewhere joins the
 * set without a restart. That's why no silence bound applies here — one quiet pull request isn't
 * a reason to stop watching the other nineteen.
 *
 * Every bound already lives in the remote system (`MAX_REVIEW_ITERATIONS`, `MAX_PR_ROUNDS_TOTAL`
 * on the marker, the label pair deciding the query). This function adds
 * `MAX_REVIEW_ROUNDS_PER_TICK` and prints the worst-case cost per tick up front, since the
 * operator is the last bound and can't act on a number not shown.
 *
 * Ends when the watched set is empty; every other ending is the operator's Ctrl-C, safe since
 * the checkout is removed after each round and nothing is held between ticks.
 */
export async function runWatch(
  settings: Settings,
  client: JiraClient,
  issueKey: string | null,
): Promise<void> {
  const pollMs = numeric(settings, "REVIEW_POLL_MS", 1);
  const maxRounds = numeric(settings, "MAX_REVIEW_ROUNDS_PER_TICK", 0);

  // Said here as well as inside the cycle, deliberately: `runReviewCycle` returns an empty
  // outcome when the switch is off, so without this an off switch reads as "nothing under
  // review" — true about a query that was never run.
  if (!flag(settings, "SOLVE_ENABLED")) {
    process.stderr.write(
      `refusing --watch: SOLVE_ENABLED is off, so nothing would be looked at and the loop would exit at once.\n`,
    );
    // Logged as well as printed: the caller logs `solve-once.done` whatever happened, so the
    // exit code is the only other trace of a refusal.
    logger.warn("solve.watch.refused", { reason: "SOLVE_ENABLED is off" });
    process.exitCode = 3;
    return;
  }

  process.stdout.write(
    `\n── review watch ──────────────────────────────────────────\n` +
      `${issueKey === null ? "Every ticket under review" : issueKey}, looked at every ` +
      `${String(Math.round(pollMs / 1000))}s.\n` +
      `A look costs two gh reads; only a round costs money. At most ${String(maxRounds)} ` +
      `round${maxRounds === 1 ? "" : "s"} per pass, roughly ` +
      `$${(maxRounds * REVIEW_ROUND_USD).toFixed(2)}.\n` +
      `Ctrl-C is safe: the checkout is removed after each round and nothing is held between passes.\n\n`,
  );

  // Before the loop, so a missing `VAULT_PATH` is one message rather than a refusal repeated
  // every two minutes. See `runReviewSweep`.
  const runDeps = createSolveRunDeps(settings);

  for (let pass = 1; ; pass += 1) {
    const outcome = await runReviewSweep(settings, client, runDeps, issueKey);

    if (outcome.watched === 0) {
      process.stdout.write(
        `\nNothing is under review${issueKey === null ? "" : ` for ${issueKey}`}. Watch finished.\n`,
      );
      return;
    }

    process.stdout.write(`\n${describeReviewSweep(pass, outcome)}\n`);
    await sleep(pollMs);
  }
}

/**
 * The write rungs, in order, with the release as the last thing that happens.
 *
 * `try`/`finally` rather than a release at each exit: the rungs can set an exit code and return,
 * `runSolver` can throw, and a claim left behind by either is a ticket nobody can pick up again.
 * A pull request that exists must not be released, so that's a flag rather than an early return.
 */
export async function runWriteRungs(
  settings: Settings,
  client: JiraClient,
  issueKey: string,
  phase: SolvePhase,
  cycle: SolveCycleOutcome | null,
  authority: ClaimAuthority,
): Promise<void> {
  const receipt = await runClaim(client, issueKey, authority);
  if (receipt === null) {
    return;
  }

  let keepClaim = false;
  let terminal: SolveOutcomeLabel | null = null;
  try {
    if (!includes(phase, "solve")) {
      // The `--claim` rehearsal, performed rather than described: with the claim in place the
      // queue must no longer offer this ticket, and running the check here means it can't be
      // forgotten.
      const again = await runSolveCycle(createSolveDeps(settings, client));
      const stillOffered = again.planned.some((candidate) => candidate.issueKey === issueKey);
      process.stdout.write(
        stillOffered
          ? `\nThe queue STILL offers ${issueKey} while it is claimed — the claim is not deduplicating.\n`
          : `\nThe queue no longer offers ${issueKey} while it is claimed, which is the dedupe working.\n`,
      );
      if (stillOffered) {
        process.exitCode = 1;
      }
      return;
    }

    const outcome = await runSolver(settings, client, issueKey, cycle);
    // Read before the early return: the outcomes that decide a ticket's fate are exactly the
    // ones that never reach a pull request.
    terminal = outcome === null ? null : terminalLabelAfter(outcome);
    if (outcome === null || !includes(phase, "pr") || outcome.kind !== "verified") {
      return;
    }

    keepClaim = await runPublish(settings, outcome, issueKey);
    if (keepClaim) {
      // Handed in here rather than released: `runRelease` restores the labels this run found,
      // including `agent:start`, which would put a solved ticket back in the queue with a
      // human's go-ahead still on it. `keepClaim` means "do not release, and move on instead of
      // sitting on a claim no longer needed" — `agent:solving` is a concurrency slot, and that
      // work is finished the moment the pull request exists.
      await moveLabels(client, issueKey, reviewTransition);

      // Runs here rather than after `finally`: the chain must only start on a run that actually
      // opened a pull request, and `keepClaim` is exactly that fact.
      if (includes(phase, "review")) {
        await runReviewChain(settings, client, issueKey);
      }
    }
  } finally {
    // Three endings: a run that reached a verdict about the ticket must not be released —
    // `runRelease` would restore `agent:solvable` among other labels, leaving a declined ticket
    // looking untried, so auto mode would re-claim and re-refuse it every tick. See
    // `terminalLabelAfter`.
    const decided = terminal;
    if (keepClaim) {
      // Handed on by `reviewTransition` above; the pull request owns it now.
    } else if (decided === null) {
      await runRelease(client, receipt);
    } else {
      await moveLabels(client, issueKey, (labels) => completionTransition(labels, decided));
      process.stdout.write(
        `\n${issueKey} is out of the solve queue until a human removes agent:${decided}.\n` +
          `That is the point: this run reached a verdict, and re-running it would reach the same one.\n`,
      );
    }
  }
}

/**
 * The claim half of a daemon tick: read the queue, and start what it offers.
 *
 * Calls `runWriteRungs` rather than reimplementing the order — claim, solve, publish, hand on
 * the claim, release on every other path — since a second copy of that order in a loop nobody
 * watches is the copy that stops agreeing the day one of them changes.
 *
 * Three bounds: `runSolveCycle` caps `planned` at `MAX_CONCURRENT_SOLVES`, counted from the
 * claim label so a second instance or a `solve:once` run alongside this one is counted too. The
 * queue itself is the second — `manual` mode asks for `agent:start`. `ledger` is the new one:
 * outcomes that write no terminal label release the ticket exactly as found, so without a count
 * the queue re-offers a failing ticket every tick forever.
 *
 * The exit code is read and thrown away deliberately: the rungs set `process.exitCode` for a
 * command's `$?`, but a daemon's exit status answers a different question — did the service stop
 * cleanly — so it is captured per ticket, reported as a field, and reset.
 */
export async function runSolveClaims(
  settings: Settings,
  queueDeps: SolveDeps,
  client: JiraClient,
  ledger: AttemptLedger,
): Promise<{ readonly found: number; readonly started: number; readonly held: number }> {
  const cycle = await runSolveCycle(queueDeps);
  const authority = queueDeps.mode;

  let started = 0;
  let held = 0;

  for (const candidate of cycle.planned) {
    // Checked between tickets as well as before the sweep: a solve is minutes long, and a stop
    // arriving mid-sweep must not be answered by starting another.
    if (queueDeps.signal?.aborted === true) {
      break;
    }

    const key = candidate.issueKey;
    if (ledger.exhausted(key)) {
      held += 1;
      continue;
    }

    // Before the claim, not after the outcome: a run that crashes on its way to a verdict has
    // still spent an attempt, and a counter written afterwards hands back a free one exactly
    // when the expensive path is what broke.
    ledger.attempted(key);

    const before = process.exitCode;
    try {
      await runWriteRungs(settings, client, key, "pr", cycle, authority);
      started += 1;
    } catch (error) {
      // One ticket's failure is not the tick's — `runWriteRungs` releases in a `finally`, so the
      // claim is already back; abandoning the rest of the queue here would hide them behind it.
      logger.error("solve.claim.failed", {
        key,
        attempt: ledger.countFor(key),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const code = process.exitCode;
      process.exitCode = before;
      if (code !== before) {
        logger.info("solve.claim.exit_code", {
          key,
          code,
          note: "the rungs' code, recorded rather than adopted: it is a command's answer, not a service's",
        });
      }
    }
  }

  logger.info(
    "solve.claims.done",
    {
      found: cycle.found,
      inFlight: cycle.inFlight,
      capacity: cycle.capacity,
      planned: cycle.planned.length,
      started,
      held,
      deferred: cycle.deferred.length,
      remembered: ledger.size(),
    },
    // An empty queue is the resting state, and so is a full one nothing could be claimed from —
    // what's news is a ticket started, or one held back after the queue picked it.
    { quiet: started === 0 && held === 0 },
  );

  return { found: cycle.found, started, held };
}
