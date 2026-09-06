/**
 * The bound on what a solve run is allowed to have changed.
 *
 * This is `assertPostable` for code: a mechanical check that sits between the
 * model finishing and anything leaving the machine, and refuses on the evidence
 * rather than on the model's account of itself. It is pure — no git, no fs, no
 * subprocess — so every rule below is testable without a repository, and so the
 * gate cannot itself be the thing that breaks.
 *
 * It runs on `git diff --numstat -z` output, which the harness produces. The
 * `-z` matters and is not a preference: without it git quotes paths containing
 * unusual bytes and C-escapes them, which means a file named with an embedded
 * newline renders as two lines and can forge a second numstat record. Since the
 * ticket text that suggested the filename is attacker-controlled, that is a
 * real path to smuggling a change past a line-oriented parser. With `-z`, paths
 * are NUL-terminated and never quoted, and the ambiguity does not exist.
 *
 * ## The two refusal families
 *
 * **Location.** Paths that escape the worktree, and paths inside directories
 * this service must never author. See `FORBIDDEN_PATHS`.
 *
 * **Verification integrity.** The subtle one, and the reason this module exists
 * rather than a line count in `runner.ts`. Verification is mechanical: the
 * harness runs the repo's own test, typecheck and lint commands and reads exit
 * codes. But it discovers those commands *from the repo*, out of `package.json`
 * — so a run that may edit `package.json` may edit the definition of whether it
 * passed. Point `test` at `true` and every subsequent check succeeds, honestly
 * reported, having verified nothing. The same applies to `tsconfig.json`
 * (disable `strict` and the typecheck passes) and to the linter's config.
 *
 * That is not a diff worth reviewing carefully; it is a diff that must not
 * reach review, because the signal a reviewer would rely on to judge it is the
 * signal it tampered with. Refused unconditionally, on any change of any size.
 *
 * ## Size is measured and never refused, and that is the third family removed
 *
 * There were three families until 2026-09-06, and the third was a cap:
 * `{ maxFiles: 5, maxLines: 200 }`, hardcoded, with no setting to change it.
 * Both halves are gone. The two families above are sound in **both**
 * directions — a path that escaped the worktree escaped it, and a run that
 * edited `vitest.config.ts` really has invalidated its own verification, with
 * no judgement required. A cap is sound in one: a run that lost the plot is
 * usually wide, but a wide diff is usually not a run that lost the plot. The
 * gate was deriving the second from the first.
 *
 * **The argument against it was already written in this repository, about a
 * different check.** `checkFailFirst` reports and never refuses, because *"a
 * check that could withhold a good pull request would have to be right about a
 * question it is only sound about in one direction."* Substitute "wide diff"
 * for "vacuous test" and it is the same sentence. It was applied to the weaker
 * case and not to this one.
 *
 * **Three things make a size veto specifically the wrong tool here.** It fires
 * *after* the model pass, so it does not prevent a spend, it discards one — the
 * round it refused on PR #2663 had already cost $1.77. It is cumulative against
 * `SOLVE_BASE_REF`, so it measures how large the pull request has become rather
 * than what this run did, and a round touching one new file is refused for the
 * four the branch already had. And a human merges every pull request this
 * service opens, so the size judgement it was making is one that a reviewer
 * makes anyway, with context the gate does not have.
 *
 * **The prose it replaces claimed a recovery that did not exist**, which is why
 * this is a rewrite rather than a deletion. It said a legitimate fix tripping
 * the cap was *"a cheap false positive — a human looks, and either widens the
 * cap for that ticket or agrees the ticket was mis-assessed."* There was no way
 * to widen the cap for a ticket, and nobody looked: a `refused` round posts
 * nothing to the pull request, so #2663's refusal was visible only in a daemon
 * log.
 *
 * `files` and `lines` are still computed and still returned on success, and
 * `solve-outcome.ts` still prints them. The measurement survives; only the veto
 * is gone. If a bound is ever wanted again it belongs where the money is spent
 * — before or during the pass — and not at the one point where refusing costs
 * everything and saves nothing.
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
 *
 * Every entry is a place where a change is either unreviewable in a code
 * review, or grants the run more than the ticket did. Anchored with `(^|\/)` so
 * they match at any depth, since a monorepo package can carry its own CI config
 * and its own lockfile.
 *
 * Note `\.git(\/|$)` does not match `.github` — the next character must be a
 * separator or the end — so the two entries are genuinely separate rules rather
 * than one shadowing the other.
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
 * Files that define what "verified" means.
 *
 * Separate from `FORBIDDEN_PATHS` only so the refusal can say *why* in the
 * terms that matter — this is not "you touched a config file", it is "you
 * edited the scoreboard you are being scored on".
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
    // Matched even though `verify.ts` runs `mvn` from PATH and never the
    // wrapper. The rule is about what a diff may contain, not about what this
    // harness happens to execute today: a run that rewrites `mvnw` has edited
    // the command the repository's own CI and every developer will run, and
    // that is a change nobody asked a bug fix to make.
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
 *
 * Exported to be tested directly, because the interesting inputs here are the
 * ones nobody writes by accident and a reviewer will not think to try.
 *
 * Normalisation is done by hand rather than with `node:path`. `path.normalize`
 * is platform-dependent — on Windows it treats `\` as a separator and on POSIX
 * it does not — and a gate whose meaning changes with the host is a gate that
 * was tested somewhere other than where it runs. Git always emits `/`, so any
 * backslash in a numstat path is already anomalous and is refused rather than
 * interpreted.
 */
