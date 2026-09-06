/**
 * How many times the daemon has claimed each ticket, so it stops claiming one
 * that keeps coming back.
 *
 * ## The runaway this closes, which the plan has had recorded as E's since D4c
 *
 * The label machine bounds every outcome that decides a ticket's fate. A merged
 * pull request is `agent:done`, a declined one `agent:closed`, a recon bail
 * `agent:failed`, and all three leave the queue because the query excludes them.
 * **Three outcomes deliberately write no label at all** — `refused` by the diff
 * gate, `failed`, and `abandoned` for a transient reason — on the argument D4c
 * made and that is still right: those say nothing about whether the ticket is
 * solvable, and labelling them would convert a slept laptop or a policy hook
 * into a state only a human can clear.
 *
 * The cost of being right about that is that the run **releases the ticket
 * exactly as it found it**, `agent:start` included. So the queue offers it again
 * on the very next tick, the run fails the same way, releases again, and repeats
 * — at full solve cost, with no condition that ever clears it. D4c closed the
 * bail's version of this and said so plainly: *"that wants a per-ticket attempt
 * count rather than a terminal label, and it belongs with E, where the thing
 * doing the retrying first exists."* This is that, and E is where it arrived.
 *
 * **Manual mode does not save it.** The instinct is that `agent:start` is
 * consumed by the claim and so a human must re-add it — but `runRelease` puts
 * back every label the run found, which is what makes a hand-driven rehearsal
 * repeatable. The go-ahead comes back with the rest, and the next tick reads it.
 *
 * ## In memory, and the same argument the watch's memo makes
 *
 * §1 refuses on-disk state because losing it causes a **double claim**. Losing
 * this causes **one extra attempt per ticket after a restart**, which is the
 * behaviour of the day before this file existed, bounded again the moment the
 * process has ticked once. The costs are not the same kind of thing.
 *
 * A label would be better on two counts — it survives a restart and a human can
 * see and clear it — and it is deliberately not what this is. It would be a
 * write per attempt on the path §3a's clobber risk is worst on, and a fourth
 * `agent:` name to reason about, for a bound whose whole job is to stop a loop
 * that only exists while a loop is running. Recorded as the upgrade if the
 * in-memory version is ever seen to expire something that mattered.
 *
 * ## What it deliberately does not count
 *
 * **Nothing a person typed.** `solve:once` and `bot:once` never consult this:
 * an operator running the same ticket twice is a decision, and a harness that
 * refused the third would be answering a question nobody asked it.
 *
 * **Nothing that left the queue.** A ticket that reached a terminal is excluded
 * by the query, so its count is never read again. Counting attempts rather than
 * *failures* is the simpler rule and errs in the safe direction: the only ticket
 * whose count can ever reach the cap is one that keeps coming back.
 */

import { logger } from "../logger.ts";

export interface AttemptLedger {
  /**
   * True when this ticket has been claimed as many times as it is allowed to be.
   *
   * Read before the claim, because the claim is the cheapest part of what
   * follows it and the point is to spend neither.
   */
  readonly exhausted: (key: string) => boolean;
  /** Records that a claim is about to be attempted. Called before the work. */
  readonly attempted: (key: string) => void;
  /** How many attempts this ticket has cost, for a log line. */
  readonly countFor: (key: string) => number;
  /** How many distinct tickets are remembered, for the cycle's own log line. */
  readonly size: () => number;
}

export function createAttemptLedger(max: number): AttemptLedger {
  const attempts = new Map<string, number>();

  return {
    // `>=` rather than `>`: the count is of attempts already made, so a ticket
    // sitting at the cap has had all of them. A strict `>` gives every ticket
    // one more than the operator asked for, which is the quiet kind of wrong —
    // an off-by-one in a spend bound reads as the bound working.
    exhausted: (key) => (attempts.get(key) ?? 0) >= max,
    attempted: (key) => {
      const now = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, now);
      if (now >= max) {
        // Said once, at the attempt that reaches the cap, rather than on every
        // tick that skips afterwards. A refusal repeated every two minutes is
        // how an operator learns to stop reading this log.
        logger.warn("solve.attempts.exhausted", {
          key,
          attempts: now,
          max,
          note: "the daemon will not claim this ticket again until it restarts or the ticket leaves the queue",
        });
      }
    },
    countFor: (key) => attempts.get(key) ?? 0,
    size: () => attempts.size,
  };
}
