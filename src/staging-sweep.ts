/**
 * Which stale entries under a staging parent directory `sweep-once` may
 * remove, and which it must never touch.
 *
 * Pure decision, no filesystem access — `cli/sweep-once.ts` reads the
 * directory and does the deleting, so this half is testable without a real
 * tree on disk, the same split `solve/silence.ts` makes for the idle
 * watchdog.
 *
 * **The property this module exists to hold: a live git worktree must never
 * match.** `worktreeRoot` (`wiring.ts`) is the parent of two different kinds
 * of entry — a skill root, and a currently-running or recently-finished
 * solve's actual checkout, cut by `createWorktree` (`solve/worktree.ts`) at
 * the bare path `<parentDirectory>/<issueKey>`, no suffix, no random
 * component. `ISSUE_KEY` (`solve/worktree.ts`) allows only an uppercase
 * letter, uppercase letters and digits, and exactly one hyphen before the
 * numeric part — so the lowercase literal `-skill-` or `-img-` this module
 * requires can never occur inside a valid issue key, and a name this module
 * matches can therefore never be a bare issue key. `salvageWorktree`'s
 * `<issueKey>-salvaged-<timestamp>` shape is covered by the same argument: it
 * contains neither substring either, so it is left alone by construction
 * rather than by a case written for it.
 */

const SKILL_ROOT_NAME = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}(?:-merge|-review)?-skill-[A-Za-z0-9]+$/u;
const IMAGE_STAGE_NAME = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}-img-[A-Za-z0-9]+$/u;

export type StagingKind = "skill-root" | "image-stage";

/**
 * Which of the two staging shapes a directory name matches, or `null` for
 * anything else — including a live worktree, a salvaged one, or a name
 * nobody in this codebase produces. `planSweep` below drops a `null` rather
 * than reporting it, because a name outside the two shapes this codebase
 * actually produces is not this sweep's to explain.
 */
export function classify(name: string): StagingKind | null {
  if (SKILL_ROOT_NAME.test(name)) {
    return "skill-root";
  }
  if (IMAGE_STAGE_NAME.test(name)) {
    return "image-stage";
  }
  return null;
}

export interface StagingEntry {
  readonly name: string;
  readonly mtimeMs: number;
}

export interface StagingVerdict extends StagingEntry {
  readonly kind: StagingKind;
  readonly ageMs: number;
  /** Old enough to remove. `cli/sweep-once.ts` still gates the removal itself on `--write`. */
  readonly sweep: boolean;
}

/**
 * Ages and classifies a directory listing, dropping everything `classify`
 * does not recognise.
 *
 * `now` and `maxAgeMs` are both passed in rather than read from the clock or
 * from settings, so a test can assert the exact boundary — an entry exactly
 * `maxAgeMs` old sweeps, one millisecond younger does not — without waiting
 * or touching real files.
 */
export function planSweep(
  entries: readonly StagingEntry[],
  now: number,
  maxAgeMs: number,
): readonly StagingVerdict[] {
  const verdicts: StagingVerdict[] = [];
  for (const entry of entries) {
    const kind = classify(entry.name);
    if (kind === null) {
      continue;
    }
    const ageMs = now - entry.mtimeMs;
    verdicts.push({ ...entry, kind, ageMs, sweep: ageMs >= maxAgeMs });
  }
  return verdicts;
}
