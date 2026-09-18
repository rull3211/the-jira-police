/**
 * The solve pipeline, end to end: one ticket in, a verified branch or a reason
 * out. This file's job is sequencing and refusal, not new capability.
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
 * Three shapes of "no", kept apart because they call for different action:
 * **bailed** (recon declined, nothing written, a human picks it up), **failed**
 * (the change was made and tests say it's wrong), and **refused** (the harness
 * declines to have an opinion — never report it as a statement about the code).
 *
 * Takes no Jira client — the caller owns labels and comments, keeping the
 * pipeline runnable by hand against one ticket. Does not clean up after a
 * failure: a failed worktree is kept so a human can read the diff.
 */

import { logger } from "../logger.ts";
import type { StagedImagePrompt } from "../triage/runner.ts";
import {
  abortMerge,
  acceptResolution,
  beginMerge,
  commitMerge,
  pushBranch,
  type BaseSyncRequest,
} from "./base-sync.ts";
import { checkDiff, parseNumstat } from "./diff-gate.ts";
import { describeEscape, escapedRepos, snapshotRepos } from "./escape.ts";
import type { BotIdentity } from "./pr.ts";
import {
  type AbandonCause,
  type FixReport,
  type MergeReport,
  type Pass,
  type ReconVerdict,
  type ReviewReport,
  type SimplifyReport,
  type SolveRunOptions,
  composeCommitMessage,
  type CommitMessage,
  parseFix,
  parseMerge,
  parseRecon,
  parseReview,
  parseSimplify,
} from "./runner.ts";
import { prepareSkillRoot, removeSkillRoot } from "./skill-root.ts";
import {
  checkFailFirst,
  verify,
  verifyBase,
  type FailFirstResult,
  type VerificationResult,
  type VerifyRequest,
} from "./verify.ts";
import {
  type CommandRunner,
  createWorktree,
  failed,
  removeWorktree,
  type RemoveResult,
  why,
  type Worktree,
  type WorktreeRequest,
} from "./worktree.ts";

/** One model pass, run to completion, parsed. Injected so the pipeline is testable without starting a model. */
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
  /**
   * Other checkouts a pass may read, absolute paths, from `SOLVE_READ_DIRS`.
   *
   * Also the set the write-escape guard watches, since a directory a pass was
   * told about and the guard was not is exactly the case the guard exists for.
   */
  readonly readDirs?: readonly string[];
  /**
   * Whether to run the fail-first experiment, `FAIL_FIRST_CHECK`.
   *
   * Defaults on, unlike every privilege setting in this service, because it
   * grants nothing and writes nothing — it is a quality check, catching a
   * regression test that is green against the bug it names.
   */
  readonly failFirstCheck?: boolean;
  readonly gitTimeoutMs: number;
  readonly stepTimeoutMs: number;
  readonly installTimeoutMs: number;
  /**
   * The ticket's images, already staged. Reaches only the recon pass — see
   * `buildSolvePrompt` and `buildSolveArgs` in `runner.ts`, which read this
   * field solely when `pass === "recon"` even though `fix`, `simplify`,
   * `review` and `merge` are all built from the same `base` this populates.
   */
  readonly images?: StagedImagePrompt;
}

/**
 * What recon learned about triage's guess.
 *
 * Triage marks a ticket `agent:solvable` without reading any source; recon is
 * the first thing that does, and this correction is the only feedback that
 * blind call ever receives.
 */
export interface DevLensFeedback {
  readonly accurate: boolean;
  readonly correction: string;
}

