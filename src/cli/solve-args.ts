/**
 * The solve command line, parsed. Nothing here does anything; it only decides
 * what the operator asked for.
 *
 * Its own module rather than an export from `solve-once.ts`, which runs `main`
 * at import time — importing that file to test a pure function starts a run.
 * `triage-once.test.ts` lives with it; this does not have to.
 *
 * ## The ladder
 *
 * ```
 *   solve:once                    whole queue, reports what it would claim
 *   solve:once SSX-3822           one ticket, same reporting
 *   solve:once SSX-3822 --claim   writes the claim label
 *   solve:once SSX-3822 --solve   ... and runs the solver, nothing leaves the box
 *   solve:once SSX-3822 --pr      ... and opens the draft pull request
 *   solve:once SSX-3822 --review  ... and works the review until it cannot
 * ```
 *
 * Each flag is a whole phase's worth of privilege, so the command line reads as
 * the escalation it is. Passing two is not an error — the highest wins, because
 * `--claim --pr` can only coherently mean "go as far as the pull request".
 *
 * ## The ladder is cumulative, and this is the change that made it so
 *
 * `--pr` runs the claim and the solve as well. `includes` is the predicate, and
 * every caller asks it rather than comparing the phase for equality.
 *
 * This is the second thing this comment has said, and the history is the useful
 * part. It first said each flag implies the ones before it; that was rewritten,
 * because at the time `--solve` also promised that nothing left the machine and
 * `--claim` writes a label to Jira, so the two sentences could not both be true.
 * The phases had landed out of order — the solver (C) was wired while the claim
 * (B2) was not — and the honest description of that state was a ladder of
 * independent rungs where `--claim` refused and `--solve` worked.
 *
 * Both are wired now, so the reason for the inversion is gone and the chain is
 * back. What went with it is the "nothing leaves the machine" promise: at
 * `--solve` a label is written to the board before any pass runs, and the
 * usage text says so. The unchanged part is what the ordering *means* —
 * privilege read as blast radius. `--claim` writes to a board a team reads,
 * `--solve` changes files in a temporary worktree, `--pr` puts them in front of
 * other people. The rung you name is the furthest one you are willing to go.
 *
 * A run that stops short of its rung undoes its own claim: `releaseClaim` puts
 * the labels back exactly as they were found. That is in `solve-once.ts`, not
 * here, but it is the reason making the ladder cumulative is not a widening of
 * what a failed `--pr` leaves behind.
 *
 * ## Two refusals, and the second is the one that matters
 *
 * **An unknown flag is rejected.** Ignoring it would be safe today — a
 * mistyped `--pr` degrading to a dry run errs toward less privilege — but the
 * failure it sets up is a flag added later that this parser silently drops,
 * and an operator watching their `--no-verify` do nothing has no way to tell.
 *
 * **Anything past the dry run demands an issue key.** This is the load-bearing
 * one. Without it, `solve:once --pr` would mean "open a pull request for every
 * ticket in the queue" — an unbounded write, from a command line one character
 * shorter than the safe one, at the exact moment an operator is experimenting.
 * Every escalation in this ladder is meant to be a person choosing one ticket,
 * so the key is required by the parser rather than remembered by the caller.
 */

/** In privilege order. The index into this array *is* the ordering. */
export const PHASES = ["plan", "claim", "solve", "pr", "review"] as const;

export type SolvePhase = (typeof PHASES)[number];

/** Which flag turns on which phase. `plan` has none: it is what you get for free. */
const PHASE_FLAGS: ReadonlyMap<string, SolvePhase> = new Map([
  ["--claim", "claim"],
  ["--solve", "solve"],
  ["--pr", "pr"],
  ["--review", "review"],
]);

