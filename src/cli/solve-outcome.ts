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

import type { AdvanceOutcome } from "../solve/delivery.ts";
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
 *
 * `unusable-base` is a failure by that rule even though it is the cheapest
 * outcome here — it stops before the model runs, so it costs almost nothing.
 * The exit code is not about money. No question was answered, and the operator
 * has something to fix that a re-run will not fix by itself.
 *
 * That same rule is what splits `abandoned` down the middle. A `judgement`
 * abandon is an answer — the model read the code and said no — and exits zero
 * for the reason `bailed` does. An `environment` abandon is `crashed` wearing a
 * different word: the machine got in the way, no question was answered, and the
 * run was paid for. Grouping the whole kind either way would hide one of them.
 */
export function isFailureExit(outcome: SolveOutcome): boolean {
  return (
    outcome.kind === "failed" ||
    outcome.kind === "refused" ||
    outcome.kind === "no-worktree" ||
    outcome.kind === "crashed" ||
    outcome.kind === "unusable-base" ||
    (outcome.kind === "abandoned" && outcome.cause === "environment")
  );
}

/** One line an operator can act on, per outcome. */
export function describeSolveOutcome(outcome: SolveOutcome): string {
  switch (outcome.kind) {
    case "no-worktree": {
      return `NO WORKTREE — the run never started: ${outcome.reason}`;
    }
    case "unusable-base": {
      // The worktree is named because it is the evidence. This outcome exists
      // for builds that pass in a normal checkout and fail in a linked one, so
      // "reproduce it in the repo" is the wrong first instruction — reproduce
      // it here.
      return `UNUSABLE BASE — ${outcome.reason}\nWorktree kept at ${outcome.worktree.path} — reproduce there, not in the main checkout, since that is the difference this found`;
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
      // The operator's next move is different in each case, which is the whole
      // reason the cause exists: `judgement` means read the reason and decide
      // whether the ticket was misjudged; `environment` means look at what
      // stopped the machine, and re-running is a reasonable thing to do.
      return outcome.cause === "environment"
        ? `ABANDONED (environment) — the machine got in the way, so this says nothing about the ticket: ${outcome.reason}\nWorktree kept at ${outcome.worktree.path}`
        : `ABANDONED (judgement) — a pass read the code and declined: ${outcome.reason}\nWorktree kept at ${outcome.worktree.path}`;
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

/**
 * Whether a review round should set `$?`.
 *
 * The same rule as `isFailureExit` — *did this produce a usable answer* — and
 * the same two cases it is easy to get wrong, in a new shape:
 *
 * - **`waiting` is a success.** Nobody has commented yet. That is the loop
 *   working, and it is what most invocations will return; exiting non-zero for
 *   it would make a correctly idle poller look like a broken one.
 * - **`abandoned` is a success.** A pass read the reviewer's comment and
 *   declined to act on it. A human takes the pull request from there, which is
 *   the outcome the review round exists to be able to reach.
 *
 * `exhausted` also exits zero: the cap firing is the cap working. The caller
 * still has to say so on the ticket, which is a different obligation from an
 * exit code.
 *
 * `capped` exits zero for the same reason and it is the one worth arguing
 * about, because unlike `exhausted` it means a pull request has cost twenty
 * rounds and is being abandoned mid-review. That is a bad state and it is
 * tempting to make `$?` say so. It must not: the brake firing is the brake
 * working, and a non-zero exit would teach a daemon's backoff to treat the
 * safety stop as an outage — retrying the one pull request that has already
 * proved it should be left alone.
 */
export function isAdvanceFailureExit(outcome: AdvanceOutcome): boolean {
  return outcome.kind === "failed" || outcome.kind === "refused";
}

/** One line an operator can act on, per review-round outcome. */
export function describeAdvanceOutcome(outcome: AdvanceOutcome): string {
  switch (outcome.kind) {
    case "waiting": {
      return `WAITING — the reviewer has not said anything yet, so nothing ran and nothing was pushed`;
    }
    case "ready": {
      return `READY — the reviewer left nothing to act on after ${String(outcome.rounds)} round(s); the pull request is out of draft`;
    }
    case "iterated": {
      // The re-request is reported on its own line rather than folded into the
      // headline, because the two facts have different owners: the round
      // succeeded and is nobody's problem, while a reviewer who was not asked
      // again is a human clicking one button.
      return (
        // Whether anything was pushed is read off the round, not assumed from
        // the kind. A round that answers a reviewer without touching code is a
        // successful round, and the headline used to call it a push — sending
        // an operator to look for a commit that does not exist, and teaching
        // them to distrust the rest of the line.
        (outcome.pushed
          ? `ITERATED — round ${String(outcome.round)} pushed.`
          : `ITERATED — round ${String(outcome.round)} answered without changing code, so nothing was pushed.`) +
        ` Responses:\n` +
        outcome.responses.map((response) => `  - ${response}`).join("\n") +
        (outcome.reviewerRequested
          ? `\nThe reviewer was asked to look again.`
          : `\nThe reviewer was NOT asked to look again — add them by hand, or nothing will re-read this.`) +
        `\nInline threads: ${String(outcome.threads.answered)} answered, ${String(outcome.threads.resolved)} resolved.` +
        // Same reasoning as the re-request line above. A reply that would not
        // post is a decline nobody can see, which on the pull request is
        // indistinguishable from the comment never having been read — and the
        // round itself succeeded, so nothing else will draw attention to it.
        (outcome.threads.failures.length === 0
          ? ""
          : `\nCould not post:\n${outcome.threads.failures.map((line) => `  - ${line}`).join("\n")}`) +
        // Printed on a successful round, not only on an exhausted one. This is
        // the field the skill calls "what tells a human to stop the loop and
        // look", and a round that succeeded is exactly when nobody goes looking.
        (outcome.unresolved === "" ? "" : `\nUnresolved:\n${outcome.unresolved}`)
      );
    }
    case "exhausted": {
      return (
        `EXHAUSTED — ${String(outcome.rounds)} round(s) spent and the reviewer still has comments open. ` +
        `Undrafted anyway; a human decides from here.\nUnresolved:\n${outcome.unresolved}`
      );
    }
    case "capped": {
      // Deliberately does not say "undrafted", because it is not. `exhausted`
      // is a reviewer running out of turns on a pull request the loop still
      // believes in; this is the machinery hitting a stop, which says nothing
      // about whether the code is ready.
      return (
        `CAPPED — ${String(outcome.rounds)} round(s) on this pull request, the absolute limit. ` +
        `Nothing ran and the pull request was left as it is, still a draft if it was one. ` +
        `Something is wrong for this to have cost twenty rounds; read it before raising the cap.` +
        `\nUnresolved:\n${outcome.unresolved}`
      );
    }
    case "abandoned": {
      return `ABANDONED (this is not a failure) — a pass read the review and declined: ${outcome.reason}`;
    }
    case "refused": {
      return `REFUSED at the ${outcome.stage} — ${outcome.reasons.join("; ")}\nNothing was pushed.`;
    }
    case "failed": {
      return `FAILED at the ${outcome.stage} stage — ${outcome.reason}`;
    }
  }
}
