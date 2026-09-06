/**
 * The write rungs of the ladder, as functions rather than as a script.
 *
 * These four steps — claim, solve, publish, release — used to live in
 * `solve-once.ts`. They moved here the moment a second command needed them, and
 * the reason is mechanical rather than stylistic: `solve-once.ts` calls `main()`
 * at module scope, so importing anything from it starts a run. That is the same
 * hazard `solve-args.ts`'s header records, and the same answer.
 *
 * What the split makes visible is worth more than the reuse. A command file is
 * now argument parsing, configuration and a call into here; everything that
 * writes to Jira, to a worktree or to GitHub is in one module that no CLI owns.
 * A reviewer asking "what can this service change from a terminal" reads this
 * file, rather than two entry points that had already begun to drift apart.
 *
 * ## Authority is a parameter, not a setting read here
 *
 * `runClaim` takes a `ClaimAuthority` and does not consult `SOLVE_MODE`. The
 * queue-driven command passes `solveMode(settings)`; the singleton command
 * passes `"named"`; the daemon passes `queueDeps.mode`, which is the same value
 * the queue it just read was built from — one reading of the setting per tick
 * rather than two, so the query and the claim cannot disagree about the mode. Reading the setting in here would have meant the singleton
 * command could not say what it means without also changing the operator's
 * configuration — and a caller that cannot express its own authority ends up
 * editing `.env` to get a run through, which is the worst possible place for
 * that decision to be recorded.
 *
 * ## `cycle` is nullable, and that is the queue being optional
 *
 * A queue cycle is a JQL round trip whose only contribution to a named-ticket
 * run is a line of commentary and, at the `--claim` rung, the dedupe check. The
 * singleton command has no queue to consult and passes `null`. The line then
 * says the queue was not consulted, rather than reporting the ticket as absent
 * from it — two different facts that a single boolean had made into one string.
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
import {
  type Worktree,
  type WorktreeResult,
  attachWorktree,
  branchNameFor,
  removeWorktree,
} from "../solve/worktree.ts";
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
 * Three outcomes and not two. "Not in the queue" is a fact about the board — the
 * ticket is missing a label, or somebody else has claimed it — and is worth
 * overriding out loud. "No queue was consulted" is a fact about the command, and
 * reporting it as the first would tell an operator their labels were wrong when
 * nothing had looked at them.
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
 * `NotSolvableError` is caught and every other error is rethrown, and the
 * difference is the whole reason this is not a bare `try`. "This ticket names a
 * repository the operator has not allowed" is an answer, and the operator's
 * fix is to widen `SOLVE_REPOS` or leave the ticket alone; anything else
 * reaching here is a fault, and swallowing it would report a misconfigured
 * service as a ticket problem.
 *
 * `rung` is the flag being refused, and it is a parameter because both callers
 * ask the same question about a different privilege — an operator told
 * "refusing --solve" after typing `--advance` would go looking in the wrong
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
 * Everything it does to code is confined to a temporary worktree: it does not
 * push and does not open anything. The claim label is already written by the
 * time this is called — that is the rung below — so "writes nothing to Jira" is
 * true of this function and no longer true of the command.
 *
 * Returns the outcome so the rung above can decide whether there is anything to
 * publish. `null` means the request could not be built, which has already been
 * reported and is not a solve failure.
 *
 * The queue's own opinion is printed but not enforced. An operator who typed a
 * key has already made the decision the queue would make, and refusing a ticket
 * for want of a label would make the solver untestable from the command line.
 * What is enforced is `SOLVE_REPOS`, in `buildSolveRequest`, because that one is
 * not about workflow — it is the answer to which repository may be written to.
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

  // `solveWithRetry`, not `solveTicket`, and the difference only ever shows on
  // one outcome: a fix pass stopped by the *machine* rather than by the code
  // gets one clean rerun. Everything else is passed through untouched, so this
  // is the same command it was on every other path.
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
    // Said out loud rather than logged. "Abandoned on an environment cause"
    // means something different depending on whether a retry was even
    // attempted, and the operator is the one who has to know which.
    process.stdout.write(`A retry was warranted and did not happen: ${retryBlocked}\n`);
  }

  // The calibration row, and the reason this call is here rather than left for
  // a later phase. Triage makes the `agent:solvable` call **without reading a
  // line of source**; recon is the first thing that opens the repository, so
  // its `devLensAccurate` reading is the only feedback that assessment ever
  // gets. `feedback.ts` was written to accumulate exactly that and was wired to
  // nothing, so the first run ever to reach `verified` reported
  // `devLensAccurate: false` — triage's lens was wrong, the single most useful
  // thing the pipeline had produced — and the process exited and lost it.
  //
  // **Every outcome but `verified` is said out loud on the ticket**, and the
  // gate is `reportsToTicket` rather than `terminalLabelAfter`. Those were one
  // predicate until 2026-09-05, and the comment here argued the fusion was the
  // point — "the label and the comment are one statement". It was wrong in a way
  // that could only ever show up as an absence: the outcomes that write no label
  // are exactly the ones that then said nothing, so a run that claimed a ticket,
  // cut a worktree, verified the base and was stopped by a policy hook released
  // every label and left a board identical to one nobody had touched. See
  // `reportsToTicket` for the run that demonstrated it.
  //
  // The narrowness is still right for the label and still wrong for the reader.
  // A `crashed`, `unusable-base` or `environment` outcome must not be labelled,
  // because re-running it is sensible; it must still be reported, because "this
  // is about the machine, not your ticket" is worth more to a team than a gap
  // they cannot distinguish from the tool being switched off. `feedback.ts`
  // already phrases all three that way and its tests already pin the wording, so
  // the bodies needed no change — only the gate withheld them.
  //
  // **This line is not mutation-covered, and that was measured rather than
  // assumed.** Putting `terminalLabelAfter` back here leaves all 1805 tests
  // green, because there is no `solve-run.test.ts` and nothing constructs this
  // function's dependencies. The predicate itself is covered nine ways over in
  // `solve-outcome.test.ts`; what is uncovered is the choice of predicate at the
  // only place it is made, which is the half that actually silenced SSX-3832.
  // Recorded here rather than fixed, because a harness for this function is a
  // larger change than the feature it would guard — but it is a gap in the house
  // rule, not an exemption from it.
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

  // Which outcomes count, and why, is `isFailureExit` — kept there rather than
  // here so it can be tested without spawning this command.
  if (isFailureExit(outcome)) {
    process.exitCode = 1;
  }

  return outcome;
}

/**
 * Moves a ticket's `agent:` labels, and says plainly when it could not.
 *
 * Every caller is *after the fact*. The pull request is already open, or the
 * round has already pushed and replied; this is the board catching up with
 * something that has happened on GitHub. So nothing here sets an exit code and
 * nothing throws — the run succeeded, and turning a bookkeeping failure into a
 * command failure would tell an operator the wrong thing about the work.
 *
 * What it does instead is report the exact repair, because a label this service
 * failed to write is a label a person now has to write. The failure directions
 * are both survivable and worth knowing:
 *
 * - **A failed `reviewTransition` leaves `agent:solving` on.** The ticket keeps
 *   holding its concurrency slot, which stalls the queue and is visible; it does
 *   not become claimable twice, which would not be.
 * - **A failed stage move leaves the old stage on.** Both stages are excluded
 *   from the queue, so the only cost is a ticket that disagrees with its own
 *   pull request about whether a human is wanted yet.
 *
 * `LabelStateError` is caught rather than propagated for one specific reason:
 * `reviewStageTransition` throws when the ticket is under review in neither
 * sense, which is not a fault. It is a person having moved the ticket while the
 * round ran, and the correct response to that is to leave their decision alone
 * and report it.
 *
 * The read-back is not the claim's read-back-and-verify and does not need to be.
 * `updateLabels` sends one atomic REST call carrying both the additions and the
 * removals, so there is no window between them to lose a label in. This confirms
 * the write landed at all.
 *
 * **Every outcome is logged rather than printed, and the last one is why.** Three
 * of these four are failures a person would read once; the fourth fires on every
 * successful move, and since Phase E one of the callers is the daemon, whose
 * stdout *is* its log. A prose line there is a line no reader can parse, emitted
 * on the happy path, in the stream somebody would go to when the board and the
 * pull requests disagree. The repair instructions are in the `note` field.
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
 * `null` means do not proceed, and the three ways of getting there are not the
 * same event:
 *
 * - **refused** — the board moved between the queue reading it and this reading
 *   it. Nothing was written and nothing is wrong; exit 3, the same code the
 *   other "you asked for something I will not do" paths use.
 * - **unverified** — the write landed and could not be confirmed. This is the
 *   dangerous one, so it prints the restore point to stderr. The result carries
 *   no receipt precisely so that this branch cannot mechanically undo a write it
 *   does not understand; a person has to look.
 * - a thrown `ClaimWriteError` is not caught here. It reaches `withConfigErrors`
 *   with its own restore point attached, which is the right handling for a fault.
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
 * Never throws for a refusal: this runs on the way out of a run that has often
 * already failed, and turning "the claim was gone before I could undo it" into
 * an exception would replace the operator's real error with a bookkeeping one.
 * It does not set an exit code for the same reason — the outcome of the run is
 * the outcome of the run.
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
 * Returns whether the pull request exists, because that answer decides whether
 * the claim is released on the way out. `published-unreviewed` counts as yes:
 * the branch is public and a pull request is open, so releasing the claim would
 * put a solved ticket back in the queue for a second solver to duplicate. The
 * missing reviewer is a `gh pr edit` away and is reported as such.
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
 * ## It rebuilds the worktree rather than remembering one
 *
 * There is no resume in this harness — every invocation starts from nothing —
 * and this is the first command that needs a checkout it did not create. The
 * two ways out were to start recording worktrees on disk, or to cut a fresh one
 * from the branch the pull request is on. It cuts a fresh one: the queue's whole
 * dedupe design keeps state in the remote system rather than in `state/`, and a
 * worktree registry would be the first thing to break after a restart, a wiped
 * temp directory, or a second host. The cost is a fetch and a checkout per
 * round, which is nothing next to the passes that follow.
 *
 * The worktree is removed on the way out for the same reason it is rebuilt on
 * the way in: `git worktree add -b` refuses when the branch or the path already
 * exists, so a round that left its checkout behind would make the next round
 * impossible. It is kept only when there is a diff a human would want to read.
 *
 * ## The branch name comes from the ticket, and the pull request is looked up
 *
 * Not the other way around. `branchNameFor` is the same function the solver used
 * to create the branch, so asking it again reproduces the name without trusting
 * anything GitHub says about it — and `attachWorktree` still refuses any name
 * that is not an implementation branch, because that guard protects the standing
 * rule rather than this call site's assumptions.
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
    // Reported and not an error. A merged pull request is the happy ending, and
    // a closed one is a person's decision; neither is something to push to.
    process.stdout.write(
      `\n#${String(found.number)} on ${branch} is ${found.state}. Nothing to advance.\n`,
    );
    // §6.1's terminal, and it had to land in the same change as the label move
    // rather than after it. Until D4 this branch printed the line above and
    // stopped, which was survivable because the ticket still carried
    // `agent:solving` and the publish step said out loud that a person had to
    // move it on. Both of those are now gone: the ticket sits in
    // `agent:review-done`, excluded from the queue, with nothing left that would
    // ever clear it. Shipping the label move without this would not be an
    // unfinished feature, it would be a leak.
    //
    // **`MERGED` and `CLOSED` do not share a label**, for the reason `AGENT_LABELS`
    // gives: `agent:done` is the count of bugs this tool fixed, and a pull request
    // a person closed unmerged is work the tool completed that nobody wanted. That
    // is a different number and an interesting one, and it disappears the moment
    // the two are folded together — a distinction drawn in a comment is a
    // distinction no report can read.
    await moveLabels(client, issueKey, (labels) =>
      isTerminal(labels)
        ? labelEdit([], [])
        : completionTransition(labels, completionLabelFor(endedState(found.state))),
    );
    return null;
  }

  // Held outside the callback so the cleanup below can see whether one was ever
  // cut. `null` here is the ordinary case on a quiet pull request and is not a
  // failure: `advance` decides there is nothing to answer and never calls the
  // source, so there is no checkout, no install, and nothing to remove.
  let worktree: Worktree | null = null;
  const attach = async (): Promise<WorktreeResult> => {
    const attached = await attachWorktree(deps.commands, {
      issueKey,
      branch,
      repoPath: base.repoPath,
      parentDirectory: base.parentDirectory,
      timeoutMs: base.gitTimeoutMs,
    });
    if (attached.outcome === "created") {
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

  // Before the worktree is cleaned up, so a failure here is reported next to the
  // round it belongs to rather than after a paragraph about directories. The
  // stage is `null` for every outcome that left the draft flag alone, which is
  // most of them, and then this is one read and no write.
  await moveReviewStage(client, issueKey, reviewStageAfter(result));

  // Kept when a human would want the diff — a refusal is a diff that was judged
  // too large or too wide, and reading it is how an operator decides whether the
  // gate or the pass was wrong. Everything else either pushed its work or wrote
  // nothing, so the checkout is a copy of the remote and holds no evidence.
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
 * **This called `.unref()` until 2026-09-05, and it made `--review` incapable of
 * waiting.** An unref'd timer does not hold the event loop open, so the first
 * time the chain found the reviewer silent and settled in to poll, Node saw
 * nothing left to do and exited — `Detected unsettled top-level await at
 * solve-once.ts:167`, exit code 13. The whole of D4d is one loop that waits, and
 * the one line that does the waiting had opted out of it. Observed on SSX-3789:
 * claim, solve, push, pull request #2660, `agent:reviewing`, then death 120ms
 * into a 120s wait.
 *
 * The argument for the unref was Ctrl-C, and it was never true. SIGINT
 * terminates the process whatever timers are pending; a `setTimeout` does not
 * queue ahead of a signal. So the unref bought nothing and cost the feature.
 *
 * The banner `runReviewChain` prints one line above the first call still says
 * *"Ctrl-C is safe: nothing is held open between rounds"*, and that sentence
 * stays, because it was describing the right thing for the wrong reason: what
 * makes an interrupt safe here is that the worktree is removed and no lock is
 * held between rounds, not that a timer was unref'd. This project's defect class
 * again — prose that happened to be true of the behaviour it was not describing.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `--review`: rounds against the reviewer until something ends it.
 *
 * The only unattended loop in this service, and the capability that Phase E is
 * otherwise defined by. It is here rather than in the daemon because the plan's
 * ordering rule is that every phase is driven by hand before the loop drives it
 * — and there was no way to drive *this* by hand, because the thing to drive is
 * the looping. One ticket, named by a person, in the foreground, with the output
 * on their terminal is the weakest form of the capability that still tests it.
 *
 * ## Four bounds, and only one of them is new
 *
 * `MAX_PR_ROUNDS_TOTAL` and `MAX_REVIEW_ITERATIONS` are enforced inside
 * `advance` against the marker on the pull request, so they bound this loop
 * without it doing anything — and they keep bounding it across restarts, which a
 * counter in this function would not. Every non-continuing outcome ends it, via
 * `chainDecision`. What is new is `REVIEW_SILENCE_MS`, because the other three
 * are all counts of *rounds* and the failure this loop adds is a reviewer who
 * never produces one.
 *
 * **That fourth bound is not counted here, and it used to be.** `MAX_REVIEW_WAITS`
 * was a `let silences` on this stack: the only bound in the service that did not
 * live in the remote system, and one whose length changed whenever the poll
 * interval did. `silence.ts` sets out the whole argument. What is left in this
 * function is a number read from settings and handed to `chainDecision`, so the
 * loop no longer has any memory of its own.
 *
 * ## It reports before it spends, because the operator is the fifth bound
 *
 * The worst case is printed up front in money. That is not decoration: a person
 * who typed `--review` on a whim can read the number and Ctrl-C before the first
 * round, and this is the only phase where the cost is a product rather than a
 * sum. Round cost is the measured $0.94 from PR #2658.
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
      // `runAdvance` reached no round and has already said why — no pull
      // request, not open, no worktree. It also set the exit code if that was
      // an error, so there is nothing to add and nothing to retry.
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
      // A chain that ends on silence is warned rather than informed, and it is
      // the one ending nobody asked for: every other stop is a decision
      // somebody made. It is still not an error exit — a quiet reviewer is not
      // a malfunction, and a non-zero code would teach a future daemon's
      // backoff to treat "nobody has looked yet" as an outage worth retrying
      // harder.
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
 * Everything a round needs, carried from the look that found it to the act that
 * pays for it.
 *
 * The cycle calls `look` and `act` as two separate functions, so the work the
 * look already did — the ticket read, the request, the repository — has to live
 * somewhere between them. It is held in a map keyed by issue key rather than
 * threaded through `ReviewLook`, because the cycle has no use for it and a type
 * carrying a `SolveRequest` it never reads would invite a future round to use
 * the cycle's copy instead of the caller's.
 */
