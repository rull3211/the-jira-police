/**
 * The solve command line, parsed; decides nothing but what the operator asked for.
 *
 * Its own module rather than an export from `solve-once.ts`, which runs `main` at import time.
 * Flags form a ladder (`--claim` < `--solve` < `--pr` < `--review`); the highest one given wins,
 * and any issue-scoped flag requires an issue key so a bare `--pr` cannot mean "every ticket."
 */

import { type Settings, repairRound } from "../settings.ts";

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
  "       solve-once <ISSUE-KEY> --pr --repair\n" +
  "       solve-once <ISSUE-KEY> --advance [--repair]\n" +
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
  "  --repair                with --pr or --review: a repair round that turns a\n" +
  "                          failed verification green opens the pull request, as a\n" +
  "                          second commit the body names. With --review, --advance\n" +
  "                          or --watch it does the same for a review round: pushed\n" +
  "                          as that round's second commit, under a notice posted on\n" +
  "                          the pull request. Without it the round's verdict is\n" +
  "                          recorded and discarded. Needs a round to run, so\n" +
  "                          REPAIR_ROUND must not be false.\n" +
  "\n" +
  "  <ISSUE-KEY> --advance   one review round on the pull request that already\n" +
  "                          exists; does not claim, solve, or open anything\n" +
  "\n" +
  "  --watch                 keep looking at every ticket under review, running a\n" +
  "                          round for the ones a reviewer has written to. A look\n" +
  "                          is two gh reads and costs nothing; only a round pays.\n" +
  "  <ISSUE-KEY> --watch     the same loop, narrowed to one ticket\n";

/**
 * The flag that is not a rung.
 *
 * Every other flag names how far up one run should go; this one names a different run — it acts
 * on a pull request an earlier invocation already opened. Reading it as a fifth rung would make
 * `--advance` imply `--pr`, which is backwards, so combining it with a rung is refused rather
 * than resolved.
 *
 * `--review` is not this flag with a longer name: it makes the pull request first, so its order
 * is forced by the work rather than guessed by the parser, and it is bounded on four sides —
 * `MAX_PR_ROUNDS_TOTAL`, `MAX_REVIEW_ITERATIONS`, `REVIEW_SILENCE_MS`, and every non-continuing
 * outcome. `chainDecision` is where the bounds live.
 */
const ADVANCE_FLAG = "--advance";

/**
 * The other flag that is not a rung, and the only one that may run bare.
 *
 * A bare `--watch` is allowed where a bare `--advance` is not because it only surveys first —
 * two `gh` reads per pull request, no checkout — and spends only on the ones a reviewer actually
 * wrote to; `MAX_REVIEW_ROUNDS_PER_TICK` bounds the worst case per pass.
 *
 * Still not a rung, for `--advance`'s reason: it acts on pull requests earlier runs opened, so
 * combining it with `--pr` or with `--advance` is refused rather than resolved.
 */
const WATCH_FLAG = "--watch";

/**
 * A modifier on `--pr` and above and on the two review modes, never a rung: a rung's index is its privilege, so one
 * between `pr` and `review` would make `--review` imply it. Decides what a green repair round may do, not whether one runs.
 */
const REPAIR_FLAG = "--repair";

export type SolveInvocation =
  | {
      readonly mode: "ladder";
      /** `null` means the whole queue. Only ever null at the `plan` phase. */
      readonly issueKey: string | null;
      readonly phase: SolvePhase;
      /** `--repair`. Only ever true at a phase that includes `pr`; the review modes carry their own. */
      readonly repair: boolean;
    }
  /** `repair`: a green repair round of a failed review round may push. */
  | { readonly mode: "advance"; readonly issueKey: string; readonly repair: boolean }
  /** `null` means every ticket the review query returns. See `WATCH_FLAG`. */
  | { readonly mode: "watch"; readonly issueKey: string | null; readonly repair: boolean };

/** The ladder half, for the commands that have no review mode at all. */
export type LadderInvocation = Extract<SolveInvocation, { mode: "ladder" }>;

