/**
 * What this service is allowed to call a branch, and what it must never touch.
 *
 * Two separate questions, and they are separate on purpose:
 *
 *  - `isWorkBranch` — is this a name we are willing to *create and push*?
 *    An allowlist of implementation prefixes. Anything not on it is refused.
 *  - `isProtectedRef` — is this a name we must refuse *whatever else is true*?
 *    A denylist of integration branches.
 *
 * An allowlist alone would be enough if the allowlist were the only path to a
 * ref. It is not: a base ref, a push target and a PR base all arrive from
 * different places, and only one of them goes through `branchNameFor`. So the
 * denylist is checked too, at every point a ref becomes an argument to `git`.
 *
 * Belt and braces is normally a smell. Here it is the requested behaviour:
 * *"the agent may never work on main or any protected branch, never"*. A rule
 * stated that absolutely should not depend on a single call site being right.
 *
 * ## Why the denylist is not just `main` and `master`
 *
 * `develop`, `staging`, `production` and `release/*` are integration refs on
 * somebody's repository even if they are not on ours, and this module is used
 * against repositories this service does not own. The cost of over-refusing is
 * that a run stops and a human reads why. The cost of under-refusing is a push
 * to a shared branch. Those are not comparable, so the list errs long.
 *
 * ## What this deliberately does not do
 *
 * It does not ask the remote which branches are protected. That would be the
 * authoritative answer, and it is the wrong mechanism here: it turns a local,
 * always-available refusal into one that depends on a network call, an API
 * token and a permission scope — and the natural failure mode of all three is
 * to return nothing, which a naive caller reads as "not protected". A guard
 * that fails open under load is worse than a short hardcoded list. If remote
 * protection is ever consulted it must be *in addition* to this, and a lookup
 * failure must refuse rather than allow.
 */

/**
 * Prefixes a generated branch may use.
 *
 * Deliberately narrower than the Conventional Commits type list in
 * `runner.ts`, which also has `style`, `build` and `ci`. Those are types of
 * change; these are types of branch, and a run whose whole purpose is to edit
 * CI configuration is refused by the diff gate long before it needs a branch
 * name for it.
 */
export const WORK_BRANCH_PREFIXES: readonly string[] = [
  "fix",
  "feat",
  "chore",
  "docs",
  "test",
  "refactor",
  "perf",
];

/**
 * Names that are never a valid target, in any position.
 *
 * Compared case-insensitively: `Main` and `MAIN` are the same ref to a
 * case-insensitive filesystem, which is what this laptop has, and treating
 * them as different names is how a denylist gets walked around by accident.
 */
const PROTECTED_NAMES: readonly string[] = [
  "main",
  "master",
  "develop",
  "development",
  "trunk",
  "staging",
  "stage",
  "production",
  "prod",
  "release",
  "next",
  "head",
];

/** Prefixes whose entire subtree is protected, e.g. `release/2026-09`. */
const PROTECTED_PREFIXES: readonly string[] = ["release/", "hotfix/", "support/"];

/**
 * Strips a leading remote name from a ref, so `origin/main` is recognised.
 *
 * Only one segment, and only when what follows is itself non-empty. Being
 * greedy here would make `feat/origin/thing` parse as remote `feat`, which is
 * the wrong reading of a legitimate branch name.
 */
function withoutRemote(ref: string): string {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return ref;
  }
  const head = ref.slice(0, slash);
  // A remote name will not be one of our work prefixes; a branch will not be
  // named after a remote. Where the two could collide, prefer reading it as a
  // branch, because that is the reading that keeps the protected check strict.
  return WORK_BRANCH_PREFIXES.includes(head) ? ref : ref.slice(slash + 1);
}

/**
 * Whether this ref names a branch the service must never write to.
 *
 * Accepts anything: fully-qualified refs, remote-tracking refs, bare names.
 * The point is to be callable at every site where a ref becomes an argument,
 * without the caller having to normalise first — a guard you have to prepare
 * for is a guard someone will call wrong.
 */
export function isProtectedRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (trimmed === "") {
    // Not a ref at all. Refusing is the safe reading of a value that should
    // never have reached here, and the caller gets a clear failure.
    return true;
  }

  let name = trimmed.toLowerCase();
  for (const qualifier of ["refs/heads/", "refs/remotes/"]) {
    if (name.startsWith(qualifier)) {
      name = name.slice(qualifier.length);
    }
  }
  // Both readings are tested, not just the stripped one. Stripping a leading
  // segment is a guess about whether it is a remote, and the guess is wrong in
  // both directions: `release/2026-09` loses the very prefix that makes it
  // protected, while `origin/main` needs the strip to be recognised at all.
  // Testing both readings means a ref is refused if *either* is protected,
  // which is the only direction a guard should be wrong in. Caught by a test:
  // the single-reading version passed `release/2026-09` as unprotected.
  for (const candidate of new Set([name, withoutRemote(name)])) {
    // `main^{commit}`, `main~1`, `main@{u}` all resolve to a protected branch.
    // Cutting at the first revision operator means the check sees the ref
    // rather than the expression, and an expression we do not understand keeps
    // its whole text, which can then only fail the comparisons below —
    // refusing, not allowing, on the unrecognised case.
    const bare = candidate.split(/[\^~@:]/u)[0] ?? candidate;
    if (PROTECTED_NAMES.includes(bare)) {
      return true;
    }
    if (PROTECTED_PREFIXES.some((prefix) => bare.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether this is a branch the service may create, commit to and push.
 *
 * Both halves must hold. The prefix allowlist is the primary rule; the
 * protected check is there because `chore/main` and `feat/release/2026-09`
 * satisfy the allowlist while naming something the denylist exists to stop.
 */
export function isWorkBranch(branch: string): boolean {
  const slash = branch.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  const prefix = branch.slice(0, slash);
  const rest = branch.slice(slash + 1);
  if (!WORK_BRANCH_PREFIXES.includes(prefix)) {
    return false;
  }
  if (rest === "") {
    return false;
  }
  return !isProtectedRef(rest);
}

/**
 * Throws unless `branch` is a legitimate work branch.
 *
 * A throwing variant exists because the two callers want opposite things from
 * a bad value: `branchNameFor` returns `null` and lets the caller refuse with
 * context, while the push path has nothing sensible to do and must not
 * continue. Making the loud version the explicit one keeps the quiet version
 * from being chosen by default.
 */
export function assertWorkBranch(branch: string, what: string): void {
  if (!isWorkBranch(branch)) {
    throw new Error(
      `${what} ${JSON.stringify(branch)} is not an implementation branch — this service writes only to ${WORK_BRANCH_PREFIXES.join("/")}-prefixed branches, and never to a protected ref`,
    );
  }
}