interface ReviewTarget {
  readonly request: AdvanceRequest;
  /** Set by `request.attach`, read by the cleanup after the round. */
  readonly holder: { worktree: Worktree | null };
}

/**
 * The cheap half, for one watched ticket.
 *
 * Every read here names its own repository, so none of them need a checkout —
 * that is the property `surveyReview` was split out to expose and the whole
 * reason a loop over the watched set is affordable. A ticket whose pull request
 * nobody has touched costs one Jira read and two `gh` reads and stops.
 *
 * **It throws rather than reporting most failures, and that is deliberate.** The
 * cycle catches a rejected look, records the ticket and its reason, and carries
 * on to the rest of the set. Returning a fourth "something went wrong" arm would
 * make every call site of `ReviewLook` handle a case the cycle already handles
 * once, and the one behaviour that matters — nineteen healthy pull requests do
 * not lose their tick to the twentieth — is the same either way.
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
    // Throws `NotSolvableError` for a ticket naming a repository the operator
    // has not allowed. Not caught here: it is a real answer about one ticket and
    // the cycle records it as such, where `--advance` prints it and sets an exit
    // code because there a person is waiting on that one ticket.
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
    const attach = async (): Promise<WorktreeResult> => {
      const attached = await attachWorktree(deps.commands, {
        issueKey: ticket.key,
        branch,
        repoPath: base.repoPath,
        parentDirectory: base.parentDirectory,
        timeoutMs: base.gitTimeoutMs,
      });
      if (attached.outcome === "created") {
        holder.worktree = attached.worktree;
      }
      return attached;
    };

    // Built here and reused by `act` rather than rebuilt there. The round has to
    // run against the same numbers the survey decided on — a `MAX_REVIEW_ITERATIONS`
    // read twice could differ across a long tick, and the marker would then
    // record a round the survey never authorised.
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
 * This is `advance`'s tail, and it is spelled out here rather than by calling
 * `advance` because `advance` would survey again. A second survey between the
 * look and the round is not merely wasted: it would read a comment posted in the
 * intervening seconds and run against a batch the cycle's bound never counted.
 */
