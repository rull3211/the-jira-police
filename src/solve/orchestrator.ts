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
  /** Recon read the code and declined. Not a failure. */
  | {
      readonly kind: "bailed";
      readonly reason: string;
      readonly recon: ReconVerdict;
      readonly devLens: DevLensFeedback;
      readonly worktree: Worktree;
    }
  /** The fix pass declined once it saw the files. */
  | {
      readonly kind: "abandoned";
      readonly reason: string;
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

async function gitDiff(
  runner: CommandRunner,
  worktreePath: string,
  timeoutMs: number,
  args: readonly string[],
): Promise<string | null> {
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
  const recon = await passes.run("recon", base, (output) => parseRecon(output, issueKey));
  const devLens = lensOf(recon);
  logger.info("solve.recon", {
    issueKey,
    proceed: recon.proceed,
    confidence: recon.confidence,
    devLensAccurate: recon.devLensAccurate,
  });
  if (!recon.proceed) {
    return { kind: "bailed", reason: recon.bailReason, recon, devLens, worktree };
  }

  // ---- fix ---------------------------------------------------------------
  const brief = JSON.stringify(recon, null, 2);
  const fix = await passes.run("fix", { ...base, brief }, (output) => parseFix(output, issueKey));
  if (fix.abandoned.trim() !== "") {
    return { kind: "abandoned", reason: fix.abandoned, devLens, worktree };
  }

  // ---- simplify ----------------------------------------------------------
  //
  // Given the diff rather than the brief, because it is not implementing
  // anything and showing it the requirement would invite it to reconsider the
  // change instead of the way the change is written.
  const diffText = await readPatch(commands, worktree.path, request.baseRef, request.gitTimeoutMs);
  const simplify = await passes.run(
    "simplify",
    { ...base, ...(diffText === null ? {} : { diff: diffText }) },
    (output) => parseSimplify(output, issueKey, fix.filesTouched),
  );
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

  const report = await passes.run(
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

  if (report.abandoned.trim() !== "") {
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
      },
      issueKey,
    ),
    verification,
  };
}
