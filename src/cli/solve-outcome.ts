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

import type { AdvanceOutcome, ReRequest, Undraft } from "../solve/delivery.ts";
import type { ReviewStage, SolveOutcomeLabel } from "../solve/labels.ts";
import { hasGoneQuiet } from "../solve/silence.ts";
import type { SolveOutcome } from "../solve/orchestrator.ts";
import type { ReviewCycleOutcome } from "../solve/review-cycle.ts";

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
    // No question was answered and the run was paid for, which is the rule
    // above applied unchanged. It is also the outcome an operator most needs
    // `$?` to be non-zero for: the run looks otherwise successful, and under a
    // daemon a zero here would let a pipeline move on from a solve that wrote
    // into a repository nobody is watching.
    outcome.kind === "escaped" ||
    (outcome.kind === "abandoned" && outcome.cause === "environment")
  );
}

/**
 * The label a finished solve leaves behind, or `null` to release the ticket.
 *
 * `null` does not mean "nothing happened". It means *put the ticket back exactly
 * as it was found*, which is the right answer for every outcome that says
 * nothing about the ticket: a crashed pass, an unusable base, a machine that got
 * in the way. Re-running those is sensible, and a label excluding the ticket
 * from the queue would convert a transient failure into a permanent one that
 * only a human could clear.
 *
 * `failed` is the opposite case, and until this function nothing produced it.
 * The label existed, `completionTransition` knew how to write it, and no
 * production caller ever asked — so the `failed` arm was built, tested and
 * unreachable. What that cost is the argument for this function: a bailed ticket
 * was restored byte-for-byte and became indistinguishable from one nobody had
 * tried, so in auto mode the queue re-claimed it every tick and paid for triage
 * and recon each time, **with no condition that could ever clear it**, because
 * the thing that would clear it was the label with no writer. Observed on
 * SSX-3831, 2026-09-05, where recon declined correctly and the ticket came back
 * carrying `agent:solvable` as though the run had never happened.
 *
 * ## Two outcomes qualify, and this is deliberately not `!isFailureExit`
 *
 * `bailed` is §5's case: recon read the code and declined. `abandoned` with
 * cause `judgement` is the same statement one pass later — the doc on that
 * variant calls it "a verdict about the ticket", against `environment`, which
 * "says nothing whatever about the ticket".
 *
 * Those happen to be the two non-success outcomes that exit zero, so this could
 * be spelled as `isFailureExit` inverted, and it is not. That rule asks *did
 * this produce a usable answer*, for the benefit of `$?` and a daemon's backoff.
 * This one asks *is this ticket's fate now decided*, for the benefit of a queue.
 * They agree today and they are two different questions — the same reasoning
 * that keeps `reviewStageAfter` on the draft flag rather than on `pushed`.
 * Deriving one from the other would let a change to an exit code silently
 * relabel tickets, which is a long way from where anyone would look.
 *
 * ## What this deliberately leaves open
 *
 * `refused` and `failed` keep releasing. An agent did work and it was not
 * accepted — neither a verdict about the ticket nor a fault of the machine — and
 * a re-run may well succeed, so they stay retryable. The cost of that is honest
 * and worth stating: auto mode can still spend repeatedly on one of them.
 *
 * `escaped` releases too, and for the stronger version of the same reason: its
 * commonest cause is expected to be the operator editing their own checkout
 * while a solve ran, which is not a fact about the ticket at all. It joins the
 * list of outcomes waiting on E's attempt count rather than getting a label.
 * Bounding *that* wants a per-ticket attempt count rather than a terminal label,
 * and it belongs with E, where the thing doing the retrying first exists.
 */
export function terminalLabelAfter(outcome: SolveOutcome): SolveOutcomeLabel | null {
  if (outcome.kind === "bailed") {
    return "failed";
  }
  return outcome.kind === "abandoned" && outcome.cause === "judgement" ? "failed" : null;
}

