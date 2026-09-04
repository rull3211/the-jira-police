/**
 * The solve pipeline, end to end: one ticket in, a verified branch or a reason
 * out.
 *
 * Every module in `src/solve/` up to now answered one question well and knew
 * nothing about the others. This is the file that puts them in order, and its
 * whole job is sequencing and refusal — there is no new capability here, only
 * decisions about when to stop.
 *
 * ```
 *   worktree      cut from the pristine base, on an implementation branch
 *     ↓
 *   recon         read-only. may say no, and saying no is a success
 *     ↓
 *   fix           the only pass that may write the change
 *     ↓
 *   simplify      a cold read of the diff; usually changes nothing
 *     ↓
 *   diff gate     bounds what may have been touched, against the real diff
 *     ↓
 *   verify        install, typecheck, lint, test — exit codes, not opinions
 *     ↓
 *   verified      handed to the delivery half, which commits and opens a PR
 * ```
 *
 * ## Three shapes of "no", kept apart on purpose
 *
 * Collapsing these would make the reports useless, because they call for
 * different actions from different people:
 *
 *   - **bailed** — recon read the code and says an agent should not do this.
 *     The fitness call was wrong. Nothing was written. A human picks it up.
 *   - **failed** — the change was made and the tests say it is wrong. A fact
 *     about the code.
 *   - **refused** — the harness declines to have an opinion: the diff broke
 *     its bounds, or verification could not be trusted. Says nothing about
 *     whether the change was any good, and must never be reported as if it
 *     did.
 *
 * ## What this file deliberately does not do
 *
 * It does not touch Jira, and it takes no Jira client. The caller owns labels
 * and comments. That keeps the pipeline runnable by hand against one ticket
 * with nothing on the board changing, which is the phase order this project
 * committed to: every stage driven by a person before the daemon drives any.
 *
 * It also does not clean up after a failure. A failed worktree is kept so a
 * human can read the diff that did not work — `removeWorktree` enforces that
 * itself, and this file does not argue with it.
 */

import { logger } from "../logger.ts";
import { checkDiff, type DiffLimits, DEFAULT_LIMITS, parseNumstat } from "./diff-gate.ts";
import {
  type AbandonCause,
  type FixReport,
  type Pass,
  type ReconVerdict,
  type ReviewReport,
  type SimplifyReport,
  type SolveRunOptions,
  composeCommitMessage,
  type CommitMessage,
  parseFix,
  parseRecon,
  parseReview,
  parseSimplify,
} from "./runner.ts";
import { prepareSkillRoot, removeSkillRoot } from "./skill-root.ts";
import { verify, type VerificationResult } from "./verify.ts";
import {
  type CommandRunner,
  createWorktree,
  removeWorktree,
  type RemoveResult,
  type Worktree,
  type WorktreeRequest,
} from "./worktree.ts";

/**
 * One model pass, run to completion, parsed.
 *
 * Injected rather than imported so the whole pipeline is testable without
 * starting a model. The parse function is passed through because each pass
 * validates differently and a run that produces incoherent structured output
 * must fail at the point of parsing, not three stages later.
 */
export interface PassRunner {
  run: <T>(
    pass: Pass,
    options: SolveRunOptions,
    parse: (structuredOutput: unknown) => T,
  ) => Promise<T>;
}

export interface SolveDependencies {
  readonly commands: CommandRunner;
  readonly passes: PassRunner;
}

export interface SolveRequest {
  readonly issueKey: string;
  /** The ticket, rendered as text. Attacker-controlled; passed as data. */
  readonly ticket: string;
  /** The ticket summary, used only to build the branch name. */
  readonly summary: string;
  readonly repoPath: string;
  readonly parentDirectory: string;
  readonly baseRef: string;
  /** Branch prefix — `fix` for a bug, `feat` for a task. Never a protected name. */
  readonly branchPrefix?: string;
  readonly vaultPath?: string;
  readonly limits?: DiffLimits;
  readonly gitTimeoutMs: number;
  readonly stepTimeoutMs: number;
  readonly installTimeoutMs: number;
}

