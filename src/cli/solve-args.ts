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
 * ```
 *
 * Each flag is a whole phase's worth of privilege, so the command line reads as
 * the escalation it is. Passing two is not an error — the highest wins, because
 * `--claim --pr` can only coherently mean "go as far as the pull request".
 *
 * ## `--solve` does not write the claim, and the ladder is not a chain
 *
 * This used to say each flag implies the ones before it. That was a tidy
 * sentence and it contradicted the line right above it, which promised that
 * `--solve` lets nothing leave the machine: `--claim` writes a label to Jira,
 * which is something leaving the machine. Both could not be true.
 *
 * Resolved in favour of the safety claim. `--solve` runs the solver against a
 * ticket the operator named and writes nothing to Jira, so a solve can be
 * watched end to end before the board is ever touched. The phases also landed
 * out of order for the same reason — C (the solver) is wired while B2 (the
 * claim) is not — so `--claim` refuses while `--solve` works. That inversion
 * looks wrong until you notice the claim is the only one of the two that is
 * visible to anybody else.
 *
 * What the ordering still means is privilege, read as blast radius: `--solve`
 * can change files in a temporary worktree, `--pr` can put them in front of
 * other people, and `--claim` writes to a board a team reads. They are not
 * cumulative, and a future change that makes them cumulative should say so
 * here rather than leaving this comment to rot.
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
export const PHASES = ["plan", "claim", "solve", "pr"] as const;

export type SolvePhase = (typeof PHASES)[number];

/** Which flag turns on which phase. `plan` has none: it is what you get for free. */
const PHASE_FLAGS: ReadonlyMap<string, SolvePhase> = new Map([
  ["--claim", "claim"],
  ["--solve", "solve"],
  ["--pr", "pr"],
]);

export const USAGE =
  "usage: solve-once [<ISSUE-KEY>] [--claim | --solve | --pr]\n" +
  "  (no arguments)          the whole queue, reporting the claims it would make\n" +
  "  <ISSUE-KEY>             one ticket, same reporting\n" +
  "  <ISSUE-KEY> --claim     writes the claim label (not wired yet)\n" +
  "  <ISSUE-KEY> --solve     runs the solver; no Jira write, nothing pushed\n" +
  "  <ISSUE-KEY> --pr        ... and opens the draft pull request\n";

export interface SolveInvocation {
  /** `null` means the whole queue. Only ever null at the `plan` phase. */
  readonly issueKey: string | null;
  readonly phase: SolvePhase;
}

export type ParsedArgs =
  | { readonly ok: true; readonly invocation: SolveInvocation }
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
 * Why a phase cannot run yet, or `null` when it can.
 *
 * The ladder is fully parsed and only its bottom rung is wired, so every rung
 * above it has to refuse. Kept in one function so the answer to "what is
 * missing" is a sentence an operator can read rather than an archaeology
 * exercise, and so landing a phase means deleting one branch here instead of
 * hunting for the guard.
 *
 * Each reason names the *structural* reason rather than a policy: nothing in
 * this process can make the edit, because no function capable of it was
 * composed. That is the same claim the phase table in the plan makes, and it is
 * checkable by reading `wiring.ts`.
 */
export function unavailable(phase: SolvePhase): string | null {
  switch (phase) {
    case "plan": {
      return null;
    }
    case "claim": {
      return "the label write path is not wired (phase B2) — `createSolveDeps` composes readers only, so no function in this process can edit a label. Note this refuses while --solve does not; see the header, the ladder is not cumulative";
    }
    case "solve": {
      // Wired. `createSolveRunDeps` composes the `CommandRunner` and the
      // `PassRunner`, which is the whole of phase C's privilege.
      return null;
    }
    case "pr": {
      return "delivery is not wired (phase D) — `src/solve/delivery.ts` exists but nothing constructs its dependencies";
    }
  }
}

export function parseSolveArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let phase: SolvePhase = "plan";

  for (const arg of argv) {
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const named = PHASE_FLAGS.get(arg);
    if (named === undefined) {
      return { ok: false, error: `unknown flag: ${arg}` };
    }
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

  if (issueKey === null && writes(phase)) {
    return {
      ok: false,
      error: `${phase === "claim" ? "--claim" : `--${phase}`} needs an issue key — it would otherwise run against every ticket in the queue`,
    };
  }

  return { ok: true, invocation: { issueKey, phase } };
}