/**
 * Whether this outcome is said out loud on the ticket.
 *
 * Until 2026-09-05 there was no such function: the commenter was gated on
 * `terminalLabelAfter(outcome) !== null`, and the comment at that call site
 * argued the fusion was the point — "the label and the comment are one
 * statement". They are not, and the fusion had a failure mode nobody predicted
 * because it is invisible by construction.
 *
 * ## What silence actually looked like
 *
 * SSX-3832, 2026-09-05. A local policy hook denied the write pass its `Write`
 * tool, so the run ended `abandoned` with cause `environment`. Before that it
 * had claimed the ticket, written fifteen labels, cut a worktree, verified the
 * base build green on all four steps, and paid for triage, recon and a fix pass.
 * Then it released every label byte-for-byte and posted nothing, because
 * `environment` writes no terminal label. **The board was identical to a ticket
 * nobody had ever picked up.** Somebody asking "did the bot try this one?" had
 * no way to find out short of reading a terminal that had already scrolled.
 *
 * ## Two questions, and only one of them is about the ticket's fate
 *
 * `terminalLabelAfter` asks *is this ticket's fate decided*, and its answer must
 * stay narrow: a hook denial or a slept laptop says nothing about the ticket, so
 * labelling it would convert a transient failure into one only a human can
 * clear. That reasoning is sound and is unchanged.
 *
 * This asks *did this run spend a claim on this ticket*, which is true of every
 * outcome above, including all the ones that must not be labelled. Answering the
 * second question with the first is what produced the silence — the narrowness
 * that is correct for a queue is exactly wrong for a reader.
 *
 * ## Why the old argument for silence does not survive
 *
 * It was noise: `feedback.ts` phrases these as "this says nothing about whether
 * the ticket is solvable", and posting that on somebody's bug every time a
 * laptop slept was judged worse than saying nothing. But silence is only kind
 * when the alternative is noise, and here the alternative is a team guessing
 * whether the tool ran at all. A sentence saying "this is about the machine, not
 * your ticket" is worth more than an unexplained gap, because the gap is
 * indistinguishable from the tool being switched off.
 *
 * The honest cost is stacking. Nothing here writes a label, so under E the same
 * ticket can be re-claimed and abandoned nightly, and `commenter.ts` has no read
 * tool with which to find and rewrite its own last comment. That is real, it is
 * the noise the old gate was reaching for, and the fix for it is the
 * transient/deterministic split plus a per-ticket attempt count — both of which
 * belong with E, where the thing doing the retrying first exists. Hand-driven
 * runs, which is all there are today, post once per invocation by a person.
 *
 * ## `verified` is the one exclusion, and it is not an exception
 *
 * A verified run is the only outcome that already announces itself: it goes on
 * to open a pull request, and the pull request is the notification. Commenting
 * as well would say the same thing twice, in the channel with no dedupe.
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
      // The worktree is named because it is the evidence. This outcome exists
      // for builds that pass in a normal checkout and fail in a linked one, so
      // "reproduce it in the repo" is the wrong first instruction — reproduce
      // it here.
      //
      // The path is kept, but it is not held. The next run for this ticket
      // moves this checkout to a `<path>-salvaged-<timestamp>` sibling and puts
      // a fresh one here (`createWorktree`), so an operator who reads this line
      // and comes back later finds a directory that looks right and is not the
      // evidence. Worse, a reproduction still running in it gets moved out from
      // under itself — observed 2026-09-11, a Maven run whose working directory
      // followed the rename while its `-Dmaven.multiModuleProjectDirectory`
      // went on naming the replacement. So the warning is part of the line, not
      // a comment only we can see.
      return `UNUSABLE BASE — ${outcome.reason}\nWorktree kept at ${outcome.worktree.path} — reproduce there, not in the main checkout, since that is the difference this found\nIt is kept, not held: the next run for this ticket moves it to a -salvaged-<timestamp> sibling and puts a fresh checkout at that path, so copy it aside before you rely on it, and stop the daemon while you work in it`;
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
    case "escaped": {
      // Prints `git status` for the operator rather than the paths alone. The
      // first question anyone asks here is "was that me?", and this run cannot
      // answer it — but the command that can is short, and an operator who has
      // to compose it themselves will instead assume the machine is wrong.
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
 * `reviewer-exhausted` also exits zero: the cap firing is the cap working. The caller
 * still has to say so on the ticket, which is a different obligation from an
 * exit code.
 *
 * `capped` exits zero for the same reason and it is the one worth arguing
 * about, because unlike `reviewer-exhausted` it means a pull request has cost twenty
 * rounds and is being abandoned mid-review. That is a bad state and it is
 * tempting to make `$?` say so. It must not: the brake firing is the brake
 * working, and a non-zero exit would teach a daemon's backoff to treat the
 * safety stop as an outage — retrying the one pull request that has already
 * proved it should be left alone.
 *
 * `stalled` exits zero by that same argument and is the hardest of the three to
 * leave alone, because a stall is unambiguously something being broken — the
 * checkout could not be cut, three times running — and every instinct says an
 * exit code is where that belongs. It is not, for two reasons. The breakage was
 * already reported: each of those attempts returned `failed`/`worktree` and set
 * `$?` non-zero at the time, so a stall adds no information a caller has not
 * had three times. And what a non-zero exit *does* is drive retry, which is the
 * one behaviour a stall exists to stop. It would take the pull request the
 * service has just decided to leave alone and make it the pull request the
 * daemon comes back to soonest.
 */