/**
 * What recon learned about triage's guess.
 *
 * Carried on every outcome that got past recon, and it is the reason this
 * field is on the result type rather than buried in the verdict: triage makes
 * the `agent:solvable` call **without reading any source**, and recon is the
 * first thing in the pipeline that does. Its correction is the only feedback
 * that assessment ever receives. Computing it and dropping it on the floor —
 * which is what happened before this existed — means the blind call never
 * gets any better.
 */
export interface DevLensFeedback {
  readonly accurate: boolean;
  readonly correction: string;
}

export type SolveOutcome =
  /** Never got as far as a session. */
  | { readonly kind: "no-worktree"; readonly reason: string }
  /**
   * Recon read the code and declined. Not a failure.
   *
   * The only outcome that cleans up after itself, and the reason is narrow:
   * recon is the one pass with no `Write` and no `Edit`, so a bailed run's
   * worktree is a pristine checkout that cost disk and holds nothing. Every
   * other outcome keeps its worktree because **nothing in this phase commits** —
   * `composeCommitMessage` composes a message that no `git commit` ever
   * consumes — so the worktree is the only copy of the work, and removing it
   * would be the destructive reading of "clean up on success".
   */
  | {
      readonly kind: "bailed";
      readonly reason: string;
      readonly recon: ReconVerdict;
      readonly devLens: DevLensFeedback;
      readonly worktree: Worktree;
      /** What became of the worktree. `kept` if git refused, with its reason. */
      readonly cleanup: RemoveResult;
    }
  /**
   * The fix pass stopped once it saw the files.
   *
   * `cause` is the whole point of this variant carrying more than a string.
   * `judgement` means the model read the code and declined — a verdict about
   * the ticket, and the correction triage's blind fitness call exists to
   * receive. `environment` means it was prevented from working, which is a
   * fact about this machine and says nothing whatever about the ticket.
   *
   * They are one kind rather than two because everything downstream of the
   * pipeline treats them identically — no commit, no push, keep the worktree —
   * and splitting the kind would force every exhaustive switch to handle a
   * distinction only two callers care about. The two that do are `feedback.ts`,
   * which must not score an environment failure as a misjudged ticket, and the
   * retry in `solveWithRetry`.
   */
  | {
      readonly kind: "abandoned";
      readonly reason: string;
      readonly cause: Exclude<AbandonCause, "none">;
      readonly devLens: DevLensFeedback;
      readonly worktree: Worktree;
    }
  /** The harness declines to have an opinion. Says nothing about the code. */
  | {
      readonly kind: "refused";
      readonly stage: "diff-gate" | "verification";
      readonly reasons: readonly string[];
      readonly devLens: DevLensFeedback;
      readonly worktree: Worktree;
    }
  /**
   * A pass died — timed out, or produced output the parser refused.
   *
   * **This is a refusal and must never be reported as a statement about the
   * code**, for the same reason `verify.ts` keeps `refused` apart from
   * `failed`: nothing was learned. It is a separate kind rather than another
   * `refused` stage so that every exhaustive switch has to be edited to admit
   * it, instead of a crash quietly arriving at a caller that thinks it is
   * looking at a diff-gate verdict.
   *
   * It carries no `devLens` because the pass that produces one may be the pass
   * that died.
   */
  | {
      readonly kind: "crashed";
      readonly pass: Pass;
      readonly reason: string;
      readonly worktree: Worktree;
    }
  /** A verification step ran and did not pass. A fact about the code. */
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly verification: VerificationResult;
      readonly devLens: DevLensFeedback;
      readonly worktree: Worktree;
    }
  /** Everything passed. The only outcome that may become a pull request. */
  | {
      readonly kind: "verified";
      readonly worktree: Worktree;
      readonly commit: CommitMessage;
      readonly recon: ReconVerdict;
      readonly fix: FixReport;
      readonly simplify: SimplifyReport;
      readonly verification: VerificationResult;
      readonly devLens: DevLensFeedback;
      readonly files: number;
      readonly lines: number;
    };

