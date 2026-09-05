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
 * passes `"named"`. Reading the setting in here would have meant the singleton
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
import type { Settings } from "../settings.ts";
import { type ClaimReceipt, claimTicket, releaseClaim } from "../solve/claim.ts";
import { advance, publish } from "../solve/delivery.ts";
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
import { type SolveOutcome, type SolveRequest, solveWithRetry } from "../solve/orchestrator.ts";
import { type SolveCycleOutcome, runSolveCycle } from "../solve/poller.ts";
import { findPullRequest } from "../solve/pr.ts";
import { attachWorktree, branchNameFor, removeWorktree } from "../solve/worktree.ts";
import {
  NotSolvableError,
  buildAdvanceRequest,
  buildFindPrRequest,
  buildPublishRequest,
  buildSolveRequest,
  createClaimCapabilities,
  createSolveDeps,
  createSolveRunDeps,
  createTicketReader,
} from "../wiring.ts";
import { type SolvePhase, includes } from "./solve-args.ts";
import {
  describeAdvanceOutcome,
  describeSolveOutcome,
  isAdvanceFailureExit,
  isFailureExit,
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
  // **No commenter is passed, and that is the phase gate, not an oversight.**
  // `reportOutcome` posts only if given a `TicketCommenter`; with none it
  // writes the local record and says the comment was not posted. So this adds a
  // local artifact and no Jira write, which is the same posture as the rest of
  // the command.
  const feedback = await reportOutcome(
    { outputDirectory: settings.OUTPUT_DIR },
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
 * What it does instead is print the exact repair, because a label this service
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
      process.stdout.write(`\n${issueKey}'s labels were left alone: ${error.message}\n`);
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
    process.stderr.write(
      `\nCould not move ${issueKey}'s labels (${wanted}): ${error instanceof Error ? error.message : String(error)}\n` +
        `Do it by hand; the pull request is unaffected.\n`,
    );
    return;
  }

  const after = await capabilities.readLabels(issueKey);
  const missing = change.add.filter((label) => !after.includes(label));
  const lingering = change.remove.filter((label) => after.includes(label));
  if (missing.length > 0 || lingering.length > 0) {
    process.stderr.write(
      `\n${issueKey}'s labels did not come back as written (${wanted}); they are: ${after.join(", ")}\n` +
        `Fix them by hand — the queue reads these.\n`,
    );
    return;
  }

  process.stdout.write(`\n${issueKey} is now: ${after.join(", ")}\n`);
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
): Promise<void> {
  const read = createTicketReader(client);
  const { text, detail } = await read(issueKey);

  const base = requestOrRefusal(settings, detail, text, "--advance");
  if (base === null) {
    return;
  }

  const branch = branchNameFor(issueKey, detail.summary);
  if (branch === null) {
    process.stderr.write(
      `refusing --advance: ${issueKey}'s summary yields no usable branch name, so there is nothing to look for.\n`,
    );
    process.exitCode = 3;
    return;
  }

  const deps = createSolveRunDeps(settings);
  const found = await findPullRequest(deps.commands, buildFindPrRequest(settings, base, branch));

  if (found.outcome === "failed") {
    process.stderr.write(`\nCould not tell whether a pull request exists: ${found.reason}\n`);
    process.exitCode = 1;
    return;
  }
  if (found.outcome === "none") {
    process.stdout.write(
      `\nNo pull request on ${branch}. --advance acts on one that already exists; run --pr first.\n`,
    );
    process.exitCode = 3;
    return;
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
        : completionTransition(labels, found.state === "MERGED" ? "done" : "closed"),
    );
    return;
  }

  const attached = await attachWorktree(deps.commands, {
    issueKey,
    branch,
    repoPath: base.repoPath,
    parentDirectory: base.parentDirectory,
    timeoutMs: base.gitTimeoutMs,
  });
  if (attached.outcome === "refused") {
    process.stderr.write(`\nNo worktree, so no review round: ${attached.reason}\n`);
    process.exitCode = 1;
    return;
  }
  const { worktree } = attached;
  process.stdout.write(`\nAdvancing #${String(found.number)} in ${worktree.path}\n`);

  const result = await advance(deps, buildAdvanceRequest(settings, base, worktree, found.number));
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
