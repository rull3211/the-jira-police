/**
 * A pure, mechanical check over `git diff --numstat -z` output that refuses on the evidence
 * rather than the model's account of itself. `-z` matters: without it, git quotes and
 * C-escapes unusual paths, letting a ticket-controlled filename with an embedded newline
 * forge a second numstat record past a line-oriented parser.
 * Diff size is measured and reported but never refused — a wide diff is not necessarily a
 * wrong one, and refusing here discards a pass that has already been paid for.
 */

import type { BumpVerdict, DependencyBump } from "./dependency-bump.ts";

/** One file's entry in a numstat record. */
export interface FileChange {
  readonly path: string;
  /** Lines added. `null` for a binary file, which numstat reports as `-`. */
  readonly added: number | null;
  readonly removed: number | null;
}

interface Rule {
  readonly pattern: RegExp;
  readonly why: string;
  /** The one exception a rule may carry, decided by `dependency-bump.ts` from the change's content. */
  readonly unless?: "dependency-bump";
}

/**
 * Paths no solve run may author, whatever the ticket says.
 * Anchored with `(^|\/)` to match at any depth; `\.git(\/|$)` requires a separator or end
 * after `git` so it does not also match `.github`.
 */
export const FORBIDDEN_PATHS: readonly Rule[] = [
  {
    pattern: /(^|\/)\.git(\/|$)/u,
    why: "the git database itself — a write here rewrites history rather than changing code",
  },
  {
    pattern: /(^|\/)\.github(\/|$)/u,
    why: "GitHub config: workflows run with repository credentials, so this is CI privilege, not code",
  },
  {
    pattern: /(^|\/)\.(circleci|gitlab-ci\.yml|travis\.yml)(\/|$)/u,
    why: "CI configuration — same reasoning as .github",
  },
  {
    pattern: /(^|\/)(Jenkinsfile|azure-pipelines\.ya?ml)$/u,
    why: "CI configuration — same reasoning as .github",
  },
  {
    pattern: /(^|\/)\.gitattributes$/u,
    why: "git attributes decide what git reports about every other file — the `ident` filter alone hides text from the very diff this gate reads",
  },
  {
    pattern: /(^|\/)\.env($|\.)/u,
    why: "environment files hold credentials; nothing this service does requires editing one",
  },
  {
    pattern: /(^|\/)\.(claude|storecode)(\/|$)/u,
    why: "the agent's own instructions, skills and permissions — a run must not be able to widen what the next run may do",
  },
  {
    pattern:
      /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$/u,
    why: "a lockfile change is a dependency change: unreviewable by eye and able to introduce code nobody in this repo wrote",
  },
];

/**
 * Files that define what "verified" means; kept separate from `FORBIDDEN_PATHS` so the
 * refusal reason names the scoreboard rather than just "a config file".
 */
export const VERIFICATION_PATHS: readonly Rule[] = [
  {
    pattern: /(^|\/)package\.json$/u,
    why: "the harness reads the test, typecheck and lint commands from here — editing it edits the definition of passing",
  },
  {
    pattern: /(^|\/)tsconfig(\.[\w-]+)?\.json$/u,
    why: "loosening compiler options makes the typecheck pass without making the code correct",
  },
  {
    pattern: /(^|\/)(\.oxlintrc\.json|\.eslintrc(\.[\w.]+)?|eslint\.config\.[\w.]+)$/u,
    why: "disabling a rule makes the lint pass without making the code correct",
  },
  {
    pattern: /(^|\/)vitest\.config\.[\w.]+$|(^|\/)vite\.config\.[\w.]+$/u,
    why: "test configuration decides which tests run at all; excluding a file is indistinguishable from fixing it",
  },
  {
    pattern: /(^|\/)pom\.xml$/u,
    why: "the Maven build is defined here — a skipped test, a dropped module or a relaxed plugin makes the build pass without making the code correct",
    unless: "dependency-bump",
  },
  {
    // Matched even though `verify.ts` invokes `mvn` from PATH, not the wrapper: a rewritten `mvnw` still changes what every other run uses.
    pattern: /(^|\/)mvnw(\.cmd)?$|(^|\/)\.mvn\//u,
    why: "the Maven wrapper and its configuration decide which build actually runs for everyone else, even though this harness invokes mvn directly",
  },
];