function createReviewAct(
  deps: SolveDependencies,
  targets: Map<string, ReviewTarget>,
): (ticket: WatchedTicket, pending: PendingRound, number: number) => Promise<AdvanceOutcome> {
  return async (ticket, pending, number) => {
    const target = targets.get(ticket.key);
    if (target === undefined) {
      // Unreachable through the cycle, which only acts on a ticket it looked at.
      // Thrown rather than defaulted because the alternative is inventing a
      // request and spending money against it.
      throw new Error(`no prepared round for ${ticket.key}`);
    }

    // Logged rather than printed, because this function now has two callers and
    // one of them is a daemon whose stdout *is* the log. A prose line there is a
    // line no reader can parse, in the stream an operator would go to when the
    // spend looks wrong — and "a round started, on this ticket, on this pull
    // request" is what a log line is for. The watch sees it too, as JSON among
    // the pass's own JSON, which is what that command already looks like while a
    // round is running.
    logger.info("review.round.started", { issueKey: ticket.key, number });

    const attached = await target.request.attach();
    if (attached.outcome === "refused") {
      // Nothing has been reserved — the reservation is on the far side of the
      // checkout — so the next tick will decide the same thing again, which is
      // right for a checkout that failed for a local reason.
      return { kind: "failed", stage: "worktree", reason: attached.reason };
    }

    const result = await runRound(deps, target.request, attached.worktree, pending);

    if (target.holder.worktree !== null) {
      // Kept only for a refusal, where the diff is the evidence an operator
      // needs to decide whether the gate or the pass was wrong. Everything else
      // either pushed its work or wrote nothing.
      await removeWorktree(
        deps.commands,
        target.holder.worktree,
        result.kind === "refused" ? "keep-as-evidence" : "discard",
        target.request.gitTimeoutMs,
      );
    }

    return result;
  };
}