function lensOf(recon: ReconVerdict): DevLensFeedback {
  return { accurate: recon.devLensAccurate, correction: recon.devLensCorrection };
}

/**
 * The two reads of the worktree, and why they are two.
 *
 * These were one function called `realDiff`, whose output went both to the
 * diff gate and into the simplify pass's prompt. They need opposite things and
 * the single version served the gate, so the prompt got the gate's format:
 * `2\t0\0src/bootstrap.tsx\0`, fenced under a heading that said `BEGIN DIFF`.
 *
 * It surfaced on 2026-09-04 as a crash — `spawn` rejects a NUL in argv, so the
 * first real solve died at the simplify pass with `ERR_INVALID_ARG_VALUE`. The
 * crash was the lucky outcome. Drop the `-z` and it would have run: the model
 * would have been shown a table of line counts, told it was a patch, and asked
 * to simplify it. It would have found nothing to simplify, every time, and the
 * pass would have looked like it was working.
 *
 * So the split is not defensive tidying. A comment saying "given the diff" and
 * a call sending a numstat is the exact prose/behaviour divergence this project
 * exists to catch, and it was in the code that catches it.
 */

/**
 * The machine-readable read, for the gate.
 *
 * `--numstat -z`, and the `-z` is load-bearing: without it a filename
 * containing a newline — which git will happily accept and a ticket can
 * plausibly suggest — forges an extra numstat record and can push a real
 * change out of the gate's view. Documented at length in `diff-gate.ts`.
 *
 * Consequence of that same `-z`: this output contains NUL bytes and can
 * therefore never reach a prompt. `parseNumstat` is its only legitimate
 * consumer.
 */
async function readNumstat(
  runner: CommandRunner,
  worktreePath: string,
  baseRef: string,
  timeoutMs: number,
): Promise<string | null> {
  return await gitDiff(runner, worktreePath, timeoutMs, ["--numstat", "-z", baseRef]);
}

/**
 * The human-readable read, for a prompt.
 *
 * A real unified patch, which is what a pass asked to review the change needs
 * to see. No `-z`: there is nothing to parse here, the text goes to a model,
 * and the filename-with-a-newline attack that `-z` defends against is a threat
 * to the *gate's* accounting, not to a model reading prose.
 */
async function readPatch(
  runner: CommandRunner,
  worktreePath: string,
  baseRef: string,
  timeoutMs: number,
): Promise<string | null> {
  return await gitDiff(runner, worktreePath, timeoutMs, [baseRef]);
}

/**
 * Makes new files visible to `git diff`, and it is a security fix.
 *
 * `git diff <base>` reports tracked files only. A pass that *creates* a file
 * does not appear in it at all, so before this the gate bounded a change it
 * could not see: measured on the first real solve, it passed a five-file change
 * having read two files and four lines. The implementation, its test and a new
 * asset were all invisible.
 *
 * That is not a reporting inaccuracy, it is a hole through every categorical
 * refusal the gate makes. Each one — `.github/`, CI config, lockfiles, the
 * files that define what verification means — names a path that must not be
 * *touched*, and each was evadable by writing a new file rather than editing an
 * existing one. A fresh `.github/workflows/*.yml` would have passed the gate
 * and then run on push. The caps were equally hollow: fifty new files counted
 * as zero.
 *
 * `--intent-to-add` rather than a real `add`: it records the path in the index
 * and nothing else, so the content still shows as a pending change and the
 * worktree is left in the state a human inspecting it would expect.
 *
 * Ignored files stay invisible, which is correct — they are not part of the
 * change and cannot be pushed — but it does mean the gate's bound is on what
 * git would carry, not on every byte the pass wrote to disk. The worktree is
 * disposable, so that is the right line.
 */