export type ParsedArgs =
  | { readonly ok: true; readonly invocation: SolveInvocation }
  | { readonly ok: false; readonly error: string };

/**
 * A parse that cannot come back as a review round — `bot:once` has no pull request to advance.
 *
 * Narrowed here rather than checked at the call site, so that command stays a compile error away
 * from silently ignoring the flag.
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
 * Call sites compare ranks rather than checking `phase === "claim"`: an equality check would
 * skip the claim on a `--pr` run, leaving the solver working on a ticket the board still shows
 * as unclaimed.
 */
export function includes(phase: SolvePhase, step: SolvePhase): boolean {
  return rank(phase) >= rank(step);
}

/**
 * Why a rung cannot run, or `null` when it can.
 *
 * Checks whether the rung is configured, not whether it's built — `--pr` needs a GitHub owner
 * with no fallback, and without this the missing setting would surface from
 * `buildPublishRequest` only after the claim was written and the solver had run.
 *
 * `buildPublishRequest` throws on the same condition; the duplication is deliberate — this one
 * fails early and legibly, the other ensures the privilege can't be granted by a caller who
 * skipped the check.
 */
export function unavailable(phase: SolvePhase, settings: LadderSettings): string | null {
  if (includes(phase, "pr") && settings.SOLVE_GITHUB_OWNER.trim() === "") {
    return "SOLVE_GITHUB_OWNER is not set, and it has no default — it names the GitHub account a pull request would be opened against, which is not a thing to guess";
  }
  return null;
}

/**
 * The settings this module reads, named structurally rather than imported whole — depending on
 * the full `Settings` type would grow this parser's test fixtures every time an unrelated
 * setting is added.
 */
export interface LadderSettings {
  readonly SOLVE_GITHUB_OWNER: string;
}

/**
 * Why `--repair` cannot run, or `null`. With `REPAIR_ROUND=false` no round runs, so the flag would
 * be accepted and do nothing — a run that reads as armed and is not.
 */
export function repairUnavailable(settings: Pick<Settings, "REPAIR_ROUND">): string | null {
  return repairRound(settings)
    ? null
    : "REPAIR_ROUND=false, so no repair round will run for --repair to act on — set REPAIR_ROUND=true for this run";
}

export function parseSolveArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let phase: SolvePhase = "plan";
  let advance = false;
  let watch = false;
  let repair = false;
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
    if (arg === WATCH_FLAG) {
      watch = true;
      continue;
    }
    if (arg === REPAIR_FLAG) {
      repair = true;
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

  if (watch) {
    // `--advance --watch` reads fine as "watch" but is refused anyway: the two differ by whether
    // the command ever returns, and an operator who typed both should be told which they meant.
    if (namedRung) {
      return {
        ok: false,
        error: `${WATCH_FLAG} cannot be combined with --${phase} — watching acts on pull requests that already exist, so there is no coherent order for the two`,
      };
    }
    if (advance) {
      return {
        ok: false,
        error: `${WATCH_FLAG} cannot be combined with ${ADVANCE_FLAG} — one looks once and returns, the other keeps looking, so say which`,
      };
    }
    return { ok: true, invocation: { mode: "watch", issueKey, repair } };
  }

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
    return { ok: true, invocation: { mode: "advance", issueKey, repair } };
  }

  if (issueKey === null && writes(phase)) {
    return {
      ok: false,
      error: `${phase === "claim" ? "--claim" : `--${phase}`} needs an issue key — it would otherwise run against every ticket in the queue`,
    };
  }

  if (repair && !includes(phase, "pr")) {
    return {
      ok: false,
      error: `${REPAIR_FLAG} needs --pr, --review, --advance or --watch — it lets a green repair round reach a pull request, and ${phase === "plan" ? "a run with no rung" : `--${phase}`} reaches none`,
    };
  }

  return { ok: true, invocation: { mode: "ladder", issueKey, phase, repair } };
}
