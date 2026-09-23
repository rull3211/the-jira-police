/**
 * How a solve outcome reaches an operator's terminal, and what it does to `$?`.
 *
 * Split out of `solve-once.ts` for the same reason `solve-args.ts` was: that file ends in a
 * top-level `await`, so importing it runs the command.
 *
 * `feedback.ts` renders the same outcomes for a Jira ticket — this is not that, and merging them
 * would be a mistake: the ticket comment is for whoever owns the bug, this is for whoever is
 * driving the harness by hand. Both must refuse to let a refusal read like a verdict.
 */

import type { AdvanceOutcome, ReRequest, Undraft } from "../solve/delivery.ts";
import type { ReviewStage, SolveOutcomeLabel } from "../solve/labels.ts";
import { hasGoneQuiet } from "../solve/silence.ts";
import type { SolveOutcome } from "../solve/orchestrator.ts";
import type { ReviewCycleOutcome } from "../solve/review-cycle.ts";

/**
 * Whether the shell should hear about this.
 *
 * A bail is a success and must not set a code — recon declining is the honest answer to a
 * fitness call made without source access. `crashed` does set one: nothing was learned and the
 * run cost real money, even though it is not a verdict about the code. `unusable-base` fails by
 * the same rule even though it is the cheapest outcome — no question was answered.
 *
 * The same rule splits `abandoned`: a `judgement` abandon is an answer and exits zero like
 * `bailed`; an `environment` abandon is `crashed` wearing a different word.
 */
export function isFailureExit(outcome: SolveOutcome): boolean {
  return (
    outcome.kind === "failed" ||
    outcome.kind === "refused" ||
    outcome.kind === "no-worktree" ||
    outcome.kind === "crashed" ||
    outcome.kind === "unusable-base" ||
    // The outcome an operator most needs `$?` non-zero for: it looks otherwise successful, and
    // under a daemon a zero exit would let a pipeline move on from a solve that wrote into a
    // repository nobody is watching.
    outcome.kind === "escaped" ||
    (outcome.kind === "abandoned" && outcome.cause === "environment")
  );
}

/**
 * The label a finished solve leaves behind, or `null` to release the ticket.
 *
 * `null` means put the ticket back exactly as found, so the queue offers it again on its own —
 * reserved now for the two outcomes where that is actually the right answer. `verified` needs no
 * terminal label because it is not terminal: `runWriteRungs` hands the ticket to
 * `reviewTransition` instead. `escaped` stays a release for a reason specific to it, not to the
 * family it used to sit in: its own docstring says the commonest cause is an operator editing
 * their own checkout mid-run, which is not a fact about the ticket at all, so labelling one would
 * name the wrong culprit.
 *
 * Every other outcome now writes `agent:failed` — `bailed` (§5's case: recon read the code and
 * declined) and bad diffs, but also every "no verdict reached" outcome (`refused`, `crashed`,
 * `unusable-base`, `no-worktree`, an environment `abandoned`) that used to release just like this
 * one. That used to be the more careful answer:
 * `architecture/solve.md`'s outcome table argues at length that `refused` must never be *reported*
 * as `failed`, because the ticket's own comment (`describeSolveOutcome`, `feedback.ts`) is what a
 * human reads to find the actual cause, and flattening the prose there would blame a broken
 * harness on a fix. That argument still holds and nothing here touches it — the comment for each
 * outcome kind stays exactly as specific as before. What changed is the label's job: a ticket
 * whose attempt ended without a pull request and without a plan to try again automatically must
 * not look, on the board, identical to one nobody has tried — SSX-3954 sat in `unusable-base`
 * (this harness's Maven toolchain against a repository's pinned Lombok version, reproduced and
 * unrelated to the ticket) and was silently reclaimed every tick the in-memory attempt ledger had
 * forgotten, across every restart, forever. `agent:failed` is now that stop sign for every one of
 * them: a human reads the comment for the real reason, fixes it if there is anything to fix, and
 * removes the label by hand — the same recovery path `bailed` already used.
 *
 * The cost is real and is named rather than hidden: `agent:failed` no longer means only "the
 * change was bad" for triage's own calibration reading (`runSolver`'s comment: recon's
 * `devLensAccurate` is the only feedback `agent:solvable` ever gets, and it is read against this
 * label). A human auditing that calibration now has to open the ticket's comment to tell "the fix
 * was wrong" from "the harness could not judge it" apart — the type-level distinction the rest of
 * this module carries did not disappear, it just stopped being visible from the label alone.
 *
 * This is deliberately not `!isFailureExit`: that asks whether a usable answer came back, this
 * asks whether the ticket's fate is decided — they still disagree on both of the exceptions above
 * (`bailed` and a `judgement` abandon exit `0` and are labelled; `escaped` exits `1` and is not),
 * so deriving one from the other would still let an exit-code change silently relabel tickets.
 */