async function stageIntentToAdd(
  runner: CommandRunner,
  worktreePath: string,
  timeoutMs: number,
): Promise<boolean> {
  const result = await runner.run(["git", "-C", worktreePath, "add", "--intent-to-add", "-A"], {
    cwd: worktreePath,
    timeoutMs,
  });
  return !result.timedOut && result.exitCode === 0;
}

/**
 * Both reads go through here, and that is the point.
 *
 * The gate and the simplify prompt must be looking at the same set of files. If
 * only one of them staged, a pass could be shown a change the gate never
 * bounded, or bounded against a change it was never shown.
 */
async function gitDiff(
  runner: CommandRunner,
  worktreePath: string,
  timeoutMs: number,
  args: readonly string[],
): Promise<string | null> {
  // Refuse rather than fall back to the tracked-only diff. A partial answer
  // here reads as "nothing else changed", which is the failure being fixed.
  if (!(await stageIntentToAdd(runner, worktreePath, timeoutMs))) {
    return null;
  }
  const result = await runner.run(["git", "-C", worktreePath, "diff", ...args, "--"], {
    cwd: worktreePath,
    timeoutMs,
  });
  if (result.timedOut || result.exitCode !== 0) {
    return null;
  }
  return result.stdout;
}

/**
 * A pass that ran, or the reason it did not — never an exception.
 *
 * `passes.run` throws two quite different ways: `runSession` rejects when the
 * session times out or exits non-zero, and the parsers throw `SolveParseError`
 * when the model's output contradicts itself. Neither was caught. A solve is a
 * long-running job holding a worktree, so an uncaught throw took the whole
 * process down and orphaned the worktree — survivable while a human is watching
 * a single command, fatal once the daemon runs the loop unattended.
 *
 * Both become the same thing here, because the caller's decision is identical:
 * no verdict was reached. Which of the two it was survives in the reason.
 */
type PassResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/**
 * The outcome for a dead pass, logged on the way out.
 *
 * Logged for the same reason the bail reasons are: this is the one record that
 * a run existed at all, and without it a solve that died mid-pass is
 * indistinguishable from one that was never started.
 */
function crashed(issueKey: string, pass: Pass, reason: string, worktree: Worktree): SolveOutcome {
  logger.info("solve.crashed", { issueKey, pass, reason, worktreePath: worktree.path });
  return { kind: "crashed", pass, reason, worktree };
}

