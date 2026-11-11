/**
 * Files recon plans to move and the harness moves, with `git mv` run by this process and never by a
 * model's tool. A move keeps its content; the fix pass then edits the file where it now is.
 */

import { type NameStatus, pathEscapes, plannedPathRefusals } from "./diff-gate.ts";
import { type CommandRunner, failed, why } from "./worktree.ts";

export interface PlannedMove {
  readonly from: string;
  readonly to: string;
}

/** A path as git will act on it, with the worktree prefix a model may add removed, or `null` when it leaves the worktree. */
export function movePath(path: string, worktreePath: string): string | null {
  const prefix = `${worktreePath.replace(/\/+$/u, "")}/`;
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  if (pathEscapes(relative)) {
    return null;
  }
  return relative
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/** The moves as git will act on them, or `null` when `moveRefusals` would refuse any. */
export function resolveMoves(
  moves: readonly PlannedMove[],
  worktreePath: string,
): readonly PlannedMove[] | null {
  if (moveRefusals(moves, worktreePath).length > 0) {
    return null;
  }
  return moves.map((move) => ({
    from: movePath(move.from, worktreePath) ?? move.from,
    to: movePath(move.to, worktreePath) ?? move.to,
  }));
}

/**
 * Why the harness would not make these moves, one reason per problem, or none. Both ends are held to
 * the plan's path rules with no exception, since a move changes no content and is never a dependency bump.
 */
export function moveRefusals(
  moves: readonly PlannedMove[],
  worktreePath: string,
): readonly string[] {
  const reasons: string[] = [];
  const ends: string[] = [];
  for (const move of moves) {
    const from = movePath(move.from, worktreePath);
    const to = movePath(move.to, worktreePath);
    const label = `${JSON.stringify(move.from)} → ${JSON.stringify(move.to)}`;
    if (from === null || to === null) {
      reasons.push(`${label}: not a move between two paths inside the worktree`);
      continue;
    }
    if (from === to) {
      reasons.push(`${label}: moves a file onto itself`);
      continue;
    }
    for (const reason of plannedPathRefusals([from, to], worktreePath, false)) {
      reasons.push(`${label}: ${reason}`);
    }
    ends.push(from, to);
  }
  // One rule for duplicates, chains and swaps alike: each would make the result depend on the order the moves run in.
  for (const end of new Set(ends)) {
    if (ends.filter((other) => other === end).length > 1) {
      reasons.push(
        `${end}: an end of more than one move, so the result would depend on their order`,
      );
    }
  }
  return reasons;
}

export type MoveResult =
  | { readonly outcome: "moved"; readonly moves: readonly PlannedMove[] }
  | { readonly outcome: "refused"; readonly reason: string; readonly done: number };

/**
 * Makes resolved moves in order, each checked first to be one tracked file. Stops at the first refusal
 * with git's own words; the moves already made stay staged, and `removeWorktree` will not force them away.
 */
export async function applyMoves(
  runner: CommandRunner,
  worktreePath: string,
  moves: readonly PlannedMove[],
  timeoutMs: number,
): Promise<MoveResult> {
  const options = { cwd: worktreePath, timeoutMs };
  let done = 0;
  for (const move of moves) {
    const label = `${move.from} → ${move.to}`;
    // Literal pathspecs: a model-written path holding `*` would otherwise list every file it matches.
    const listed = await runner.run(
      ["git", "--literal-pathspecs", "-C", worktreePath, "ls-files", "-z", "--", move.from],
      options,
    );
    if (failed(listed) || listed.stdout !== `${move.from}\0`) {
      return {
        outcome: "refused",
        reason: `${label}: the source is not one tracked file in the worktree`,
        done,
      };
    }
    const moved = await runner.run(
      ["git", "-C", worktreePath, "mv", "--", move.from, move.to],
      options,
    );
    if (failed(moved)) {
      return { outcome: "refused", reason: `${label}: git mv refused — ${why(moved)}`, done };
    }
    done += 1;
  }
  return { outcome: "moved", moves };
}

/** Each move as git's own account of the final tree shows it: the old path gone and the new one present. */
export function moveViolations(
  moves: readonly PlannedMove[],
  records: readonly NameStatus[],
): readonly string[] {
  const reasons: string[] = [];
  for (const move of moves) {
    const left = records.some(
      (record) =>
        (record.status === "R" && record.from === move.from) ||
        (record.status === "D" && record.path === move.from),
    );
    const arrived = records.some(
      (record) => (record.status === "R" || record.status === "A") && record.path === move.to,
    );
    if (!left) {
      reasons.push(
        `${move.from}: the harness moved this file to ${move.to}, and it is back in the tree — a moved file is edited at its new path, never written again at its old one`,
      );
    }
    if (!arrived) {
      reasons.push(
        `${move.to}: the harness moved ${move.from} here, and it is no longer in the tree`,
      );
    }
  }
  return reasons;
}