export function terminalLabelAfter(outcome: SolveOutcome): SolveOutcomeLabel | null {
  return outcome.kind === "verified" || outcome.kind === "escaped" ? null : "failed";
}

/**
 * Whether this outcome is said out loud on the ticket.
 *
 * Split from `terminalLabelAfter` after SSX-3832 (2026-09-05): a hook denied a write pass its
 * `Write` tool, the run ended `abandoned`/`environment`, released every label byte-for-byte, and
 * posted nothing — indistinguishable on the board from a ticket nobody had picked up. Answering
 * "did this run spend a claim on this ticket" with "is this ticket's fate decided" is what
 * produced that silence.
 *
 * `verified` is the one exclusion: it opens a pull request, and the pull request is the
 * notification, so commenting too would say the same thing twice.
 */
export function reportsToTicket(outcome: SolveOutcome): boolean {
  return outcome.kind !== "verified";
}

/** One line an operator can act on, per outcome. */
export function describeSolveOutcome(outcome: SolveOutcome): string {
  switch (outcome.kind) {
    case "no-worktree": {
      return `NO WORKTREE — the run never started: ${outcome.reason}`;
    }
    case "unusable-base": {
      // The path is kept but not held: the next run for this ticket moves it to a
      // `-salvaged-<timestamp>` sibling and puts a fresh checkout here, so a reproduction still
      // running in it can be moved out from under itself (observed 2026-09-11, a Maven run whose
      // working directory followed the rename while `-Dmaven.multiModuleProjectDirectory` named
      // the replacement) — the warning is in the line, not a comment only we can see.
      return `UNUSABLE BASE — ${outcome.reason}\nWorktree kept at ${outcome.worktree.path} — reproduce there, not in the main checkout, since that is the difference this found\nIt is kept, not held: the next run for this ticket moves it to a -salvaged-<timestamp> sibling and puts a fresh checkout at that path, so copy it aside before you rely on it, and stop the daemon while you work in it`;
    }
    case "bailed": {
      // The one outcome whose worktree may be gone, so this reads the cleanup result rather than
      // assuming it — printing "kept at <path>" for a directory that no longer exists would send
      // an operator to an empty path.
      return `BAILED (this is a success) — recon declined: ${outcome.reason}\n${
        outcome.cleanup.outcome === "removed"
          ? `Worktree removed — recon writes nothing, so there was nothing in it`
          : `Worktree kept at ${outcome.cleanup.path} — ${outcome.cleanup.reason}`
      }`;
    }
    case "abandoned": {
      // The operator's next move differs by cause: `judgement` means read the reason and decide
      // whether the ticket was misjudged; `environment` means look at what stopped the machine.
      return outcome.cause === "environment"
        ? `ABANDONED (environment) — the machine got in the way, so this says nothing about the ticket: ${outcome.reason}\nWorktree kept at ${outcome.worktree.path}`
        : `ABANDONED (judgement) — a pass read the code and declined: ${outcome.reason}\nWorktree kept at ${outcome.worktree.path}`;
    }
    case "refused": {
      return `REFUSED at the ${outcome.stage} — ${outcome.reasons.join("; ")}\nWorktree kept at ${outcome.worktree.path}`;
    }
    case "escaped": {
      // Prints `git status` for the operator: the first question anyone asks here is "was that
      // me?", and one forced to compose the command themselves will instead assume the machine
      // is wrong.
      return [
        `ESCAPED — something outside this run's working copy changed while it ran, so nothing is being offered${
          outcome.would === "verified"
            ? " (the change itself had passed every check)"
            : ` (the run was otherwise ${outcome.would})`
        }.`,
        ...outcome.paths.map((path) => `  ${path} — inspect with: git -C ${path} status`),
        `If that was your own editing, re-run; this guard cannot tell your writes from a pass's.`,
        `Worktree kept at ${outcome.worktree.path}`,
      ].join("\n");
    }
    case "failed": {
      if (outcome.repairOutcome === undefined) {
        return `FAILED — ${outcome.reason}\nWorktree kept at ${outcome.worktree.path}`;
      }
      const risk = outcome.repair?.residualRisk.trim() ?? "";
      return [
        `FAILED — ${outcome.reason}`,
        // The verdict is stated as discarded rather than merely omitted: a reader who sees
        // "verified" anywhere near a repair round will otherwise take it as the run's answer.
        outcome.repairOutcome === "verified"
          ? `A repair round ran and its corrected diff passed. That verdict is DISCARDED, not acted on — the pass has never been watched working, and deleting the assertion that failed reaches green the same way.`
          : `A repair round ran and ended ${outcome.repairOutcome}, so it did not rescue the run either.`,
        ...(risk === "" ? [] : [`The repair flagged this about its own edit: ${risk}`]),
        // The reason above was measured before the round, so the tree it names no longer produces it.
        `The worktree now holds the round's edits on top of the diff that failed, so it no longer reproduces the reason above.`,
        `Read the round's edits alone: git -C ${outcome.worktree.path} diff HEAD`,
        `and the fix they correct, committed underneath: git -C ${outcome.worktree.path} show HEAD (a solve.repair.boundary_failed warning above means it is not)`,
        `Set REPAIR_ROUND=false to stop buying this round.`,
        `Worktree kept at ${outcome.worktree.path}`,
      ].join("\n");
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
 * Same rule as `isFailureExit`. `waiting` and `abandoned` are successes — an idle poller or a
 * declined comment, not a failure. `reviewer-exhausted` and `capped` exit zero too: a round-cap
 * firing is the cap working, and a non-zero exit would teach a daemon's backoff to treat a safety
 * stop as an outage. `stalled` exits zero for the same reason — each failed attempt already set
 * `$?` non-zero at the time, so the stall itself adds no new information, and a non-zero exit
 * here would drive the retry a stall exists to stop.
 */
export function isAdvanceFailureExit(outcome: AdvanceOutcome): boolean {
  return outcome.kind === "failed" || outcome.kind === "refused";
}

/**
 * Whether `--review` should run another round, and what to call the ending.
 *
 * The chain's termination logic as a pure function over one outcome, so the loop that consumes
 * it only sleeps, counts, and obeys. Only `waiting` and `iterated` continue; every other outcome
 * stops, with the default arm written to stop so a new outcome must be argued into the loop
 * rather than fall into it.
 *
 * Undrafting always ends the chain here even though §6.1 keeps the daemon's loop listening after
 * undraft — this is a foreground command, so "keep listening" would block a terminal for however
 * long a human takes to review. `ready` and `reviewer-exhausted` stop (both undrafted), and
 * `iterated` stops when it undrafted itself, which is §6.1c's rule that a round changing nothing
 * has finished.
 *
 * `silent` is a separate question from `stop`: it marks the one outcome — the reviewer saying
 * nothing — that the round caps (`MAX_PR_ROUNDS_TOTAL`, `MAX_REVIEW_ITERATIONS`) cannot see at
 * all, since a silent reviewer produces no rounds to count.
 *
 * The silence bound is read off `silenceMs` (how long the pull request has actually been quiet)
 * rather than counted here, since a poll-count bound makes patience a product of the poll
 * interval — see `silence.ts`. It is a parameter rather than a closed-over setting because the
 * daemon and this foreground command apply different policies to the same measurement.
 */
export interface ChainDecision {
  readonly stop: boolean;
  /** True only when the reviewer has not spoken. */
  readonly silent: boolean;
  /** One line, for the operator, naming why the chain did what it did next. */
  readonly why: string;
}

export function chainDecision(outcome: AdvanceOutcome, silenceMs: number): ChainDecision {
  switch (outcome.kind) {
    case "waiting": {
      // Unmeasurable reads as "keep looking" — hasGoneQuiet's rule, not a guess here — so a
      // bound that fires when it cannot measure never ends the chain on an unread payload.
      return hasGoneQuiet(outcome.quietMs, silenceMs)
        ? {
            stop: true,
            silent: true,
            why: `nothing has happened on the pull request for ${String(Math.round((outcome.quietMs ?? 0) / 60000))} minutes — leaving it as it is; run --advance later, or check the reviewer was actually requested`,
          }
        : { stop: false, silent: true, why: "the reviewer has not said anything yet" };
    }
    case "iterated": {
      // The draft flag, not `pushed` — same choice as `reviewStageAfter`, since a round can push
      // nothing and still be finished, or push and still hold the draft deliberately.
      return outcome.undrafted === "undrafted"
        ? {
            stop: true,
            silent: false,
            why: "the round undrafted the pull request — a human has it now",
          }
        : {
            stop: false,
            silent: false,
            why: `round ${String(outcome.round)} ${outcome.pushed ? "pushed" : "answered without pushing"}, so the reviewer gets another look`,
          };
    }
    case "synced": {
      // Continues rather than falling to `default`: a merge round answers the base, not the
      // reviewer, so feedback that was waiting is still waiting and stopping here would end the
      // chain one step early. Not `silent` — a merge round did work, so the wall-clock quiet
      // bound must reset. Cannot spin: a merge round spends one of MAX_PR_ROUNDS_TOTAL like any
      // other, so a base that keeps moving runs the count out and stops at `capped`.
      return {
        stop: false,
        silent: false,
        why: `round ${String(outcome.round)} merged ${String(outcome.behind)} commit(s) of the base in, so the next round reads the review against a current branch`,
      };
    }
    case "ready": {
      return { stop: true, silent: false, why: "nothing left to act on — undrafted" };
    }
    case "reviewer-exhausted": {
      return {
        stop: true,
        silent: false,
        why: "the reviewer's round budget is spent; undrafted anyway",
      };
    }
    case "capped": {
      return {
        stop: true,
        silent: false,
        why: "MAX_PR_ROUNDS_TOTAL reached — the pull request is left in draft for a human",
      };
    }
    case "stalled": {
      // Not `silent`, even though nothing was heard from the reviewer either: a stall means work
      // was there every time and this side couldn't get to it, the opposite claim from a slow
      // reviewer — marking it silent hid this local breakage for four days.
      return {
        stop: true,
        silent: false,
        why: `${String(outcome.attempts)} attempts to start a round have failed in a row — leaving it; the last said: ${outcome.reason}`,
      };
    }
    case "abandoned": {
      return { stop: true, silent: false, why: `the pass declined: ${outcome.reason}` };
    }
    case "refused": {
      return { stop: true, silent: false, why: `refused at the ${outcome.stage}` };
    }
    default: {
      // `failed`, and anything added later — stopping by default so a new outcome that should
      // loop must be a deliberate edit here.
      return { stop: true, silent: false, why: "the round could not complete" };
    }
  }
}

/**
 * Which review stage the ticket should be in after this round, or `null`.
 *
 * The pull request's draft flag is the source of truth; this reads only what the round did to
 * the draft, never what it concluded. `null` is the answer for every outcome that left the draft
 * flag alone — `capped`, `abandoned`, `refused` and the error kinds all deliberately leave the
 * pull request as they found it, so writing a label for them would override an earlier,
 * better-informed decision with a default.
 */
export function reviewStageAfter(outcome: AdvanceOutcome): ReviewStage | null {
  switch (outcome.kind) {
    // Undrafted, so a human is the only thing left — reviewer-exhausted reaches the same place by
    // a different road (budget spent rather than reviewer satisfied), a difference recorded in
    // the ticket comment since the pull request can't tell them apart either.
    case "ready":
    case "reviewer-exhausted": {
      return "review-done";
    }
    // Decided by the draft flag rather than `pushed` — they agree today (§6.1c: a round that
    // pushed stays a draft) but are different facts, so reading the one this label mirrors keeps
    // a future rule change from silently desyncing the board from the pull request.
    case "iterated": {
      return outcome.undrafted === "undrafted" ? "review-done" : "reviewing";
    }
    default: {
      return null;
    }
  }
}

/**
 * `gh`'s state string, narrowed to the two endings that mean something here.
 *
 * Anything not exactly `MERGED` reads as closed — the safe direction, since a future `gh`
 * spelling this service has never seen must not inflate the count of bugs it claims to have
 * fixed. Callers must rule `OPEN` out first; there is nothing sensible to return for it.
 */
export function endedState(state: string): "MERGED" | "CLOSED" {
  return state === "MERGED" ? "MERGED" : "CLOSED";
}

/**
 * The terminal label a finished pull request earns, and it is a metric.
 *
 * §3c: `agent:done` is merged only — a pull request a person closed unmerged is work completed
 * that nobody wanted, a different and more interesting number that disappears if the buckets are
 * folded together.
 *
 * A function rather than a ternary at each of the two call sites, so the rule §3c guards is not
 * encoded as the same literal twice.
 */
export function completionLabelFor(state: "MERGED" | "CLOSED"): SolveOutcomeLabel {
  return state === "MERGED" ? "done" : "closed";
}

/**
 * One line per re-request result, and only one of the three is a call to act.
 *
 * A table rather than a ternary: a round that pushed nothing sends no ping, and printing the
 * "NOT asked" warning for it would send a person to re-review an unchanged diff.
 */
const REREQUEST_LINE = {
  asked: `\nThe reviewer was asked to look again.`,
  failed: `\nThe reviewer was NOT asked to look again — add them by hand, or nothing will re-read this.`,
  unnecessary: `\nThe reviewer was not asked again — nothing was pushed, so there is nothing new to re-read.`,
} as const satisfies Record<ReRequest, string>;

/**
 * One line per draft transition, and again only one is a call to act.
 *
 * `still-drafting` says why, rather than reading as something gone wrong.
 */
const UNDRAFT_LINE = {
  undrafted: `\nThe pull request is out of draft — this side is done with it, a human takes it from here.`,
  failed: `\nThe pull request could NOT be taken out of draft — do it by hand, or nobody will review this.`,
  "still-drafting": `\nStill a draft: there is something new for the reviewer to read first.`,
} as const satisfies Record<Undraft, string>;

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
      // The re-request is reported on its own line, since the round succeeding and a reviewer
      // not being re-asked are different owners' problems.
      return (
        // Whether anything was pushed is read off the round, not assumed from the kind — a round
        // that answers without touching code used to be reported as a push.
        (outcome.pushed
          ? `ITERATED — round ${String(outcome.round)} pushed.`
          : `ITERATED — round ${String(outcome.round)} answered without changing code, so nothing was pushed.`) +
        ` Responses:\n` +
        outcome.responses.map((response) => `  - ${response}`).join("\n") +
        REREQUEST_LINE[outcome.reviewerRequested] +
        UNDRAFT_LINE[outcome.undrafted] +
        // A review body has no thread, so this is the only channel the round's answer to it has;
        // losing it leaves a reviewer's objection standing with the rebuttal unread.
        (outcome.spoken.outcome === "failed"
          ? `\nThe answer did NOT reach the pull request — ${outcome.spoken.reason}`
          : "") +
        `\nInline threads: ${String(outcome.threads.answered)} answered, ${String(outcome.threads.resolved)} resolved.` +
        // Same reasoning as the re-request line: a reply that would not post is a decline nobody
        // can see, indistinguishable on the pull request from the comment never being read.
        (outcome.threads.failures.length === 0
          ? ""
          : `\nCould not post:\n${outcome.threads.failures.map((line) => `  - ${line}`).join("\n")}`) +
        // Printed on a successful round too, not only an exhausted one — this is what tells a
        // human to stop the loop and look, and a successful round is exactly when nobody does.
        (outcome.unresolved === "" ? "" : `\nUnresolved:\n${outcome.unresolved}`)
      );
    }
    case "reviewer-exhausted": {
      return (
        `REVIEWER EXHAUSTED — ${String(outcome.rounds)} round(s) spent and the reviewer still has comments open. ` +
        `Undrafted anyway; a human decides from here, and a human's comment still gets a round.` +
        `\nUnresolved:\n${outcome.unresolved}`
      );
    }
    case "capped": {
      // Deliberately does not say "undrafted" — reviewer-exhausted is a reviewer out of turns on
      // a pull request the loop still believes in; this is the machinery hitting a stop.
      return (
        `CAPPED — ${String(outcome.rounds)} round(s) on this pull request, the absolute limit. ` +
        `Nothing ran and the pull request was left as it is, still a draft if it was one. ` +
        `Something is wrong for this to have cost twenty rounds; read it before raising the cap.` +
        `\nUnresolved:\n${outcome.unresolved}`
      );
    }
    case "stalled": {
      return (
        `STALLED — ${String(outcome.attempts)} attempts to start a round have failed in a row, so this pull request is being left alone. ` +
        `No round was reserved by any of them, which is why no round cap noticed. ` +
        `The failure is on this side, not the reviewer's: read the marker comment on the pull request for the list, ` +
        `and clear whatever is holding the checkout before running this again.` +
        `\nThe last attempt said: ${outcome.reason}`
      );
    }
    case "synced": {
      // Says out loud that the reviewer was not read this round, since it otherwise looks like
      // any other round — reserved, cost money, pushed a commit.
      return (
        (outcome.conflicts.length === 0
          ? `SYNCED — round ${String(outcome.round)} merged ${String(outcome.behind)} commit(s) of the base in cleanly and pushed.`
          : `SYNCED — round ${String(outcome.round)} merged ${String(outcome.behind)} commit(s) of the base in, resolving conflicts in ${outcome.conflicts.join(", ")}, and pushed.`) +
        `\nThe review was not read this round: a branch its base will not merge into cannot be verified, so the merge went first. The next round answers the reviewer.`
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

/**
 * One pass over the watched set, in the fewest lines that still say what it cost.
 *
 * Printed every tick forever, so counts that are usually zero are omitted, and `acted` always
 * names its tickets rather than counting them.
 *
 * `deferred` is never omitted when non-zero: it is the one number that says a bound
 * (`MAX_REVIEW_ROUNDS_PER_TICK`) actually bit, and hiding it would make the bound invisible at
 * exactly the moment it looks like the loop is ignoring a reviewer.
 */
export function describeReviewSweep(pass: number, outcome: ReviewCycleOutcome): string {
  const parts = [`pass ${String(pass)}: ${String(outcome.watched)} watched`];

  if (outcome.acted.length > 0) {
    parts.push(
      `${String(outcome.acted.length)} round(s) — ` +
        outcome.acted
          .map((entry) => `${entry.issueKey} #${String(entry.number)} ${entry.outcome.kind}`)
          .join(", "),
    );
  }
  if (outcome.settled.length > 0) {
    parts.push(`${String(outcome.settled.length)} settled without spending`);
  }
  if (outcome.ended.length > 0) {
    parts.push(
      `ended — ${outcome.ended.map((entry) => `${entry.issueKey} ${entry.state}`).join(", ")}`,
    );
  }
  if (outcome.deferred.length > 0) {
    parts.push(`${String(outcome.deferred.length)} deferred to the next pass`);
  }
  // Last, and always listed by ticket — a look that failed repeats identically every pass until
  // somebody reads the reason, so a bare count would scroll past forever saying nothing.
  if (outcome.unlooked.length > 0) {
    parts.push(
      `could not look at — ${outcome.unlooked.map((entry) => `${entry.issueKey}: ${entry.reason}`).join("; ")}`,
    );
  }

  return parts.join("\n  ");
}