/**
 * One pass over the watched set, with the label writes the cycle refuses to make.
 *
 * `runReviewCycle` reads and decides and writes nothing, exactly as
 * `runSolveCycle` does, so the three label transitions live here: the terminal
 * for a pull request that ended, and the draft-flag mirror for everything that
 * reached an answer. That split is not tidiness — a write is a visible change to
 * an interface a reviewer would look at, and it should be findable at a call
 * site rather than buried in a loop body.
 *
 * **`runDeps` is a parameter and not built here, which it used to be.** It is a
 * command runner and a pass runner, so sharing one across passes saves nothing
 * worth naming; what it saves is a `SettingsError`. `createSolveRunDeps` throws
 * on a missing `VAULT_PATH`, and both callers are loops — a sweep that built its
 * own would turn one misconfiguration into a failure on every tick, forever,
 * where the loop above it can only see "the cycle threw" and back off. Built by
 * the caller before its loop starts, the same mistake is one message at startup.
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

  // Narrowed after the query rather than by a different one. The subscription is
  // the pair of labels, so a named ticket that is not carrying one is not under
  // review — and saying "it is not in the watched set" is a more useful answer
  // than silently watching something nothing else would have looked at.
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
    // §6.1's terminal, through the same function `--advance` uses. The rule that
    // only a merge earns `agent:done` is a metric, and a metric encoded twice is
    // a metric that will eventually be encoded two ways.
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
 * ## Why this is a different loop from `--review`, and not a longer one
 *
 * `runReviewChain` polls one pull request it just opened, and stops when that
 * pull request is done or has gone quiet. Its subject is a run. This one's
 * subject is *the board*: it re-reads the query every tick, so a pull request
 * another run opened five minutes ago joins the set without anything being
 * restarted, and one that merged leaves it. That is the difference between
 * finishing a job and holding a post, and it is why the silence bound does not
 * appear here — one quiet pull request is not a reason to stop watching the
 * other nineteen.
 *
 * ## What bounds it
 *
 * Not a round count on this stack, which is the mistake `silence.ts` sets out.
 * Every bound it has already lives in the remote system: `MAX_REVIEW_ITERATIONS`
 * and `MAX_PR_ROUNDS_TOTAL` on each pull request's marker, and the pair of labels
 * that decides whether a ticket is in the query at all. What this function adds
 * is `MAX_REVIEW_ROUNDS_PER_TICK`, and the banner prints what a tick can cost
 * before the first one runs, for the reason `--review` prints its own worst case:
 * the operator is the last bound, and a bound cannot act on a number it has not
 * been shown.
 *
 * It ends when the watched set is empty. That is the honest terminal for a
 * command whose subject is a set — there is nothing under review — and every
 * other ending is the operator's Ctrl-C, which is safe here for the same reason
 * it is safe in the chain: the checkout is removed after each round and nothing
 * is held between ticks.
 */