export type SolveOutcome =
  /** Never got as far as a session. */
  | { readonly kind: "no-worktree"; readonly reason: string }
  /**
   * The worktree exists but the repository's own build does not pass in it,
   * before any pass ran. Says nothing about the ticket or any fix.
   *
   * A separate kind rather than a `refused` stage because it happens before
   * recon, so there is no `devLens` to carry. The worktree is kept, since it's
   * the only place the build's odd behavior can be reproduced — but
   * `createWorktree` moves it to a timestamped sibling first, so the next run's
   * `worktree add -b` on the same issue key does not collide with it forever.
   */
  | {
      readonly kind: "unusable-base";
      readonly reason: string;
      readonly verification: VerificationResult;
      readonly worktree: Worktree;
    }
  /**
   * Recon read the code and declined. Not a failure.
   *
   * The only outcome that cleans up its worktree: recon has no `Write` and no
   * `Edit`, so a bailed worktree holds nothing. Every other outcome keeps its
   * worktree, since it's the only copy of any work done and nothing in this
   * phase commits.
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
   * `cause` distinguishes `judgement` (the model declined — a verdict about the
   * ticket) from `environment` (it was prevented from working — a fact about
   * the machine, not the ticket). One kind rather than two because everything
   * downstream treats them identically; only `feedback.ts` and
   * `solveWithRetry` care about the difference.
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
   * Something outside the worktree changed while this run was in flight.
   *
   * Overrides whatever the pipeline concluded, including `verified`: a run
   * that also wrote into somebody else's checkout has not earned a pull
   * request, since `diff-gate.ts` only sees the worktree and cannot tell.
   *
   * `paths` is evidence, not an accusation — the guard compares `git status`
   * before and after, and cannot tell a pass's write from an operator editing
   * a file by hand during the run, so false positives are expected when nobody
   * is watching. `would` carries what the run had concluded, since a reader's
   * first question is whether the fix itself was any good.
   */
  | {
      readonly kind: "escaped";
      readonly paths: readonly string[];
      readonly would: SolveOutcome["kind"];
      readonly worktree: Worktree;
    }
  /**
   * A pass died — timed out, or produced output the parser refused.
   *
   * A refusal, never a statement about the code: nothing was learned. Carries
   * no `devLens` because the pass that produces one may be the pass that died.
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
      /**
       * Whether the run's own tests notice when its fix is taken away.
       *
       * On the outcome rather than only in a log, since it is feedback for a
       * reviewer. Never a reason to withhold the pull request — see `checkFailFirst`.
       */
      readonly failFirst: FailFirstResult;
      readonly devLens: DevLensFeedback;
      readonly files: number;
      readonly lines: number;
    };

function lensOf(recon: ReconVerdict): DevLensFeedback {
  return { accurate: recon.devLensAccurate, correction: recon.devLensCorrection };
}

/**
 * The two reads of the worktree, kept separate rather than shared.
 *
 * Sharing one `--numstat -z` output between the gate and the simplify prompt
 * once sent the model a NUL-delimited numstat table instead of a patch, and it
 * silently found nothing to simplify every time — the crash on a stray NUL in
 * argv was the lucky version of that bug.
 */

/**
 * The machine-readable read, for the gate.
 *
 * The `-z` is load-bearing: without it a filename containing a newline forges
 * an extra numstat record and can push a real change out of the gate's view.
 * Contains NUL bytes as a result, so `parseNumstat` is its only legitimate consumer.
 */
async function readNumstat(
  runner: CommandRunner,
  worktreePath: string,
  baseRef: string,
  timeoutMs: number,
): Promise<string | null> {
  return await gitDiff(runner, worktreePath, timeoutMs, ["--numstat", "-z", baseRef]);
}

/** The human-readable read, for a prompt. No `-z`: nothing here is parsed, so the gate's newline-in-filename defense does not apply. */
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
 * `git diff <base>` reports tracked files only, so a pass that creates a file
 * was invisible to every categorical refusal the gate makes — a fresh
 * `.github/workflows/*.yml` would have passed the gate and then run on push.
 * `--intent-to-add` rather than a real `add` records the path in the index
 * only, leaving the worktree looking as a human inspecting it would expect.
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