export function pathEscapes(path: string): boolean {
  if (path === "" || path.includes("\0") || path.includes("\\")) {
    return true;
  }
  // Absolute POSIX, and Windows drive-letter or UNC forms, none of which git
  // produces for a tracked file.
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.startsWith("//")) {
    return true;
  }

  const resolved: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      // Refuse rather than pop. A path that climbs and comes back --
      // `src/../src/a.ts` -- stays inside, but it is not a path git emits, and
      // treating it as equivalent to `src/a.ts` means the forbidden-path
      // patterns above see a different string from the one git will act on.
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
 * Parses `git diff --numstat -z` into records.
 *
 * The `-z` grammar is not the line-oriented one with NULs swapped in. Each
 * record is `added \t removed \t path \0`, except a rename or copy, which emits
 * `added \t removed \t \0 oldpath \0 newpath \0` — the path field empty, and
 * two further NUL-terminated fields following it. Handling that explicitly is
 * the whole reason this is not a one-line `split`.
 *
 * A rename yields the *destination* path. The source is checked too, so a run
 * cannot move a forbidden file somewhere innocuous and have only the harmless
 * half inspected.
 *
 * Throws rather than returning a verdict. A numstat this cannot parse is not a
 * diff that failed the gate, it is a gate that does not know what it is looking
 * at, and the two must not arrive at the caller looking the same.
 */
export function parseNumstat(raw: string): readonly FileChange[] {
  if (raw === "") {
    return [];
  }
  const fields = raw.split("\0");
  // A well-formed stream ends with a terminator, leaving one empty final field.
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
 * The gate.
 *
 * Collects every reason rather than returning the first, because the operator
 * reading the refusal artifact wants the shape of what went wrong, and a gate
 * that reveals one problem per run turns one review into four.
 *
 * An empty diff is refused. A solve that changed nothing has not fixed the bug,
 * and the failure mode it guards against is specific: a run that edits a file
 * and reverts it, or writes only to an ignored path, reaches here looking
 * exactly like success and would otherwise open an empty PR.
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
      // No further rules for this path: the pattern checks below assume a
      // normal relative path, and running them on one that is not would report
      // a reason implying the path was understood.
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

  // Measured for the report, never compared against anything. See the header:
  // a wide diff is not a wrong diff, and this is the one point in the run where
  // refusing discards a pass that has already been paid for.
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