/** Never lets a pass throw past it. */
async function runPass<T>(
  passes: PassRunner,
  pass: Pass,
  options: SolveRunOptions,
  parse: (output: unknown) => T,
): Promise<PassResult<T>> {
  try {
    return { ok: true, value: await passes.run(pass, options, parse) };
  } catch (error) {
    // The message only. A stack trace here would be the harness's own frames,
    // which say nothing about why the pass did not produce a verdict, and this
    // string reaches a ticket comment.
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

/**
 * Runs one ticket through the pipeline.
 *
 * Reads top to bottom as the sequence it is. Each stage either produces the
 * input to the next or returns an outcome; there is no state machine and no
 * shared mutable context, because the value of this file is that a reader can
 * see every exit in one pass.
 */
export async function solveTicket(
  deps: SolveDependencies,
  request: SolveRequest,
): Promise<SolveOutcome> {
  const staged = await prepareSkillRoot(request.parentDirectory, request.issueKey);
  if (staged.outcome === "refused") {
    // `no-worktree` is the right shape even though no worktree was attempted:
    // it is the outcome that means "the run never started", and starting a run
    // whose every prompt opens with an unresolvable `/agent-solve` is worse
    // than not starting one.
    return { kind: "no-worktree", reason: staged.reason };
  }
  try {
    return await runPipeline(deps, request, staged.path);
  } finally {
    // Always, including on the paths that keep the worktree. A failed run's
    // worktree is evidence; a copy of a skill that is still in git is not.
    await removeSkillRoot(staged.path);
  }
}

/** One run, plus whatever a second one produced. */
export interface SolveAttempts {
  readonly outcome: SolveOutcome;
  /** 1 or 2. Never more — see `solveWithRetry`. */
  readonly attempts: number;
  /**
   * Why a warranted retry did not happen, or "" when none was warranted or one
   * ran. Returned rather than only logged: a caller reporting "abandoned" for
   * an environment cause is saying something quite different depending on
   * whether the pipeline tried twice, and a human reading the ticket comment is
   * the person who has to know.
   */
  readonly retryBlocked: string;
}

/**
 * Runs the ticket, and runs it once more if the *machine* got in the way.
 *
 * Observed on SSX-3822, 2026-09-04: the host's own safety hook denied a `Write`
 * mid-pass, twice in eight write-capable sessions, non-deterministically — the
 * successful run of the same feature wrote materially identical content to a
 * neighbouring path. Nothing about the ticket changed between those runs, so
 * recording that as "the fix pass declined" would have written a falsehood into
 * the calibration record and marked a fixable ticket unfixable.
 *
 * Only `environment`, and only once. A `judgement` cause is a verdict about the
 * ticket and rerunning it is asking the same question twice at full price; an
 * environment obstacle that survives a clean retry is not transient, and a loop
 * that keeps trying turns a blocked machine into an unbounded bill.
 *
 * The retry is a *fresh worktree*, never a second pass over the first — that
 * worktree's state is unknown by definition, since the run stopped in the
 * middle of writing to it. Which makes the cleanup load-bearing rather than
 * tidy: `createWorktree` derives both the path and the branch from the issue
 * key, so a second attempt collides with its own predecessor unless both are
 * gone. If either survives, there is no retry — `git worktree remove` refuses
 * on a dirty checkout and `branch -d` refuses on unmerged commits, so a refusal
 * here means the first attempt left work behind, and work left behind is
 * evidence rather than debris.
 */
export async function solveWithRetry(
  deps: SolveDependencies,
  request: SolveRequest,
): Promise<SolveAttempts> {
  const first = await solveTicket(deps, request);
  if (first.kind !== "abandoned" || first.cause !== "environment") {
    return { outcome: first, attempts: 1, retryBlocked: "" };
  }

  const blocked = (retryBlocked: string): SolveAttempts => {
    logger.info("solve.retry.blocked", { issueKey: request.issueKey, reason: retryBlocked });
    return { outcome: first, attempts: 1, retryBlocked };
  };

  const cleanup = await removeWorktree(
    deps.commands,
    first.worktree,
    "discard",
    request.gitTimeoutMs,
  );
  if (cleanup.outcome !== "removed") {
    return blocked(`the first attempt's worktree is still there: ${cleanup.reason}`);
  }
  if (cleanup.branch.outcome !== "deleted") {
    return blocked(`the first attempt's branch is still there: ${cleanup.branch.reason}`);
  }

  logger.info("solve.retry", {
    issueKey: request.issueKey,
    cause: "environment",
    reason: first.reason,
  });
  return { outcome: await solveTicket(deps, request), attempts: 2, retryBlocked: "" };
}

async function runPipeline(
  deps: SolveDependencies,
  request: SolveRequest,
  skillRootPath: string,
): Promise<SolveOutcome> {
  const { issueKey } = request;
  const { commands, passes } = deps;

  const worktreeRequest: WorktreeRequest = {
    issueKey,
    summary: request.summary,
    repoPath: request.repoPath,
    parentDirectory: request.parentDirectory,
    baseRef: request.baseRef,
    ...(request.branchPrefix === undefined ? {} : { branchPrefix: request.branchPrefix }),
    timeoutMs: request.gitTimeoutMs,
  };
  const created = await createWorktree(commands, worktreeRequest);
  if (created.outcome === "refused") {
    return { kind: "no-worktree", reason: created.reason };
  }
  const { worktree } = created;

  const base: SolveRunOptions = {
    issueKey,
    worktreePath: worktree.path,
    ticket: request.ticket,
    skillRootPath,
    ...(request.vaultPath === undefined ? {} : { vaultPath: request.vaultPath }),
  };

  // ---- recon -------------------------------------------------------------
  const reconRun = await runPass(passes, "recon", base, (output) => parseRecon(output, issueKey));
  if (!reconRun.ok) {
    return crashed(issueKey, "recon", reconRun.reason, worktree);
  }
  const recon = reconRun.value;
  const devLens = lensOf(recon);
  logger.info("solve.recon", {
    issueKey,
    proceed: recon.proceed,
    confidence: recon.confidence,
    devLensAccurate: recon.devLensAccurate,
  });
  if (!recon.proceed) {
    // The bail reason is the whole product of a read-only pass. It is the only
    // calibration the fitness assessment ever gets — triage cannot read source,
    // so this is the first time anything with the code in front of it has had
    // an opinion — and it was going nowhere.
    logger.info("solve.abandoned", {
      issueKey,
      pass: "recon",
      reason: recon.bailReason,
      leftFiles: false,
      worktreePath: worktree.path,
    });
    // The one place a worktree is removed, and the one place it is provably
    // safe to. Recon holds no `Write` and no `Edit`, so there is nothing in
    // there to lose; and a bail is the *expected* outcome for a ticket triage
    // called wrong, so leaking a full checkout per bail is the leak that grows
    // fastest. `removeWorktree` does not force, so if this reasoning is ever
    // wrong — a future recon that can write — git refuses and says so, and the
    // reason travels out on the outcome rather than into a log nobody reads.
    const cleanup = await removeWorktree(commands, worktree, "discard", request.gitTimeoutMs);
    return { kind: "bailed", reason: recon.bailReason, recon, devLens, worktree, cleanup };
  }

  // ---- fix ---------------------------------------------------------------
  const brief = JSON.stringify(recon, null, 2);
  const fixRun = await runPass(passes, "fix", { ...base, brief }, (output) =>
    parseFix(output, issueKey),
  );
  if (!fixRun.ok) {
    return crashed(issueKey, "fix", fixRun.reason, worktree);
  }
  const fix = fixRun.value;
  if (fix.abandoned.trim() !== "") {
    // Logged, because it was not. A bail is the most informative thing a solve
    // produces — it is the fitness assessment being corrected by something that
    // can actually read the code — and until now the reason was returned to a
    // caller that printed a one-word outcome, so it reached nobody. `leftFiles`
    // because an abandoned run may still have touched the worktree, and whether
    // there is debris to look at changes what a human does next.
    // `cause` is narrowed here rather than trusted: `parseFix` has already
    // rejected `none` on an abandoned run, so this cast documents a check that
    // has happened rather than performing one.
    const cause = fix.abandonedCause as Exclude<AbandonCause, "none">;
    logger.info("solve.abandoned", {
      issueKey,
      pass: "fix",
      cause,
      reason: fix.abandoned,
      leftFiles: fix.changed,
      worktreePath: worktree.path,
    });
    return { kind: "abandoned", reason: fix.abandoned, cause, devLens, worktree };
  }

  // The pass that actually spends the privilege, and until the first verified
  // run it was the only one that logged nothing — recon, simplify and verify
  // each did. So the write pass was the single step with no record that it had
  // run, which is precisely backwards: in a six-minute gap between two log
  // lines there was no way to tell a slow fix from a hung one, and afterwards
  // no way to tell what it had claimed to touch.
  //
  // Counts and flags only. `filesTouched` is model-authored text derived from a
  // ticket anyone can edit, and the diff gate is what checks those paths
  // against git's own account a few lines below; putting them in a log line
  // that a human skims would invite trusting the claim instead of the check.
  logger.info("solve.fix", {
    issueKey,
    changed: fix.changed,
    files: fix.filesTouched.length,
    testAdded: fix.testAdded,
    // Empty on a healthy run. Non-empty means the pass shipped a change while
    // telling us why it might not hold, and that is worth having in the log
    // next to the outcome rather than only inside a returned object.
    residualRisk: fix.residualRisk,
    testOmittedReason: fix.testOmittedReason,
  });

  // ---- simplify ----------------------------------------------------------
  //
  // Given the diff rather than the brief, because it is not implementing
  // anything and showing it the requirement would invite it to reconsider the
  // change instead of the way the change is written.
  const diffText = await readPatch(commands, worktree.path, request.baseRef, request.gitTimeoutMs);
  const simplifyRun = await runPass(
    passes,
    "simplify",
    { ...base, ...(diffText === null ? {} : { diff: diffText }) },
    (output) => parseSimplify(output, issueKey, fix.filesTouched),
  );
  if (!simplifyRun.ok) {
    // Note this discards a fix that may have been perfectly good. Deliberate:
    // the diff gate has not run yet, so nothing has bounded what is in the
    // worktree, and shipping an unbounded diff because the pass that would have
    // tidied it died is the wrong way to fail. The worktree is kept, so the
    // work is not lost — it is just not automatically believed.
    return crashed(issueKey, "simplify", simplifyRun.reason, worktree);
  }
  const simplify = simplifyRun.value;
  logger.info("solve.simplify", { issueKey, changed: simplify.changed });

  // ---- the diff gate -----------------------------------------------------
  //
  // Read fresh, after simplify, and never from either model's own account of
  // what it touched. `fix.filesTouched` bounded the simplify pass; this bounds
  // both of them against what git actually says happened.
  const finalDiff = await readNumstat(
    commands,
    worktree.path,
    request.baseRef,
    request.gitTimeoutMs,
  );
  if (finalDiff === null) {
    return {
      kind: "refused",
      stage: "diff-gate",
      reasons: ["could not read the diff, so there is nothing to bound"],
      devLens,
      worktree,
    };
  }
  const verdict = checkDiff(parseNumstat(finalDiff), request.limits ?? DEFAULT_LIMITS);
  if (!verdict.ok) {
    logger.warn("solve.diff_gate.refused", { issueKey, reasons: verdict.reasons });
    return { kind: "refused", stage: "diff-gate", reasons: verdict.reasons, devLens, worktree };
  }

  // ---- verification ------------------------------------------------------
  const verification = await verify(commands, {
    repoPath: request.repoPath,
    worktreePath: worktree.path,
    baseRef: request.baseRef,
    stepTimeoutMs: request.stepTimeoutMs,
    installTimeoutMs: request.installTimeoutMs,
  });
  if (verification.outcome === "refused") {
    // Not a statement about the change. Kept distinct from `failed` all the way
    // out of this function so no caller can report it as one.
    return {
      kind: "refused",
      stage: "verification",
      reasons: [verification.reason],
      devLens,
      worktree,
    };
  }
  if (verification.outcome === "failed") {
    return { kind: "failed", reason: verification.reason, verification, devLens, worktree };
  }

  logger.info("solve.verified", {
    issueKey,
    branch: worktree.branch,
    files: verdict.files,
    lines: verdict.lines,
  });
  return {
    kind: "verified",
    worktree,
    commit: composeCommitMessage(fix, issueKey),
    recon,
    fix,
    simplify,
    verification,
    devLens,
    files: verdict.files,
    lines: verdict.lines,
  };
}

export type ReviewRoundOutcome =
  | { readonly kind: "no-change"; readonly report: ReviewReport }
  | { readonly kind: "abandoned"; readonly reason: string }
  | {
      readonly kind: "refused";
      readonly stage: "diff-gate" | "verification";
      readonly reasons: readonly string[];
    }
  | { readonly kind: "failed"; readonly reason: string; readonly verification: VerificationResult }
  | {
      readonly kind: "resolved";
      readonly report: ReviewReport;
      readonly commit: CommitMessage;
      readonly verification: VerificationResult;
    };

export interface ReviewRoundRequest extends SolveRequest {
  readonly worktree: Worktree;
  /** The reviewer's comments, rendered. Data — see `REVIEW_SCHEMA`. */
  readonly reviewFeedback: string;
}

/**
 * One round of resolving reviewer feedback.
 *
 * Deliberately re-runs the same gate and the same verification as the first
 * pass, against the whole diff rather than the increment. A round that fixes
 * what the reviewer asked for and breaks something else has not improved the
 * pull request, and bounding only the delta would be measuring the wrong
 * thing — the reviewer is looking at the cumulative diff, so that is what has
 * to stay inside the bound.
 *
 * No simplify pass here. The reviewer *is* the second opinion at this point,
 * and inserting another editor between their comment and their re-read would
 * mean they are no longer reviewing the thing they commented on.
 */
export async function resolveReview(
  deps: SolveDependencies,
  request: ReviewRoundRequest,
): Promise<ReviewRoundOutcome> {
  const staged = await prepareSkillRoot(request.parentDirectory, `${request.issueKey}-review`);
  if (staged.outcome === "refused") {
    return { kind: "abandoned", reason: staged.reason };
  }
  try {
    return await runReviewRound(deps, request, staged.path);
  } finally {
    await removeSkillRoot(staged.path);
  }
}

async function runReviewRound(
  deps: SolveDependencies,
  request: ReviewRoundRequest,
  skillRootPath: string,
): Promise<ReviewRoundOutcome> {
  const { issueKey, worktree } = request;
  const { commands, passes } = deps;

  const reviewRun = await runPass(
    passes,
    "review",
    {
      issueKey,
      worktreePath: worktree.path,
      ticket: request.ticket,
      reviewFeedback: request.reviewFeedback,
      skillRootPath,
      ...(request.vaultPath === undefined ? {} : { vaultPath: request.vaultPath }),
    },
    (output) => parseReview(output, issueKey),
  );
  if (!reviewRun.ok) {
    // A dead review round is `abandoned` rather than its own kind: unlike the
    // three passes above, a pull request already exists here, so the loop has
    // somewhere to put the reason and a human is already on the other end.
    logger.info("solve.crashed", {
      issueKey,
      pass: "review",
      reason: reviewRun.reason,
      worktreePath: worktree.path,
    });
    return { kind: "abandoned", reason: reviewRun.reason };
  }
  const report = reviewRun.value;

  if (report.abandoned.trim() !== "") {
    logger.info("solve.abandoned", {
      issueKey,
      pass: "review",
      reason: report.abandoned,
      leftFiles: report.changed,
      worktreePath: worktree.path,
    });
    return { kind: "abandoned", reason: report.abandoned };
  }
  if (!report.changed) {
    // A review can raise only questions. Answering them without touching code
    // is a legitimate round, and there is nothing to re-verify.
    return { kind: "no-change", report };
  }

  const diffText = await readNumstat(
    commands,
    worktree.path,
    request.baseRef,
    request.gitTimeoutMs,
  );
  if (diffText === null) {
    return {
      kind: "refused",
      stage: "diff-gate",
      reasons: ["could not read the diff, so there is nothing to bound"],
    };
  }
  const verdict = checkDiff(parseNumstat(diffText), request.limits ?? DEFAULT_LIMITS);
  if (!verdict.ok) {
    return { kind: "refused", stage: "diff-gate", reasons: verdict.reasons };
  }

  const verification = await verify(commands, {
    repoPath: request.repoPath,
    worktreePath: worktree.path,
    baseRef: request.baseRef,
    stepTimeoutMs: request.stepTimeoutMs,
    installTimeoutMs: request.installTimeoutMs,
  });
  if (verification.outcome === "refused") {
    return { kind: "refused", stage: "verification", reasons: [verification.reason] };
  }
  if (verification.outcome === "failed") {
    return { kind: "failed", reason: verification.reason, verification };
  }

  return {
    kind: "resolved",
    report,
    commit: composeCommitMessage(
      {
        changed: report.changed,
        filesTouched: report.filesTouched,
        summary: report.summary,
        commitSubject: report.commitSubject,
        commitBody: report.commitBody,
        testAdded: false,
        testOmittedReason: "",
        residualRisk: report.unresolved,
        abandoned: "",
        abandonedCause: "none",
      },
      issueKey,
    ),
    verification,
  };
}