/** Both reads go through here so the gate and the simplify prompt see the same set of files. */
async function gitDiff(
  runner: CommandRunner,
  worktreePath: string,
  timeoutMs: number,
  args: readonly string[],
): Promise<string | null> {
  // Refuse rather than fall back to the tracked-only diff, which would read as "nothing else changed".
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
 * `passes.run` throws both on a session timeout/non-zero exit and on
 * `SolveParseError`; an uncaught throw here would take the whole process down
 * and orphan the worktree once the daemon runs unattended.
 */
type PassResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/** The outcome for a dead pass, logged on the way out, so a solve that died mid-pass is distinguishable from one never started. */
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
    // The message only — a stack trace would be the harness's own frames, and this string reaches a ticket comment.
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

/** Runs one ticket through the pipeline. No state machine and no shared mutable context — each stage either feeds the next or returns an outcome. */
export async function solveTicket(
  deps: SolveDependencies,
  request: SolveRequest,
): Promise<SolveOutcome> {
  const staged = await prepareSkillRoot(request.parentDirectory, request.issueKey);
  if (staged.outcome === "refused") {
    // `no-worktree` means "the run never started", which is right here too: no worktree was attempted.
    return { kind: "no-worktree", reason: staged.reason };
  }
  const watched = watchedDirs(request);
  const before = await snapshotRepos(deps.commands, watched, request.gitTimeoutMs);
  try {
    const outcome = await runPipeline(deps, request, staged.path);
    const after = await snapshotRepos(deps.commands, watched, request.gitTimeoutMs);
    return escapeVerdict(request.issueKey, outcome, escapedRepos(before, after));
  } finally {
    // Always, even on paths that keep the worktree: a failed run's worktree is evidence, a staged skill copy is not.
    await removeSkillRoot(staged.path);
  }
}

/**
 * The checkouts a run must leave exactly as it found them: the repository
 * (holding the operator's own uncommitted work), the vault, and the read-only
 * checkouts — but not the worktree itself, where writing is the job.
 *
 * `git worktree add`, `git fetch` and `git branch -d` all write inside `.git`
 * and none appear in `git status`, so the harness's own git traffic does not trip this.
 */
function watchedDirs(request: SolveRequest): readonly string[] {
  const candidates = [request.repoPath, request.vaultPath ?? "", ...(request.readDirs ?? [])];
  return [...new Set(candidates.filter((path) => path !== ""))];
}

/**
 * Folds an escape into the run's verdict, or leaves the verdict alone.
 *
 * Never overrides `no-worktree`: that means `createWorktree` refused, so no
 * pass ever started and reporting an escape would be a false accusation.
 */
function escapeVerdict(
  issueKey: string,
  outcome: SolveOutcome,
  paths: readonly string[],
): SolveOutcome {
  if (paths.length === 0) {
    return outcome;
  }
  logger.info("solve.escape", { issueKey, paths, would: outcome.kind });
  if (outcome.kind === "no-worktree") {
    return outcome;
  }
  return { kind: "escaped", paths, would: outcome.kind, worktree: outcome.worktree };
}

/** One run, plus whatever a second one produced. */
export interface SolveAttempts {
  readonly outcome: SolveOutcome;
  /** 1 or 2. Never more — see `solveWithRetry`. */
  readonly attempts: number;
  /** Why a warranted retry did not happen, or "" when none was warranted or one ran. */
  readonly retryBlocked: string;
}

/**
 * Runs the ticket, and runs it once more if the *machine* got in the way.
 *
 * Only for `environment` causes, and only once: a `judgement` cause is a
 * verdict about the ticket, and an environment obstacle that survives a clean
 * retry is not transient. The retry is a fresh worktree, never a second pass
 * over the first, since the first stopped mid-write and its state is unknown.
 *
 * The cleanup check below is load-bearing, not tidying: `createWorktree`
 * derives both the path and branch from the issue key, so if either the
 * worktree or branch from the first attempt survives, there's a refusal here
 * rather than a silent collision — because that survival means the first
 * attempt left evidence behind, not debris. This is deliberately stricter than
 * `createWorktree`'s own salvage behavior, which exists for a different case
 * (the daemon resuming after a dead process) and must not be relied on to
 * "handle" this one, since it would discard exactly what this guards.
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

/**
 * What recon alone produced, with no fix pass to hand a `proceed` to.
 *
 * Not a `SolveOutcome`: there, `proceed` means "run fix next", and every
 * caller of that type assumes a pipeline continues. Here nothing does, so
 * `proceed` needs its own shape rather than overloading a kind whose meaning
 * elsewhere is "and then".
 */

export type ReconOnlyOutcome =
  | { readonly kind: "no-worktree"; readonly reason: string }
  /**
   * Kept, not discarded — the same asymmetry `crashed` has in the full
   * pipeline. A parse failure or a timeout is the one case worth a human
   * looking at what recon actually saw.
   */
  | { readonly kind: "crashed"; readonly reason: string; readonly worktree: Worktree }
  | {
      readonly kind: "bailed";
      readonly reason: string;
      readonly recon: ReconVerdict;
      readonly devLens: DevLensFeedback;
      readonly cleanup: RemoveResult;
    }
  | {
      readonly kind: "proceed";
      readonly recon: ReconVerdict;
      readonly devLens: DevLensFeedback;
      readonly cleanup: RemoveResult;
    };

/**
 * Runs recon alone: a worktree, a skill root, one pass, always discarded.
 *
 * Skips `verifyBase` on purpose. That check exists to give a later `verify`
 * a green premise to fail against — see its own comment in `runPipeline` —
 * and with no fix pass here there is no later `verify` for it to serve.
 *
 * Discards the worktree on `bailed` **and** on `proceed`, which the full
 * pipeline does not do for the latter: there, `proceed` means fix runs next
 * and needs the checkout. Here nothing does.
 */
export async function runReconOnly(
  deps: SolveDependencies,
  request: SolveRequest,
): Promise<ReconOnlyOutcome> {
  const { issueKey } = request;
  const staged = await prepareSkillRoot(request.parentDirectory, issueKey);
  if (staged.outcome === "refused") {
    return { kind: "no-worktree", reason: staged.reason };
  }
  try {
    const worktreeRequest: WorktreeRequest = {
      issueKey,
      summary: request.summary,
      repoPath: request.repoPath,
      parentDirectory: request.parentDirectory,
      baseRef: request.baseRef,
      ...(request.branchPrefix === undefined ? {} : { branchPrefix: request.branchPrefix }),
      timeoutMs: request.gitTimeoutMs,
    };
    const created = await createWorktree(deps.commands, worktreeRequest);
    if (created.outcome === "refused") {
      return { kind: "no-worktree", reason: created.reason };
    }
    const { worktree } = created;

    const base: SolveRunOptions = {
      issueKey,
      worktreePath: worktree.path,
      ticket: request.ticket,
      skillRootPath: staged.path,
      ...(request.vaultPath === undefined ? {} : { vaultPath: request.vaultPath }),
      ...(request.readDirs === undefined ? {} : { readDirs: request.readDirs }),
      ...(request.images === undefined ? {} : { images: request.images }),
    };
    const reconRun = await runPass(deps.passes, "recon", base, (output) =>
      parseRecon(output, issueKey),
    );
    if (!reconRun.ok) {
      logger.info("solve.crashed", {
        issueKey,
        pass: "recon",
        reason: reconRun.reason,
        worktreePath: worktree.path,
      });
      return { kind: "crashed", reason: reconRun.reason, worktree };
    }

    const recon = reconRun.value;
    const devLens = lensOf(recon);
    logger.info("solve.recon", {
      issueKey,
      proceed: recon.proceed,
      confidence: recon.confidence,
      devLensAccurate: recon.devLensAccurate,
    });

    const cleanup = await removeWorktree(deps.commands, worktree, "discard", request.gitTimeoutMs);
    return recon.proceed
      ? { kind: "proceed", recon, devLens, cleanup }
      : { kind: "bailed", reason: recon.bailReason, recon, devLens, cleanup };
  } finally {
    await removeSkillRoot(staged.path);
  }
}

/** The only place a {@link VerifyRequest} is built, so the base check and the post-fix check cannot drift apart on timeout or base ref. */
function verifyRequestOf(
  request: Pick<SolveRequest, "repoPath" | "baseRef" | "stepTimeoutMs" | "installTimeoutMs">,
  worktree: Worktree,
): VerifyRequest {
  return {
    repoPath: request.repoPath,
    worktreePath: worktree.path,
    baseRef: request.baseRef,
    stepTimeoutMs: request.stepTimeoutMs,
    installTimeoutMs: request.installTimeoutMs,
  };
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

  // ---- the base ------------------------------------------------------------
  // Before any pass: `verify`'s `failed` means "the change is bad", which is only true if these steps would have passed without it.
  const baseCheck = await verifyBase(deps.commands, verifyRequestOf(request, worktree));
  if (baseCheck.outcome === "unusable") {
    logger.info("solve.base.unusable", {
      issueKey,
      verification: baseCheck.verification.outcome,
    });
    return {
      kind: "unusable-base",
      reason: baseCheck.reason,
      verification: baseCheck.verification,
      worktree,
    };
  }

  const base: SolveRunOptions = {
    issueKey,
    worktreePath: worktree.path,
    ticket: request.ticket,
    skillRootPath,
    ...(request.vaultPath === undefined ? {} : { vaultPath: request.vaultPath }),
    ...(request.readDirs === undefined ? {} : { readDirs: request.readDirs }),
    ...(request.images === undefined ? {} : { images: request.images }),
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
    logger.info("solve.abandoned", {
      issueKey,
      pass: "recon",
      reason: recon.bailReason,
      leftFiles: false,
      worktreePath: worktree.path,
    });
    // The one place a worktree is removed: recon has no Write/Edit, so there is nothing in it to lose.
    // `removeWorktree` does not force, so if a future recon can write, git refuses and the reason travels out on the outcome.
    // `runReconOnly` repeats this reasoning for its own worktree, separately — there is no pipeline for it to be "in".
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
    // `leftFiles` matters because an abandoned run may still have touched the worktree.
    // `parseFix` already rejects `none` on an abandoned run; this cast documents that check rather than performing one.
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

  // Counts and flags only, not the paths themselves: `filesTouched` is model-authored text from an editable ticket,
  // and logging it invites trusting the claim instead of the diff gate's check against git's own account below.
  logger.info("solve.fix", {
    issueKey,
    changed: fix.changed,
    files: fix.filesTouched.length,
    testAdded: fix.testAdded,
    // Empty on a healthy run; non-empty means the pass shipped a change while flagging why it might not hold.
    residualRisk: fix.residualRisk,
    testOmittedReason: fix.testOmittedReason,
  });

  // ---- simplify ----------------------------------------------------------
  // Given the diff rather than the brief: showing the requirement would invite reconsidering the change, not just its style.
  const diffText = await readPatch(commands, worktree.path, request.baseRef, request.gitTimeoutMs);
  const simplifyRun = await runPass(
    passes,
    "simplify",
    { ...base, ...(diffText === null ? {} : { diff: diffText }) },
    (output) => parseSimplify(output, issueKey, fix.filesTouched),
  );
  if (!simplifyRun.ok) {
    // Discards a fix that may have been fine: the diff gate has not run yet, so nothing bounds the worktree. Kept, not lost.
    return crashed(issueKey, "simplify", simplifyRun.reason, worktree);
  }
  const simplify = simplifyRun.value;
  logger.info("solve.simplify", { issueKey, changed: simplify.changed });

  // ---- the diff gate -----------------------------------------------------
  // Read fresh, after simplify, against what git says happened rather than either model's own account.
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
  const changes = parseNumstat(finalDiff);
  const verdict = checkDiff(changes);
  if (!verdict.ok) {
    logger.warn("solve.diff_gate.refused", { issueKey, reasons: verdict.reasons });
    return { kind: "refused", stage: "diff-gate", reasons: verdict.reasons, devLens, worktree };
  }

  // ---- verification ------------------------------------------------------
  const verification = await verify(commands, verifyRequestOf(request, worktree));
  if (verification.outcome === "refused") {
    // Not a statement about the change; kept distinct from `failed` so no caller can report it as one.
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

  // ---- fail-first ----------------------------------------------------------
  // After verification, never instead of it: no point asking whether the tests notice the fix's absence before it's seen to pass with it there.
  const failFirst =
    request.failFirstCheck === false
      ? ({ outcome: "skipped", reason: "FAIL_FIRST_CHECK is off" } as const)
      : await checkFailFirst(commands, {
          repoPath: request.repoPath,
          worktreePath: worktree.path,
          probePath: `${worktree.path}-failfirst`,
          baseRef: request.baseRef,
          changedPaths: changes.map((change) => change.path),
          stepTimeoutMs: request.stepTimeoutMs,
          installTimeoutMs: request.installTimeoutMs,
        });

  logger.info("solve.verified", {
    issueKey,
    branch: worktree.branch,
    files: verdict.files,
    lines: verdict.lines,
    failFirst: failFirst.outcome,
  });
  return {
    kind: "verified",
    worktree,
    commit: composeCommitMessage(fix, issueKey),
    recon,
    fix,
    simplify,
    verification,
    failFirst,
    devLens,
    files: verdict.files,
    lines: verdict.lines,
  };
}

export type ConflictRoundOutcome =
  /** The branch already contained its base. Nothing ran, nothing was paid for. */
  | { readonly kind: "current" }
  /** It merged cleanly this time, and is pushed. No pass was needed. */
  | { readonly kind: "merged"; readonly behind: number }
  /** The pass declined to resolve it. The merge is aborted; a human is needed. */
  | { readonly kind: "abandoned"; readonly reason: string }
  /** The harness declines to accept the resolution. The merge is aborted. */
  | { readonly kind: "refused"; readonly reason: string }
  /** Resolved, and the tests are red against the result. The merge is aborted. */
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly verification: VerificationResult;
    }
  /** Resolved, verified, committed and pushed. */
  | {
      readonly kind: "resolved";
      readonly report: MergeReport;
      readonly behind: number;
      readonly verification: VerificationResult;
    };

export interface ConflictRoundRequest extends SolveRequest {
  readonly worktree: Worktree;
  /** Whose name goes on the merge commit. */
  readonly identity: BotIdentity;
}

/**
 * What the pass is told about the conflict: the paths, not the conflicted
 * text, since the session already has `Read` on the worktree and a pasted copy
 * would go stale the moment it edits anything. The list is git's, which makes
 * every later question checkable against it rather than against the pass's
 * own account.
 */
function renderConflict(baseRef: string, behind: number, files: readonly string[]): string {
  return [
    `Merging ${baseRef} into this branch, which is ${String(behind)} commit(s) behind it.`,
    "",
    "git reports these paths conflicted:",
    ...files.map((file) => `- ${file}`),
  ].join("\n");
}

/**
 * One attempt at merging a base that will not merge itself.
 *
 * Its own round rather than a step in one, because a branch that will not
 * take its base cannot be verified, so a review round on top of it would be
 * answering a reviewer from a state nobody can build — the reviewer's thread
 * stays unanswered on purpose. The merge is re-run rather than kept from
 * `base-sync.ts`'s attach-path attempt, since it's deterministic and cheap and
 * a conflicted tree left sitting through a model call would be salvaged out
 * from under this function anyway. Nothing the pass says about the tree is
 * believed — `acceptResolution` and `verify` check git directly, and the
 * report's own `resolutions` are only checked for naming files git actually
 * flagged.
 */
export async function resolveConflict(
  deps: SolveDependencies,
  request: ConflictRoundRequest,
): Promise<ConflictRoundOutcome> {
  const staged = await prepareSkillRoot(request.parentDirectory, `${request.issueKey}-merge`);
  if (staged.outcome === "refused") {
    return { kind: "abandoned", reason: staged.reason };
  }
  try {
    return await runConflictRound(deps, request, staged.path);
  } finally {
    await removeSkillRoot(staged.path);
  }
}

async function runConflictRound(
  deps: SolveDependencies,
  request: ConflictRoundRequest,
  skillRootPath: string,
): Promise<ConflictRoundOutcome> {
  const { issueKey, worktree, identity } = request;
  const { commands, passes } = deps;
  const sync: BaseSyncRequest = {
    issueKey,
    branch: worktree.branch,
    worktreePath: worktree.path,
    baseRef: request.baseRef,
    identity,
    timeoutMs: request.gitTimeoutMs,
  };

  const started = await beginMerge(commands, sync);
  if (started.outcome === "current") {
    return { kind: "current" };
  }
  if (started.outcome === "refused") {
    return { kind: "refused", reason: started.reason };
  }
  if (started.outcome === "merged") {
    // Conflicted on the attach path but not now, since the base moved between the two; push and spend nothing else.
    const pushed = await pushBranch(commands, sync);
    return pushed.outcome === "pushed"
      ? { kind: "merged", behind: started.behind }
      : { kind: "refused", reason: pushed.reason };
  }

  const { behind, files } = started;
  /** Every failure below leaves a merge in progress, so every one aborts it. */
  const undo = async (outcome: ConflictRoundOutcome): Promise<ConflictRoundOutcome> => {
    await abortMerge(commands, worktree.path, request.gitTimeoutMs);
    return outcome;
  };

  const mergeRun = await runPass(
    passes,
    "merge",
    {
      issueKey,
      worktreePath: worktree.path,
      ticket: request.ticket,
      conflict: renderConflict(request.baseRef, behind, files),
      skillRootPath,
      ...(request.vaultPath === undefined ? {} : { vaultPath: request.vaultPath }),
      ...(request.readDirs === undefined ? {} : { readDirs: request.readDirs }),
    },
    (output) => parseMerge(output, issueKey),
  );
  if (!mergeRun.ok) {
    logger.info("solve.crashed", {
      issueKey,
      pass: "merge",
      reason: mergeRun.reason,
      worktreePath: worktree.path,
    });
    return await undo({ kind: "abandoned", reason: mergeRun.reason });
  }
  const report = mergeRun.value;

  if (!report.resolved) {
    logger.info("solve.abandoned", {
      issueKey,
      pass: "merge",
      reason: report.abandoned,
      worktreePath: worktree.path,
    });
    return await undo({ kind: "abandoned", reason: report.abandoned });
  }

  // Checked before the tree is: a report naming a file git never flagged is describing a situation the pass invented.
  const claimed = report.resolutions.map((resolution) => resolution.path);
  const unasked = claimed.filter((path) => !files.includes(path));
  if (unasked.length > 0) {
    return await undo({
      kind: "refused",
      reason: `the pass reported resolving files git did not flag: ${unasked.join(", ")}`,
    });
  }

  const accepted = await acceptResolution(commands, {
    worktreePath: worktree.path,
    conflicted: files,
    timeoutMs: request.gitTimeoutMs,
  });
  if (!accepted.ok) {
    return await undo({ kind: "refused", reason: accepted.reason });
  }

  const verification = await verify(commands, verifyRequestOf(request, worktree));
  if (verification.outcome === "refused") {
    return await undo({ kind: "refused", reason: verification.reason });
  }
  if (verification.outcome === "failed") {
    // Aborted rather than pushed: a red merge commit replaces a problem a reviewer can see with one they cannot.
    return await undo({ kind: "failed", reason: verification.reason, verification });
  }

  const committed = await commitMerge(commands, sync);
  if (failed(committed)) {
    return await undo({
      kind: "refused",
      reason: `could not commit the merge (${why(committed)})`,
    });
  }

  // Not `undo`: the merge is committed, so `merge --abort` has nothing to abort. `pushBranch` resets to `ORIG_HEAD` instead.
  const pushed = await pushBranch(commands, sync);
  if (pushed.outcome === "refused") {
    return { kind: "refused", reason: pushed.reason };
  }

  logger.info("solve.base.resolved", {
    issueKey,
    branch: worktree.branch,
    baseRef: request.baseRef,
    behind,
    files: claimed,
  });
  return { kind: "resolved", report, behind, verification };
}

export type ReviewRoundOutcome =
  | { readonly kind: "no-change"; readonly report: ReviewReport }
  | { readonly kind: "abandoned"; readonly reason: string }
  /**
   * `write-escape` is the same guard `solveTicket` runs, reported differently:
   * a review round has no dev lens and no calibration row, so `refused` is
   * the honest shape rather than a dedicated `escaped` kind.
   */
  | {
      readonly kind: "refused";
      readonly stage: "diff-gate" | "verification" | "write-escape";
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
 * Re-runs the gate and verification against the whole diff, not the
 * increment, since the reviewer is looking at the cumulative diff. No
 * simplify pass here: the reviewer is the second opinion, and another editor
 * between their comment and re-read would mean they're no longer reviewing
 * what they commented on.
 */
export async function resolveReview(
  deps: SolveDependencies,
  request: ReviewRoundRequest,
): Promise<ReviewRoundOutcome> {
  const staged = await prepareSkillRoot(request.parentDirectory, `${request.issueKey}-review`);
  if (staged.outcome === "refused") {
    return { kind: "abandoned", reason: staged.reason };
  }
  // The review pass is a write pass and gets the same write-escape guard as the passes in solveTicket.
  const watched = watchedDirs(request);
  const before = await snapshotRepos(deps.commands, watched, request.gitTimeoutMs);
  try {
    const outcome = await runReviewRound(deps, request, staged.path);
    const after = await snapshotRepos(deps.commands, watched, request.gitTimeoutMs);
    const escaped = escapedRepos(before, after);
    if (escaped.length === 0) {
      return outcome;
    }
    logger.info("solve.escape", {
      issueKey: request.issueKey,
      paths: escaped,
      would: outcome.kind,
    });
    return { kind: "refused", stage: "write-escape", reasons: [describeEscape(escaped)] };
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
      ...(request.readDirs === undefined ? {} : { readDirs: request.readDirs }),
    },
    (output) => parseReview(output, issueKey),
  );
  if (!reviewRun.ok) {
    // `abandoned` rather than its own kind: unlike the passes in solveTicket, a pull request already exists to carry the reason.
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
    // A review round can raise only questions, with nothing to re-verify.
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
  const verdict = checkDiff(parseNumstat(diffText));
  if (!verdict.ok) {
    return { kind: "refused", stage: "diff-gate", reasons: verdict.reasons };
  }

  const verification = await verify(commands, verifyRequestOf(request, worktree));
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