export const USAGE =
  "usage: solve-once [<ISSUE-KEY>] [--claim | --solve | --pr | --review]\n" +
  "       solve-once <ISSUE-KEY> --advance\n" +
  "  (no arguments)          the whole queue, reporting the claims it would make\n" +
  "  <ISSUE-KEY>             one ticket, same reporting\n" +
  "  <ISSUE-KEY> --claim     writes the claim label, then releases it\n" +
  "  <ISSUE-KEY> --solve     ... and runs the solver; nothing is pushed\n" +
  "  <ISSUE-KEY> --pr        ... and opens the draft pull request\n" +
  "  <ISSUE-KEY> --review    ... and keeps answering the review until it is done,\n" +
  "                          out of rounds, or out of patience. Unattended, paid\n" +
  "                          per round, and the only loop in this service.\n" +
  "Each flag does everything the ones above it do. A run that does not reach a\n" +
  "pull request puts the labels back where it found them.\n" +
  "\n" +
  "  <ISSUE-KEY> --advance   one review round on the pull request that already\n" +
  "                          exists; does not claim, solve, or open anything\n";

/**
 * The flag that is not a rung.
 *
 * Every other flag names how far up one run should go, so they share an
 * ordering and the highest wins. This one names a *different run*: it operates
 * on a pull request an earlier, finished invocation opened, and the worktree it
 * needs is reconstructed from that pull request's branch rather than cut fresh.
 *
 * Reading it as a fifth rung would make `--advance` imply `--pr`, which is the
 * opposite of what the word means — the pull request is the precondition, not
 * the thing to create. So it is a separate mode, and combining it with a rung
 * is refused rather than resolved: `--pr --advance` has no coherent reading,
 * and the two guesses available (solve then advance, or advance then ignore the
 * solve) differ by a paid model pass and a force-push.
 *
 * ## `--review` is the fifth rung, and it is not this flag with a longer name
 *
 * The distinction is exactly the one above. `--advance` cannot be a rung because
 * it needs a pull request it did not make, so ordering it against `--pr` is a
 * guess. `--review` *is* a rung because it makes the pull request first: the
 * order is forced by the work rather than chosen by the parser, and every rung
 * below it runs unchanged. One run, going as far as a run can go.
 *
 * What it adds over `--pr` is the only unattended loop in this service: rounds
 * against whatever the reviewer says, until something ends it. That is E's
 * defining capability arriving early, and the thing that keeps it honest is that
 * it is bounded on four sides — `MAX_PR_ROUNDS_TOTAL` on the machinery,
 * `MAX_REVIEW_ITERATIONS` on the reviewer, `REVIEW_SILENCE_MS` on silence, and
 * every non-continuing outcome — and that a person typed one ticket key and is
 * watching it. `chainDecision` is where the first and last of those live.
 */
const ADVANCE_FLAG = "--advance";

export type SolveInvocation =
  | {
      readonly mode: "ladder";
      /** `null` means the whole queue. Only ever null at the `plan` phase. */
      readonly issueKey: string | null;
      readonly phase: SolvePhase;
    }
  | { readonly mode: "advance"; readonly issueKey: string };

/** The ladder half, for the commands that have no review mode at all. */
export type LadderInvocation = Extract<SolveInvocation, { mode: "ladder" }>;

export type ParsedArgs =
  | { readonly ok: true; readonly invocation: SolveInvocation }
  | { readonly ok: false; readonly error: string };

/**
 * A parse that cannot come back as a review round.
 *
 * `bot:once` triages a ticket and then solves it; there is no pull request in
 * its world yet, so `--advance` is not a flag it can honour. Narrowing the
 * return type rather than checking the mode at the call site means that command
 * stays a compile error away from silently ignoring the flag.
 */
export type ParsedLadderArgs =
  | { readonly ok: true; readonly invocation: LadderInvocation }
  | { readonly ok: false; readonly error: string };

/** How far up the ladder a phase sits. */
export function rank(phase: SolvePhase): number {
  return PHASES.indexOf(phase);
}

/** True when the run is allowed to change something outside this process. */
export function writes(phase: SolvePhase): boolean {
  return rank(phase) > rank("plan");
}