export type DiffVerdict =
  | {
      readonly ok: true;
      readonly files: number;
      readonly lines: number;
      /** Every dependency version the diff moved; empty for a diff that touched no build file. */
      readonly bumps: readonly DependencyBump[];
    }
  | {
      readonly ok: false;
      /** Every reason, not the first — a run that trips three rules should say so once. */
      readonly reasons: readonly string[];
      /**
       * The paths a rule refused, each one a reason names, or `null` when a reason belongs to no
       * ordinary path — an empty diff, or a path outside the worktree — so none could be rolled back.
       */
      readonly refusedPaths: readonly string[] | null;
    };

export class DiffParseError extends Error {
  constructor(message: string) {
    super(`Unparseable numstat: ${message}`);
    this.name = "DiffParseError";
  }
}

/**
 * Rejects a path that could reach outside the worktree.
 * Normalises by hand rather than with `node:path`: `path.normalize` treats `\` as a separator
 * only on Windows, so a gate built on it would change meaning with the host.
 */
export function pathEscapes(path: string): boolean {
  if (path === "" || path.includes("\0") || path.includes("\\")) {
    return true;
  }
  // Absolute POSIX/Windows drive-letter/UNC forms; git never produces these for a tracked file.
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.startsWith("//")) {
    return true;
  }

  const resolved: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      // Refused rather than resolved: resolving it would let the forbidden-path patterns see a different string than the one git will act on.
      return true;
    }
    resolved.push(segment);
  }
  return resolved.length === 0;
}

function count(field: string, raw: string): number | null {
  if (field === "-") {
    return null;
  }
  if (!/^\d+$/u.test(field)) {
    throw new DiffParseError(
      `expected a line count or "-", got ${JSON.stringify(field)} in ${raw}`,
    );
  }
  return Number(field);
}

/**
 * Parses `git diff --numstat -z` into records. A rename or copy emits an empty path field
 * followed by two further NUL-terminated fields (old, new); both are checked, so a run
 * cannot move a forbidden file to an innocuous name and have only the destination inspected.
 * Throws rather than returning a verdict: a numstat this cannot parse is a gate that does not
 * know what it is looking at, not a diff that failed it.
 */
export function parseNumstat(raw: string): readonly FileChange[] {
  if (raw === "") {
    return [];
  }
  const fields = raw.split("\0");
  // A well-formed stream ends with a terminator, so drop the empty final field.
  if (fields.at(-1) === "") {
    fields.pop();
  }

  const changes: FileChange[] = [];
  let index = 0;
  while (index < fields.length) {
    const head = fields[index] ?? "";
    index += 1;

    const parts = head.split("\t");
    if (parts.length !== 3) {
      throw new DiffParseError(`expected three tab-separated fields, got ${JSON.stringify(head)}`);
    }
    const added = count(parts[0] ?? "", head);
    const removed = count(parts[1] ?? "", head);
    const path = parts[2] ?? "";

    if (path !== "") {
      changes.push({ path, added, removed });
      continue;
    }

    // Rename or copy: two more fields, and both are inspected.
    const from = fields[index];
    const to = fields[index + 1];
    index += 2;
    if (from === undefined || to === undefined) {
      throw new DiffParseError(`rename record truncated after ${JSON.stringify(head)}`);
    }
    changes.push({ path: from, added: 0, removed: 0 });
    changes.push({ path: to, added, removed });
  }
  return changes;
}

function match(rules: readonly Rule[], path: string): Rule | undefined {
  return rules.find((rule) => rule.pattern.test(path));
}

