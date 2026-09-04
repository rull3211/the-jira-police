/**
 * How a solve outcome reaches an operator's terminal, and what it does to `$?`.
 *
 * Split out of `solve-once.ts` for the same reason `solve-args.ts` was: that
 * file ends in a top-level `await`, so importing it runs the command. Nothing
 * in it could be tested without spawning a process and reading stdout, which is
 * why the exit-code rule below went unverified through four real solve runs.
 *
 * ## Two audiences, deliberately not one renderer
 *
 * `feedback.ts` renders the same outcomes for a Jira ticket. This is not that,
 * and merging them would be a mistake: the ticket comment is read by whoever
 * owns the bug and says what it means for their work, while this is read by
 * whoever is driving the harness by hand and says what to do next — which
 * worktree to open, which command to re-run. The one thing both must do is
 * refuse to let a refusal read like a verdict, and each does it in its own
 * register. Both have a test saying so.
 */

import type { SolveOutcome } from "../solve/orchestrator.ts";

/**
 * Whether the shell should hear about this.
 *
 * A bail is a **success** and must not set a code: recon declining is the
 * honest answer to a fitness call made without source access, and a non-zero
 * exit there would train an operator — and later a daemon's backoff — to treat
 * the pipeline working correctly as an error.
 *
 * `crashed` does set one, and it is the case most easily got wrong. It is not a
 * verdict about the code, which is what makes it tempting to group with `bailed`;
 * but nothing was learned, the run cost real money, and a person driving this by
 * hand needs `$?` to say so rather than reading past a line of output. The rule
 * is "did this produce a usable answer", not "was the code bad".
 */
export function isFailureExit(outcome: SolveOutcome): boolean {
  return (
    outcome.kind === "failed" ||
    outcome.kind === "refused" ||
    outcome.kind === "no-worktree" ||
    outcome.kind === "crashed"
  );
}

/** One line an operator can act on, per outcome. */
export function describeSolveOutcome(outcome: SolveOutcome): string {
  switch (outcome.kind) {
    case "no-worktree": {
      return `NO WORKTREE — the run never started: ${outcome.reason}`;
    }
    case "bailed": {
      // The one outcome whose worktree may be gone, so this is the one line
      // that has to read the cleanup result rather than assume. Printing
      // "Worktree kept at <path>" for a directory that no longer exists is
      // exactly the prose/behaviour divergence this project exists to catch,
      // and it would send an operator to an empty path to find out why.
      return `BAILED (this is a success) — recon declined: ${outcome.reason}\n${
        outcome.cleanup.outcome === "removed"
          ? `Worktree removed — recon writes nothing, so there was nothing in it`
          : `Worktree kept at ${outcome.cleanup.path} — ${outcome.cleanup.reason}`
      }`;
    }
    case "abandoned": {
      return `ABANDONED — a pass declined mid-run: ${outcome.reason}\nWorktree kept at ${outcome.worktree.path}`;
    }
    case "refused": {
      return `REFUSED at the ${outcome.stage} — ${outcome.reasons.join("; ")}\nWorktree kept at ${outcome.worktree.path}`;
    }
    case "failed": {
      return `FAILED — ${outcome.reason}\nWorktree kept at ${outcome.worktree.path}`;
    }
    case "crashed": {
      return `CRASHED at the ${outcome.pass} pass — no verdict was reached, so this says nothing about the code: ${outcome.reason}\nWorktree kept at ${outcome.worktree.path}`;
    }
    case "verified": {
      return [
        `VERIFIED — ${outcome.files} file(s), ${outcome.lines} line(s) changed.`,
        `Commit would be: ${outcome.commit.subject}`,
        `Nothing was pushed and nothing was written to Jira.`,
        `Read the diff yourself: git -C ${outcome.worktree.path} diff ${outcome.worktree.branch}`,
      ].join("\n");
    }
  }
}