export function isAdvanceFailureExit(outcome: AdvanceOutcome): boolean {
  return outcome.kind === "failed" || outcome.kind === "refused";
}

/**
 * Whether `--review` should run another round, and what to call the ending.
 *
 * The whole of the chain's termination logic, as a pure function over one
 * outcome, because the alternative is a `while` loop with six `break`s in it and
 * no way to test the sixth. The loop that consumes this decides nothing: it
 * sleeps, it counts, and it obeys.
 *
 * ## Continuing is the narrow case, and that is the safe direction
 *
 * Exactly two outcomes continue. `waiting` means the reviewer has not spoken, so
 * there is nothing to do but look again. `iterated` means a round happened, and
 * a round that happened invites another review. **Everything else stops**, and
 * the default arm is written to stop rather than to continue so that an outcome
 * added later has to be argued into the loop instead of falling into it.
 *
 * ## Undrafting ends the chain, which is the one decision worth defending
 *
 * §6.1 says the loop keeps listening after undraft, because a human review is
 * exactly what undrafting invites. That is right for the daemon and wrong here:
 * this is a foreground command, and "keep listening" in a foreground command
 * means a terminal blocked for however many days a person takes to review. The
 * chain's goal is the handover, so it stops at the handover — undrafted, ticket
 * on `agent:review-done`, a human's turn. The listening E does afterwards is a
 * different loop with a different operator, and conflating them would make this
 * command's ending depend on somebody else's calendar.
 *
 * So `ready` stops, `reviewer-exhausted` stops — both undrafted — and `iterated` stops
 * when it undrafted itself, which is §6.1c's rule that a round changing nothing
 * has finished. An `iterated` round that pushed stays a draft and goes round
 * again.
 *
 * ## `silent` is a separate question from `stop`
 *
 * It marks the one outcome that means *the reviewer said nothing*, and it is the
 * one the round caps cannot see at all: a reviewer that never answers produces
 * no rounds, so `MAX_PR_ROUNDS_TOTAL` and `MAX_REVIEW_ITERATIONS` both sit at
 * zero while the loop spins. Silence is the unbounded case, and it is unbounded
 * precisely because it is free.
 *
 * ## The silence bound is read, not counted
 *
 * This used to be `MAX_REVIEW_WAITS` and the chain counted its own consecutive
 * silent polls. Two things were wrong with that, and `silence.ts` sets both out:
 * the count lived on a stack, and it made patience a product of the poll
 * interval. So the outcome now carries how long the pull request has actually
 * been quiet, and the only thing left to decide here is what that is worth — a
 * decision this function makes for a foreground command and a daemon will make
 * differently for itself.
 *
 * `silenceMs` is a parameter rather than a closed-over setting for the same
 * reason: two callers, one measurement, two policies.
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
      // Unmeasurable reads as "keep looking", which is `hasGoneQuiet`'s rule and
      // not this function's guess. A bound that fires when it cannot measure
      // would end the chain on a payload it failed to understand.
      return hasGoneQuiet(outcome.quietMs, silenceMs)
        ? {
            stop: true,
            silent: true,
            why: `nothing has happened on the pull request for ${String(Math.round((outcome.quietMs ?? 0) / 60000))} minutes — leaving it as it is; run --advance later, or check the reviewer was actually requested`,
          }
        : { stop: false, silent: true, why: "the reviewer has not said anything yet" };
    }
    case "iterated": {
      // The draft flag, not `pushed` — the same choice `reviewStageAfter` makes
      // and for the same reason. A round can push nothing and still be finished,
      // and a round whose answer would not post holds the draft deliberately.
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
      // The third outcome that continues, and it has to be argued in rather than
      // left to the `default` arm below. A merge round answers the *base*, not
      // the reviewer: the feedback that was waiting is still waiting, unread, and
      // stopping here would end the chain one step before the round that reads
      // it — on a pull request the loop had just made buildable again.
      //
      // Not `silent`. A merge round did work, so the wall-clock quiet bound must
      // reset; treating it as silence would let a branch that keeps needing the
      // base merged trip the absent-reviewer brake, which measures the reviewer
      // and would be measuring us.
      //
      // It cannot spin, because a merge round reserves like any other and so
      // spends one of `MAX_PR_ROUNDS_TOTAL`. A base that kept moving would run
      // the count out and stop at `capped`, which is the right ending for it.
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
      // Not `silent`, even though nothing was heard from the reviewer either.
      // `silent` drives the wall-clock quiet bound, and a stall is the opposite
      // claim: there was work to do every time, and every time this side could
      // not get to it. Marking it silent would file a local breakage as a slow
      // reviewer, which is where it hid for four days.
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
      // `failed`, and anything added later. Stopping is the default on purpose:
      // a new outcome that should loop is a deliberate edit here, and a new
      // outcome nobody thought about ends the chain rather than driving it.
      return { stop: true, silent: false, why: "the round could not complete" };
    }
  }
}

/**
 * Which review stage the ticket should be in after this round, or `null`.
 *
 * The pull request's draft flag is the source of truth and the ticket's label is
 * a mirror of it, so this reads only what the round did to the draft — never
 * what it concluded, and never whether it succeeded. `agent:review-done` means
 * *the pull request is out of draft*, which is a fact anyone can check.
 *
 * **`null` is the answer for every outcome that left the draft flag alone**, and
 * it is the majority of them. Saying "leave the label as it is" is not the same
 * as saying "the ticket is still under review": `capped`, `abandoned`, `refused`
 * and the error kinds all deliberately leave a pull request exactly as they
 * found it, and a round that writes a label after changing nothing is a round
 * that overrides an earlier, better-informed decision with a default.
 *
 * `waiting` is the one worth naming separately even though it shares the answer.
 * It is the *most common* outcome by a wide margin once the advance step runs on
 * a timer, and it costs nothing today only because it also returns `null` here.
 * Give it a stage and every quiet pull request becomes a Jira write per tick.
 */