/** Whether only a dependency bump could excuse a change to this path, so its content must be read. */
export function isDependencyBumpPath(path: string): boolean {
  return match(VERIFICATION_PATHS, path)?.unless === "dependency-bump";
}

/**
 * What `checkDiff` would refuse by name in recon's plan, with why. The plan is the model's account,
 * so this may only refuse: an empty answer allows nothing, and the gate still reads the real diff.
 */
export function plannedPathRefusals(
  plannedFiles: readonly string[],
  worktreePath: string,
  /** `DEPENDENCY_BUMPS`. Off, a path with an exception is refused by name like any other. */
  allowExceptions: boolean,
): readonly string[] {
  const prefix = `${worktreePath.replace(/\/+$/u, "")}/`;
  const reasons: string[] = [];
  for (const planned of plannedFiles) {
    // Models name a file by the absolute path they read it at, which is the same file.
    const path = planned.startsWith(prefix) ? planned.slice(prefix.length) : planned;
    if (pathEscapes(path)) {
      reasons.push(`${JSON.stringify(planned)}: not a path inside the worktree`);
      continue;
    }
    for (const rule of [match(VERIFICATION_PATHS, path), match(FORBIDDEN_PATHS, path)]) {
      // A path alone cannot say whether its change will be a dependency bump, so that rule waits for the diff.
      if (rule !== undefined && (rule.unless === undefined || !allowExceptions)) {
        reasons.push(`${path}: ${rule.why}`);
      }
    }
  }
  return reasons;
}

/**
 * Collects every refusal reason rather than stopping at the first, and refuses an empty diff
 * outright — a run that edits a file and reverts it would otherwise look like success.
 */
export function checkDiff(
  changes: readonly FileChange[],
  /** From `judgeBumps`. A path it has no verdict for is refused as if no exception existed. */
  bumpVerdicts: ReadonlyMap<string, BumpVerdict> = new Map(),
): DiffVerdict {
  const reasons: string[] = [];
  const bumps: DependencyBump[] = [];
  const refused = new Set<string>();
  let unattributable = false;

  if (changes.length === 0) {
    return {
      ok: false,
      reasons: ["the diff is empty — nothing was changed, so nothing was fixed"],
      refusedPaths: null,
    };
  }

  for (const change of changes) {
    if (pathEscapes(change.path)) {
      reasons.push(
        `${JSON.stringify(change.path)}: not a path inside the worktree, so it is refused without being interpreted`,
      );
      unattributable = true;
      // The pattern checks below assume a normal relative path; running them
      // on one that escaped would report a reason implying it was understood.
      continue;
    }
    const before = reasons.length;
    if (change.added === null || change.removed === null) {
      reasons.push(
        `${change.path}: binary change — a diff nobody can read in a review is not a diff this service opens a PR for`,
      );
    }
    const verification = match(VERIFICATION_PATHS, change.path);
    const bump = verification?.unless === undefined ? undefined : bumpVerdicts.get(change.path);
    if (bump?.ok === true) {
      bumps.push(...bump.bumps);
    } else if (verification !== undefined) {
      reasons.push(
        `${change.path}: ${verification.why}${bump === undefined ? "" : ` — and this change is more than a dependency version: ${bump.reason}`}`,
      );
    }
    const forbidden = match(FORBIDDEN_PATHS, change.path);
    if (forbidden !== undefined) {
      reasons.push(`${change.path}: ${forbidden.why}`);
    }
    if (reasons.length > before) {
      refused.add(change.path);
    }
  }

  // Measured for the report; never compared against anything — see the module header.
  const files = changes.length;
  const lines = changes.reduce(
    (total, change) => total + (change.added ?? 0) + (change.removed ?? 0),
    0,
  );

  if (reasons.length > 0) {
    return { ok: false, reasons, refusedPaths: unattributable ? null : [...refused] };
  }
  return { ok: true, files, lines, bumps };
}
