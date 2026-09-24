/**
 * A pure, mechanical check over `git diff --numstat -z` output that refuses on the evidence
 * rather than the model's account of itself. `-z` matters: without it, git quotes and
 * C-escapes unusual paths, letting a ticket-controlled filename with an embedded newline
 * forge a second numstat record past a line-oriented parser.
 * Diff size is measured and reported but never refused — a wide diff is not necessarily a
 * wrong one, and refusing here discards a pass that has already been paid for.
 */

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
    }
  | {
      readonly ok: false;
      /** Every reason, not the first — a run that trips three rules should say so once. */
      readonly reasons: readonly string[];
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

/**
 * Every path in recon's plan that `checkDiff` would refuse by name, with why — empty when none.
 * The plan is the model's account, so this may only ever refuse: an empty answer allows nothing,
 * and `checkDiff` still reads the real diff. An absolute path under `worktreePath` is read relative
 * to it, because a model naming the file it read by its full path means the same file.
 */
export function plannedPathRefusals(
  plannedFiles: readonly string[],
  worktreePath: string,
): readonly string[] {
  const prefix = `${worktreePath.replace(/\/+$/u, "")}/`;
  const reasons: string[] = [];
  for (const planned of plannedFiles) {
    const path = planned.startsWith(prefix) ? planned.slice(prefix.length) : planned;
    if (pathEscapes(path)) {
      reasons.push(`${JSON.stringify(planned)}: not a path inside the worktree`);
      continue;
    }
    const rule = match(VERIFICATION_PATHS, path) ?? match(FORBIDDEN_PATHS, path);
    if (rule !== undefined) {
      reasons.push(`${path}: ${rule.why}`);
    }
  }
  return reasons;
}

/**
 * Collects every refusal reason rather than stopping at the first, and refuses an empty diff
 * outright — a run that edits a file and reverts it would otherwise look like success.
 */
export function checkDiff(changes: readonly FileChange[]): DiffVerdict {
  const reasons: string[] = [];

  if (changes.length === 0) {
    return {
      ok: false,
      reasons: ["the diff is empty — nothing was changed, so nothing was fixed"],
    };
  }

  for (const change of changes) {
    if (pathEscapes(change.path)) {
      reasons.push(
        `${JSON.stringify(change.path)}: not a path inside the worktree, so it is refused without being interpreted`,
      );
      // The pattern checks below assume a normal relative path; running them
      // on one that escaped would report a reason implying it was understood.
      continue;
    }
    if (change.added === null || change.removed === null) {
      reasons.push(
        `${change.path}: binary change — a diff nobody can read in a review is not a diff this service opens a PR for`,
      );
    }
    const verification = match(VERIFICATION_PATHS, change.path);
    if (verification !== undefined) {
      reasons.push(`${change.path}: ${verification.why}`);
    }
    const forbidden = match(FORBIDDEN_PATHS, change.path);
    if (forbidden !== undefined) {
      reasons.push(`${change.path}: ${forbidden.why}`);
    }
  }

  // Measured for the report; never compared against anything — see the module header.
  const files = changes.length;
  const lines = changes.reduce(
    (total, change) => total + (change.added ?? 0) + (change.removed ?? 0),
    0,
  );

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, files, lines };
}