export async function runWatch(
  settings: Settings,
  client: JiraClient,
  issueKey: string | null,
): Promise<void> {
  const pollMs = numeric(settings, "REVIEW_POLL_MS", 1);
  const maxRounds = numeric(settings, "MAX_REVIEW_ROUNDS_PER_TICK", 0);

  // Said here as well as inside the cycle, and the duplication is the point.
  // `runReviewCycle` returns an empty outcome when the switch is off, and this
  // loop's terminal is an empty watched set — so without this, `SOLVE_ENABLED=false`
  // prints "Nothing is under review" and exits. That is a true sentence about a
  // query that was never run, which is this project's whole defect class: the
  // operator would go looking at labels for a fault that is in their `.env`.
  if (!flag(settings, "SOLVE_ENABLED")) {
    process.stderr.write(
      `refusing --watch: SOLVE_ENABLED is off, so nothing would be looked at and the loop would exit at once.\n`,
    );
    // Logged as well as printed, because the caller logs `solve-once.done`
    // whatever happened and the exit code is the only other trace. A refusal
    // that appears in a log only as a successful finish is the same divergence
    // the message above exists to prevent, one layer out.
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

  // Before the loop, so a missing `VAULT_PATH` is one message rather than a
  // refusal repeated every two minutes. See `runReviewSweep`.
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
 * `try`/`finally` rather than a release at each exit: the rungs below can set an
 * exit code and return, `runSolver` can throw, and a claim left behind by either
 * is a ticket nobody can pick up again. The one case that must *not* release is
 * a pull request that exists, so that is a flag rather than an early return.
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
      // The `--claim` rehearsal, and the experiment the plan asks for, performed
      // rather than described: with the claim in place the queue must no longer
      // offer this ticket. Running it here means the check cannot be forgotten,
      // and it costs one query on a command that has already made a round trip.
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
    // Read before the early return, because the outcomes that decide a ticket's
    // fate are exactly the ones that never reach a pull request. Computing it
    // after the `verified` narrowing below would be dead code that looked live.
    terminal = outcome === null ? null : terminalLabelAfter(outcome);
    if (outcome === null || !includes(phase, "pr") || outcome.kind !== "verified") {
      return;
    }

    keepClaim = await runPublish(settings, outcome, issueKey);
    if (keepClaim) {
      // The claim is handed in here rather than released, and the difference
      // matters. `runRelease` restores the labels this run found — including the
      // `agent:start` the claim consumed — which is right for a run that
      // achieved nothing and wrong for one that left a pull request open: it
      // would put the ticket back in the queue with a human's go-ahead still on
      // it, to be solved a second time.
      //
      // So `keepClaim` still means "do not release", and what it now also means
      // is that the ticket moves on instead of sitting on a claim it no longer
      // needs. `agent:solving` is a concurrency slot, and the work it was
      // counting is finished the moment the pull request exists.
      await moveLabels(client, issueKey, reviewTransition);

      // The fifth rung, and it runs here rather than after the `finally` for a
      // reason worth stating: the chain must only start on a run that actually
      // opened a pull request. `keepClaim` is that fact — it is set by
      // `runPublish` and is the same condition that moves the ticket to
      // `agent:reviewing`. Hanging the loop off the phase alone would start it
      // after a publish that failed, where it would find no pull request,
      // report so, and exit having looked expensive for no reason.
      if (includes(phase, "review")) {
        await runReviewChain(settings, client, issueKey);
      }
    }
  } finally {
    // Three endings, and the middle one used to be the only one. A run that
    // reached a verdict about the ticket must not be released: `runRelease`
    // restores the labels this run found, `agent:solvable` among them, which
    // leaves a declined ticket looking exactly like one nobody has tried. In
    // auto mode the queue then re-claims it every tick and pays for the same
    // refusal each time — see `terminalLabelAfter`.
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
 * ## It calls `runWriteRungs` rather than reimplementing the order
 *
 * Claim, solve, publish, hand on the claim, release on every other path — that
 * order is the whole of B2 through D1, and a second copy of it in a loop nobody
 * watches is the copy that stops agreeing on the day one of them changes. This
 * repository has found that defect five times and it has never once been in the
 * copy somebody was looking at. So the daemon climbs the same ladder the command
 * does, to the same rung, and differs only in what it may spend.
 *
 * ## Three bounds, and only one of them is new
 *
 * `runSolveCycle` already caps `planned` at the capacity left by
 * `MAX_CONCURRENT_SOLVES`, counted from the tickets carrying the claim label
 * rather than from anything this process remembers — so a second instance, or a
 * `solve:once` run alongside this one, is counted too.
 *
 * The queue itself is the second: in `manual` mode it asks for `agent:start`,
 * so the daemon can only ever pick up a ticket a person has said yes to.
 *
 * The new one is `ledger`, and `attempts.ts` has the argument. Briefly: the
 * outcomes that write no terminal label release the ticket exactly as they found
 * it, so without a count the queue re-offers a failing ticket every tick forever.
 *
 * ## The exit code is read and thrown away, deliberately
 *
 * The rungs set `process.exitCode` because they were written for a command,
 * where it answers *what should `$?` be*. A daemon's exit status answers a
 * different question — did the service stop cleanly — and letting one refused
 * diff gate at 3am decide it would make every later shutdown report a failure
 * that had already been logged, handled, and released. So it is captured per
 * ticket, reported as a field, and reset. Reset rather than ignored: leaving it
 * set means the *next* tick cannot tell its own failure from the last one's.
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
    // Checked between tickets as well as before the sweep: a solve is minutes
    // long, and a stop that arrived during one must not be answered by starting
    // another. The signal is the one `queueDeps` was built with, so there is no
    // second source of truth about whether this process is going away.
    if (queueDeps.signal?.aborted === true) {
      break;
    }

    const key = candidate.issueKey;
    if (ledger.exhausted(key)) {
      held += 1;
      continue;
    }

    // Before the claim, not after the outcome. The count is a reservation for
    // the same reason the re-triage counter is one: a run that crashes on its
    // way to a verdict has still spent an attempt, and a counter written
    // afterwards hands back a free one every time the expensive path is the
    // thing that broke.
    ledger.attempted(key);

    const before = process.exitCode;
    try {
      await runWriteRungs(settings, client, key, "pr", cycle, authority);
      started += 1;
    } catch (error) {
      // One ticket's failure is not the tick's. `runWriteRungs` releases in a
      // `finally`, so the claim is already back; abandoning the rest of the
      // queue here would hide them behind it and, in the loop above, back off
      // to the cap over a fault that belongs to one ticket.
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

  logger.info("solve.claims.done", {
    found: cycle.found,
    inFlight: cycle.inFlight,
    capacity: cycle.capacity,
    planned: cycle.planned.length,
    started,
    held,
    deferred: cycle.deferred.length,
    remembered: ledger.size(),
  });

  return { found: cycle.found, started, held };
}