export function reviewStageAfter(outcome: AdvanceOutcome): ReviewStage | null {
  switch (outcome.kind) {
    // Undrafted, so the agentic cycle is over and a human is the only thing
    // left. `reviewer-exhausted` reaches the same place by a different road — the
    // reviewer's budget ran out rather than the reviewer running out of things
    // to say — and the ticket cannot tell the difference because the pull
    // request cannot either. The comment on the ticket is where that difference
    // is recorded, and it already is.
    case "ready":
    case "reviewer-exhausted": {
      return "review-done";
    }
    // The only outcome that can go either way, and it is decided by the draft
    // flag rather than by `pushed`. Those agree today — §6.1c's rule is that a
    // round which pushed stays a draft — but they are two different facts, and
    // reading the one this label mirrors means a future change to that rule
    // cannot silently desynchronise the board from the pull request. A `failed`
    // undraft is `reviewing`, which is correct rather than pessimistic: the pull
    // request really is still a draft.
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
 * `FindPrResult.state` is a `string` because it is whatever `gh pr list`
 * printed, and this service must not care: the only question it asks of a
 * finished pull request is whether it was merged. So anything that is not
 * exactly `MERGED` is read as closed, which is the safe direction — `closed` is
 * the label that counts nothing, and a future `gh` spelling this service has
 * never seen must not be able to inflate the number of bugs it claims to have
 * fixed.
 *
 * Callers must have ruled `OPEN` out first. It is not an ending, and there is
 * nothing sensible to return for it; a third arm would invite a caller to pass
 * an open pull request and get a terminal back.
 */
export function endedState(state: string): "MERGED" | "CLOSED" {
  return state === "MERGED" ? "MERGED" : "CLOSED";
}

/**
 * The terminal label a finished pull request earns, and it is a metric.
 *
 * §3c: `agent:done` is **merged only**. It is the count of bugs this tool
 * actually fixed, and a pull request a person closed unmerged is work the tool
 * completed that nobody wanted — a different number, and the more interesting of
 * the two, which disappears entirely the moment the buckets are folded together.
 *
 * A function rather than a ternary at each call site, and that is the whole
 * reason it exists. There are two places a pull request's terminal is written —
 * `--advance` finding it already ended, and the watch cycle noticing the same
 * thing on a later pass — and until this they held the same ternary twice. Two
 * identical literals encoding a rule is the failure `labels.ts`'s own header
 * names, and the failure mode here is not a crash: it is a plausible-looking
 * figure in a report, which is exactly the mutation §3c asks to be guarded.
 */
export function completionLabelFor(state: "MERGED" | "CLOSED"): SolveOutcomeLabel {
  return state === "MERGED" ? "done" : "closed";
}

/**
 * One line per re-request result, and only one of the three is a call to act.
 *
 * A table rather than a ternary because the middle case is the one that used to
 * be missing: a round that pushed nothing sent no ping, and printing the "NOT
 * asked" warning for it would send a person to click a button that would do
 * nothing but summon a second review of an unchanged diff.
 */
const REREQUEST_LINE = {
  asked: `\nThe reviewer was asked to look again.`,
  failed: `\nThe reviewer was NOT asked to look again — add them by hand, or nothing will re-read this.`,
  unnecessary: `\nThe reviewer was not asked again — nothing was pushed, so there is nothing new to re-read.`,
} as const satisfies Record<ReRequest, string>;

/**
 * One line per draft transition, and again only one is a call to act.
 *
 * `still-drafting` is the ordinary case on a round that pushed, so it says why
 * rather than reading as a thing that went wrong.
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
        REREQUEST_LINE[outcome.reviewerRequested] +
        UNDRAFT_LINE[outcome.undrafted] +
        // A review body has no thread, so this is the only channel the round's
        // answer to it has. Losing it silently leaves a reviewer's objection
        // standing with the rebuttal in a terminal nobody will read again.
        (outcome.spoken.outcome === "failed"
          ? `\nThe answer did NOT reach the pull request — ${outcome.spoken.reason}`
          : "") +
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
    case "reviewer-exhausted": {
      return (
        `REVIEWER EXHAUSTED — ${String(outcome.rounds)} round(s) spent and the reviewer still has comments open. ` +
        `Undrafted anyway; a human decides from here, and a human's comment still gets a round.` +
        `\nUnresolved:\n${outcome.unresolved}`
      );
    }
    case "capped": {
      // Deliberately does not say "undrafted", because it is not. `reviewer-exhausted`
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
      // Says out loud that the reviewer was not read, because the round looks
      // like every other one from the outside — it reserved, it cost money, it
      // pushed a commit — and an operator who took it for a review round would
      // read the reviewer's silence as agreement.
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
 * A watch prints this every tick, forever, so the shape matters more than it
 * does for a one-shot command: an operator is going to read hundreds of these
 * and the only way that stays useful is if a quiet pass is one short line and an
 * expensive one is visibly longer. So the counts that are usually zero are
 * omitted when they are, and `acted` — the only field that spent money — always
 * names its tickets rather than counting them.
 *
 * **`deferred` is never omitted when non-zero, even though it looks like noise.**
 * It is the one number that says the bound bit: work was actionable and this
 * pass declined to pay for it. Hiding that would make `MAX_REVIEW_ROUNDS_PER_TICK`
 * invisible at exactly the moment it is doing something, which is how a bound
 * gets blamed for a loop that seems to be ignoring a reviewer.
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
  // Last, and always listed by ticket. A look that failed is the one thing here
  // that will repeat identically every pass until somebody reads the reason, so
  // a bare count would scroll past forever saying nothing.
  if (outcome.unlooked.length > 0) {
    parts.push(
      `could not look at — ${outcome.unlooked.map((entry) => `${entry.issueKey}: ${entry.reason}`).join("; ")}`,
    );
  }

  return parts.join("\n  ");
}