/**
 * Whether asking for `phase` also means doing `step`.
 *
 * The whole of the ladder's cumulativeness, in one place. Call sites ask
 * `includes(phase, "claim")` rather than `phase === "claim"`, and the difference
 * is not stylistic: an equality check skips the claim on a `--pr` run, leaving
 * the solver working on a ticket the board still shows as unclaimed. Comparing
 * ranks rules that out, and makes inserting a rung a change to `PHASES` alone.
 */
export function includes(phase: SolvePhase, step: SolvePhase): boolean {
  return rank(phase) >= rank(step);
}

/**
 * Why a rung cannot run, or `null` when it can.
 *
 * ## What this used to be, and what it is now
 *
 * It used to answer "is that phase built yet". Every rung above `plan` returned
 * a sentence naming the function nobody had composed, and landing a phase meant
 * deleting a branch. All four are built, so that version of the function would
 * now return `null` four times — a switch that has stopped asking anything.
 *
 * It is kept because the question it should have been asking all along is a
 * different one and does not go away: **is this rung configured**. `--pr` names
 * a GitHub owner that has no fallback, on purpose, and without this check the
 * missing setting would surface from `buildPublishRequest` — after the claim was
 * written and the solver had run. An operator would then have a labelled ticket,
 * a worktree full of edits and a settings error, for a mistake visible before
 * anything started.
 *
 * So it takes settings now, and it is still checked before the first write.
 * `buildPublishRequest` throws on the same condition and that duplication is
 * deliberate: this one exists to fail early and legibly, the other exists so the
 * privilege cannot be granted by a caller who skipped the check.
 */
export function unavailable(phase: SolvePhase, settings: LadderSettings): string | null {
  if (includes(phase, "pr") && settings.SOLVE_GITHUB_OWNER.trim() === "") {
    return "SOLVE_GITHUB_OWNER is not set, and it has no default — it names the GitHub account a pull request would be opened against, which is not a thing to guess";
  }
  return null;
}

/**
 * The settings this module reads, named structurally rather than imported whole.
 *
 * `Settings` is every key the service has; depending on it here would make the
 * argument parser's test fixtures grow every time an unrelated setting is added,
 * and would obscure that this file reads exactly one.
 */
export interface LadderSettings {
  readonly SOLVE_GITHUB_OWNER: string;
}

export function parseSolveArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let phase: SolvePhase = "plan";
  let advance = false;
  let namedRung = false;

  for (const arg of argv) {
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === ADVANCE_FLAG) {
      advance = true;
      continue;
    }
    const named = PHASE_FLAGS.get(arg);
    if (named === undefined) {
      return { ok: false, error: `unknown flag: ${arg}` };
    }
    namedRung = true;
    // Highest wins. `--claim --pr` has one coherent reading.
    if (rank(named) > rank(phase)) {
      phase = named;
    }
  }

  if (positional.length > 1) {
    return {
      ok: false,
      error: `expected at most one issue key, got ${positional.length}: ${positional.join(" ")}`,
    };
  }

  const issueKey = positional[0] ?? null;

  if (advance) {
    // Refused, not resolved. See `ADVANCE_FLAG`.
    if (namedRung) {
      return {
        ok: false,
        error: `${ADVANCE_FLAG} cannot be combined with --${phase} — advancing acts on a pull request that already exists, so there is no coherent order for the two`,
      };
    }
    if (issueKey === null) {
      return {
        ok: false,
        error: `${ADVANCE_FLAG} needs an issue key — it would otherwise push a commit to every open pull request the queue knows about`,
      };
    }
    return { ok: true, invocation: { mode: "advance", issueKey } };
  }

  if (issueKey === null && writes(phase)) {
    return {
      ok: false,
      error: `${phase === "claim" ? "--claim" : `--${phase}`} needs an issue key — it would otherwise run against every ticket in the queue`,
    };
  }

  return { ok: true, invocation: { mode: "ladder", issueKey, phase } };
}
